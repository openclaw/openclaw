package ai.openclaw.wear.chat

import ai.openclaw.wear.R
import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.android.gateway.GatewaySessionEntry
import ai.openclaw.android.gateway.asObjectOrNull
import ai.openclaw.android.gateway.asStringOrNull
import ai.openclaw.android.gateway.parseSessionsList
import ai.openclaw.wear.gateway.GatewayClientInterface
import java.util.UUID
import java.util.Locale
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.coroutines.coroutineContext

class WearChatController(
  private val scope: CoroutineScope,
  private var client: GatewayClientInterface,
  private val stringResolver: (Int) -> String,
) {
  private companion object {
    private const val PENDING_RUN_TIMEOUT_MS = 120_000L
    private const val PENDING_HISTORY_REFRESH_MS = 1_500L
  }

  private data class PendingRunSnapshot(
    val sessionKey: String,
    val baselineUserCount: Int,
    val baselineAssistantCount: Int,
    val baselineAssistantId: String?,
    val pendingOrder: Int,
    val optimisticMessage: WearChatMessage,
  )

  private data class QueuedOutboundMessage(
    val sessionKey: String,
    val text: String,
  )

  private data class HistorySnapshot(
    val userCount: Int,
    val assistantCount: Int,
    val latestAssistantId: String?,
  )

  private val json = Json { ignoreUnknownKeys = true }
  private var eventsJob: Job? = null
  private var pendingHistoryRefreshJob: Job? = null
  private var historyLoadJob: Job? = null
  private val historyRequestVersion = AtomicLong(0)

  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  private val _messages = MutableStateFlow<List<WearChatMessage>>(emptyList())
  val messages: StateFlow<List<WearChatMessage>> = _messages.asStateFlow()

  private val _streamingText = MutableStateFlow<String?>(null)
  val streamingText: StateFlow<String?> = _streamingText.asStateFlow()

  private val _errorText = MutableStateFlow<String?>(null)
  val errorText: StateFlow<String?> = _errorText.asStateFlow()

  fun clearErrorText() {
    _errorText.value = null
  }

  private val _isLoading = MutableStateFlow(false)
  val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

  private val _isSending = MutableStateFlow(false)
  val isSending: StateFlow<Boolean> = _isSending.asStateFlow()

  private val _sessions = MutableStateFlow<List<GatewaySessionEntry>>(emptyList())
  val sessions: StateFlow<List<GatewaySessionEntry>> = _sessions.asStateFlow()

  private val _assistantReplies = MutableSharedFlow<String>(extraBufferCapacity = 4)
  val assistantReplies: SharedFlow<String> = _assistantReplies.asSharedFlow()

  private val pendingRuns = linkedMapOf<String, PendingRunSnapshot>()
  private val pendingRunTimeoutJobs = mutableMapOf<String, Job>()
  private val queuedOutboundMessages = linkedMapOf<String, QueuedOutboundMessage>()
  private val dispatchJobs = mutableMapOf<String, Job>()
  private var lastAnnouncedAssistantId: String? = null
  private var lastSyncedHistory: List<WearChatMessage> = emptyList()
  private var hasSyncedHistory = false

  init {
    startEventsCollection()
  }

  fun switchClient(newClient: GatewayClientInterface) {
    eventsJob?.cancel()
    historyLoadJob?.cancel()
    historyLoadJob = null
    historyRequestVersion.incrementAndGet()
    client = newClient
    _messages.value = emptyList()
    _streamingText.value = null
    _errorText.value = null
    _isSending.value = false
    _isLoading.value = false
    lastSyncedHistory = emptyList()
    hasSyncedHistory = false
    clearPendingRuns()
    clearQueuedOutboundMessages()
    startEventsCollection()
  }

  private fun startEventsCollection() {
    eventsJob = scope.launch {
      client.events.collect { event -> handleEvent(event) }
    }
  }

  fun loadHistory(emitLatestAssistantReply: Boolean = false) {
    val requestedSessionKey = _sessionKey.value
    val requestVersion = historyRequestVersion.incrementAndGet()
    historyLoadJob?.cancel()
    val loadJob =
      scope.launch {
        _isLoading.value = true
        _errorText.value = null
        try {
          val history = fetchHistory(requestedSessionKey)
          applyHistorySnapshot(
            requestVersion = requestVersion,
            requestedSessionKey = requestedSessionKey,
            history = history,
            emitLatestAssistantReply = emitLatestAssistantReply,
          )
        } catch (_: CancellationException) {
          // A newer history request superseded this one.
        } catch (e: Throwable) {
          _errorText.value = localizedErrorMessage(e, R.string.wear_chat_error_loading_failed)
        } finally {
          if (historyLoadJob === coroutineContext[Job]) {
            _isLoading.value = false
          }
        }
      }
    historyLoadJob = loadJob
  }

  fun fetchSessions() {
    scope.launch {
      try {
        val params = buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          put("limit", JsonPrimitive(50))
        }
        val result = client.request("sessions.list", params.toString())
        _sessions.value = parseSessionsList(result)
      } catch (_: Throwable) {
        // best-effort
      }
    }
  }

  fun switchSession(key: String) {
    val trimmed = key.trim()
    if (trimmed.isEmpty() || trimmed == _sessionKey.value) return
    _sessionKey.value = trimmed
    _messages.value = emptyList()
    _streamingText.value = null
    _errorText.value = null
    lastSyncedHistory = emptyList()
    hasSyncedHistory = false
    clearPendingRuns()
    clearQueuedOutboundMessages()
    lastAnnouncedAssistantId = null
    loadHistory()
  }

  fun sendMessage(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return

    val runId = UUID.randomUUID().toString()
    val activeSessionKey = _sessionKey.value
    val optimisticMessage =
      WearChatMessage(
        id = UUID.randomUUID().toString(),
        role = "user",
        text = trimmed,
        timestampMs = System.currentTimeMillis(),
      )

    // Optimistic UI update
    _messages.value = _messages.value + optimisticMessage
    _streamingText.value = null
    _errorText.value = null
    _isSending.value = true

    scope.launch {
      try {
        val baseline = resolveBaselineSnapshot()
        lastAnnouncedAssistantId = baseline.latestAssistantId
        synchronized(pendingRuns) {
          val pendingOrder = pendingRuns.values.count { it.sessionKey == activeSessionKey }
          pendingRuns[runId] = PendingRunSnapshot(
            sessionKey = activeSessionKey,
            baselineUserCount = baseline.userCount,
            baselineAssistantCount = baseline.assistantCount,
            baselineAssistantId = baseline.latestAssistantId,
            pendingOrder = pendingOrder,
            optimisticMessage = optimisticMessage,
          )
          _isSending.value = pendingRuns.isNotEmpty()
        }
        queueOrDispatchPendingMessage(
          runId = runId,
          sessionKey = activeSessionKey,
          text = trimmed,
        )
      } catch (e: Throwable) {
        clearPendingRun(runId)
        _errorText.value = localizedErrorMessage(e, R.string.wear_chat_error_send_failed)
      }
    }
  }

  fun onConnected() {
    loadHistory()
    fetchSessions()
    dispatchQueuedOutboundMessages()
  }

  fun onDisconnected() {
    _streamingText.value = null
    _isSending.value = hasPendingRuns()
  }

  private fun queueOrDispatchPendingMessage(runId: String, sessionKey: String, text: String) {
    if (!isPendingRun(runId)) return
    if (!client.connected.value) {
      synchronized(queuedOutboundMessages) {
        queuedOutboundMessages[runId] = QueuedOutboundMessage(
          sessionKey = sessionKey,
          text = text,
        )
      }
      return
    }
    dispatchPendingMessage(runId, sessionKey, text)
  }

  private fun dispatchQueuedOutboundMessages() {
    val pendingMessages =
      synchronized(queuedOutboundMessages) {
        queuedOutboundMessages.toMap()
      }
    pendingMessages.forEach { (runId, queued) ->
      if (isPendingRun(runId)) {
        dispatchPendingMessage(runId, queued.sessionKey, queued.text)
      } else {
        synchronized(queuedOutboundMessages) {
          queuedOutboundMessages.remove(runId)
        }
      }
    }
  }

  private fun dispatchPendingMessage(runId: String, sessionKey: String, text: String) {
    synchronized(dispatchJobs) {
      if (dispatchJobs.containsKey(runId)) return
    }

    val job =
      scope.launch {
        try {
          if (!client.connected.value) {
            synchronized(queuedOutboundMessages) {
              queuedOutboundMessages[runId] = QueuedOutboundMessage(sessionKey = sessionKey, text = text)
            }
            return@launch
          }

          synchronized(queuedOutboundMessages) {
            queuedOutboundMessages.remove(runId)
          }
          armPendingRunTimeout(runId)
          ensurePendingHistoryRefreshLoop()

          val params = buildJsonObject {
            put("sessionKey", JsonPrimitive(sessionKey))
            put("message", JsonPrimitive(text))
            put("thinking", JsonPrimitive("off"))
            put("timeoutMs", JsonPrimitive(30_000))
            put("idempotencyKey", JsonPrimitive(runId))
          }
          val response = client.request("chat.send", params.toString())
          val actualRunId = parseRunId(response) ?: runId
          if (actualRunId != runId) {
            replacePendingRunId(from = runId, to = actualRunId)
          }
        } catch (e: Throwable) {
          if (e.isCancelledRequest() && isPendingRun(runId)) {
            synchronized(queuedOutboundMessages) {
              queuedOutboundMessages[runId] = QueuedOutboundMessage(sessionKey = sessionKey, text = text)
            }
            return@launch
          }
          val shouldRetry = e.message?.contains("not connected", ignoreCase = true) == true
          if (shouldRetry && isPendingRun(runId)) {
            synchronized(queuedOutboundMessages) {
              queuedOutboundMessages[runId] = QueuedOutboundMessage(sessionKey = sessionKey, text = text)
            }
            return@launch
          }
          if (!isPendingRun(runId)) {
            return@launch
          }
          clearPendingRun(runId)
          _errorText.value = localizedErrorMessage(e, R.string.wear_chat_error_send_failed)
        } finally {
          synchronized(dispatchJobs) {
            dispatchJobs.remove(runId)
          }
        }
      }
    synchronized(dispatchJobs) {
      dispatchJobs[runId] = job
    }
  }

  private fun handleEvent(event: GatewayEvent) {
    when (event.event) {
      "mainSessionKey" -> {
        val key = event.payloadJson?.trim()
        if (!key.isNullOrEmpty() && _sessionKey.value == "main") {
          _sessionKey.value = key
          loadHistory()
        }
      }
      "proxy.connected" -> {
        // PhoneProxyClient established connection — load data
        onConnected()
      }
      "chat" -> {
        if (event.payloadJson.isNullOrBlank()) return
        handleChatEvent(event.payloadJson)
      }
      "agent" -> {
        if (event.payloadJson.isNullOrBlank()) return
        handleAgentEvent(event.payloadJson)
      }
    }
  }

  private fun handleChatEvent(payloadJson: String) {
    val payload = parseObject(payloadJson) ?: return
    val sessionKey = payload.str("sessionKey")
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return
    val runId = payload.str("runId")

    when (payload.str("state")) {
      "delta" -> {
        if (runId != null && !isPendingRun(runId)) return
        val message = payload["message"].asObjectOrNull()
        if (message?.get("role").asStringOrNull() == "assistant") {
          val content = (message["content"] as? JsonArray) ?: return
          for (item in content) {
            val obj = item.asObj() ?: continue
            if (obj.str("type") == "text") {
              val text = obj.str("text")
              if (!text.isNullOrEmpty()) {
                _streamingText.value = text
              }
            }
          }
        }
      }
      "final", "aborted", "error" -> {
        if (runId != null && !isPendingRun(runId)) return
        val state = payload.str("state")
        if (state == "error") {
          _errorText.value =
            payload.str("errorMessage")?.takeIf { it.isNotBlank() }
              ?: stringResolver(R.string.wear_chat_error_failed)
        }

        if (runId != null && isPendingRun(runId)) {
          clearPendingRun(runId)
        } else {
          if (runId == null) {
            clearPendingRuns()
          }
        }
        _streamingText.value = null
        refreshHistoryImmediately(emitLatestAssistantReply = state == "final")
      }
    }
  }

  private fun handleAgentEvent(payloadJson: String) {
    val payload = parseObject(payloadJson) ?: return
    val sessionKey = payload.str("sessionKey")
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return
    val runId = payload.str("runId")

    when (payload.str("stream")) {
      "assistant" -> {
        if (runId != null && !isPendingRun(runId)) return
        val data = payload["data"].asObj()
        val text = data?.str("text")
        if (!text.isNullOrEmpty()) {
          _streamingText.value = text
        }
      }
    }
  }

  private suspend fun resolveBaselineSnapshot(): HistorySnapshot {
    if (hasSyncedHistory) {
      return HistorySnapshot(
        userCount = lastSyncedHistory.countUserMessages(),
        assistantCount = lastSyncedHistory.countAssistantMessages(),
        latestAssistantId = lastSyncedHistory.latestAssistantId(),
      )
    }

    val history =
      try {
        fetchHistory(_sessionKey.value)
      } catch (_: Throwable) {
        emptyList()
      }
    lastSyncedHistory = history
    hasSyncedHistory = true
    return HistorySnapshot(
      userCount = history.countUserMessages(),
      assistantCount = history.countAssistantMessages(),
      latestAssistantId = history.latestAssistantId(),
    )
  }

  private suspend fun fetchHistory(sessionKey: String): List<WearChatMessage> {
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(sessionKey))
      }
    val result = client.request("chat.history", params.toString())
    return parseHistory(result)
  }

  private fun applyHistorySnapshot(
    requestVersion: Long,
    requestedSessionKey: String,
    history: List<WearChatMessage>,
    emitLatestAssistantReply: Boolean,
  ): Boolean {
    if (
      historyRequestVersion.get() != requestVersion ||
      requestedSessionKey != _sessionKey.value
    ) {
      return false
    }
    lastSyncedHistory = history
    hasSyncedHistory = true
    val resolvedPendingRuns = reconcilePendingRuns(history)
    _messages.value = mergePendingOptimisticMessages(requestedSessionKey = requestedSessionKey, history = history)
    if (emitLatestAssistantReply || resolvedPendingRuns) {
      emitLatestAssistantReplyIfNeeded(history)
    }
    return true
  }

  private fun mergePendingOptimisticMessages(
    requestedSessionKey: String,
    history: List<WearChatMessage>,
  ): List<WearChatMessage> {
    val historyUserCount = history.countUserMessages()
    val pendingOptimisticMessages =
      synchronized(pendingRuns) {
        pendingRuns.values
          .filter { snapshot ->
            snapshot.sessionKey == requestedSessionKey &&
              historyUserCount <= snapshot.baselineUserCount + snapshot.pendingOrder
          }
          .map { it.optimisticMessage }
      }
    if (pendingOptimisticMessages.isEmpty()) return history

    val merged = history.toMutableList()
    for (message in pendingOptimisticMessages.sortedBy { it.timestampMs ?: Long.MAX_VALUE }) {
      if (merged.none { it.id == message.id }) {
        merged += message
      }
    }
    return merged
  }

  private fun emitLatestAssistantReplyIfNeeded(history: List<WearChatMessage>) {
    val latestAssistant = history.lastOrNull { it.role == "assistant" && it.text.isNotBlank() } ?: return
    if (latestAssistant.id == lastAnnouncedAssistantId) return
    lastAnnouncedAssistantId = latestAssistant.id
    _assistantReplies.tryEmit(latestAssistant.text)
  }

  private fun reconcilePendingRuns(history: List<WearChatMessage>): Boolean {
    val pendingSnapshots =
      synchronized(pendingRuns) {
        pendingRuns.entries.map { it.toPair() }
      }
    if (pendingSnapshots.isEmpty()) return false

    val userCount = history.countUserMessages()
    val assistantCount = history.countAssistantMessages()
    val latestAssistantId = history.latestAssistantId()
    val resolvedRunIds =
      pendingSnapshots.mapNotNull { (runId, snapshot) ->
        val userPersisted = userCount > snapshot.baselineUserCount + snapshot.pendingOrder
        when {
          userPersisted && assistantCount > snapshot.baselineAssistantCount + snapshot.pendingOrder -> runId
          userPersisted &&
            latestAssistantId != null &&
            latestAssistantId != snapshot.baselineAssistantId &&
            assistantCount > snapshot.baselineAssistantCount -> runId
          else -> null
        }
      }
    if (resolvedRunIds.isEmpty()) return false

    resolvedRunIds.forEach(::clearPendingRun)
    _streamingText.value = null
    return true
  }

  private fun parseHistory(resultJson: String): List<WearChatMessage> {
    val root = parseObject(resultJson) ?: return emptyList()
    val array = (root["messages"] as? JsonArray) ?: return emptyList()

    return array.mapIndexedNotNull { index, item ->
      val obj = item.asObj() ?: return@mapIndexedNotNull null
      val role = obj.str("role") ?: return@mapIndexedNotNull null
      val content = (obj["content"] as? JsonArray) ?: return@mapIndexedNotNull null
      val textParts = content.mapNotNull { c ->
        val cObj = c.asObj() ?: return@mapNotNull null
        if (cObj.str("type") == "text") cObj.str("text") else null
      }
      val text = textParts.joinToString("\n").trim()
      if (text.isEmpty() && role == "assistant") return@mapIndexedNotNull null
      val ts = (obj["timestamp"] as? JsonPrimitive)?.content?.toLongOrNull()
      WearChatMessage(
        id = stableMessageId(role = role, text = text, timestampMs = ts, index = index),
        role = role,
        text = text,
        timestampMs = ts,
      )
    }
  }



  private fun parseObject(s: String): JsonObject? {
    return try {
      json.parseToJsonElement(s) as? JsonObject
    } catch (_: Throwable) {
      null
    }
  }

  private fun JsonObject.str(key: String): String? {
    val el = this[key] ?: return null
    return if (el is JsonPrimitive && el !is JsonNull) el.content else null
  }

  private fun parseRunId(resultJson: String): String? {
    return parseObject(resultJson)?.str("runId")?.trim()?.ifEmpty { null }
  }

  private fun isPendingRun(runId: String): Boolean {
    return synchronized(pendingRuns) { pendingRuns.containsKey(runId) }
  }

  private fun ensurePendingHistoryRefreshLoop() {
    if (pendingHistoryRefreshJob?.isActive == true) return
    pendingHistoryRefreshJob =
      scope.launch {
        try {
          while (hasPendingRuns()) {
            delay(PENDING_HISTORY_REFRESH_MS)
            refreshPendingHistoryIfNeeded(emitLatestAssistantReply = false)
          }
        } finally {
          pendingHistoryRefreshJob = null
        }
      }
  }

  private fun refreshHistoryImmediately(emitLatestAssistantReply: Boolean) {
    val requestedSessionKey = _sessionKey.value
    val requestVersion = historyRequestVersion.incrementAndGet()
    scope.launch {
      try {
        val history = fetchHistory(requestedSessionKey)
        applyHistorySnapshot(
          requestVersion = requestVersion,
          requestedSessionKey = requestedSessionKey,
          history = history,
          emitLatestAssistantReply = emitLatestAssistantReply,
        )
      } catch (_: Throwable) {
        // best-effort refresh for terminal events
      }
    }
  }

  private suspend fun refreshPendingHistoryIfNeeded(emitLatestAssistantReply: Boolean) {
    if (!hasPendingRuns()) return
    try {
      val requestedSessionKey = _sessionKey.value
      val requestVersion = historyRequestVersion.incrementAndGet()
      val history = fetchHistory(requestedSessionKey)
      applyHistorySnapshot(
        requestVersion = requestVersion,
        requestedSessionKey = requestedSessionKey,
        history = history,
        emitLatestAssistantReply = emitLatestAssistantReply,
      )
    } catch (_: Throwable) {
      // best-effort recovery while a send is pending
    }
  }

  private fun hasPendingRuns(): Boolean {
    return synchronized(pendingRuns) { pendingRuns.isNotEmpty() }
  }

  private fun replacePendingRunId(from: String, to: String) {
    if (from == to) return
    val snapshot =
      synchronized(pendingRuns) {
        pendingRuns.remove(from)?.also {
          pendingRuns[to] = it
          _isSending.value = pendingRuns.isNotEmpty()
        }
    }
    if (snapshot == null) return
    cancelPendingRunTimeout(from)
    armPendingRunTimeout(to)
  }

  private fun armPendingRunTimeout(runId: String) {
    val timeoutJob = scope.launch {
      delay(PENDING_RUN_TIMEOUT_MS)
      if (!isPendingRun(runId)) return@launch
      clearPendingRun(runId)
      _errorText.value = stringResolver(R.string.wear_chat_error_timed_out)
      refreshHistoryImmediately(emitLatestAssistantReply = false)
    }
    replacePendingRunTimeout(runId, timeoutJob)
  }

  private fun clearPendingRun(runId: String) {
    synchronized(queuedOutboundMessages) {
      queuedOutboundMessages.remove(runId)
    }
    synchronized(dispatchJobs) {
      dispatchJobs.remove(runId)
    }
    cancelPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.remove(runId)
      _isSending.value = pendingRuns.isNotEmpty()
    }
    if (!hasPendingRuns()) pendingHistoryRefreshJob?.cancel()
  }

  private fun clearPendingRuns() {
    pendingHistoryRefreshJob?.cancel()
    pendingHistoryRefreshJob = null
    synchronized(dispatchJobs) {
      dispatchJobs.values.forEach { it.cancel() }
      dispatchJobs.clear()
    }
    clearPendingRunTimeouts()
    synchronized(pendingRuns) {
      pendingRuns.clear()
      _isSending.value = false
    }
  }

  private fun clearQueuedOutboundMessages() {
    synchronized(queuedOutboundMessages) {
      queuedOutboundMessages.clear()
    }
  }

  private fun cancelPendingRunTimeout(runId: String) {
    val job =
      synchronized(pendingRunTimeoutJobs) {
        pendingRunTimeoutJobs.remove(runId)
      }
    job?.cancel()
  }

  private fun replacePendingRunTimeout(runId: String, job: Job) {
    val previousJob =
      synchronized(pendingRunTimeoutJobs) {
        pendingRunTimeoutJobs.put(runId, job)
      }
    previousJob?.cancel()
  }

  private fun clearPendingRunTimeouts() {
    val jobs =
      synchronized(pendingRunTimeoutJobs) {
        val activeJobs = pendingRunTimeoutJobs.values.toList()
        pendingRunTimeoutJobs.clear()
        activeJobs
      }
    jobs.forEach { it.cancel() }
  }

  private fun stableMessageId(role: String, text: String, timestampMs: Long?, index: Int): String {
    val seed = "$role|${timestampMs ?: "?"}|$index|$text"
    return UUID.nameUUIDFromBytes(seed.toByteArray(Charsets.UTF_8)).toString()
  }

  private fun List<WearChatMessage>.countAssistantMessages(): Int {
    return count { it.role == "assistant" && it.text.isNotBlank() }
  }

  private fun List<WearChatMessage>.countUserMessages(): Int {
    return count { it.role == "user" && it.text.isNotBlank() }
  }

  private fun List<WearChatMessage>.latestAssistantId(): String? {
    return lastOrNull { it.role == "assistant" && it.text.isNotBlank() }?.id
  }

  private fun JsonElement?.asObj(): JsonObject? = this as? JsonObject

  private fun Throwable.isCancelledRequest(): Boolean {
    if (this is CancellationException) return true
    val normalized = message?.lowercase(Locale.ROOT) ?: return false
    return normalized.contains("job was cancelled") || normalized.contains("job was canceled")
  }

  private fun localizedErrorMessage(error: Throwable, fallbackResId: Int): String? {
    if (error.isCancelledRequest()) return null
    return error.message?.trim()?.takeIf { it.isNotEmpty() } ?: stringResolver(fallbackResId)
  }
}
