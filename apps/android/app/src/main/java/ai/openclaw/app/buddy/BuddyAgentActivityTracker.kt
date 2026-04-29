package ai.openclaw.app.buddy

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

enum class BuddyAgentActivityPhase {
  Idle,
  Thinking,
  Speaking,
  Working,
  Error,
}

data class BuddyAgentActivity(
  val phase: BuddyAgentActivityPhase = BuddyAgentActivityPhase.Idle,
  val sessionKey: String? = null,
  val runId: String? = null,
  val toolCallId: String? = null,
  val toolName: String? = null,
  val message: String? = null,
)

class BuddyAgentActivityTracker(
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val acceptedSessionKey: ((String?) -> Boolean)? = null,
) {
  private val activeRuns = linkedSetOf<String>()
  private val completedRuns = linkedSetOf<String>()
  private val assistantTextByRun = linkedMapOf<String, String>()
  private val activeTools = linkedMapOf<String, ToolActivity>()
  private var lastAssistantMessage: String? = null
  private val _activity = MutableStateFlow(BuddyAgentActivity())
  val activity: StateFlow<BuddyAgentActivity> = _activity.asStateFlow()

  fun markSubmitted(sessionKey: String?, runId: String?) {
    val id = runId?.trim().takeUnless { it.isNullOrEmpty() }
    if (id != null && completedRuns.contains(id)) {
      activeRuns.remove(id)
      val assistantText = assistantTextByRun[id]?.trim().takeUnless { it.isNullOrEmpty() }
      if (assistantText != null) {
        _activity.value =
          BuddyAgentActivity(
            phase = BuddyAgentActivityPhase.Speaking,
            sessionKey = sessionKey?.trim().takeUnless { it.isNullOrEmpty() },
            runId = id,
            message = assistantText,
          )
      }
      return
    }
    if (id != null) {
      completedRuns.remove(id)
      assistantTextByRun.remove(id)
      activeRuns.add(id)
    }
    _activity.value =
      BuddyAgentActivity(
        phase = BuddyAgentActivityPhase.Thinking,
        sessionKey = sessionKey?.trim().takeUnless { it.isNullOrEmpty() },
        runId = id,
      )
  }

  fun confirmSubmittedRun(sessionKey: String?, provisionalRunId: String?, runId: String?) {
    val provisional = provisionalRunId?.trim().takeUnless { it.isNullOrEmpty() }
    val confirmed = runId?.trim().takeUnless { it.isNullOrEmpty() }
    if (provisional != null && confirmed != null && provisional != confirmed) {
      activeRuns.remove(provisional)
      assistantTextByRun.remove(provisional)
    }
    markSubmitted(sessionKey = sessionKey, runId = confirmed ?: provisional)
  }

  fun clearSubmittedRun(runId: String?, sessionKey: String?) {
    val id = runId?.trim().takeUnless { it.isNullOrEmpty() } ?: return
    val removed = activeRuns.remove(id)
    val current = _activity.value
    if (!removed && current.runId != id) return
    assistantTextByRun.remove(id)
    publishCurrent(
      sessionKey = sessionKey?.trim().takeUnless { it.isNullOrEmpty() },
      runId = id,
    )
  }

  fun markSubmittedRunTimedOut(runId: String?, sessionKey: String?) {
    val id = runId?.trim().takeUnless { it.isNullOrEmpty() } ?: return
    val assistantText = assistantTextByRun[id]?.trim().takeUnless { it.isNullOrEmpty() }
    if (assistantText != null) {
      _activity.value =
        BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Speaking,
          sessionKey = sessionKey?.trim().takeUnless { it.isNullOrEmpty() },
          runId = id,
          message = assistantText,
        )
      return
    }
    val removed = activeRuns.remove(id)
    val current = _activity.value
    if (!removed && current.runId != id) return
    _activity.value =
      BuddyAgentActivity(
        phase = BuddyAgentActivityPhase.Error,
        sessionKey = sessionKey?.trim().takeUnless { it.isNullOrEmpty() },
        runId = id,
        message = "Nemo 刚才没想好，可以再说一次",
      )
  }

  fun replayLastAssistantMessage(sessionKey: String? = null): String? {
    val message = lastAssistantMessage?.trim().takeUnless { it.isNullOrEmpty() } ?: return null
    _activity.value =
      BuddyAgentActivity(
        phase = BuddyAgentActivityPhase.Speaking,
        sessionKey = sessionKey?.trim().takeUnless { it.isNullOrEmpty() } ?: _activity.value.sessionKey,
        message = message,
      )
    return message
  }

  fun handleGatewayEvent(event: String, payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    try {
      when (event) {
        "chat" -> handleChatEvent(payloadJson)
        "agent" -> handleAgentEvent(payloadJson)
      }
    } catch (_: Throwable) {
      // Ignore malformed event payloads; the tracker should not affect transport handling.
    }
  }

  private fun handleChatEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
    val runId = payload["runId"].asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
    if (!acceptsEvent(sessionKey = sessionKey, runId = runId)) return
    when (payload["state"].asStringOrNull()) {
      "delta" -> {
        if (runId != null && completedRuns.contains(runId)) return
        if (runId != null) activeRuns.add(runId)
        val assistantText = parseAssistantDeltaText(payload)
        if (!assistantText.isNullOrEmpty()) {
          publishAssistantText(sessionKey = sessionKey, runId = runId, text = assistantText)
        } else {
          publishThinking(sessionKey = sessionKey, runId = runId)
        }
      }
      "final", "aborted", "error" -> {
        if (runId != null) {
          activeRuns.remove(runId)
          rememberCompletedRun(runId)
        } else {
          activeRuns.clear()
        }
        if (payload["state"].asStringOrNull() == "error") {
          _activity.value =
            BuddyAgentActivity(
              phase = BuddyAgentActivityPhase.Error,
              sessionKey = sessionKey,
              runId = runId,
              message = payload["errorMessage"].asStringOrNull(),
          )
          return
        }
        val assistantText = runId?.let { assistantTextByRun[it] }
        if (!assistantText.isNullOrEmpty()) {
          _activity.value =
            BuddyAgentActivity(
              phase = BuddyAgentActivityPhase.Speaking,
              sessionKey = sessionKey,
              runId = runId,
              message = assistantText,
            )
          return
        }
        publishCurrent(sessionKey = sessionKey, runId = runId)
      }
    }
  }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
    val runId = payload["runId"].asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
    if (!acceptsEvent(sessionKey = sessionKey, runId = runId)) return
    val stream = payload["stream"].asStringOrNull()
    val data = payload["data"].asObjectOrNull()

    when (stream) {
      "assistant" -> {
        if (runId != null && completedRuns.contains(runId)) return
        if (runId != null) activeRuns.add(runId)
        val assistantText = data?.get("text").asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
        if (!assistantText.isNullOrEmpty()) {
          publishAssistantText(sessionKey = sessionKey, runId = runId, text = assistantText)
        } else {
          publishThinking(sessionKey = sessionKey, runId = runId)
        }
      }
      "tool" -> {
        if (runId != null && completedRuns.contains(runId)) return
        val phase = data?.get("phase").asStringOrNull()
        val name = data?.get("name").asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
        val toolCallId =
          data?.get("toolCallId").asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() }
            ?: name
            ?: runId
            ?: "tool"
        when (phase) {
          "start" -> {
            activeTools[toolCallId] = ToolActivity(id = toolCallId, name = name, sessionKey = sessionKey, runId = runId)
            _activity.value =
              BuddyAgentActivity(
                phase = BuddyAgentActivityPhase.Working,
                sessionKey = sessionKey,
                runId = runId,
                toolCallId = toolCallId,
                toolName = name,
              )
          }
          "result" -> {
            activeTools.remove(toolCallId)
            publishCurrent(sessionKey = sessionKey, runId = runId)
          }
        }
      }
      "error" -> {
        if (runId != null) rememberCompletedRun(runId)
        activeRuns.clear()
        activeTools.clear()
        _activity.value =
          BuddyAgentActivity(
            phase = BuddyAgentActivityPhase.Error,
            sessionKey = sessionKey,
            runId = runId,
            message = data?.get("message").asStringOrNull(),
          )
      }
    }
  }

  private fun publishThinking(sessionKey: String?, runId: String?) {
    _activity.value =
      BuddyAgentActivity(
        phase = BuddyAgentActivityPhase.Thinking,
        sessionKey = sessionKey,
        runId = runId ?: activeRuns.firstOrNull(),
      )
  }

  private fun acceptsEvent(sessionKey: String?, runId: String?): Boolean {
    val accepts = acceptedSessionKey ?: return true
    if (accepts(sessionKey)) return true
    return sessionKey == null && runId != null && activeRuns.contains(runId)
  }

  private fun publishAssistantText(sessionKey: String?, runId: String?, text: String) {
    val trimmed = text.trim().takeIf { it.isNotEmpty() } ?: return
    lastAssistantMessage = trimmed
    if (runId != null) {
      assistantTextByRun[runId] = trimmed
      while (assistantTextByRun.size > 16) {
        assistantTextByRun.remove(assistantTextByRun.keys.first())
      }
    }
    _activity.value =
      BuddyAgentActivity(
        phase = BuddyAgentActivityPhase.Speaking,
        sessionKey = sessionKey,
        runId = runId ?: activeRuns.firstOrNull(),
        message = trimmed,
      )
  }

  private fun publishCurrent(sessionKey: String?, runId: String?) {
    val tool = activeTools.values.firstOrNull()
    if (tool != null) {
      _activity.value =
        BuddyAgentActivity(
          phase = BuddyAgentActivityPhase.Working,
          sessionKey = tool.sessionKey ?: sessionKey,
          runId = tool.runId ?: runId,
          toolCallId = tool.id,
          toolName = tool.name,
        )
      return
    }

    val activeRunId = activeRuns.firstOrNull()
    if (activeRunId != null) {
      publishThinking(sessionKey = sessionKey, runId = activeRunId)
      return
    }

    _activity.value = BuddyAgentActivity(phase = BuddyAgentActivityPhase.Idle, sessionKey = sessionKey)
  }

  private data class ToolActivity(
    val id: String,
    val name: String?,
    val sessionKey: String?,
    val runId: String?,
  )

  private fun rememberCompletedRun(runId: String) {
    completedRuns.add(runId)
    while (completedRuns.size > 64) {
      completedRuns.remove(completedRuns.first())
    }
  }

  private fun parseAssistantDeltaText(payload: JsonObject): String? {
    val message = payload["message"].asObjectOrNull() ?: return null
    if (message["role"].asStringOrNull() != "assistant") return null
    val content = message["content"].asArrayOrNull() ?: return null
    for (item in content) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["type"].asStringOrNull() != "text") continue
      val text = obj["text"].asStringOrNull()?.trim()
      if (!text.isNullOrEmpty()) return text
    }
    return null
  }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }
