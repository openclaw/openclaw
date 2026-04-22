package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.chat.resolveSessionAgentId
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

class ChatController(
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val json: Json,
  private val supportsChatSubscribe: Boolean,
  private val createSessionRequest: suspend (String) -> String? =
    { agentId ->
      val payload =
        buildJsonObject {
          put("agentId", JsonPrimitive(agentId))
        }
      parseSessionMutationKey(session.request("sessions.create", payload.toString()))
    },
  private val deleteSessionRequest: suspend (String) -> DeleteSessionOutcome =
    { key ->
      deleteSessionThroughGateway(
        request = { method, paramsJson -> session.requestDetailed(method, paramsJson) },
        sessionKey = key,
      )
    },
) {
  private var appliedMainSessionKey = "main"
  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  private val _sessionId = MutableStateFlow<String?>(null)
  val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

  private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

  private val _timeline = MutableStateFlow<List<ChatTimelineItem>>(emptyList())
  val timeline: StateFlow<List<ChatTimelineItem>> = _timeline.asStateFlow()

  private val _errorText = MutableStateFlow<String?>(null)
  val errorText: StateFlow<String?> = _errorText.asStateFlow()

  private val _healthOk = MutableStateFlow(false)
  val healthOk: StateFlow<Boolean> = _healthOk.asStateFlow()

  private val _thinkingLevel = MutableStateFlow("off")
  val thinkingLevel: StateFlow<String> = _thinkingLevel.asStateFlow()

  private val _pendingRunCount = MutableStateFlow(0)
  val pendingRunCount: StateFlow<Int> = _pendingRunCount.asStateFlow()

  private val _sessionActionInFlight = MutableStateFlow(false)
  val sessionActionInFlight: StateFlow<Boolean> = _sessionActionInFlight.asStateFlow()

  private val _streamingAssistantText = MutableStateFlow<String?>(null)
  val streamingAssistantText: StateFlow<String?> = _streamingAssistantText.asStateFlow()

  private val pendingToolCallsById = ConcurrentHashMap<String, ChatPendingToolCall>()
  private val _pendingToolCalls = MutableStateFlow<List<ChatPendingToolCall>>(emptyList())
  val pendingToolCalls: StateFlow<List<ChatPendingToolCall>> = _pendingToolCalls.asStateFlow()

  private val _sessions = MutableStateFlow<List<ChatSessionEntry>>(emptyList())
  val sessions: StateFlow<List<ChatSessionEntry>> = _sessions.asStateFlow()

  private val _sessionDefaults = MutableStateFlow(ChatSessionDefaults())
  val sessionDefaults: StateFlow<ChatSessionDefaults> = _sessionDefaults.asStateFlow()

  private val _modelCatalog = MutableStateFlow<List<ChatModelCatalogEntry>>(emptyList())
  val modelCatalog: StateFlow<List<ChatModelCatalogEntry>> = _modelCatalog.asStateFlow()

  private val _compactionStatus = MutableStateFlow<ChatCompactionStatus?>(null)
  val compactionStatus: StateFlow<ChatCompactionStatus?> = _compactionStatus.asStateFlow()

  private val _fallbackStatus = MutableStateFlow<ChatFallbackStatus?>(null)
  val fallbackStatus: StateFlow<ChatFallbackStatus?> = _fallbackStatus.asStateFlow()

  private val pendingRuns = mutableSetOf<String>()
  private val pendingRunTimeoutJobs = ConcurrentHashMap<String, Job>()
  private val pendingRunTimeoutMs = 120_000L
  private val sessionActionGuard = AtomicBoolean(false)

  private var lastHealthPollAtMs: Long? = null
  private var compactionClearJob: Job? = null
  private var fallbackClearJob: Job? = null

  fun onDisconnected(message: String) {
    _healthOk.value = false
    _errorText.value = null
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
    publishMessages(emptyList())
    clearCompactionStatus()
    clearFallbackStatus()
  }

  fun load(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    _sessionKey.value = key
    clearVisibleSessionState()
    scope.launch { bootstrap(forceHealth = true, refreshSessions = true) }
  }

  fun applyMainSessionKey(mainSessionKey: String) {
    val trimmed = mainSessionKey.trim()
    if (trimmed.isEmpty()) return
    val nextState =
      applyMainSessionKey(
        currentSessionKey = normalizeRequestedSessionKey(_sessionKey.value),
        appliedMainSessionKey = appliedMainSessionKey,
        nextMainSessionKey = trimmed,
      )
    appliedMainSessionKey = nextState.appliedMainSessionKey
    if (_sessionKey.value == nextState.currentSessionKey) return
    _sessionKey.value = nextState.currentSessionKey
    clearVisibleSessionState()
    scope.launch { bootstrap(forceHealth = true, refreshSessions = true) }
  }

  fun refresh() {
    scope.launch { bootstrap(forceHealth = true, refreshSessions = true) }
  }

  fun refreshSessions(limit: Int? = null) {
    scope.launch { fetchSessions(limit = limit) }
  }

  fun refreshModelCatalog() {
    scope.launch { fetchModelCatalog() }
  }

  fun createSession() {
    val blockReason = beginSessionAction() ?: return
    if (blockReason.isNotEmpty()) {
      _errorText.value = blockReason
      return
    }
    scope.launch {
      try {
        val currentKey = normalizeRequestedSessionKey(_sessionKey.value)
        val createdKey = createSessionRequest(resolveSessionAgentId(currentKey, appliedMainSessionKey))
        if (createdKey.isNullOrBlank()) {
          _errorText.value = "Created chat session, but the gateway did not return a session key."
          fetchSessions(limit = 50)
          return@launch
        }
        _sessionKey.value = normalizeRequestedSessionKey(createdKey)
        clearVisibleSessionState()
        bootstrap(forceHealth = true, refreshSessions = true)
      } catch (err: Throwable) {
        _errorText.value = err.message
      } finally {
        endSessionAction()
      }
    }
  }

  fun deleteCurrentSession() {
    val blockReason = beginSessionAction() ?: return
    if (blockReason.isNotEmpty()) {
      _errorText.value = blockReason
      return
    }
    scope.launch {
      try {
        val currentKey = normalizeRequestedSessionKey(_sessionKey.value)
        if (!canDeleteSession(currentKey, appliedMainSessionKey)) {
          _errorText.value = "Main chat can't be deleted."
          return@launch
        }
        val fallbackKey =
          resolveDeletionFallbackSessionKey(
            currentSessionKey = currentKey,
            sessions = _sessions.value,
            mainSessionKey = appliedMainSessionKey,
          )
        val outcome = deleteSessionRequest(currentKey)
        if (!outcome.deleted) {
          _errorText.value = outcome.errorText ?: "Chat session wasn't deleted."
          fetchSessions(limit = 50)
          return@launch
        }
        _sessionKey.value = normalizeRequestedSessionKey(fallbackKey)
        clearVisibleSessionState()
        bootstrap(forceHealth = true, refreshSessions = true)
      } catch (err: Throwable) {
        _errorText.value = err.message
      } finally {
        endSessionAction()
      }
    }
  }

  fun setThinkingLevel(thinkingLevel: String) {
    val normalized = normalizeThinking(thinkingLevel)
    if (normalized == _thinkingLevel.value) return
    _thinkingLevel.value = normalized
    scope.launch { patchSessionThinkingLevel(normalized) }
  }

  fun setModel(model: String?) {
    scope.launch { patchSessionModel(model) }
  }

  fun switchSession(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key.isEmpty()) return
    if (key == _sessionKey.value) return
    val blockReason = beginSessionAction() ?: return
    if (blockReason.isNotEmpty()) {
      _errorText.value = blockReason
      return
    }
    _sessionKey.value = key
    clearVisibleSessionState()
    scope.launch {
      try {
        bootstrap(forceHealth = true, refreshSessions = false)
      } finally {
        endSessionAction()
      }
    }
  }

  private fun normalizeRequestedSessionKey(sessionKey: String): String {
    val key = sessionKey.trim()
    if (key.isEmpty()) return appliedMainSessionKey
    if (key == "main" && appliedMainSessionKey != "main") return appliedMainSessionKey
    return key
  }

  private fun beginSessionAction(): String? {
    if (pendingRunCount.value > 0) {
      return "Wait for the current run to finish before changing chats."
    }
    if (!sessionActionGuard.compareAndSet(false, true)) {
      return null
    }
    _sessionActionInFlight.value = true
    return ""
  }

  private fun endSessionAction() {
    sessionActionGuard.set(false)
    _sessionActionInFlight.value = false
  }

  fun sendMessage(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ) {
    scope.launch {
      sendMessageAwaitAcceptance(
        message = message,
        thinkingLevel = thinkingLevel,
        attachments = attachments,
      )
    }
  }

  suspend fun sendMessageAwaitAcceptance(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean {
    val trimmed = message.trim()
    if (trimmed.isEmpty() && attachments.isEmpty()) return false
    if (!_healthOk.value) {
      _errorText.value = "Gateway health not OK; cannot send"
      return false
    }

    val runId = UUID.randomUUID().toString()
    val text = if (trimmed.isEmpty() && attachments.isNotEmpty()) "See attached." else trimmed
    val sessionKey = _sessionKey.value
    val thinking = normalizeThinking(thinkingLevel)

    val userContent =
      buildList {
        add(ChatMessageContent(type = "text", text = text))
        for (att in attachments) {
          add(
            ChatMessageContent(
              type = att.type,
              mimeType = att.mimeType,
              fileName = att.fileName,
              base64 = att.base64,
            ),
          )
        }
      }
    val nextMessages =
      _messages.value +
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = "user",
          content = userContent,
          timestampMs = System.currentTimeMillis(),
        )
    publishMessages(nextMessages)

    armPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }

    _errorText.value = null
    _streamingAssistantText.value = null
    pendingToolCallsById.clear()
    publishPendingToolCalls()

    return try {
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(sessionKey))
          put("message", JsonPrimitive(text))
          put("thinking", JsonPrimitive(thinking))
          put("timeoutMs", JsonPrimitive(30_000))
          put("idempotencyKey", JsonPrimitive(runId))
          if (attachments.isNotEmpty()) {
            put(
              "attachments",
              JsonArray(
                attachments.map { att ->
                  buildJsonObject {
                    put("type", JsonPrimitive(att.type))
                    put("mimeType", JsonPrimitive(att.mimeType))
                    put("fileName", JsonPrimitive(att.fileName))
                    put("content", JsonPrimitive(att.base64))
                  }
                },
              ),
            )
          }
        }
      val res = session.request("chat.send", params.toString())
      val actualRunId = parseRunId(res) ?: runId
      if (actualRunId != runId) {
        clearPendingRun(runId)
        armPendingRunTimeout(actualRunId)
        synchronized(pendingRuns) {
          pendingRuns.add(actualRunId)
          _pendingRunCount.value = pendingRuns.size
        }
      }
      true
    } catch (err: Throwable) {
      clearPendingRun(runId)
      _errorText.value = err.message
      false
    }
  }

  fun abort() {
    val runIds =
      synchronized(pendingRuns) {
        pendingRuns.toList()
      }
    if (runIds.isEmpty()) return
    scope.launch {
      for (runId in runIds) {
        try {
          val params =
            buildJsonObject {
              put("sessionKey", JsonPrimitive(_sessionKey.value))
              put("runId", JsonPrimitive(runId))
            }
          session.request("chat.abort", params.toString())
        } catch (_: Throwable) {
        }
      }
    }
  }

  fun handleGatewayEvent(event: String, payloadJson: String?) {
    when (event) {
      "tick" -> {
        scope.launch { pollHealthIfNeeded(force = false) }
      }
      "health" -> {
        _healthOk.value = true
      }
      "seqGap" -> {
        _errorText.value = "Event stream interrupted; try refreshing."
        clearPendingRuns()
      }
      "chat" -> {
        if (payloadJson.isNullOrBlank()) return
        handleChatEvent(payloadJson)
      }
      "agent" -> {
        if (payloadJson.isNullOrBlank()) return
        handleAgentEvent(payloadJson)
      }
    }
  }

  private suspend fun bootstrap(forceHealth: Boolean, refreshSessions: Boolean) {
    _errorText.value = null
    _healthOk.value = false
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
    clearCompactionStatus()
    clearFallbackStatus()

    try {
      if (refreshSessions) {
        fetchSessions(limit = 50, reloadOnReconcile = false)
      }

      val key = _sessionKey.value
      if (supportsChatSubscribe) {
        session.sendNodeEvent("chat.subscribe", """{"sessionKey":"$key"}""")
      }

      val historyJson = session.request("chat.history", """{"sessionKey":"$key"}""")
      val history = parseHistory(historyJson, sessionKey = key, previousMessages = _messages.value)
      publishMessages(history.messages)
      _sessionId.value = history.sessionId
      history.thinkingLevel?.trim()?.takeIf { it.isNotEmpty() }?.let { _thinkingLevel.value = it }

      pollHealthIfNeeded(force = forceHealth)
      if (_modelCatalog.value.isEmpty()) {
        fetchModelCatalog()
      }
    } catch (err: Throwable) {
      _errorText.value = err.message
    }
  }

  private suspend fun fetchSessions(limit: Int?, reloadOnReconcile: Boolean = true) {
    try {
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          put("includeDerivedTitles", JsonPrimitive(true))
          if (limit != null && limit > 0) put("limit", JsonPrimitive(limit))
        }
      val res = session.request("sessions.list", params.toString())
      val parsedSessions = parseSessions(res)
      _sessions.value = parsedSessions
      _sessionDefaults.value = parseSessionDefaults(res)

      val resolvedCurrent =
        resolveAuthoritativeCurrentSessionKey(
          currentSessionKey = _sessionKey.value,
          sessions = parsedSessions,
          mainSessionKey = appliedMainSessionKey,
        )
      if (resolvedCurrent != _sessionKey.value) {
        _sessionKey.value = resolvedCurrent
        clearVisibleSessionState()
        if (reloadOnReconcile) {
          bootstrap(forceHealth = true, refreshSessions = false)
        }
      }
    } catch (_: Throwable) {
    }
  }

  private fun clearVisibleSessionState() {
    _errorText.value = null
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
    publishMessages(emptyList())
    clearCompactionStatus()
    clearFallbackStatus()
  }

  private suspend fun fetchModelCatalog() {
    try {
      val res = session.request("models.list", "{}")
      _modelCatalog.value = parseModelCatalog(res)
    } catch (_: Throwable) {
    }
  }

  private suspend fun patchSessionThinkingLevel(level: String) {
    val payload =
      buildJsonObject {
        put("key", JsonPrimitive(_sessionKey.value))
        put(
          "thinkingLevel",
          if (level.isBlank()) JsonNull else JsonPrimitive(level),
        )
      }
    try {
      session.request("sessions.patch", payload.toString())
      fetchSessions(limit = 50)
    } catch (_: Throwable) {
    }
  }

  private suspend fun patchSessionModel(model: String?) {
    val trimmed = model?.trim().orEmpty()
    val payload =
      buildJsonObject {
        put("key", JsonPrimitive(_sessionKey.value))
        put(
          "model",
          if (trimmed.isEmpty()) JsonNull else JsonPrimitive(trimmed),
        )
      }
    try {
      session.request("sessions.patch", payload.toString())
      fetchSessions(limit = 50)
    } catch (_: Throwable) {
    }
  }

  private suspend fun pollHealthIfNeeded(force: Boolean) {
    val now = System.currentTimeMillis()
    val last = lastHealthPollAtMs
    if (!force && last != null && now - last < 10_000) return
    lastHealthPollAtMs = now
    try {
      session.request("health", null)
      _healthOk.value = true
    } catch (_: Throwable) {
      _healthOk.value = false
    }
  }

  private fun handleChatEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (sessionKey.isNullOrEmpty() || sessionKey != _sessionKey.value) return

    val runId = payload["runId"].asStringOrNull()
    val isPending =
      if (runId != null) synchronized(pendingRuns) { pendingRuns.contains(runId) } else true

    val state = payload["state"].asStringOrNull()
    when (state) {
      "delta" -> {
        if (!isPending) return
        val text = parseAssistantDeltaText(payload)
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }
      "final", "aborted", "error" -> {
        if (state == "error") {
          _errorText.value = payload["errorMessage"].asStringOrNull() ?: "Chat failed"
        }
        if (runId != null) clearPendingRun(runId) else clearPendingRuns()
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        scope.launch {
          try {
            val historyJson = session.request("chat.history", """{"sessionKey":"${_sessionKey.value}"}""")
            val history = parseHistory(historyJson, sessionKey = _sessionKey.value, previousMessages = _messages.value)
            publishMessages(history.messages)
            _sessionId.value = history.sessionId
            history.thinkingLevel?.trim()?.takeIf { it.isNotEmpty() }?.let { _thinkingLevel.value = it }
          } catch (_: Throwable) {
          }
        }
      }
    }
  }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (sessionKey.isNullOrEmpty() || sessionKey != _sessionKey.value) return

    val stream = payload["stream"].asStringOrNull()
    val data = payload["data"].asObjectOrNull()
    val runId = payload["runId"].asStringOrNull()
    val ts = payload["ts"].asLongOrNull() ?: System.currentTimeMillis()

    when (stream) {
      "assistant" -> {
        val text = data?.get("text")?.asStringOrNull()
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }
      "tool" -> {
        val phase = data?.get("phase")?.asStringOrNull()
        val name = data?.get("name")?.asStringOrNull()
        val toolCallId = data?.get("toolCallId")?.asStringOrNull()
        if (phase.isNullOrEmpty() || name.isNullOrEmpty() || toolCallId.isNullOrEmpty()) return

        if (phase == "start") {
          val args = data["args"].asObjectOrNull()
          pendingToolCallsById[toolCallId] =
            ChatPendingToolCall(
              toolCallId = toolCallId,
              name = name,
              args = args,
              startedAtMs = ts,
              isError = null,
            )
          publishPendingToolCalls()
        } else if (phase == "result") {
          pendingToolCallsById.remove(toolCallId)
          publishPendingToolCalls()
        }
      }
      "compaction" -> {
        handleCompactionEvent(runId = runId, data = data, ts = ts)
      }
      "fallback" -> {
        handleFallbackEvent(data = data, ts = ts, cleared = false)
      }
      "lifecycle" -> {
        handleLifecycleEvent(runId = runId, data = data, ts = ts)
      }
      "error" -> {
        _errorText.value = "Event stream interrupted; try refreshing."
        clearPendingRuns()
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
      }
    }
  }

  private fun parseAssistantDeltaText(payload: JsonObject): String? {
    val message = payload["message"].asObjectOrNull() ?: return null
    if (message["role"].asStringOrNull() != "assistant") return null
    val content = message["content"].asArrayOrNull() ?: return null
    for (item in content) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["type"].asStringOrNull() != "text") continue
      val text = obj["text"].asStringOrNull()
      if (!text.isNullOrEmpty()) {
        return text
      }
    }
    return null
  }

  private fun publishPendingToolCalls() {
    _pendingToolCalls.value = pendingToolCallsById.values.sortedBy { it.startedAtMs }
  }

  private fun publishMessages(messages: List<ChatMessage>) {
    _messages.value = messages
    _timeline.value = buildTimeline(messages)
  }

  private fun armPendingRunTimeout(runId: String) {
    pendingRunTimeoutJobs[runId]?.cancel()
    pendingRunTimeoutJobs[runId] =
      scope.launch {
        delay(pendingRunTimeoutMs)
        val stillPending =
          synchronized(pendingRuns) {
            pendingRuns.contains(runId)
          }
        if (!stillPending) return@launch
        clearPendingRun(runId)
        _errorText.value = "Timed out waiting for a reply; try again or refresh."
      }
  }

  private fun clearPendingRun(runId: String) {
    pendingRunTimeoutJobs.remove(runId)?.cancel()
    synchronized(pendingRuns) {
      pendingRuns.remove(runId)
      _pendingRunCount.value = pendingRuns.size
    }
  }

  private fun clearPendingRuns() {
    for ((_, job) in pendingRunTimeoutJobs) {
      job.cancel()
    }
    pendingRunTimeoutJobs.clear()
    synchronized(pendingRuns) {
      pendingRuns.clear()
      _pendingRunCount.value = 0
    }
  }

  private fun parseHistory(
    historyJson: String,
    sessionKey: String,
    previousMessages: List<ChatMessage>,
  ): ChatHistory {
    val root = json.parseToJsonElement(historyJson).asObjectOrNull() ?: return ChatHistory(sessionKey, null, null, emptyList())
    val sid = root["sessionId"].asStringOrNull()
    val thinkingLevel = root["thinkingLevel"].asStringOrNull()
    val array = root["messages"].asArrayOrNull() ?: JsonArray(emptyList())

    val messages =
      array.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = obj["role"].asStringOrNull() ?: return@mapNotNull null
        val content = obj["content"].asArrayOrNull()?.mapNotNull(::parseMessageContent) ?: emptyList()
        val ts = obj["timestamp"].asLongOrNull()
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = role,
          content = content,
          timestampMs = ts,
          sourceId = obj["id"].asStringOrNull(),
          toolCallId = obj["toolCallId"].asStringOrNull() ?: obj["tool_call_id"].asStringOrNull(),
          toolName = obj["toolName"].asStringOrNull() ?: obj["tool_name"].asStringOrNull(),
          senderLabel = obj["senderLabel"].asStringOrNull(),
          isError = obj["isError"].asBooleanOrNull(),
        )
      }

    return ChatHistory(
      sessionKey = sessionKey,
      sessionId = sid,
      thinkingLevel = thinkingLevel,
      messages = reconcileMessageIds(previous = previousMessages, incoming = messages),
    )
  }

  private fun parseMessageContent(el: JsonElement): ChatMessageContent? {
    val obj = el.asObjectOrNull() ?: return null
    val type = obj["type"].asStringOrNull() ?: "text"
    return when (normalizeContentType(type)) {
      "text" -> ChatMessageContent(type = "text", text = obj["text"].asStringOrNull())
      "thinking" ->
        ChatMessageContent(
          type = "thinking",
          thinking = obj["thinking"].asStringOrNull() ?: obj["text"].asStringOrNull(),
          thinkingSignature = obj["thinkingSignature"].asStringOrNull(),
        )
      "toolcall", "tooluse" ->
        ChatMessageContent(
          type = "tool_call",
          text = obj["text"].asStringOrNull(),
          toolName = obj["name"].asStringOrNull(),
          toolCallId = obj["id"].asStringOrNull()
            ?: obj["toolCallId"].asStringOrNull()
            ?: obj["tool_call_id"].asStringOrNull(),
          toolArgumentsJson = renderJsonValue(obj["arguments"] ?: obj["args"] ?: obj["input"]),
        )
      "toolresult" -> {
        val rawText = obj["text"].asStringOrNull() ?: obj["content"].asStringOrNull()
        val canvasPreview = obj["preview"].asCanvasPreviewOrNull() ?: extractCanvasPreview(rawText)
        ChatMessageContent(
          type = "tool_result",
          text = rawText,
          toolName = obj["name"].asStringOrNull(),
          toolCallId = obj["id"].asStringOrNull()
            ?: obj["toolCallId"].asStringOrNull()
            ?: obj["tool_call_id"].asStringOrNull(),
          canvasPreview = canvasPreview,
          rawText = rawText,
        )
      }
      "canvas" ->
        ChatMessageContent(
          type = "canvas",
          canvasPreview = obj["preview"].asCanvasPreviewOrNull(),
          rawText = obj["rawText"].asStringOrNull(),
        )
      else ->
        ChatMessageContent(
          type = type,
          text = obj["text"].asStringOrNull(),
          mimeType = obj["mimeType"].asStringOrNull(),
          fileName = obj["fileName"].asStringOrNull(),
          base64 = obj["content"].asStringOrNull(),
        )
    }
  }

  private fun parseSessions(jsonString: String): List<ChatSessionEntry> {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return emptyList()
    val sessions = root["sessions"].asArrayOrNull() ?: return emptyList()
    return sessions.mapNotNull { item ->
      val obj = item.asObjectOrNull() ?: return@mapNotNull null
      val key = obj["key"].asStringOrNull()?.trim().orEmpty()
      if (key.isEmpty()) return@mapNotNull null
      val updatedAt = obj["updatedAt"].asLongOrNull()
      val displayName = obj["displayName"].asStringOrNull()?.trim()
      val label = obj["label"].asStringOrNull()?.trim()
      val derivedTitle = obj["derivedTitle"].asStringOrNull()?.trim()
      val lastThreadId = obj["lastThreadId"].asStringOrNull()?.trim() ?: obj["lastThreadId"].asLongOrNull()?.toString()
      val topicId = obj["topicId"].asStringOrNull()?.trim() ?: lastThreadId
      val channel = obj["channel"].asStringOrNull()?.trim() ?: obj["lastChannel"].asStringOrNull()?.trim()
      val subject = obj["subject"].asStringOrNull()?.trim()
      val chatType = obj["chatType"].asStringOrNull()?.trim()
      val lastTo = obj["lastTo"].asStringOrNull()?.trim()
      val lastChannel = obj["lastChannel"].asStringOrNull()?.trim()
      ChatSessionEntry(
        key = key,
        updatedAtMs = updatedAt,
        displayName = displayName,
        label = label,
        derivedTitle = derivedTitle,
        model = obj["model"].asStringOrNull()?.trim(),
        topicId = topicId,
        channel = channel,
        subject = subject,
        chatType = chatType,
        lastThreadId = lastThreadId,
        lastTo = lastTo,
        lastChannel = lastChannel,
        modelProvider = obj["modelProvider"].asStringOrNull()?.trim(),
        thinkingLevel = obj["thinkingLevel"].asStringOrNull()?.trim(),
        reasoningLevel = obj["reasoningLevel"].asStringOrNull()?.trim(),
        contextTokens = obj["contextTokens"].asIntOrNull(),
        totalTokens = obj["totalTokens"].asIntOrNull(),
        totalTokensFresh = obj["totalTokensFresh"].asBooleanOrNull(),
      )
    }
  }

  private fun parseSessionDefaults(jsonString: String): ChatSessionDefaults {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return ChatSessionDefaults()
    val defaults = root["defaults"].asObjectOrNull() ?: return ChatSessionDefaults()
    return ChatSessionDefaults(
      model = defaults["model"].asStringOrNull()?.trim(),
      modelProvider = defaults["modelProvider"].asStringOrNull()?.trim(),
    )
  }

  private fun parseModelCatalog(jsonString: String): List<ChatModelCatalogEntry> {
    val root = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return emptyList()
    val models = root["models"].asArrayOrNull() ?: return emptyList()
    return models.mapNotNull { item ->
      val obj = item.asObjectOrNull() ?: return@mapNotNull null
      val id = obj["id"].asStringOrNull()?.trim().orEmpty()
      val name = obj["name"].asStringOrNull()?.trim().orEmpty()
      val provider = obj["provider"].asStringOrNull()?.trim().orEmpty()
      if (id.isEmpty() || name.isEmpty() || provider.isEmpty()) return@mapNotNull null
      ChatModelCatalogEntry(
        id = id,
        name = name,
        provider = provider,
        alias = obj["alias"].asStringOrNull()?.trim(),
        reasoning = obj["reasoning"].asBooleanOrNull(),
      )
    }
  }

  private fun parseRunId(resJson: String): String? {
    return try {
      json.parseToJsonElement(resJson).asObjectOrNull()?.get("runId").asStringOrNull()
    } catch (_: Throwable) {
      null
    }
  }

  private fun handleCompactionEvent(runId: String?, data: JsonObject?, ts: Long) {
    val phase = data?.get("phase").asStringOrNull()
    val completed = data?.get("completed").asBooleanOrNull() == true
    cancelCompactionClear()
    when (phase) {
      "start" -> {
        _compactionStatus.value =
          ChatCompactionStatus(
            phase = ChatCompactionStatus.Phase.Active,
            runId = runId,
            startedAtMs = ts,
            completedAtMs = null,
          )
      }
      "end" -> {
        if (data?.get("willRetry").asBooleanOrNull() == true && completed) {
          _compactionStatus.value =
            ChatCompactionStatus(
              phase = ChatCompactionStatus.Phase.Retrying,
              runId = runId,
              startedAtMs = _compactionStatus.value?.startedAtMs ?: ts,
              completedAtMs = null,
            )
          return
        }
        if (completed) {
          setCompactionComplete(runId = runId, completedAtMs = ts)
        } else {
          clearCompactionStatus()
        }
      }
    }
  }

  private fun handleLifecycleEvent(runId: String?, data: JsonObject?, ts: Long) {
    when (data?.get("phase").asStringOrNull()) {
      "end", "error" -> {
        val current = _compactionStatus.value
        if (current?.phase == ChatCompactionStatus.Phase.Retrying &&
          (current.runId == null || current.runId == runId)
        ) {
          setCompactionComplete(runId = runId, completedAtMs = ts)
        }
      }
      "fallback", "fallback_cleared" -> {
        handleFallbackEvent(
          data = data,
          ts = ts,
          cleared = data?.get("phase").asStringOrNull() == "fallback_cleared",
        )
      }
    }
  }

  private fun handleFallbackEvent(data: JsonObject?, ts: Long, cleared: Boolean) {
    val selected =
      resolveModelLabel(
        provider = data?.get("selectedProvider").asStringOrNull() ?: data?.get("fromProvider").asStringOrNull(),
        model = data?.get("selectedModel").asStringOrNull() ?: data?.get("fromModel").asStringOrNull(),
      ) ?: return
    val active =
      resolveModelLabel(
        provider = data?.get("activeProvider").asStringOrNull() ?: data?.get("toProvider").asStringOrNull(),
        model = data?.get("activeModel").asStringOrNull() ?: data?.get("toModel").asStringOrNull(),
      ) ?: return
    if (!cleared && selected == active) return

    val previous =
      resolveModelLabel(
        provider = data?.get("previousActiveProvider").asStringOrNull(),
        model = data?.get("previousActiveModel").asStringOrNull(),
      )
    val reason = data?.get("reasonSummary").asStringOrNull() ?: data?.get("reason").asStringOrNull()
    val attempts = parseFallbackAttempts(data?.get("attemptSummaries") ?: data?.get("attempts"))

    cancelFallbackClear()
    _fallbackStatus.value =
      ChatFallbackStatus(
        phase = if (cleared) ChatFallbackStatus.Phase.Cleared else ChatFallbackStatus.Phase.Active,
        selectedModel = selected,
        activeModel = if (cleared) selected else active,
        previousModel = if (cleared) previous ?: if (active != selected) active else null else null,
        reason = reason,
        attempts = attempts,
        occurredAtMs = ts,
      )
    scheduleFallbackClear()
  }

  private fun setCompactionComplete(runId: String?, completedAtMs: Long) {
    _compactionStatus.value =
      ChatCompactionStatus(
        phase = ChatCompactionStatus.Phase.Complete,
        runId = runId,
        startedAtMs = _compactionStatus.value?.startedAtMs,
        completedAtMs = completedAtMs,
      )
    scheduleCompactionClear()
  }

  private fun scheduleCompactionClear() {
    cancelCompactionClear()
    compactionClearJob =
      scope.launch {
        delay(COMPACTION_TOAST_DURATION_MS)
        _compactionStatus.value = null
      }
  }

  private fun cancelCompactionClear() {
    compactionClearJob?.cancel()
    compactionClearJob = null
  }

  private fun clearCompactionStatus() {
    cancelCompactionClear()
    _compactionStatus.value = null
  }

  private fun scheduleFallbackClear() {
    cancelFallbackClear()
    fallbackClearJob =
      scope.launch {
        delay(FALLBACK_TOAST_DURATION_MS)
        _fallbackStatus.value = null
      }
  }

  private fun cancelFallbackClear() {
    fallbackClearJob?.cancel()
    fallbackClearJob = null
  }

  private fun clearFallbackStatus() {
    cancelFallbackClear()
    _fallbackStatus.value = null
  }

  private fun parseFallbackAttempts(value: JsonElement?): List<String> {
    val array = value.asArrayOrNull() ?: return emptyList()
    val direct = array.mapNotNull { it.asStringOrNull()?.trim()?.takeIf(String::isNotEmpty) }
    if (direct.isNotEmpty()) return direct
    return array.mapNotNull { entry ->
      val item = entry.asObjectOrNull() ?: return@mapNotNull null
      val provider = item["provider"].asStringOrNull()?.trim().orEmpty()
      val model = item["model"].asStringOrNull()?.trim().orEmpty()
      if (provider.isEmpty() || model.isEmpty()) return@mapNotNull null
      val reason =
        item["reason"].asStringOrNull()?.replace('_', ' ')
          ?: item["code"].asStringOrNull()
          ?: item["error"].asStringOrNull()
          ?: item["status"].asIntOrNull()?.let { "HTTP $it" }
          ?: "error"
      "${resolveModelLabel(provider, model) ?: "$provider/$model"}: $reason"
    }
  }

  private fun resolveModelLabel(provider: String?, model: String?): String? {
    val modelValue = model?.trim().orEmpty()
    if (modelValue.isEmpty()) return null
    val providerValue = provider?.trim().orEmpty()
    if (providerValue.isEmpty()) return modelValue
    return if (modelValue.startsWith("$providerValue/", ignoreCase = true)) {
      "$providerValue/${modelValue.substringAfter('/').trim()}"
    } else {
      "$providerValue/$modelValue"
    }
  }

  private fun renderJsonValue(value: JsonElement?): String? {
    if (value == null || value is JsonNull) return null
    return when (value) {
      is JsonPrimitive -> value.content
      else -> runCatching { json.encodeToString(JsonElement.serializer(), value) }.getOrNull()
    }
  }

  private fun normalizeContentType(rawType: String): String {
    return rawType.trim().replace("_", "").replace("-", "").lowercase()
  }

  private fun normalizeThinking(raw: String): String {
    val key = raw.trim().lowercase()
    val collapsed = key.replace(Regex("[\\s_-]+"), "")
    return when {
      key.isBlank() || key == "default" -> ""
      key == "off" -> "off"
      key == "on" || key == "enable" || key == "enabled" -> "low"
      key == "min" || key == "minimal" || key == "think" -> "minimal"
      key == "low" || key == "thinkhard" -> "low"
      key == "medium" || key == "med" || key == "mid" || key == "harder" || key == "thinkharder" -> "medium"
      key == "high" || key == "max" || key == "highest" || key == "thinkhardest" || key == "ultra" || key == "ultrathink" -> "high"
      collapsed == "adaptive" || collapsed == "auto" -> "adaptive"
      collapsed == "xhigh" || collapsed == "extrahigh" -> "xhigh"
      else -> key
    }
  }

  companion object {
    private const val COMPACTION_TOAST_DURATION_MS = 5_000L
    private const val FALLBACK_TOAST_DURATION_MS = 8_000L
  }
}

internal data class MainSessionState(
  val currentSessionKey: String,
  val appliedMainSessionKey: String,
)

internal fun applyMainSessionKey(
  currentSessionKey: String,
  appliedMainSessionKey: String,
  nextMainSessionKey: String,
): MainSessionState {
  if (currentSessionKey == appliedMainSessionKey) {
    return MainSessionState(
      currentSessionKey = nextMainSessionKey,
      appliedMainSessionKey = nextMainSessionKey,
    )
  }
  return MainSessionState(
    currentSessionKey = currentSessionKey,
    appliedMainSessionKey = nextMainSessionKey,
  )
}

data class DeleteSessionOutcome(
  val deleted: Boolean,
  val errorText: String? = null,
)

internal fun buildDeleteSessionParamsJson(sessionKey: String): String =
  buildJsonObject {
    put("key", JsonPrimitive(sessionKey))
    put("deleteTranscript", JsonPrimitive(true))
  }.toString()

internal suspend fun deleteSessionThroughGateway(
  request: suspend (method: String, paramsJson: String) -> GatewaySession.RpcResult,
  sessionKey: String,
): DeleteSessionOutcome {
  val response = request("sessions.delete", buildDeleteSessionParamsJson(sessionKey))
  if (response.ok) {
    return if (parseDeletedFlag(response.payloadJson)) {
      DeleteSessionOutcome(deleted = true)
    } else {
      DeleteSessionOutcome(deleted = false, errorText = "Chat session wasn't deleted.")
    }
  }
  val message = response.error?.message?.trim().takeIf { !it.isNullOrEmpty() } ?: "Chat session wasn't deleted."
  return DeleteSessionOutcome(deleted = false, errorText = message)
}

internal fun canDeleteSession(
  currentSessionKey: String,
  mainSessionKey: String,
): Boolean {
  val normalizedMain = mainSessionKey.trim().ifEmpty { "main" }
  val normalizedCurrent =
    currentSessionKey.trim().let { key ->
      if (key == "main" && normalizedMain != "main") normalizedMain else key
    }
  return normalizedCurrent.isNotEmpty() && normalizedCurrent != normalizedMain && normalizedCurrent != "main"
}

internal fun resolveDeletionFallbackSessionKey(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
): String {
  val normalizedMain = mainSessionKey.trim().ifEmpty { "main" }
  val normalizedCurrent =
    currentSessionKey.trim().let { key ->
      if (key == "main" && normalizedMain != "main") normalizedMain else key
    }
  val currentAgent = resolveSessionAgentId(normalizedCurrent, normalizedMain)
  val uniqueSessions =
    sessions
      .distinctBy { it.key }
      .filter { entry ->
        val key = entry.key.trim()
        key.isNotEmpty() && key != normalizedCurrent && resolveSessionAgentId(key, normalizedMain) == currentAgent
      }
      .sortedWith(
        compareByDescending<ChatSessionEntry> { isMainSessionForAgent(it.key, currentAgent, normalizedMain) }
          .thenByDescending { it.updatedAtMs ?: 0L },
      )

  return uniqueSessions.firstOrNull()?.key ?: normalizedMain
}

private fun isMainSessionForAgent(
  sessionKey: String,
  agentId: String,
  mainSessionKey: String,
): Boolean {
  val trimmed = sessionKey.trim()
  if (agentId == "main") {
    return trimmed == mainSessionKey || trimmed == "main" || trimmed == "agent:main:main"
  }
  return trimmed == "agent:$agentId:main"
}

internal fun parseSessionMutationKey(resJson: String?): String? {
  return try {
    resJson?.let { Json.parseToJsonElement(it).asObjectOrNull()?.get("key").asStringOrNull()?.trim() }
  } catch (_: Throwable) {
    null
  }
}

internal fun parseDeletedFlag(resJson: String?): Boolean {
  return try {
    resJson?.let { Json.parseToJsonElement(it).asObjectOrNull()?.get("deleted").asBooleanOrNull() == true } == true
  } catch (_: Throwable) {
    false
  }
}

internal fun resolveAuthoritativeCurrentSessionKey(
  currentSessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
): String {
  val normalizedMain = mainSessionKey.trim().ifEmpty { "main" }
  val normalizedCurrent =
    currentSessionKey.trim().let { key ->
      if (key.isEmpty()) normalizedMain else if (key == "main" && normalizedMain != "main") normalizedMain else key
    }
  if (sessions.any { it.key == normalizedCurrent }) {
    return normalizedCurrent
  }
  return resolveDeletionFallbackSessionKey(
    currentSessionKey = normalizedCurrent,
    sessions = sessions,
    mainSessionKey = normalizedMain,
  )
}

internal fun reconcileMessageIds(previous: List<ChatMessage>, incoming: List<ChatMessage>): List<ChatMessage> {
  if (previous.isEmpty() || incoming.isEmpty()) return incoming

  val idsByKey = LinkedHashMap<String, ArrayDeque<String>>()
  for (message in previous) {
    val key = messageIdentityKey(message) ?: continue
    idsByKey.getOrPut(key) { ArrayDeque() }.addLast(message.id)
  }

  return incoming.map { message ->
    val key = messageIdentityKey(message) ?: return@map message
    val ids = idsByKey[key] ?: return@map message
    val reusedId = ids.removeFirstOrNull() ?: return@map message
    if (ids.isEmpty()) {
      idsByKey.remove(key)
    }
    if (reusedId == message.id) return@map message
    message.copy(id = reusedId)
  }
}

internal fun messageIdentityKey(message: ChatMessage): String? {
  val role = message.role.trim().lowercase()
  if (role.isEmpty()) return null

  val timestamp = message.timestampMs?.toString().orEmpty()
  val contentFingerprint =
    message.content.joinToString(separator = "\u001E") { part ->
      listOf(
        part.type.trim().lowercase(),
        part.text?.trim().orEmpty(),
        part.mimeType?.trim()?.lowercase().orEmpty(),
        part.fileName?.trim().orEmpty(),
        part.base64?.hashCode()?.toString().orEmpty(),
        part.thinking?.trim().orEmpty(),
        part.thinkingSignature?.trim().orEmpty(),
        part.toolName?.trim()?.lowercase().orEmpty(),
        part.toolCallId?.trim().orEmpty(),
        part.toolArgumentsJson?.trim().orEmpty(),
        part.canvasPreview?.url?.trim().orEmpty(),
        part.canvasPreview?.viewId?.trim().orEmpty(),
      ).joinToString(separator = "\u001F")
    }

  if (timestamp.isEmpty() && contentFingerprint.isEmpty()) return null
  return listOf(
    role,
    timestamp,
    message.sourceId?.trim().orEmpty(),
    message.toolCallId?.trim().orEmpty(),
    message.toolName?.trim()?.lowercase().orEmpty(),
    contentFingerprint,
  ).joinToString(separator = "|")
}

internal fun buildTimeline(messages: List<ChatMessage>): List<ChatTimelineItem> {
  if (messages.isEmpty()) return emptyList()
  val items = mutableListOf<ChatTimelineItem>()
  val toolsById = LinkedHashMap<String, Int>()
  var fallbackCounter = 0

  fun registerTool(item: ChatTimelineToolItem): Int {
    items.add(item)
    return items.lastIndex
  }

  for (message in messages) {
    val role = message.role.trim().lowercase()
    val messageItem = ChatTimelineMessageItem(id = "message:${message.id}", message = message)

    val contentToolBlocks = message.content.mapIndexedNotNull { index, part ->
      when (part.type) {
        "tool_call" -> {
          val callId = part.toolCallId ?: message.toolCallId ?: "call:${message.id}:$index"
          ChatTimelineToolItem(
            id = "tool:$callId",
            timestampMs = message.timestampMs,
            toolCallId = callId,
            toolName = part.toolName ?: message.toolName ?: "tool",
            args = parseJsonObjectOrNull(part.toolArgumentsJson),
            inputText = part.toolArgumentsJson,
            sourceMessageIds = listOf(message.id),
          )
        }
        "tool_result" -> {
          val callId = part.toolCallId ?: message.toolCallId
          val name = part.toolName ?: message.toolName ?: "tool"
          ChatTimelineToolItem(
            id = "tool:${callId ?: "${message.id}:$index"}",
            timestampMs = message.timestampMs,
            toolCallId = callId,
            toolName = name,
            outputText = part.text,
            preview = part.canvasPreview,
            isError = message.isError,
            sourceMessageIds = listOf(message.id),
            completedAtMs = message.timestampMs,
          )
        }
        else -> null
      }
    }

    if (contentToolBlocks.isNotEmpty()) {
      items.add(messageItem)
      for (tool in contentToolBlocks) {
        val key = tool.toolCallId ?: tool.id
        if (tool.inputText != null && tool.outputText == null) {
          toolsById[key] = registerTool(tool)
        } else {
          val existingIndex = toolsById[key]
          if (existingIndex != null && items.getOrNull(existingIndex) is ChatTimelineToolItem) {
            val existing = items[existingIndex] as ChatTimelineToolItem
            items[existingIndex] =
              existing.copy(
                timestampMs = tool.timestampMs ?: existing.timestampMs,
                outputText = tool.outputText ?: existing.outputText,
                preview = tool.preview ?: existing.preview,
                isError = tool.isError ?: existing.isError,
                completedAtMs = tool.completedAtMs ?: existing.completedAtMs,
                sourceMessageIds = (existing.sourceMessageIds + tool.sourceMessageIds).distinct(),
              )
          } else {
            toolsById[key] = registerTool(tool)
          }
        }
      }
      continue
    }

    if ((role == "toolresult" || role == "tool_result" || role == "tool" || role == "function") &&
      (message.toolCallId != null || message.toolName != null)
    ) {
      items.add(messageItem)
      val text = message.content.firstNotNullOfOrNull { it.text?.takeIf(String::isNotBlank) }
      val preview = message.content.firstNotNullOfOrNull { it.canvasPreview }
      val key = message.toolCallId ?: "standalone:${message.id}:${fallbackCounter++}"
      val toolItem =
        ChatTimelineToolItem(
          id = "tool:$key",
          timestampMs = message.timestampMs,
          toolCallId = message.toolCallId,
          toolName = message.toolName ?: "tool",
          outputText = text,
          preview = preview ?: extractCanvasPreview(text),
          isError = message.isError,
          sourceMessageIds = listOf(message.id),
          completedAtMs = message.timestampMs,
        )
      val existingIndex = toolsById[key]
      if (existingIndex != null && items.getOrNull(existingIndex) is ChatTimelineToolItem) {
        val existing = items[existingIndex] as ChatTimelineToolItem
        items[existingIndex] =
          existing.copy(
            outputText = toolItem.outputText ?: existing.outputText,
            preview = toolItem.preview ?: existing.preview,
            isError = toolItem.isError ?: existing.isError,
            completedAtMs = toolItem.completedAtMs ?: existing.completedAtMs,
            sourceMessageIds = (existing.sourceMessageIds + toolItem.sourceMessageIds).distinct(),
          )
      } else {
        toolsById[key] = registerTool(toolItem)
      }
      continue
    }

    items.add(messageItem)
  }

  return items
}

private fun parseJsonObjectOrNull(value: String?): JsonObject? {
  val trimmed = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  return runCatching {
    Json.parseToJsonElement(trimmed) as? JsonObject
  }.getOrNull()
}

private fun extractCanvasPreview(rawText: String?): ChatCanvasPreview? {
  val trimmed = rawText?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val obj = runCatching { Json.parseToJsonElement(trimmed) as? JsonObject }.getOrNull() ?: return null
  val kind = obj["kind"].asStringOrNull()?.trim()?.lowercase()
  if (kind != "canvas") return null
  val view = obj["view"].asObjectOrNull() ?: return null
  val presentation = obj["presentation"].asObjectOrNull()
  val target = presentation?.get("target").asStringOrNull() ?: "assistant_message"
  if (target != "assistant_message") return null
  return ChatCanvasPreview(
    kind = "canvas",
    surface = "assistant_message",
    render = "url",
    title = view["title"].asStringOrNull(),
    preferredHeight = view["preferred_height"].asIntOrNull() ?: view["preferredHeight"].asIntOrNull(),
    url = view["url"].asStringOrNull(),
    viewId = view["id"].asStringOrNull(),
    className = view["className"].asStringOrNull(),
    style = view["style"].asStringOrNull(),
  )
}

private fun JsonElement?.asCanvasPreviewOrNull(): ChatCanvasPreview? {
  val obj = this.asObjectOrNull() ?: return null
  val kind = obj["kind"].asStringOrNull() ?: return null
  if (!kind.equals("canvas", ignoreCase = true)) return null
  val render = obj["render"].asStringOrNull() ?: "url"
  val surface = obj["surface"].asStringOrNull() ?: "assistant_message"
  if (!surface.equals("assistant_message", ignoreCase = true)) return null
  if (!render.equals("url", ignoreCase = true)) return null
  return ChatCanvasPreview(
    kind = "canvas",
    surface = "assistant_message",
    render = "url",
    title = obj["title"].asStringOrNull(),
    preferredHeight = obj["preferredHeight"].asIntOrNull() ?: obj["preferred_height"].asIntOrNull(),
    url = obj["url"].asStringOrNull(),
    viewId = obj["viewId"].asStringOrNull() ?: obj["view_id"].asStringOrNull(),
    className = obj["className"].asStringOrNull() ?: obj["class_name"].asStringOrNull(),
    style = obj["style"].asStringOrNull(),
  )
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

private fun JsonElement?.asLongOrNull(): Long? =
  when (this) {
    is JsonPrimitive -> content.toLongOrNull()
    else -> null
  }

private fun JsonElement?.asIntOrNull(): Int? =
  when (this) {
    is JsonPrimitive -> content.toIntOrNull()
    else -> null
  }

private fun JsonElement?.asBooleanOrNull(): Boolean? =
  when (this) {
    is JsonPrimitive -> content.toBooleanStrictOrNull()
    else -> null
  }
