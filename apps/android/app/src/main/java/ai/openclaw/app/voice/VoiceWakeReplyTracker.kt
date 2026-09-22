package ai.openclaw.app.voice

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Follows the agent run that answers a wake-word command so its final reply can be spoken.
 *
 * The Gateway assigns the run id for a `voice.transcript` node event, so the node cannot know it up
 * front. The tracker adopts the first chat run seen on the wake session after arming and reports the
 * assistant text once that run reaches its final state.
 */
internal class VoiceWakeReplyTracker(
  private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
) {
  private class Armed(
    val sessionKey: String,
    val armedAtMs: Long,
  ) {
    var runId: String? = null
  }

  private val lock = Any()
  private var armed: Armed? = null

  /** Starts waiting for the reply to a command just dispatched on [sessionKey]. */
  fun arm(
    sessionKey: String,
    nowMs: Long,
  ) {
    synchronized(lock) { armed = Armed(sessionKey = sessionKey, armedAtMs = nowMs) }
  }

  fun clear() {
    synchronized(lock) { armed = null }
  }

  /** Returns the assistant text to speak when [payload] completes the tracked run, otherwise null. */
  fun onChatEvent(
    payload: JsonObject,
    nowMs: Long,
  ): String? =
    synchronized(lock) {
      val current = armed ?: return null
      if (nowMs - current.armedAtMs > timeoutMs) {
        armed = null
        return null
      }
      val sessionKey = payload["sessionKey"].asStringOrNull()
      if (sessionKey != null && sessionKey != current.sessionKey) return null
      val runId = payload["runId"].asStringOrNull() ?: return null
      val state = payload["state"].asStringOrNull() ?: return null
      if (current.runId == null) current.runId = runId
      if (current.runId != runId) return null
      when (state) {
        "final" -> {
          armed = null
          ChatEventText.assistantTextFromPayload(payload)
        }

        "aborted", "error" -> {
          armed = null
          null
        }

        else -> {
          null
        }
      }
    }

  private companion object {
    const val DEFAULT_TIMEOUT_MS = 120_000L
  }
}

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
