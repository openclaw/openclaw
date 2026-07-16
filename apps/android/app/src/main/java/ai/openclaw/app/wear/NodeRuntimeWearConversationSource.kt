package ai.openclaw.app.wear

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.wear.shared.WearAgentSummary
import ai.openclaw.wear.shared.WearChatMessage
import ai.openclaw.wear.shared.WearChatRole
import ai.openclaw.wear.shared.WearConversationErrorCode
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearSessionSummary
import kotlinx.coroutines.delay
import java.security.MessageDigest

internal class NodeRuntimeWearConversationSource(
  private val app: NodeApp,
  private val clock: () -> Long = System::currentTimeMillis,
) : PhoneWearConversationSource {
  override suspend fun snapshot(): PhoneWearConversationResult =
    app
      .peekRuntime()
      ?.let { runtime -> PhoneWearConversationResult(snapshot = runtime.toWearSnapshot()) }
      ?: phoneNotReady()

  override suspend fun sendMessage(message: String): PhoneWearConversationResult {
    val runtime = app.peekRuntime() ?: return phoneNotReady()
    if (!runtime.gatewayConnectionDisplay.value.isConnected) return gatewayOffline()

    val accepted =
      runtime.sendChatAwaitAcceptance(
        message = message,
        thinking = runtime.chatThinkingLevel.value,
        attachments = emptyList(),
      )
    return if (accepted) {
      PhoneWearConversationResult(snapshot = runtime.toWearSnapshot())
    } else {
      PhoneWearConversationResult(
        errorCode = WearConversationErrorCode.ACTION_REJECTED,
      )
    }
  }

  override suspend fun selectSession(sessionId: String): PhoneWearConversationResult {
    val runtime = app.peekRuntime() ?: return phoneNotReady()
    if (!runtime.gatewayConnectionDisplay.value.isConnected) return gatewayOffline()
    val session =
      runtime.chatSessions.value.firstOrNull { entry ->
        sessionHandle(entry.key) == sessionId
      } ?: return notFound()

    runtime.switchChatSession(session.key)
    waitForSelection { runtime.chatSessionKey.value == session.key }
    return PhoneWearConversationResult(snapshot = runtime.toWearSnapshot())
  }

  override suspend fun selectAgent(agentId: String): PhoneWearConversationResult {
    val runtime = app.peekRuntime() ?: return phoneNotReady()
    if (!runtime.gatewayConnectionDisplay.value.isConnected) return gatewayOffline()
    if (runtime.gatewayAgents.value.none { agent -> agent.id == agentId }) return notFound()

    runtime.selectChatAgent(agentId)
    waitForSelection {
      resolveAgentIdFromMainSessionKey(runtime.mainSessionKey.value) == agentId
    }
    return PhoneWearConversationResult(snapshot = runtime.toWearSnapshot())
  }

  private suspend fun waitForSelection(predicate: () -> Boolean) {
    repeat(SELECTION_WAIT_ATTEMPTS) {
      if (predicate()) return
      delay(SELECTION_WAIT_INTERVAL_MILLIS)
    }
  }

  private fun NodeRuntime.toWearSnapshot(): WearConversationSnapshot {
    val gatewayConnected = gatewayConnectionDisplay.value.isConnected
    val activeAgentId =
      resolveAgentIdFromMainSessionKey(mainSessionKey.value)
        ?: gatewayDefaultAgentId.value
    val activeSessionKey = chatSessionKey.value
    val currentSessions =
      buildList {
        chatSessions.value
          .asSequence()
          .filterNot { session -> session.archived == true }
          .take(MAX_SESSIONS)
          .forEach(::add)
        if (none { session -> session.key == activeSessionKey }) {
          add(
            0,
            ChatSessionEntry(
              key = activeSessionKey,
              updatedAtMs = null,
              displayName = "Current session",
            ),
          )
        }
      }.distinctBy(ChatSessionEntry::key)

    return WearConversationSnapshot(
      generatedAtEpochMillis = clock(),
      gatewayState =
        if (gatewayConnected) {
          WearGatewayState.CONNECTED
        } else {
          WearGatewayState.DISCONNECTED
        },
      activeAgentId = activeAgentId,
      agents =
        gatewayAgents.value
          .take(MAX_AGENTS)
          .map { agent -> agent.toWearAgent(activeAgentId) },
      activeSessionId = sessionHandle(activeSessionKey),
      sessions =
        currentSessions.map { session ->
          session.toWearSession(activeSessionKey)
        },
      messages =
        chatMessages.value
          .mapNotNull { message -> message.toWearMessage() }
          .takeLast(MAX_MESSAGES),
      streamingAssistantText =
        chatStreamingAssistantText.value
          ?.normalizedText(MAX_MESSAGE_TEXT_LENGTH),
      pendingRunCount = pendingRunCount.value.coerceAtLeast(0),
      selectedModelRef = chatSelectedModelRef.value?.normalizedText(MAX_MODEL_REF_LENGTH),
      errorText = chatError.value?.normalizedText(MAX_ERROR_TEXT_LENGTH),
    )
  }

  private fun GatewayAgentSummary.toWearAgent(activeAgentId: String?): WearAgentSummary =
    WearAgentSummary(
      id = id,
      name = name?.normalizedText(MAX_AGENT_NAME_LENGTH) ?: id,
      emoji = emoji?.normalizedText(MAX_EMOJI_LENGTH),
      selected = id == activeAgentId,
    )

  private fun ChatSessionEntry.toWearSession(activeSessionKey: String): WearSessionSummary =
    WearSessionSummary(
      id = sessionHandle(key),
      title =
        label?.normalizedText(MAX_SESSION_TITLE_LENGTH)
          ?: displayName?.normalizedText(MAX_SESSION_TITLE_LENGTH)
          ?: if (key == activeSessionKey) "Current session" else "Session",
      updatedAtEpochMillis = updatedAtMs,
      selected = key == activeSessionKey,
    )

  private fun ChatMessage.toWearMessage(): WearChatMessage? {
    val wearRole =
      when (role.trim().lowercase()) {
        "user" -> WearChatRole.USER
        "assistant" -> WearChatRole.ASSISTANT
        "system", "custom" -> WearChatRole.SYSTEM
        else -> return null
      }
    val messageText =
      content
        .asSequence()
        .mapNotNull { part -> part.text?.trim()?.takeIf(String::isNotEmpty) }
        .joinToString("\n")
        .normalizedText(MAX_MESSAGE_TEXT_LENGTH)
        ?: return null
    return WearChatMessage(
      id = id.normalizedText(MAX_MESSAGE_ID_LENGTH) ?: sessionHandle("$role:$messageText"),
      role = wearRole,
      text = messageText,
      timestampEpochMillis = timestampMs,
    )
  }

  private fun String.normalizedText(maxLength: Int): String? =
    trim()
      .takeIf(String::isNotEmpty)
      ?.take(maxLength)

  private fun sessionHandle(sessionKey: String): String {
    val digest =
      MessageDigest
        .getInstance("SHA-256")
        .digest(sessionKey.encodeToByteArray())
    return digest
      .take(SESSION_HANDLE_BYTES)
      .joinToString(separator = "") { byte ->
        "%02x".format(byte.toInt() and 0xff)
      }
  }

  private fun phoneNotReady(): PhoneWearConversationResult =
    PhoneWearConversationResult(
      errorCode = WearConversationErrorCode.PHONE_NOT_READY,
    )

  private fun gatewayOffline(): PhoneWearConversationResult =
    PhoneWearConversationResult(
      errorCode = WearConversationErrorCode.GATEWAY_OFFLINE,
    )

  private fun notFound(): PhoneWearConversationResult =
    PhoneWearConversationResult(
      errorCode = WearConversationErrorCode.NOT_FOUND,
    )

  private companion object {
    const val MAX_AGENTS = 16
    const val MAX_SESSIONS = 24
    const val MAX_MESSAGES = 18
    const val MAX_MESSAGE_TEXT_LENGTH = 1_500
    const val MAX_MESSAGE_ID_LENGTH = 128
    const val MAX_AGENT_NAME_LENGTH = 96
    const val MAX_SESSION_TITLE_LENGTH = 120
    const val MAX_MODEL_REF_LENGTH = 160
    const val MAX_ERROR_TEXT_LENGTH = 300
    const val MAX_EMOJI_LENGTH = 16
    const val SESSION_HANDLE_BYTES = 12
    const val SELECTION_WAIT_ATTEMPTS = 20
    const val SELECTION_WAIT_INTERVAL_MILLIS = 50L
  }
}
