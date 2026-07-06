package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.parseChatSendAck
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

// Capture before suspend points; both fields must still match before gateway data reaches UI state.
internal data class ChatCacheScope(
  val gatewayId: String,
  val connectionGeneration: Long,
)

class ChatController internal constructor(
  private val scope: CoroutineScope,
  private val json: Json,
  private val requestGateway: suspend (method: String, paramsJson: String?) -> String,
  private val transcriptCache: ChatTranscriptCache? = null,
  private val cacheScope: () -> ChatCacheScope? = { null },
  private val commandOutbox: ChatCommandOutbox? = null,
) {
  internal constructor(
    scope: CoroutineScope,
    session: GatewaySession,
    json: Json,
    transcriptCache: ChatTranscriptCache? = null,
    cacheScope: () -> ChatCacheScope? = { null },
    commandOutbox: ChatCommandOutbox? = null,
  ) : this(
    scope = scope,
    json = json,
    requestGateway = { method, paramsJson -> session.request(method, paramsJson) },
    transcriptCache = transcriptCache,
    cacheScope = cacheScope,
    commandOutbox = commandOutbox,
  )

  private var appliedMainSessionKey = "main"
  private val cacheMutationMutex = Mutex()
  private val _sessionKey = MutableStateFlow("main")
  val sessionKey: StateFlow<String> = _sessionKey.asStateFlow()

  private val _sessionId = MutableStateFlow<String?>(null)
  val sessionId: StateFlow<String?> = _sessionId.asStateFlow()

  private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

  // True while the transcript shown came from the offline cache and no live history replaced it yet.
  private val _messagesFromCache = MutableStateFlow(false)
  val messagesFromCache: StateFlow<Boolean> = _messagesFromCache.asStateFlow()

  private val _historyLoading = MutableStateFlow(false)
  val historyLoading: StateFlow<Boolean> = _historyLoading.asStateFlow()

  private val _errorText = MutableStateFlow<String?>(null)
  val errorText: StateFlow<String?> = _errorText.asStateFlow()

  private val _healthOk = MutableStateFlow(false)
  val healthOk: StateFlow<Boolean> = _healthOk.asStateFlow()

  private val _thinkingLevel = MutableStateFlow("off")
  val thinkingLevel: StateFlow<String> = _thinkingLevel.asStateFlow()

  private val _pendingRunCount = MutableStateFlow(0)
  val pendingRunCount: StateFlow<Int> = _pendingRunCount.asStateFlow()

  private val _streamingAssistantText = MutableStateFlow<String?>(null)
  val streamingAssistantText: StateFlow<String?> = _streamingAssistantText.asStateFlow()

  private val pendingToolCallsById = ConcurrentHashMap<String, ChatPendingToolCall>()
  private val _pendingToolCalls = MutableStateFlow<List<ChatPendingToolCall>>(emptyList())
  val pendingToolCalls: StateFlow<List<ChatPendingToolCall>> = _pendingToolCalls.asStateFlow()

  private val _sessions = MutableStateFlow<List<ChatSessionEntry>>(emptyList())
  val sessions: StateFlow<List<ChatSessionEntry>> = _sessions.asStateFlow()

  private val _commands = MutableStateFlow<List<ChatCommandEntry>>(emptyList())
  val commands: StateFlow<List<ChatCommandEntry>> = _commands.asStateFlow()

  private val pendingRuns = mutableSetOf<String>()
  private val disconnectedPendingRunIds = mutableSetOf<String>()
  private val timedOutRunIds = ConcurrentHashMap.newKeySet<String>()
  private val terminalWithoutReplyRunIds = ConcurrentHashMap.newKeySet<String>()
  private val unknownOutcomeRunIds = ConcurrentHashMap.newKeySet<String>()
  private val pendingRunTimeoutJobs = ConcurrentHashMap<String, Job>()

  // Preserve sent messages locally until chat.history includes the gateway-confirmed copy.
  private val optimisticMessagesByRunId = ConcurrentHashMap<String, ChatMessage>()
  // Keep reply ownership after the user row persists; the assistant row can land later.
  private val unresolvedRepliesByRunId = ConcurrentHashMap<String, ChatMessage>()
  private val pendingRunTimeoutMs = 120_000L
  private val recoveryHistoryRetryDelayMs = 750L
  private var recoveryHistoryReconciliationGeneration = -1L
  private var recoveryHistoryReconciliationJob: Job? = null

  // Drops stale history responses after session switches or refresh races.
  private val historyLoadGeneration = AtomicLong(0)
  private val historyRequestSequence = AtomicLong(0)
  private val gatewayScopeApplyLock = Any()
  private var latestAppliedHistoryRequest = 0L
  private var latestAppliedInFlightRunId: String? = null
  private var lastHandledTerminalRunId: String? = null
  private var historyLoadErrorGeneration: Long? = null
  private val newChatCreateInFlight = AtomicBoolean(false)

  private var lastHealthPollAtMs: Long? = null
  private var commandsAgentId: String? = null

  // Armed on disconnect so the next health event refetches history and re-adopts
  // any run the gateway still reports in flight (chat.history `inFlightRun`).
  private var restoreRunStateOnReconnect = false
  private var reconnectRecoveryGeneration: Long? = null

  private fun updateErrorText(
    message: String?,
    historyGeneration: Long? = null,
  ) {
    _errorText.value = message
    historyLoadErrorGeneration = historyGeneration
  }

  private val _outboxItems = MutableStateFlow<List<ChatOutboxItem>>(emptyList())
  val outboxItems: StateFlow<List<ChatOutboxItem>> = _outboxItems.asStateFlow()

  private val outboxFlushInFlight = AtomicBoolean(false)

  init {
    if (commandOutbox != null) {
      scope.launch {
        // Crash safety: a process killed mid-flush leaves rows in 'sending'; requeue them so
        // they are retried instead of being stuck invisible to the flush loop forever.
        runCatching { commandOutbox.requeueSendingAfterRestart() }
        currentCacheScope()?.let { outboxScope ->
          runCatching { commandOutbox.expireStale(outboxScope.gatewayId, System.currentTimeMillis()) }
        }
        publishOutbox()
      }
    }
  }

  /** Clears transient chat state when the operator gateway session disconnects. */
  fun onDisconnected(message: String) {
    historyLoadGeneration.incrementAndGet()
    restoreRunStateOnReconnect = true
    reconnectRecoveryGeneration = null
    _healthOk.value = false
    updateErrorText(null)
    _commands.value = emptyList()
    commandsAgentId = null
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.addAll(pendingRuns)
    }
    // History can lag the accepted send. Keep the optimistic echo available for the
    // reconnect snapshot to reconcile instead of dropping the user's message.
    clearPendingRuns(
      clearOptimisticMessages = false,
      preserveDisconnectedOwnership = true,
    )
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _historyLoading.value = false
    _sessionId.value = null
  }

  /** Refreshes the connected gateway while preserving recovery ownership after a disconnect. */
  fun onGatewayConnected() {
    if (!restoreRunStateOnReconnect) {
      refresh()
      return
    }
    updateErrorText(null)
    refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
  }

  /** Invalidates and clears gateway-bound UI state before a target switch can race old responses. */
  fun onGatewayScopeChanging() {
    synchronized(gatewayScopeApplyLock) {
      beginHistoryLoad(
        key = normalizeRequestedSessionKey(_sessionKey.value),
        clearMessages = true,
        markLoading = false,
      )
      _sessions.value = emptyList()
      // Outbox rows are gateway-scoped too; the next publish repopulates them for the new scope.
      _outboxItems.value = emptyList()
    }
  }

  /** Purges cached transcripts and queued sends after old-scope writes finish. */
  internal suspend fun clearTranscriptCache() {
    val cache = transcriptCache ?: return
    cacheMutationMutex.withLock {
      cache.clearAll()
      commandOutbox?.clearAll()
    }
  }

  /** Loads a chat session, normalizing "main" to the current gateway-provided main session key. */
  fun load(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key == _sessionKey.value) {
      refresh()
      return
    }
    val generation = beginHistoryLoad(key, clearMessages = true)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = true)
    }
  }

  /** Rebinds chat to a new canonical main session key after gateway hello/agent changes. */
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
    val generation = beginHistoryLoad(nextState.currentSessionKey, clearMessages = true)
    scope.launch {
      bootstrap(
        sessionKey = nextState.currentSessionKey,
        generation = generation,
        forceHealth = true,
        refreshSessions = true,
      )
    }
  }

  /** Refreshes current chat history and session list without clearing optimistic messages first. */
  fun refresh() {
    updateErrorText(null)
    refreshHistoryForRecovery(forceHealth = true)
  }

  fun refreshSessions(limit: Int? = null) {
    scope.launch { fetchSessions(limit = limit) }
  }

  /** Starts a fresh chat for the active gateway session key. */
  fun startNewChat() {
    scope.launch { startNewChatAwait() }
  }

  /** Starts a fresh chat and returns whether the gateway created the session. */
  suspend fun startNewChatAwait(): Boolean {
    val parentKey = normalizeRequestedSessionKey(_sessionKey.value)
    if (parentKey.isEmpty()) return false
    if (_pendingRunCount.value > 0) {
      updateErrorText("Wait for the current response to finish before starting a new chat.")
      return false
    }
    if (!newChatCreateInFlight.compareAndSet(false, true)) {
      return false
    }
    val requestGeneration = historyLoadGeneration.get()
    updateErrorText(null)
    _historyLoading.value = true
    return try {
      val label = nextNewChatSessionLabel(_sessions.value)
      val hasLoadedParentSession = !_sessionId.value.isNullOrBlank()
      val params =
        buildJsonObject {
          put("agentId", JsonPrimitive(resolveAgentIdForSessionKey(parentKey)))
          if (hasLoadedParentSession) {
            put("parentSessionKey", JsonPrimitive(parentKey))
            put("emitCommandHooks", JsonPrimitive(true))
          }
          put("label", JsonPrimitive(label))
        }
      val res = requestGateway("sessions.create", params.toString())
      if (!isCurrentHistoryLoad(parentKey, _sessionKey.value, requestGeneration, historyLoadGeneration.get())) {
        return false
      }
      val createdKey = parseCreatedSessionKey(json, res) ?: parentKey
      val generation = beginHistoryLoad(createdKey, clearMessages = true)
      bootstrap(sessionKey = createdKey, generation = generation, forceHealth = true, refreshSessions = true)
      true
    } catch (err: Throwable) {
      updateErrorText(err.message)
      _historyLoading.value = false
      false
    } finally {
      newChatCreateInFlight.set(false)
    }
  }

  /** Refreshes the available text slash commands for the current gateway. */
  fun refreshCommands() {
    scope.launch { fetchCommands() }
  }

  /** Persists the normalized thinking level used for subsequent chat sends. */
  fun setThinkingLevel(thinkingLevel: String) {
    val normalized = normalizeThinking(thinkingLevel)
    if (normalized == _thinkingLevel.value) return
    _thinkingLevel.value = normalized
  }

  /** Switches to another gateway chat session and starts a fresh history load. */
  fun switchSession(sessionKey: String) {
    val key = normalizeRequestedSessionKey(sessionKey)
    if (key.isEmpty()) return
    if (key == _sessionKey.value) return
    val generation = beginHistoryLoad(key, clearMessages = true)
    scope.launch {
      bootstrap(sessionKey = key, generation = generation, forceHealth = true, refreshSessions = false)
    }
  }

  private fun beginHistoryLoad(
    key: String,
    clearMessages: Boolean,
    markLoading: Boolean = true,
  ): Long {
    val generation = historyLoadGeneration.incrementAndGet()
    _sessionKey.value = key
    lastHandledTerminalRunId = null
    val nextAgentId = resolveAgentIdForSessionKey(key)
    if (commandsAgentId != nextAgentId) {
      _commands.value = emptyList()
      commandsAgentId = null
    }
    updateErrorText(null)
    _healthOk.value = false
    clearPendingRuns()
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
    _sessionId.value = null
    _historyLoading.value = markLoading
    if (clearMessages) {
      _messages.value = emptyList()
      _messagesFromCache.value = false
    }
    return generation
  }

  private fun normalizeRequestedSessionKey(sessionKey: String): String {
    val key = sessionKey.trim()
    if (key.isEmpty()) return appliedMainSessionKey
    if (key == "main" && appliedMainSessionKey != "main") return appliedMainSessionKey
    return key
  }

  private fun resolveAgentIdForSessionKey(parentKey: String): String = resolveAgentIdFromMainSessionKey(parentKey) ?: "main"

  /** Queues a chat send without waiting for gateway acceptance. */
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

  /** Sends a chat message and returns once the gateway accepts or rejects the request. */
  suspend fun sendMessageAwaitAcceptance(
    message: String,
    thinkingLevel: String,
    attachments: List<OutgoingAttachment>,
  ): Boolean {
    val trimmed = message.trim()
    if (trimmed.isEmpty() && attachments.isEmpty()) return false
    if (!_healthOk.value) {
      // Offline capture: text-only commands become durable outbox rows and flush on reconnect.
      // Attachments stay blocked (text-only v1) so large payloads never sit in the database.
      if (commandOutbox == null || attachments.isNotEmpty()) {
        updateErrorText("Gateway health not OK; cannot send")
        return false
      }
      return enqueueOfflineCommand(text = trimmed, thinkingLevel = normalizeThinking(thinkingLevel))
    }

    val runId = UUID.randomUUID().toString()
    val text = if (trimmed.isEmpty() && attachments.isNotEmpty()) "See attached." else trimmed
    val sessionKey = _sessionKey.value
    val thinking = normalizeThinking(thinkingLevel)

    // Optimistic user message keeps the composer responsive while chat.send and history refresh complete.
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
    val optimisticMessage =
      ChatMessage(
        id = UUID.randomUUID().toString(),
        role = "user",
        content = userContent,
        timestampMs = System.currentTimeMillis(),
        idempotencyKey = "$runId:user",
    )
    optimisticMessagesByRunId[runId] = optimisticMessage
    unresolvedRepliesByRunId[runId] = optimisticMessage
    _messages.value = _messages.value + optimisticMessage

    armPendingRunTimeout(runId)
    synchronized(pendingRuns) {
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }

    updateErrorText(null)
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
      val res = requestGateway("chat.send", params.toString())
      val ack = parseChatSendAck(json, res)
      val actualRunId = ack.runId ?: runId
      if (actualRunId != runId) {
        transferRunOwnership(runId, actualRunId, optimisticMessage)
      }
      if (ack.isTerminal) {
        clearPendingRun(actualRunId)
        removeOptimisticMessage(actualRunId)
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        if (ack.isTerminalSuccess) {
          unresolvedRepliesByRunId.remove(actualRunId)
          refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(actualRunId))
          true
        } else {
          // Terminal timeout/error means the gateway did not accept a runnable turn.
          // Surface failed acceptance instead of letting a cleared composer look successful.
          unresolvedRepliesByRunId.remove(actualRunId)
          updateErrorText("Chat failed before the run started; try again.")
          false
        }
      } else {
        true
      }
    } catch (err: CancellationException) {
      throw err
    } catch (err: GatewayRequestDefinitiveFailure) {
      clearPendingRun(runId)
      removeOptimisticMessage(runId)
      unresolvedRepliesByRunId.remove(runId)
      updateErrorText(err.message)
      false
    } catch (_: GatewayRequestOutcomeUnknown) {
      // A transport failure cannot distinguish rejection from an accepted send whose
      // ACK was lost. Keep the idempotency-key-backed row to prevent a duplicate retry.
      unknownOutcomeRunIds.add(runId)
      if (_healthOk.value) {
        refreshCurrentHistoryBestEffort(runIdsToReconcile = setOf(runId))
      }
      true
    } catch (err: Throwable) {
      clearPendingRun(runId)
      removeOptimisticMessage(runId)
      unresolvedRepliesByRunId.remove(runId)
      updateErrorText(err.message)
      false
    }
  }

  /** Sends best-effort abort requests for every currently pending gateway run. */
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
          requestGateway("chat.abort", params.toString())
        } catch (_: Throwable) {
          // best-effort
        }
      }
    }
  }

  fun handleGatewayEvent(
    event: String,
    payloadJson: String?,
  ) {
    when (event) {
      "tick" -> {
        if (restoreRunStateOnReconnect) {
          refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
        } else {
          scope.launch { pollHealthIfNeeded(force = false) }
        }
      }
      "health" -> {
        if (restoreRunStateOnReconnect) {
          refreshHistoryForRecovery(forceHealth = true, completesReconnectRecovery = true)
        } else {
          markHealthOk()
          refreshCommandsAfterReconnect()
        }
      }
      "seqGap" -> {
        // Missed events may include deltas or the terminal state of a pending run;
        // retain local ownership until the recovery snapshot can reconcile it.
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        refreshHistoryForRecovery()
      }
      "chat" -> {
        if (payloadJson.isNullOrBlank()) return
        handleChatEvent(payloadJson)
      }
      "sessions.changed" -> {
        if (payloadJson.isNullOrBlank()) {
          refreshSessionsForCurrentWindow()
        } else {
          handleSessionsChangedEvent(payloadJson)
        }
      }
      "session.message" -> {
        if (payloadJson.isNullOrBlank()) return
        handleSessionMessageEvent(payloadJson)
      }
      "agent" -> {
        if (payloadJson.isNullOrBlank()) return
        handleAgentEvent(payloadJson)
      }
    }
  }

  /**
   * Reconnect/seq-gap recovery: refetch history for the current session without the
   * beginHistoryLoad transient-state reset. Runs pending when the request begins stay
   * owned until that authoritative snapshot resolves them; resetting healthOk here
   * would block sends after reconnect.
   */
  private fun refreshHistoryForRecovery(
    forceHealth: Boolean = false,
    completesReconnectRecovery: Boolean = false,
  ) {
    val key = normalizeRequestedSessionKey(_sessionKey.value)
    val generation = historyLoadGeneration.incrementAndGet()
    if (completesReconnectRecovery) {
      synchronized(gatewayScopeApplyLock) {
        reconnectRecoveryGeneration = generation
      }
    }
    val restoredRunIds =
      synchronized(pendingRuns) {
        val restored = disconnectedPendingRunIds.toSet()
        pendingRuns.addAll(restored)
        disconnectedPendingRunIds.clear()
        _pendingRunCount.value = pendingRuns.size
        restored
      }
    restoredRunIds.forEach(::armPendingRunTimeout)
    val runIdsToReconcile =
      synchronized(pendingRuns) {
        pendingRuns + optimisticMessagesByRunId.keys + unresolvedRepliesByRunId.keys
      }
    _sessionKey.value = key
    _historyLoading.value = true
    scope.launch {
      bootstrap(
        sessionKey = key,
        generation = generation,
        forceHealth = forceHealth,
        refreshSessions = true,
        runIdsToReconcile = runIdsToReconcile,
      )
    }
  }

  private suspend fun bootstrap(
    sessionKey: String,
    generation: Long,
    forceHealth: Boolean,
    refreshSessions: Boolean,
    runIdsToReconcile: Set<String> = emptySet(),
  ) {
    val ownsReconnectRecovery =
      synchronized(gatewayScopeApplyLock) {
        reconnectRecoveryGeneration == generation
      }
    // Cache-first cold open: prime before the live request so ordering is deterministic and the
    // live chat.history response always replaces cached rows wholesale.
    primeFromCache(sessionKey, generation)
    try {
      val historyApplied =
        fetchAndApplyHistory(
          sessionKey,
          generation,
          updateSessionInfo = true,
          runIdsToReconcile = runIdsToReconcile,
        )
      if (!historyApplied) return

      if (!ownsReconnectRecovery) {
        pollHealthIfNeeded(force = forceHealth)
      }
      if (refreshSessions) {
        fetchSessions(limit = 50)
      }
    } catch (err: Throwable) {
      if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return
      updateErrorText(err.message, historyGeneration = generation)
      _historyLoading.value = false
    } finally {
      if (isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) {
        scheduleRecoveryHistoryReconciliation(
          sessionKey = sessionKey,
          generation = generation,
          runIds = runIdsToReconcile,
        )
      }
    }
  }

  /**
   * Requests live history and applies it to controller state, replacing any cached transcript.
   * Returns false when a newer load superseded this request (stale responses are dropped).
   */
  private suspend fun fetchAndApplyHistory(
    sessionKey: String,
    generation: Long,
    updateSessionInfo: Boolean,
    runIdsToReconcile: Set<String> = emptySet(),
  ): Boolean {
    val requestSequence = historyRequestSequence.incrementAndGet()
    val requestCacheScope = currentCacheScope()
    val history =
      try {
        val historyJson =
          requestGateway(
            "chat.history",
            buildJsonObject { put("sessionKey", JsonPrimitive(sessionKey)) }.toString(),
          )
        parseHistory(historyJson, sessionKey = sessionKey, previousMessages = _messages.value)
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        val superseded =
          synchronized(gatewayScopeApplyLock) {
            !isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) ||
              requestCacheScope != currentCacheScope() ||
              requestSequence < latestAppliedHistoryRequest
          }
        if (superseded) return false
        throw err
      }
    val applied =
      synchronized(gatewayScopeApplyLock) {
        if (
          !isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) ||
          requestCacheScope != currentCacheScope() ||
          requestSequence < latestAppliedHistoryRequest
        ) {
          return@synchronized false
        }
        latestAppliedHistoryRequest = requestSequence
        if (updateSessionInfo) {
          updateSessionFromHistory(history)
        }
        transferLostAckOwnershipFromHistory(history)
        resolvePersistedReplies(history.messages)
        val snapshotRunId = history.inFlightRun?.runId?.trim()?.takeIf { it.isNotEmpty() }
        latestAppliedInFlightRunId = snapshotRunId
        val optimisticRunIds = runIdsToReconcile.filterTo(mutableSetOf()) { optimisticMessagesByRunId.containsKey(it) }
        prunePersistedOptimisticMessages(history.messages)
        if (snapshotRunId == null) {
          optimisticRunIds
            .filterNot { runId ->
              unknownOutcomeRunIds.contains(runId) && unresolvedRepliesByRunId.containsKey(runId)
            }
            .filterNotTo(mutableSetOf()) { optimisticMessagesByRunId.containsKey(it) }
            .forEach(::clearPendingRun)
        }
        if (snapshotRunId != null) {
          runIdsToReconcile
            .filterTo(mutableSetOf()) {
              it != snapshotRunId &&
                !optimisticMessagesByRunId.containsKey(it) &&
                !unresolvedRepliesByRunId.containsKey(it)
            }
            .forEach(::clearPendingRun)
        }
        _messagesFromCache.value = false
        _messages.value = mergeOptimisticMessages(incoming = history.messages, optimistic = optimisticMessagesByRunId.values)
        _sessionId.value = history.sessionId
        _historyLoading.value = false
        if (historyLoadErrorGeneration == generation) {
          updateErrorText(null)
        }
        if (history.inFlightRun == null) {
          // Empty history is terminal proof for acknowledged runs. An unknown-outcome
          // send stays owned until its reply persists, a terminal arrives, or it expires.
          runIdsToReconcile
            .filterNot { runId ->
              unknownOutcomeRunIds.contains(runId) && unresolvedRepliesByRunId.containsKey(runId)
            }
            .forEach(::clearPendingRun)
        }
        clearTransientRunUiIfIdle()
        // All live history paths (bootstrap, reconnect recovery, cache-first
        // replace) adopt the gateway's in-flight run snapshot so restored
        // runs keep their pending state and streaming text.
        adoptInFlightRun(history.inFlightRun)
        history.thinkingLevel
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
          ?.let { _thinkingLevel.value = it }
        true
      }
    if (!applied) return false
    completeReconnectRecoveryIfOwned(sessionKey, generation)
    persistTranscript(requestCacheScope, sessionKey, history.messages)
    return true
  }

  /** Lets whichever same-generation history request wins finish reconnect health recovery. */
  private suspend fun completeReconnectRecoveryIfOwned(
    sessionKey: String,
    generation: Long,
  ) {
    val ownsRecovery =
      synchronized(gatewayScopeApplyLock) {
        reconnectRecoveryGeneration == generation &&
          isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())
      }
    if (!ownsRecovery) return
    pollHealthIfNeeded(force = true)
    synchronized(gatewayScopeApplyLock) {
      if (
        reconnectRecoveryGeneration == generation &&
        isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get()) &&
        _healthOk.value
      ) {
        reconnectRecoveryGeneration = null
        restoreRunStateOnReconnect = false
      }
    }
  }

  /** Emits cached transcript/session rows for instant cold open; live data replaces them wholesale. */
  private suspend fun primeFromCache(
    sessionKey: String,
    generation: Long,
  ) {
    val cache = transcriptCache ?: return
    val requestCacheScope = currentCacheScope() ?: return
    if (_messages.value.isEmpty()) {
      val cached = runCatching { cache.loadTranscript(requestCacheScope.gatewayId, sessionKey) }.getOrDefault(emptyList())
      synchronized(gatewayScopeApplyLock) {
        if (
          cached.isNotEmpty() &&
          _messages.value.isEmpty() &&
          requestCacheScope == currentCacheScope() &&
          isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())
        ) {
          _messagesFromCache.value = true
          _messages.value = cached
        }
      }
    }
    if (_sessions.value.isEmpty()) {
      val cachedSessions = runCatching { cache.loadSessions(requestCacheScope.gatewayId) }.getOrDefault(emptyList())
      synchronized(gatewayScopeApplyLock) {
        if (cachedSessions.isNotEmpty() && _sessions.value.isEmpty() && requestCacheScope == currentCacheScope()) {
          _sessions.value = cachedSessions
        }
      }
    }
  }

  // Write-through uses the scope captured before the live request. Re-resolving here could put
  // an old response under a newly selected gateway. Failures are ignored: the cache is disposable.
  private suspend fun persistTranscript(
    requestCacheScope: ChatCacheScope?,
    sessionKey: String,
    messages: List<ChatMessage>,
  ) {
    val cache = transcriptCache ?: return
    val capturedScope = requestCacheScope ?: return
    cacheMutationMutex.withLock {
      if (capturedScope != currentCacheScope()) return@withLock
      runCatching { cache.saveTranscript(capturedScope.gatewayId, sessionKey, messages) }
    }
  }

  private suspend fun persistSessions(
    requestCacheScope: ChatCacheScope?,
    sessions: List<ChatSessionEntry>,
    retainedSessionKey: String?,
  ) {
    val cache = transcriptCache ?: return
    val capturedScope = requestCacheScope ?: return
    cacheMutationMutex.withLock {
      if (capturedScope != currentCacheScope()) return@withLock
      runCatching { cache.saveSessions(capturedScope.gatewayId, sessions, retainedSessionKey) }
    }
  }

  private suspend fun fetchSessions(limit: Int?) {
    try {
      val requestCacheScope = currentCacheScope()
      val params =
        buildJsonObject {
          put("includeGlobal", JsonPrimitive(true))
          put("includeUnknown", JsonPrimitive(false))
          if (limit != null && limit > 0) put("limit", JsonPrimitive(limit))
        }
      val res = requestGateway("sessions.list", params.toString())
      val result = parseSessions(res)
      val retainedSessionKey =
        synchronized(gatewayScopeApplyLock) {
          if (requestCacheScope != currentCacheScope()) return
          _sessions.value = result.sessions
          val activeSessionKey = _sessionKey.value
          val activeOutsideLocalWindow =
            result.sessions
              .drop(MAX_CACHED_SESSIONS)
              .any { session -> session.key == activeSessionKey }
          activeSessionKey.takeIf { result.isTruncated || activeOutsideLocalWindow }
        }
      persistSessions(requestCacheScope, result.sessions, retainedSessionKey)
    } catch (_: Throwable) {
      // best-effort
    }
  }

  private suspend fun fetchCommands() {
    val agentId = resolveAgentIdForSessionKey(_sessionKey.value)
    try {
      val params =
        buildJsonObject {
          put("agentId", JsonPrimitive(agentId))
          put("scope", JsonPrimitive("text"))
          put("includeArgs", JsonPrimitive(true))
        }
      val res = requestGateway("commands.list", params.toString())
      if (agentId == resolveAgentIdForSessionKey(_sessionKey.value)) {
        _commands.value = parseChatCommands(json, res)
        commandsAgentId = agentId
      }
    } catch (_: Throwable) {
      if (agentId == resolveAgentIdForSessionKey(_sessionKey.value)) {
        _commands.value = emptyList()
        commandsAgentId = null
      }
    }
  }

  private fun refreshSessionsForCurrentWindow() {
    scope.launch { fetchSessions(limit = _sessions.value.size.takeIf { it > 0 } ?: 100) }
  }

  private suspend fun pollHealthIfNeeded(force: Boolean) {
    val now = System.currentTimeMillis()
    val last = lastHealthPollAtMs
    if (!force && last != null && now - last < 10_000) return
    lastHealthPollAtMs = now
    try {
      requestGateway("health", null)
      markHealthOk()
      if (_commands.value.isEmpty() || commandsAgentId != resolveAgentIdForSessionKey(_sessionKey.value)) {
        fetchCommands()
      }
    } catch (_: Throwable) {
      _healthOk.value = false
    }
  }

  // Gateway-health transition is the single reconnect trigger for the outbox flush; it avoids a
  // second reachability source (ConnectivityManager) that could disagree with gateway state.
  private fun markHealthOk() {
    val wasOk = _healthOk.value
    _healthOk.value = true
    if (!wasOk && commandOutbox != null) {
      scope.launch { flushOutbox() }
    }
  }

  private fun refreshCommandsAfterReconnect() {
    if (_commands.value.isNotEmpty() && commandsAgentId == resolveAgentIdForSessionKey(_sessionKey.value)) return
    scope.launch { fetchCommands() }
  }

  private suspend fun enqueueOfflineCommand(
    text: String,
    thinkingLevel: String,
  ): Boolean {
    val outbox = commandOutbox ?: return false
    val outboxScope =
      currentCacheScope() ?: run {
        updateErrorText("Gateway health not OK; cannot send")
        return false
      }
    val result =
      try {
        outbox.enqueue(
          gatewayId = outboxScope.gatewayId,
          sessionKey = _sessionKey.value,
          text = text,
          thinkingLevel = thinkingLevel,
          nowMs = System.currentTimeMillis(),
        )
      } catch (_: Throwable) {
        updateErrorText("Could not queue message for later delivery.")
        return false
      }
    return when (result) {
      is ChatOutboxEnqueueResult.Queued -> {
        updateErrorText(null)
        publishOutbox()
        true
      }
      ChatOutboxEnqueueResult.QueueFull -> {
        updateErrorText("Offline queue is full ($OUTBOX_MAX_QUEUED messages); delete queued items first.")
        false
      }
      ChatOutboxEnqueueResult.Unavailable -> {
        updateErrorText("Gateway health not OK; cannot send")
        false
      }
    }
  }

  /** Re-queues a failed outbox item and flushes immediately when the gateway is healthy. */
  fun retryOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      val outboxScope = currentCacheScope() ?: return@launch
      // requeueForRetry (not a plain status flip) refreshes createdAt so retrying an expired
      // row does not get re-expired by the flush sweep before it can send.
      runCatching { outbox.requeueForRetry(gatewayId = outboxScope.gatewayId, id = id, nowMs = System.currentTimeMillis()) }
      publishOutbox()
      if (_healthOk.value) flushOutbox()
    }
  }

  fun deleteOutboxCommand(id: String) {
    val outbox = commandOutbox ?: return
    scope.launch {
      runCatching { outbox.delete(id) }
      publishOutbox()
    }
  }

  private suspend fun publishOutbox() {
    val outbox = commandOutbox ?: return
    val outboxScope = currentCacheScope()
    if (outboxScope == null) {
      _outboxItems.value = emptyList()
      return
    }
    val items = runCatching { outbox.load(outboxScope.gatewayId) }.getOrDefault(emptyList())
    // Publish under the scope lock so rows loaded for an old gateway cannot land after a switch.
    synchronized(gatewayScopeApplyLock) {
      if (outboxScope == currentCacheScope()) {
        _outboxItems.value = items
      }
    }
  }

  /**
   * Sends queued outbox rows strictly createdAt-ordered. Single-flight: health events can fire
   * repeatedly while a flush is already draining the queue.
   */
  private suspend fun flushOutbox() {
    val outbox = commandOutbox ?: return
    if (!outboxFlushInFlight.compareAndSet(false, true)) return
    var flushedAny = false
    try {
      // The whole flush is bound to one gateway scope; a connection switch mid-flush stops it
      // and the next health transition flushes under the new scope.
      val flushScope = currentCacheScope() ?: return
      runCatching { outbox.expireStale(flushScope.gatewayId, System.currentTimeMillis()) }
      publishOutbox()
      while (_healthOk.value && currentCacheScope() == flushScope) {
        val next =
          runCatching { outbox.load(flushScope.gatewayId) }
            .getOrDefault(emptyList())
            .firstOrNull { it.status == ChatOutboxStatus.Queued } ?: break
        when (sendOutboxItem(outbox, next, flushScope)) {
          OutboxSendOutcome.Sent -> flushedAny = true
          OutboxSendOutcome.Failed, OutboxSendOutcome.Skipped -> {}
          OutboxSendOutcome.Stop -> break
        }
      }
    } finally {
      outboxFlushInFlight.set(false)
      publishOutbox()
      if (flushedAny) {
        // Durable history replaces the queued bubbles; reconciliation matches by idempotency key.
        refreshCurrentHistoryBestEffort()
      }
    }
  }

  // Sent: acked and removed. Failed: parked as failed. Skipped: row vanished (user delete).
  // Stop: flush must halt (offline or gateway scope changed); the row stays queued.
  private enum class OutboxSendOutcome { Sent, Failed, Skipped, Stop }

  private sealed interface OutboxSendResult {
    data object Accepted : OutboxSendResult

    /** Gateway responded with a terminal failure ack; the message reached it but was rejected. */
    data class Rejected(
      val error: String,
    ) : OutboxSendResult

    /** Request never got an ack (socket drop, timeout); delivery state is unknown. */
    data class TransportFailure(
      val error: String,
    ) : OutboxSendResult
  }

  private suspend fun sendOutboxItem(
    outbox: ChatCommandOutbox,
    item: ChatOutboxItem,
    flushScope: ChatCacheScope,
  ): OutboxSendOutcome {
    // Claim the row before sending: 0 updated rows means it was deleted since the load, and a
    // deleted command must never be sent. Skipped (like Failed) lets the flush continue.
    val claimed = runCatching { outbox.updateStatus(item.id, ChatOutboxStatus.Sending, item.retryCount, item.lastError) }.getOrDefault(0)
    publishOutbox()
    if (claimed == 0) return OutboxSendOutcome.Skipped
    var attempts = item.retryCount
    while (true) {
      val error =
        when (val result = attemptOutboxSend(item)) {
          OutboxSendResult.Accepted -> {
            // Ack received: delete the row so the flushed history copy is the only bubble left.
            runCatching { outbox.delete(item.id) }
            publishOutbox()
            return OutboxSendOutcome.Sent
          }
          is OutboxSendResult.TransportFailure -> {
            // No ack means the gateway is effectively unreachable even if healthOk has not
            // flipped yet. Keep the row queued without burning attempts and drop health so
            // the next successful health poll/event re-triggers the flush.
            runCatching { outbox.updateStatus(item.id, ChatOutboxStatus.Queued, attempts, result.error) }
            publishOutbox()
            _healthOk.value = false
            return OutboxSendOutcome.Stop
          }
          is OutboxSendResult.Rejected -> result.error
        }
      attempts += 1
      if (attempts >= OUTBOX_MAX_SEND_ATTEMPTS) {
        runCatching { outbox.updateStatus(item.id, ChatOutboxStatus.Failed, attempts, error) }
        publishOutbox()
        return OutboxSendOutcome.Failed
      }
      // The row stays 'sending' through the backoff: Sending rows expose no Delete/Retry
      // actions, so the user cannot delete a row this loop is about to resend.
      runCatching { outbox.updateStatus(item.id, ChatOutboxStatus.Sending, attempts, error) }
      publishOutbox()
      // Losing health or the gateway scope mid-flush means this item must not retry now:
      // requeue it for the next reconnect under the right scope. Without the scope check,
      // a pairing switch during backoff could replay the captured text into the new gateway.
      if (!_healthOk.value || currentCacheScope() != flushScope) {
        return requeueAndStop(outbox, item.id, attempts, error)
      }
      delay(OUTBOX_RETRY_BACKOFF_MS * attempts)
      if (!_healthOk.value || currentCacheScope() != flushScope) {
        return requeueAndStop(outbox, item.id, attempts, error)
      }
      // Re-claim after the delay: a row deleted through any non-UI path must not be resent.
      val reclaimed = runCatching { outbox.updateStatus(item.id, ChatOutboxStatus.Sending, attempts, error) }.getOrDefault(0)
      if (reclaimed == 0) {
        publishOutbox()
        return OutboxSendOutcome.Skipped
      }
    }
  }

  private suspend fun requeueAndStop(
    outbox: ChatCommandOutbox,
    id: String,
    attempts: Int,
    error: String,
  ): OutboxSendOutcome {
    runCatching { outbox.updateStatus(id, ChatOutboxStatus.Queued, attempts, error) }
    publishOutbox()
    return OutboxSendOutcome.Stop
  }

  private suspend fun attemptOutboxSend(item: ChatOutboxItem): OutboxSendResult =
    try {
      val params =
        buildJsonObject {
          // Rows enqueued under the pre-hello "main" alias must flush to the canonical main
          // session the gateway announced, matching how the UI attributes those rows.
          put("sessionKey", JsonPrimitive(normalizeRequestedSessionKey(item.sessionKey)))
          put("message", JsonPrimitive(item.text))
          // Enqueue-time thinking level: a later selector change must not alter queued sends.
          put("thinking", JsonPrimitive(item.thinkingLevel))
          put("timeoutMs", JsonPrimitive(30_000))
          // The row id is the idempotency key, so gateway-side dedupe makes redelivery of an
          // acked-but-crashed item harmless.
          put("idempotencyKey", JsonPrimitive(item.id))
        }
      val ack = parseChatSendAck(json, requestGateway("chat.send", params.toString()))
      if (ack.isTerminalFailure) {
        OutboxSendResult.Rejected("Chat failed before the run started")
      } else {
        OutboxSendResult.Accepted
      }
    } catch (err: CancellationException) {
      // Teardown must not be recorded as a send failure; the row stays 'sending' and the
      // next startup recovery requeues it.
      throw err
    } catch (err: Throwable) {
      OutboxSendResult.TransportFailure(err.message ?: "send failed")
    }

  private fun handleChatEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return

    val runId = payload["runId"].asStringOrNull()
    val isPending =
      if (runId != null) synchronized(pendingRuns) { pendingRuns.contains(runId) } else true
    val isOwned = isPending || (runId != null && unresolvedRepliesByRunId.containsKey(runId))

    val state = payload["state"].asStringOrNull()
    when (state) {
      "delta" -> {
        // Only show streaming text for runs we initiated in this controller.
        if (!isPending) return
        val text = parseAssistantDeltaText(payload)
        if (!text.isNullOrEmpty()) {
          _streamingAssistantText.value = text
        }
      }
      "final", "aborted", "error" -> {
        val terminalHasAssistantMessage =
          state == "final" && payload["message"].asObjectOrNull()?.get("role").asStringOrNull() == "assistant"
        val resolvesWithoutReply = state != "final" || !terminalHasAssistantMessage
        val wasTimedOut = runId != null && timedOutRunIds.remove(runId)
        if (runId != null && runId == lastHandledTerminalRunId) return
        if (runId != null && !isOwned && !wasTimedOut) {
          val hasLocalRun =
            synchronized(pendingRuns) { pendingRuns.isNotEmpty() } || unresolvedRepliesByRunId.isNotEmpty()
          if (!hasLocalRun) {
            // Another client or chat.inject can finish the open session. Refresh
            // idle history without allowing its terminal state to own local UI.
            lastHandledTerminalRunId = runId
            refreshCurrentHistoryBestEffort(updateSessionInfo = true)
          }
          return
        }
        if (runId != null) lastHandledTerminalRunId = runId
        if (wasTimedOut) {
          val hasNewerRun =
            synchronized(pendingRuns) { pendingRuns.isNotEmpty() } || unresolvedRepliesByRunId.isNotEmpty()
          if (!hasNewerRun) {
            pendingToolCallsById.clear()
            publishPendingToolCalls()
            _streamingAssistantText.value = null
            updateErrorText(if (state == "error") payload["errorMessage"].asStringOrNull() ?: "Chat failed" else null)
          }
          refreshCurrentHistoryBestEffort(updateSessionInfo = true)
          return
        }
        if (runId != null && !isPending) {
          if (resolvesWithoutReply) terminalWithoutReplyRunIds.add(runId)
          refreshCurrentHistoryBestEffort(
            runIdsToReconcile = setOf(runId),
            updateSessionInfo = true,
          )
          return
        }
        if (state == "error") {
          updateErrorText(payload["errorMessage"].asStringOrNull() ?: "Chat failed")
        }
        if (runId != null) {
          clearPendingRun(runId)
          if (resolvesWithoutReply) {
            terminalWithoutReplyRunIds.add(runId)
          }
        } else {
          clearPendingRuns(clearOptimisticMessages = false)
        }
        pendingToolCallsById.clear()
        publishPendingToolCalls()
        _streamingAssistantText.value = null
        val terminalRunIds = runId?.let(::setOf) ?: unresolvedRepliesByRunId.keys.toSet()
        refreshCurrentHistoryBestEffort(
          runIdsToReconcile = terminalRunIds,
          updateSessionInfo = true,
        )
      }
    }
  }

  private fun handleSessionsChangedEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    if (payload["reason"].asStringOrNull() == "delete") {
      removeSessionEntry(payload["sessionKey"].asStringOrNull() ?: payload["key"].asStringOrNull())
      return
    }
    val entry = parseEventSessionEntry(payload)
    if (entry != null) {
      upsertSessionEntry(entry)
    } else {
      refreshSessionsForCurrentWindow()
    }
  }

  private fun handleSessionMessageEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val entry = parseEventSessionEntry(payload)
    if (entry != null) {
      upsertSessionEntry(entry)
    }
  }

  private fun parseEventSessionEntry(payload: JsonObject): ChatSessionEntry? = payload["session"].asObjectOrNull()?.let(::parseSessionEntry) ?: parseSessionEntry(payload)

  private fun handleAgentEvent(payloadJson: String) {
    val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
    val sessionKey = payload["sessionKey"].asStringOrNull()?.trim()
    if (!sessionKey.isNullOrEmpty() && sessionKey != _sessionKey.value) return
    val runId = payload["runId"].asStringOrNull()
    if (
      runId != null &&
      synchronized(pendingRuns) { runId !in pendingRuns } &&
      !unresolvedRepliesByRunId.containsKey(runId)
    ) {
      return
    }

    val stream = payload["stream"].asStringOrNull()
    val data = payload["data"].asObjectOrNull()

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

        val ts = payload["ts"].asLongOrNull() ?: System.currentTimeMillis()
        if (phase == "start") {
          val args = data.get("args").asObjectOrNull()
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
      "error" -> {
        updateErrorText("Event stream interrupted; try refreshing.")
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
    _pendingToolCalls.value =
      pendingToolCallsById.values.sortedBy { it.startedAtMs }
  }

  /**
   * Adopts the run the gateway reports still streaming for this session so reconnect,
   * cold start, and seq-gap recovery restore pending/streaming UI state. Snapshot absence
   * never clears local state: live terminal events and the pending-run timeout own
   * completion, and a snapshot fetched before our own send must not cancel that run.
   */
  private fun adoptInFlightRun(run: ChatInFlightRun?) {
    if (run == null) return
    val runId = run.runId.trim()
    if (runId.isEmpty()) return
    synchronized(pendingRuns) {
      // A different locally-owned run means this snapshot predates it; ignore.
      if (pendingRuns.isNotEmpty() && runId !in pendingRuns) return
      if (pendingRuns.isEmpty() && unresolvedRepliesByRunId.isNotEmpty() && !unresolvedRepliesByRunId.containsKey(runId)) return
      pendingRuns.add(runId)
      _pendingRunCount.value = pendingRuns.size
    }
    armPendingRunTimeout(runId)
    if (run.text.isNotEmpty()) {
      _streamingAssistantText.value = run.text
    }
  }

  private fun armPendingRunTimeout(runId: String) {
    pendingRunTimeoutJobs[runId]?.cancel()
    pendingRunTimeoutJobs[runId] =
      scope.launch {
        delay(pendingRunTimeoutMs)
        refreshHistorySnapshotBestEffort(
          sessionKey = _sessionKey.value,
          generation = historyLoadGeneration.get(),
          runIdsToReconcile = emptySet(),
        )
        val runStillInFlight = synchronized(gatewayScopeApplyLock) { latestAppliedInFlightRunId == runId }
        val replyStillUnresolved = unresolvedRepliesByRunId.containsKey(runId)
        if (!runStillInFlight) {
          clearPendingRun(runId)
          clearTransientRunUiIfIdle()
          if (!replyStillUnresolved) return@launch
        }
        val stillPending =
          synchronized(pendingRuns) {
            pendingRuns.contains(runId)
          }
        if (!stillPending && !replyStillUnresolved) return@launch
        clearPendingRun(runId)
        clearTransientRunUiIfIdle()
        removeOptimisticMessage(runId)
        unresolvedRepliesByRunId.remove(runId)
        terminalWithoutReplyRunIds.remove(runId)
        timedOutRunIds.add(runId)
        updateErrorText("Timed out waiting for a reply; try again or refresh.")
      }
  }

  private fun clearPendingRun(runId: String) {
    pendingRunTimeoutJobs.remove(runId)?.cancel()
    unknownOutcomeRunIds.remove(runId)
    synchronized(pendingRuns) {
      disconnectedPendingRunIds.remove(runId)
      pendingRuns.remove(runId)
      _pendingRunCount.value = pendingRuns.size
    }
  }

  private fun clearTransientRunUiIfIdle() {
    if (synchronized(pendingRuns) { pendingRuns.isNotEmpty() }) return
    pendingToolCallsById.clear()
    publishPendingToolCalls()
    _streamingAssistantText.value = null
  }

  private fun clearPendingRuns(
    clearOptimisticMessages: Boolean = true,
    preserveDisconnectedOwnership: Boolean = false,
  ) {
    for ((_, job) in pendingRunTimeoutJobs) {
      job.cancel()
    }
    pendingRunTimeoutJobs.clear()
    if (clearOptimisticMessages) {
      recoveryHistoryReconciliationJob?.cancel()
      recoveryHistoryReconciliationGeneration = -1L
      recoveryHistoryReconciliationJob = null
      optimisticMessagesByRunId.clear()
      unresolvedRepliesByRunId.clear()
      timedOutRunIds.clear()
      terminalWithoutReplyRunIds.clear()
      unknownOutcomeRunIds.clear()
    }
    synchronized(pendingRuns) {
      if (!preserveDisconnectedOwnership) {
        disconnectedPendingRunIds.clear()
      }
      pendingRuns.clear()
      _pendingRunCount.value = 0
    }
  }

  private fun removeOptimisticMessage(runId: String) {
    val message = optimisticMessagesByRunId.remove(runId) ?: return
    _messages.value = _messages.value.filterNot { it.id == message.id }
  }

  private fun transferRunOwnership(
    oldRunId: String,
    newRunId: String,
    fallbackMessage: ChatMessage,
    messageIdempotencyKey: String? = fallbackMessage.idempotencyKey,
  ) {
    if (oldRunId == newRunId) return
    val optimistic = optimisticMessagesByRunId.remove(oldRunId)
    val unresolved = unresolvedRepliesByRunId.remove(oldRunId)
    val terminalWithoutReply = terminalWithoutReplyRunIds.remove(oldRunId)
    unknownOutcomeRunIds.remove(oldRunId)
    val original = optimistic ?: unresolved ?: fallbackMessage
    // Run ownership can change independently of the client key persisted on the
    // user row. Only history proof may replace that transcript identity.
    val rekeyed = original.copy(idempotencyKey = messageIdempotencyKey)
    if (optimistic != null) optimisticMessagesByRunId[newRunId] = rekeyed
    if (unresolved != null) unresolvedRepliesByRunId[newRunId] = rekeyed
    if (terminalWithoutReply) terminalWithoutReplyRunIds.add(newRunId)
    _messages.value = _messages.value.map { if (it.id == original.id) rekeyed else it }
    clearPendingRun(oldRunId)
    synchronized(pendingRuns) {
      pendingRuns.add(newRunId)
      _pendingRunCount.value = pendingRuns.size
    }
    armPendingRunTimeout(newRunId)
  }

  private fun transferLostAckOwnershipFromHistory(history: ChatHistory) {
    val snapshotRunId = history.inFlightRun?.runId?.trim()?.takeIf { it.isNotEmpty() } ?: return
    if (unresolvedRepliesByRunId.containsKey(snapshotRunId)) return
    val localRunId =
      synchronized(pendingRuns) {
        (pendingRuns + disconnectedPendingRunIds).singleOrNull()
      } ?: return
    if (!unknownOutcomeRunIds.contains(localRunId)) return
    val optimistic = unresolvedRepliesByRunId[localRunId] ?: return
    val canonicalUserKey = "$snapshotRunId:user"
    val optimisticUserKey = optimistic.idempotencyKey?.trim()
    val optimisticContentKey = messageContentIdentityKey(optimistic)
    val persistedUser =
      history.messages.firstOrNull { message ->
        val persistedUserKey = message.idempotencyKey?.trim()
        (persistedUserKey == optimisticUserKey || persistedUserKey == canonicalUserKey) &&
          messageContentIdentityKey(message) == optimisticContentKey
      }
    if (persistedUser != null) {
      transferRunOwnership(
        oldRunId = localRunId,
        newRunId = snapshotRunId,
        fallbackMessage = optimistic,
        messageIdempotencyKey = persistedUser.idempotencyKey,
      )
    }
  }

  private fun prunePersistedOptimisticMessages(incoming: List<ChatMessage>) {
    val retained =
      retainUnmatchedOptimisticMessages(
        incoming = incoming,
        optimistic = optimisticMessagesByRunId.values,
      ).toSet()
    optimisticMessagesByRunId.entries.removeAll { entry -> entry.value !in retained }
  }

  private fun resolvePersistedReplies(incoming: List<ChatMessage>) {
    val resolvedRunIds =
      unresolvedRepliesByRunId
        .filter { (runId, optimistic) ->
          val userIndex = incoming.indexOfFirst { message -> incomingMessageConsumesOptimistic(message, optimistic) }
          if (userIndex < 0) return@filter false
          terminalWithoutReplyRunIds.contains(runId) ||
            incoming
              .drop(userIndex + 1)
              .takeWhile { it.role.trim().lowercase() != "user" }
              .any { it.role.trim().lowercase() == "assistant" }
        }.keys
        .toList()
    resolvedRunIds.forEach(unresolvedRepliesByRunId::remove)
    resolvedRunIds.forEach(terminalWithoutReplyRunIds::remove)
  }

  private fun scheduleRecoveryHistoryReconciliation(
    sessionKey: String,
    generation: Long,
    runIds: Set<String>,
  ) {
    val reconciliationRunIds = runIds + unresolvedRepliesByRunId.keys
    if (reconciliationRunIds.isEmpty()) return
    val hasPendingRun = synchronized(pendingRuns) { reconciliationRunIds.any { it in pendingRuns } }
    if (!hasPendingRun && reconciliationRunIds.none(unresolvedRepliesByRunId::containsKey)) return
    if (generation < recoveryHistoryReconciliationGeneration) return
    recoveryHistoryReconciliationJob?.cancel()
    recoveryHistoryReconciliationGeneration = generation
    recoveryHistoryReconciliationJob =
      scope.launch {
        delay(recoveryHistoryRetryDelayMs)
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return@launch
        if (!_healthOk.value) return@launch
        refreshHistorySnapshotBestEffort(sessionKey, generation, reconciliationRunIds)
        if (synchronized(pendingRuns) { reconciliationRunIds.any { it in pendingRuns } }) return@launch
        if (reconciliationRunIds.none(unresolvedRepliesByRunId::containsKey)) return@launch

        // A persisted user row is not terminal proof: the assistant row can lag
        // behind it even after the run disappears from the history snapshot.
        delay(pendingRunTimeoutMs - recoveryHistoryRetryDelayMs)
        if (!isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) return@launch
        if (!_healthOk.value) return@launch
        refreshHistorySnapshotBestEffort(sessionKey, generation, reconciliationRunIds)
        if (synchronized(pendingRuns) { reconciliationRunIds.any { it in pendingRuns } }) return@launch
        val unresolvedRunIds = reconciliationRunIds.filter(unresolvedRepliesByRunId::containsKey)
        if (unresolvedRunIds.isEmpty()) return@launch
        unresolvedRunIds.forEach(::removeOptimisticMessage)
        unresolvedRunIds.forEach(unresolvedRepliesByRunId::remove)
        unresolvedRunIds.forEach(terminalWithoutReplyRunIds::remove)
        updateErrorText("Timed out confirming the sent message; refresh to check delivery.")
      }
  }

  private suspend fun refreshHistorySnapshotBestEffort(
    sessionKey: String,
    generation: Long,
    runIdsToReconcile: Set<String>,
  ) {
    try {
      fetchAndApplyHistory(
        sessionKey,
        generation,
        updateSessionInfo = true,
        runIdsToReconcile = runIdsToReconcile,
      )
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      // The bounded expiry below remains the final reconciliation path.
    }
  }

  private fun refreshCurrentHistoryBestEffort(
    runIdsToReconcile: Set<String> = emptySet(),
    updateSessionInfo: Boolean = false,
  ) {
    val sessionKey = _sessionKey.value
    val generation = historyLoadGeneration.get()
    scope.launch {
      try {
        fetchAndApplyHistory(
          sessionKey = sessionKey,
          generation = generation,
          updateSessionInfo = updateSessionInfo,
          runIdsToReconcile = runIdsToReconcile,
        )
      } catch (_: Throwable) {
        // best-effort
      } finally {
        if (isCurrentHistoryLoad(sessionKey, _sessionKey.value, generation, historyLoadGeneration.get())) {
          scheduleRecoveryHistoryReconciliation(sessionKey, generation, runIdsToReconcile)
        }
      }
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
    val sessionInfo = root["sessionInfo"].asObjectOrNull()?.let { parseSessionEntry(it, fallbackKey = sessionKey) }
    val array = root["messages"].asArrayOrNull() ?: JsonArray(emptyList())

    val messages =
      array.mapNotNull { item ->
        val obj = item.asObjectOrNull() ?: return@mapNotNull null
        val role = obj["role"].asStringOrNull() ?: return@mapNotNull null
        val content = parseChatMessageContents(obj)
        val ts = obj["timestamp"].asLongOrNull()
        ChatMessage(
          id = UUID.randomUUID().toString(),
          role = role,
          content = content,
          timestampMs = ts,
          idempotencyKey = obj["idempotencyKey"].asStringOrNull(),
        )
      }

    return ChatHistory(
      sessionKey = sessionKey,
      sessionId = sid,
      thinkingLevel = thinkingLevel,
      messages = reconcileMessageIds(previous = previousMessages, incoming = messages),
      sessionInfo = sessionInfo,
      inFlightRun = parseInFlightRun(root),
    )
  }

  private fun parseInFlightRun(root: JsonObject): ChatInFlightRun? {
    val obj = root["inFlightRun"].asObjectOrNull() ?: return null
    val runId = obj["runId"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return ChatInFlightRun(runId = runId, text = obj["text"].asStringOrNull().orEmpty())
  }

  private data class SessionListResult(
    val sessions: List<ChatSessionEntry>,
    val isTruncated: Boolean,
  )

  private fun parseSessions(jsonString: String): SessionListResult {
    val root =
      json.parseToJsonElement(jsonString).asObjectOrNull()
        ?: return SessionListResult(emptyList(), isTruncated = false)
    val sessions =
      root["sessions"]
        .asArrayOrNull()
        ?.mapNotNull { item -> parseSessionEntry(item.asObjectOrNull()) }
        .orEmpty()
    val totalCount = root["totalCount"].asLongOrNull()
    val isTruncated =
      root["hasMore"].asBooleanOrNull() == true ||
        (totalCount != null && totalCount > sessions.size)
    return SessionListResult(sessions, isTruncated)
  }

  private fun parseSessionEntry(
    obj: JsonObject?,
    fallbackKey: String? = null,
  ): ChatSessionEntry? {
    if (obj == null) return null
    val key =
      obj["key"]
        .asStringOrNull()
        ?.trim()
        .orEmpty()
        .ifEmpty {
          obj["sessionKey"]
            .asStringOrNull()
            ?.trim()
            .orEmpty()
        }.ifEmpty { fallbackKey?.trim().orEmpty() }
    if (key.isEmpty()) return null
    return ChatSessionEntry(
      key = key,
      updatedAtMs = obj["updatedAt"].asLongOrNull(),
      displayName = obj["displayName"].asStringOrNull()?.trim(),
      totalTokens = obj["totalTokens"].asLongOrNull(),
      totalTokensFresh = obj["totalTokensFresh"].asBooleanOrNull(),
      contextTokens = obj["contextTokens"].asLongOrNull(),
      hasContextUsageMetadata =
        "totalTokens" in obj ||
          "totalTokensFresh" in obj ||
          "contextTokens" in obj,
    )
  }

  private fun updateSessionFromHistory(history: ChatHistory) {
    val info = history.sessionInfo ?: return
    upsertSessionEntry(info, preserveExistingContextUsageWithoutTotal = true)
  }

  private fun upsertSessionEntry(
    entry: ChatSessionEntry,
    preserveExistingContextUsageWithoutTotal: Boolean = false,
  ) {
    val current = _sessions.value
    val index = current.indexOfFirst { it.key == entry.key }
    _sessions.value =
      if (index >= 0) {
        current.toMutableList().also {
          it[index] =
            mergeChatSessionEntry(
              existing = it[index],
              next = entry,
              preserveExistingContextUsageWithoutTotal = preserveExistingContextUsageWithoutTotal,
            )
        }
      } else {
        listOf(entry) + current
      }
  }

  private fun removeSessionEntry(sessionKey: String?) {
    val key = sessionKey?.trim()?.takeIf { it.isNotEmpty() } ?: return
    _sessions.value = _sessions.value.filterNot { it.key == key }
    // Gateway-side deletes must also purge the offline copy, or the deleted transcript would
    // reappear on the next offline cold open. Queued commands for the session die with it too.
    val requestCacheScope = currentCacheScope() ?: return
    scope.launch {
      cacheMutationMutex.withLock {
        if (requestCacheScope != currentCacheScope()) return@withLock
        transcriptCache?.let { runCatching { it.deleteSession(requestCacheScope.gatewayId, key) } }
        commandOutbox?.let { runCatching { it.deleteForSession(requestCacheScope.gatewayId, key) } }
      }
      publishOutbox()
    }
  }

  private fun currentCacheScope(): ChatCacheScope? {
    val scope = cacheScope() ?: return null
    val gatewayId = scope.gatewayId.trim().takeIf { it.isNotEmpty() } ?: return null
    return if (gatewayId == scope.gatewayId) scope else scope.copy(gatewayId = gatewayId)
  }

  private fun normalizeThinking(raw: String): String =
    when (raw.trim().lowercase()) {
      "low" -> "low"
      "medium" -> "medium"
      "high" -> "high"
      else -> "off"
    }
}

private const val NEW_CHAT_SESSION_LABEL = "New chat"

internal fun nextNewChatSessionLabel(sessions: List<ChatSessionEntry>): String {
  val baseLabel = NEW_CHAT_SESSION_LABEL
  val existingLabels =
    sessions
      .mapNotNull { session -> session.displayName?.trim()?.takeIf { it.isNotEmpty() } }
      .toSet()
  if (baseLabel !in existingLabels) return baseLabel

  var suffix = 2
  while (newChatSessionLabelWithSuffix(suffix) in existingLabels) {
    suffix += 1
  }
  return newChatSessionLabelWithSuffix(suffix)
}

private fun newChatSessionLabelWithSuffix(suffix: Int): String = NEW_CHAT_SESSION_LABEL + ' ' + suffix

internal fun isCurrentHistoryLoad(
  requestedSessionKey: String,
  currentSessionKey: String,
  requestGeneration: Long,
  activeGeneration: Long,
): Boolean = requestedSessionKey == currentSessionKey && requestGeneration == activeGeneration

/**
 * Convert gateway chat content parts into Android UI content parts.
 */
internal fun parseChatMessageContent(el: JsonElement): ChatMessageContent? {
  val obj = el.asObjectOrNull() ?: return null
  return when (obj["type"].asStringOrNull() ?: "text") {
    "text", "input_text", "output_text" ->
      ChatMessageContent(
        type = "text",
        text = obj["text"].asStringOrNull() ?: obj["content"].asStringOrNull(),
      )

    "image" ->
      ChatMessageContent(
        type = "image",
        mimeType = obj["mimeType"].asStringOrNull(),
        fileName = obj["fileName"].asStringOrNull(),
        base64 = obj["content"].asStringOrNull()?.takeIf { it.isNotBlank() },
      )

    else -> null
  }
}

internal fun parseChatMessageContents(obj: JsonObject): List<ChatMessageContent> {
  obj["content"].asArrayOrNull()?.let { content ->
    return content.mapNotNull(::parseChatMessageContent)
  }
  obj["content"].asStringOrNull()?.let { text ->
    return listOf(ChatMessageContent(type = "text", text = text))
  }
  obj["text"].asStringOrNull()?.let { text ->
    return listOf(ChatMessageContent(type = "text", text = text))
  }
  return emptyList()
}

private fun parseCreatedSessionKey(
  json: Json,
  sessionJson: String,
): String? {
  val root =
    runCatching { json.parseToJsonElement(sessionJson).asObjectOrNull() }.getOrNull()
      ?: return null

  fun clean(value: String?): String? = value?.trim()?.takeIf { it.isNotEmpty() }
  return clean(root["key"].asStringOrNull())
    ?: clean(root["sessionKey"].asStringOrNull())
    ?: root["session"].asObjectOrNull()?.let { session ->
      clean(session["key"].asStringOrNull()) ?: clean(session["sessionKey"].asStringOrNull())
    }
}

internal fun parseChatCommands(
  json: Json,
  commandsJson: String,
): List<ChatCommandEntry> {
  val root = json.parseToJsonElement(commandsJson).asObjectOrNull() ?: return emptyList()
  val commands = root["commands"].asArrayOrNull() ?: return emptyList()
  return commands.mapNotNull { item -> parseChatCommandEntry(item.asObjectOrNull()) }
}

private fun parseChatCommandEntry(obj: JsonObject?): ChatCommandEntry? {
  if (obj == null) return null
  val aliases =
    obj["textAliases"]
      .asArrayOrNull()
      ?.mapNotNull { alias -> alias.asStringOrNull()?.trim()?.takeIf { it.startsWith("/") && it.length > 1 } }
      ?.distinct()
      .orEmpty()
  val name =
    obj["name"]
      .asStringOrNull()
      ?.trim()
      ?.removePrefix("/")
      ?.takeIf { it.isNotEmpty() }
      ?: aliases.firstOrNull()?.removePrefix("/")
      ?: return null
  return ChatCommandEntry(
    name = name,
    description = obj["description"].asStringOrNull()?.trim().orEmpty(),
    category = obj["category"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() },
    textAliases = aliases,
    acceptsArgs = obj["acceptsArgs"].asBooleanOrNull() ?: false,
  )
}

internal data class MainSessionState(
  val currentSessionKey: String,
  val appliedMainSessionKey: String,
)

/**
 * Rewrite only the active "main" alias when the gateway publishes a new canonical main session key.
 */
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

/**
 * Keep Compose item identity stable across history refreshes by matching existing messages to incoming copies.
 */
internal fun reconcileMessageIds(
  previous: List<ChatMessage>,
  incoming: List<ChatMessage>,
): List<ChatMessage> {
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

internal fun mergeOptimisticMessages(
  incoming: List<ChatMessage>,
  optimistic: Collection<ChatMessage>,
): List<ChatMessage> {
  if (optimistic.isEmpty()) return incoming

  val missingOptimistic = retainUnmatchedOptimisticMessages(incoming = incoming, optimistic = optimistic)
  if (missingOptimistic.isEmpty()) return incoming

  return (incoming + missingOptimistic).sortedWith(compareBy<ChatMessage> { it.timestampMs ?: Long.MAX_VALUE }.thenBy { it.id })
}

internal fun retainUnmatchedOptimisticMessages(
  incoming: List<ChatMessage>,
  optimistic: Collection<ChatMessage>,
): List<ChatMessage> {
  if (optimistic.isEmpty()) return emptyList()

  val unmatchedIncoming = incoming.toMutableList()
  return optimistic.filter { message ->
    val matchIndex =
      unmatchedIncoming.indexOfFirst { incomingMessage ->
        incomingMessageConsumesOptimistic(incomingMessage, message)
      }
    if (matchIndex >= 0) {
      unmatchedIncoming.removeAt(matchIndex)
      false
    } else {
      true
    }
  }
}

/**
 * Message identity used only for refresh reconciliation; it avoids exposing gateway ids as UI keys.
 */
internal fun messageIdentityKey(message: ChatMessage): String? {
  val idempotencyKey = message.idempotencyKey?.trim().orEmpty()
  if (idempotencyKey.isNotEmpty()) {
    return listOf(message.role.trim().lowercase(), idempotencyKey).joinToString(separator = "|")
  }
  val contentKey = messageContentIdentityKey(message) ?: return null
  val timestamp = message.timestampMs?.toString().orEmpty()
  if (timestamp.isEmpty() && contentKey.isEmpty()) return null
  return listOf(contentKey, timestamp).joinToString(separator = "|")
}

private fun optimisticMessageIdentityKey(message: ChatMessage): String? = messageContentIdentityKey(message)

private fun incomingMessageConsumesOptimistic(
  incoming: ChatMessage,
  optimistic: ChatMessage,
): Boolean {
  val optimisticIdempotencyKey = optimistic.idempotencyKey?.trim().orEmpty()
  if (optimisticIdempotencyKey.isNotEmpty()) {
    return incoming.idempotencyKey?.trim() == optimisticIdempotencyKey
  }
  if (optimisticMessageIdentityKey(incoming) != optimisticMessageIdentityKey(optimistic)) return false
  val incomingTimestamp = incoming.timestampMs ?: return false
  val optimisticTimestamp = optimistic.timestampMs ?: return true
  return incomingTimestamp >= optimisticTimestamp
}

private fun messageContentIdentityKey(message: ChatMessage): String? {
  val role = message.role.trim().lowercase()
  if (role.isEmpty()) return null

  val contentFingerprint =
    message.content.joinToString(separator = "\u001E") { part ->
      listOf(
        part.type.trim().lowercase(),
        part.text?.trim().orEmpty(),
        part.mimeType
          ?.trim()
          ?.lowercase()
          .orEmpty(),
        part.fileName?.trim().orEmpty(),
        part.base64
          ?.hashCode()
          ?.toString()
          .orEmpty(),
      ).joinToString(separator = "\u001F")
    }

  return listOf(role, contentFingerprint).joinToString(separator = "|")
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

private fun JsonElement?.asBooleanOrNull(): Boolean? =
  when (this) {
    is JsonPrimitive -> content.toBooleanStrictOrNull()
    else -> null
  }

internal fun mergeChatSessionEntry(
  existing: ChatSessionEntry,
  next: ChatSessionEntry,
  preserveExistingContextUsageWithoutTotal: Boolean = false,
): ChatSessionEntry {
  val preserveExistingContextUsage = preserveExistingContextUsageWithoutTotal && next.totalTokens == null
  return existing.copy(
    updatedAtMs = next.updatedAtMs ?: existing.updatedAtMs,
    displayName = next.displayName ?: existing.displayName,
    totalTokens =
      when {
        preserveExistingContextUsage -> existing.totalTokens
        next.hasContextUsageMetadata -> next.totalTokens
        else -> null
      },
    totalTokensFresh =
      when {
        preserveExistingContextUsage -> existing.totalTokensFresh
        next.hasContextUsageMetadata -> next.totalTokensFresh
        else -> null
      },
    contextTokens =
      when {
        preserveExistingContextUsage -> next.contextTokens ?: existing.contextTokens
        next.hasContextUsageMetadata -> next.contextTokens
        else -> null
      },
    hasContextUsageMetadata =
      when {
        preserveExistingContextUsage -> existing.hasContextUsageMetadata || next.contextTokens != null
        else -> next.hasContextUsageMetadata
      },
  )
}
