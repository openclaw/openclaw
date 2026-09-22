package ai.openclaw.wear

import ai.openclaw.wear.shared.WearConnectionFailure
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import java.util.UUID

internal data class WearPendingReply(
  val runId: String,
  val retryable: Boolean = false,
  val terminalAwaitingHistory: WearReplyTerminal? = null,
)

internal data class WearReplyAbort(
  val rpcRunId: String?,
  val replyRunId: String,
  val awaitingAck: Boolean = true,
)

internal enum class WearReplyOutcome {
  Final,
  Aborted,
  Error,

  // Confirmed Watch control completion: finish waiting without speaking transcript text.
  Canceled,
}

internal data class WearReplyHistory(
  val latestAssistantMessage: WearChatMessage?,
) {
  fun isSupersededBy(messages: List<WearChatMessage>): Boolean {
    val latest = messages.lastOrNull { it.role == "assistant" } ?: return false
    val previous = latestAssistantMessage ?: return true
    val boundaryIndex =
      messages.indexOfLast { message ->
        when {
          previous.id != null && message.id != null -> {
            previous.id == message.id
          }

          previous.idempotencyKey != null -> {
            previous.role == message.role && previous.idempotencyKey == message.idempotencyKey
          }

          previous.id == null && message.id == null && previous.timestamp != null && message.timestamp != null -> {
            previous.timestamp == message.timestamp && previous.role == message.role
          }

          else -> {
            previous == message
          }
        }
      }
    // In-place rewrites preserve identity; deletion may expose an older tail.
    // Require canonical ordering or a later timestamp, not merely a different ID.
    if (boundaryIndex >= 0) return messages.drop(boundaryIndex + 1).any { it.role == "assistant" }
    return previous.timestamp != null && latest.timestamp != null && latest.timestamp > previous.timestamp
  }
}

internal data class WearReplyTerminal(
  val sessionKey: String,
  val phoneNodeId: String?,
  val runId: String?,
  val outcome: WearReplyOutcome,
  val history: WearReplyHistory? = null,
  val message: WearChatMessage? = null,
)

private fun WearReplyTerminal.anchorHistory(messages: List<WearChatMessage>): WearReplyTerminal {
  if (history != null) return this
  val ownMessage =
    runId?.let { run -> messages.lastOrNull { it.replyOutcomeForRun(run) != null } }
      ?: message?.takeIf { it.role == "assistant" }?.id?.let { id ->
        messages.lastOrNull { it.role == "assistant" && it.id == id }
      }
  // Canonical presence establishes order. A bounded window without the own
  // message retains the first snapshot boundary rather than guessing its position.
  return copy(history = WearReplyHistory(ownMessage ?: messages.lastOrNull { it.role == "assistant" }))
}

internal data class WearUiState(
  val loading: Boolean = true,
  val connected: Boolean = false,
  val phoneNodeId: String? = null,
  val agents: List<WearAgent> = emptyList(),
  val activeAgentId: String? = null,
  val selectedModelRef: String? = null,
  val models: List<WearModel> = emptyList(),
  val modelCatalogRefreshFailed: Boolean = false,
  val proxyCapabilities: Set<WearProxyCapability> = emptySet(),
  val sessions: List<WearSession> = emptyList(),
  val selectedSession: WearSession? = null,
  val phoneActiveSessionKey: String? = null,
  val sessionSearchQuery: String? = null,
  val sessionSearchResults: List<WearSession> = emptyList(),
  val sessionSearchHasMore: Boolean = false,
  val sessionSearchNextOffset: Int? = null,
  val modelSearchQuery: String? = null,
  val modelSearchResults: List<WearModel> = emptyList(),
  val messages: List<WearChatMessage> = emptyList(),
  val streamText: String? = null,
  val activeRunId: String? = null,
  val sending: Boolean = false,
  val pendingReply: WearPendingReply? = null,
  val replyTerminal: WearReplyTerminal? = null,
  // A completed Watch send can precede the conversation's latest terminal.
  val replyCompletion: WearReplyTerminal? = null,
  val replyAbort: WearReplyAbort? = null,
  val realtimeTalk: WearRealtimeTalkSnapshot = WearRealtimeTalkSnapshot(),
  val realtimeCapturing: Boolean = false,
  val realtimePlaying: Boolean = false,
  val realtimeMouthLevel: Float = 0f,
  val realtimePlaybackFailed: Boolean = false,
  val talkBusy: Boolean = false,
  val talkStopping: Boolean = false,
  val controlBusy: Boolean = false,
  val failure: WearConversationFailure? = null,
  val agentPulse: WearAgentPulseSnapshot? = null,
  val agentPulseLoading: Boolean = false,
  val agentPulseFailure: WearConversationFailure? = null,
) {
  val pendingAbortRunId: String?
    get() = replyAbort?.takeIf { it.awaitingAck }?.replyRunId

  val hasActiveStream: Boolean
    get() = activeRunId != null || streamText != null

  val abortRunId: String?
    get() = activeRunId ?: pendingReply?.runId.takeIf { streamText == null }

  val canSubmitReply: Boolean
    get() = pendingAbortRunId == null && !sending && !hasActiveStream && (pendingReply == null || pendingReply.retryable)

  val conversationFailure: WearConversationFailure?
    get() = failure ?: WearConversationFailure.INTERNAL_ERROR.takeIf { replyTerminal?.outcome == WearReplyOutcome.Error }
}

internal fun WearUiState.resetForPhoneChange(): WearUiState = WearUiState()

internal fun WearUiState.switchAgentContext(agentId: String): WearUiState =
  copy(
    activeAgentId = agentId,
    sending = false,
    sessions = emptyList(),
    selectedSession = null,
    phoneActiveSessionKey = null,
    sessionSearchQuery = null,
    sessionSearchResults = emptyList(),
    sessionSearchHasMore = false,
    sessionSearchNextOffset = null,
    modelSearchQuery = null,
    modelSearchResults = emptyList(),
    messages = emptyList(),
    streamText = null,
    activeRunId = null,
    pendingReply = null,
    replyTerminal = null,
    replyCompletion = null,
    replyAbort = null,
    selectedModelRef = null,
    models = emptyList(),
    modelCatalogRefreshFailed = false,
    agentPulse = null,
    agentPulseLoading = false,
    agentPulseFailure = null,
  )

internal fun WearUiState.switchSessionContext(session: WearSession): WearUiState =
  copy(
    selectedSession = session,
    sending = false,
    sessionSearchQuery = null,
    sessionSearchResults = emptyList(),
    sessionSearchHasMore = false,
    sessionSearchNextOffset = null,
    modelSearchQuery = null,
    modelSearchResults = emptyList(),
    messages = emptyList(),
    streamText = null,
    activeRunId = null,
    pendingReply = null,
    replyTerminal = null,
    replyCompletion = null,
    replyAbort = null,
    selectedModelRef = session.modelRef,
    models = emptyList(),
    modelCatalogRefreshFailed = false,
    realtimeTalk = WearRealtimeTalkSnapshot(),
    realtimeMouthLevel = 0f,
    talkBusy = false,
    talkStopping = false,
    failure = null,
    agentPulse = null,
    agentPulseLoading = false,
    agentPulseFailure = null,
  )

internal fun WearUiState.switchModelContext(modelRef: String): WearUiState {
  val currentSession = selectedSession ?: return this
  val updatedSession = currentSession.copy(modelRef = modelRef)
  return copy(
    selectedModelRef = modelRef,
    selectedSession = updatedSession,
    // The phone preserves the selected model in its bounded catalog slice.
    // A model change therefore invalidates the previous slice.
    models = emptyList(),
    modelCatalogRefreshFailed = false,
    modelSearchQuery = null,
    modelSearchResults = emptyList(),
    sessions = sessions.map { session -> if (session.key == updatedSession.key) updatedSession else session },
  )
}

internal fun WearUiState.containsModelRef(modelRef: String): Boolean =
  models.any { model -> model.ref == modelRef } ||
    modelSearchResults.any { model -> model.ref == modelRef }

internal fun shouldAcceptWearTalkSnapshot(
  snapshot: WearRealtimeTalkSnapshot,
  attemptId: String?,
): Boolean = snapshot.attemptId != null && snapshot.attemptId == attemptId

internal data class WearTerminalChatTransition(
  val state: WearUiState,
  val reloadHistory: Boolean,
  val observedMessage: WearChatMessage? = null,
)

internal fun reduceWearTerminalChatEvent(
  current: WearUiState,
  event: WearChatEvent,
): WearTerminalChatTransition {
  if (current.selectedSession == null || event.sessionKey != current.selectedSession.key) {
    return WearTerminalChatTransition(state = current, reloadHistory = false)
  }
  // Abort broadcasts can arrive before their partial transcript message is persisted.
  val finalMessage = event.message?.takeIf { event.state == "final" || event.state == "aborted" }
  val preservedState =
    finalMessage?.let { message ->
      current.copy(messages = mergeEventMessage(current.messages, message))
    } ?: current
  // A send's idempotency key is its Gateway client run ID, including before
  // the first delta. A completed terminal is an outcome, not a live run owner.
  // An anonymous live stream still requires history to resolve identity.
  val ownedRunId =
    current.activeRunId
      ?: current.pendingReply?.runId.takeIf { current.streamText == null }
  val outcome =
    when (event.state) {
      "final" -> WearReplyOutcome.Final
      "aborted" -> WearReplyOutcome.Aborted
      "error" -> WearReplyOutcome.Error
      else -> return WearTerminalChatTransition(state = current, reloadHistory = false)
    }
  val terminal = WearReplyTerminal(checkNotNull(event.sessionKey), current.phoneNodeId, event.runId, outcome, message = finalMessage)
  if (ownedRunId != null && event.runId != null && ownedRunId != event.runId) {
    // The visible stream and the Watch send can belong to different runs.
    // Remember the send's terminal without clearing another run's live text.
    val pending = current.pendingReply?.takeIf { it.runId == event.runId }
    return WearTerminalChatTransition(
      state =
        preservedState.copy(
          pendingReply = pending?.copy(retryable = false, terminalAwaitingHistory = terminal) ?: current.pendingReply,
          replyCompletion = terminal.takeIf { pending != null } ?: current.replyCompletion,
        ),
      reloadHistory = pending != null,
      observedMessage = finalMessage.takeIf { pending != null },
    )
  }
  val hasLiveReply = ownedRunId != null || current.streamText != null
  if (hasLiveReply && (ownedRunId == null || event.runId == null)) {
    // Missing run identity cannot distinguish a delayed terminal from the
    // live run's first identified terminal. Preserve the live reply until
    // authoritative history resolves which run actually remains active.
    return WearTerminalChatTransition(
      state =
        preservedState.copy(
          // Remember only the pending send's identified terminal. It cannot own or
          // clear an anonymous live stream; an inactive history snapshot must settle it.
          pendingReply =
            preservedState.pendingReply?.let { pending ->
              if (event.runId == pending.runId) pending.copy(retryable = false, terminalAwaitingHistory = terminal) else pending
            },
          replyCompletion =
            terminal.takeIf { it.runId != null && it.runId == current.pendingReply?.runId } ?: current.replyCompletion,
        ),
      reloadHistory = true,
      observedMessage = finalMessage,
    )
  }
  return WearTerminalChatTransition(
    state =
      preservedState.copy(
        streamText = if (outcome == WearReplyOutcome.Final && finalMessage == null) current.streamText else null,
        activeRunId = null,
        pendingReply = current.pendingReply?.takeUnless { it.runId == event.runId },
        replyTerminal = terminal,
        replyCompletion = terminal.takeIf { it.runId != null && it.runId == current.pendingReply?.runId } ?: current.replyCompletion,
      ),
    reloadHistory = true,
    observedMessage = finalMessage,
  )
}

internal fun WearUiState.reconcileReplyHistory(transcript: WearTranscript): WearUiState {
  val recoveredTerminal =
    pendingReply
      ?.takeIf {
        transcript.sessionKey == selectedSession?.key && transcript.phoneNodeId == phoneNodeId
      }?.let { pending ->
        // A run-correlated canonical assistant can complete a missed terminal even
        // when another run has appended a later message to the transcript.
        transcript.messages.asReversed().firstNotNullOfOrNull { message ->
          message.replyOutcomeForRun(pending.runId)?.let { outcome ->
            WearReplyTerminal(transcript.sessionKey, transcript.phoneNodeId, pending.runId, outcome, message = message)
          }
        }
      }
  val pendingTerminal = (pendingReply?.terminalAwaitingHistory ?: recoveredTerminal)?.takeIf { !hasActiveStream }
  val completion =
    (replyCompletion ?: pendingReply?.terminalAwaitingHistory ?: recoveredTerminal)
      ?.takeIf { it.sessionKey == transcript.sessionKey && it.phoneNodeId == transcript.phoneNodeId }
      ?.let {
        if (it.history == null && (!hasActiveStream || (pendingReply == null && it.runId != null && it.runId == activeRunId))) {
          it.anchorHistory(transcript.messages)
        } else {
          it
        }
      }
  val observedTerminal = replyTerminal ?: pendingTerminal
  val terminal =
    observedTerminal
      ?.takeIf {
        it.sessionKey == transcript.sessionKey && it.phoneNodeId == transcript.phoneNodeId &&
          ((activeRunId == null && streamText == null) || (it.runId != null && it.runId == activeRunId))
      }?.anchorHistory(transcript.messages)
      // The first accepted response may already contain a newer reply after
      // the terminal's own message; do not anchor the old outcome to that reply.
      ?.takeUnless { it.history?.isSupersededBy(transcript.messages) == true }
  val clearLiveReply = terminal != null || (completion?.history != null && completion.runId != null && completion.runId == activeRunId)
  return copy(
    // A lagging history response cannot resurrect the run we observed terminating.
    // A different identified run or an anonymous live snapshot supersedes that outcome.
    activeRunId = if (clearLiveReply) null else activeRunId,
    streamText = if (clearLiveReply) null else streamText,
    replyTerminal = terminal,
    replyCompletion = completion,
    pendingReply =
      pendingReply
        ?.takeUnless { it.runId == completion?.runId && completion.history != null }
        ?.let { if (it.runId == completion?.runId) it.copy(retryable = false) else it },
  ).reconcileReplyAbort()
}

private fun WearUiState.reconcileReplyAbort(): WearUiState {
  val request = replyAbort?.takeIf { !it.awaitingAck && it.rpcRunId == null } ?: return this
  val completion =
    replyCompletion?.takeIf {
      it.runId == request.replyRunId && it.sessionKey == selectedSession?.key && it.phoneNodeId == phoneNodeId
    } ?: return this
  // Session-wide aborted:true identifies no run. Only the captured reply's own
  // aborted terminal/history can cancel its feedback; Final/Error remain ordinary outcomes.
  val canceled = completion.outcome == WearReplyOutcome.Aborted
  return copy(
    replyAbort = null,
    replyCompletion = if (canceled) completion.copy(outcome = WearReplyOutcome.Canceled) else completion,
    pendingReply = pendingReply?.takeUnless { canceled && it.runId == request.replyRunId },
  )
}

internal class WearViewModel(
  application: Application,
) : AndroidViewModel(application) {
  private val app = application as WearApplication
  private val repository = app.gatewayRepository
  private val realtimeTalkClient = WearRealtimeTalkClient(app, repository)
  private val mutableState = MutableStateFlow(WearUiState())
  private val eventSequenceTracker = WearEventSequenceTracker()
  private val eventSourceTracker = WearEventSourceTracker()
  private val resyncEventBuffer = WearEventResyncBuffer()
  private val historyLoadTracker = WearHistoryLoadTracker()
  private val sendAttemptTracker = WearSendAttemptTracker()
  private val controlBusyOwner = WearControlBusyOwner()
  private var loadJob: Job? = null
  private var sessionSearchJob: Job? = null
  private var phoneRouteGeneration = 0L
  private var agentPulsePollJob: Job? = null
  private var agentPulseVisible = false
  private var agentPulseRequestGeneration = 0L

  // Session switches clear the prior bounded catalog; only the matching phone/session may refill it.
  private var modelLoadJob: Job? = null
  private var talkStartJob: Job? = null
  private var talkAttemptId: String? = null

  val state: StateFlow<WearUiState> = mutableState.asStateFlow()

  init {
    viewModelScope.launch {
      app.proxyClient.events.collect(::handleEvent)
    }
    viewModelScope.launch {
      app.proxyClient.preferredPhoneChanges.collect(::reloadForPreferredPhone)
    }
    viewModelScope.launch {
      realtimeTalkClient.channelFailed.collect { failed ->
        mutableState.update { it.copy(realtimePlaybackFailed = failed) }
        if (failed) {
          talkAttemptId = null
          mutableState.update {
            it.copy(
              realtimeTalk = WearRealtimeTalkSnapshot(),
              realtimeCapturing = false,
              realtimePlaying = false,
              realtimeMouthLevel = 0f,
              talkBusy = false,
              talkStopping = false,
              failure = WearConversationFailure.INTERNAL_ERROR,
            )
          }
        }
      }
    }
    viewModelScope.launch {
      realtimeTalkClient.isCapturing.collect { capturing ->
        mutableState.update { it.copy(realtimeCapturing = capturing) }
      }
    }
    viewModelScope.launch {
      realtimeTalkClient.isPlaying.collect { playing ->
        mutableState.update { it.copy(realtimePlaying = playing) }
      }
    }
    viewModelScope.launch {
      realtimeTalkClient.mouthLevel.collect { level ->
        mutableState.update { it.copy(realtimeMouthLevel = level) }
      }
    }
    refresh()
  }

  fun refresh() {
    loadSessions()
  }

  fun setAgentPulseVisible(visible: Boolean) {
    if (agentPulseVisible == visible) {
      if (visible && agentPulsePollJob?.isActive != true) {
        restartAgentPulsePolling(forceLoading = true)
      }
      return
    }
    agentPulseVisible = visible
    if (visible) {
      restartAgentPulsePolling(forceLoading = true)
    } else {
      invalidateAgentPulse(clearSnapshot = true)
    }
  }

  fun refreshAgentPulse() {
    if (!agentPulseVisible) return
    restartAgentPulsePolling(forceLoading = true)
  }

  fun openSession(session: WearSession) {
    val current = mutableState.value
    if (
      current.controlBusy ||
      current.talkBusy ||
      current.realtimeTalk.active ||
      current.realtimeCapturing ||
      current.realtimePlaying ||
      current.selectedSession?.key == session.key
    ) {
      return
    }
    endRealtimeTalkForNavigation()
    cancelModelLoad()
    invalidateAgentPulse(clearSnapshot = true)
    sendAttemptTracker.retainForTarget(session.key, session.phoneNodeId)
    mutableState.update { it.switchSessionContext(session) }
    loadModels(session)
    loadHistory(session)
    restartAgentPulsePolling(forceLoading = true)
  }

  fun searchSessions(query: String) {
    if (WearProxyCapability.SessionSearchPagination !in mutableState.value.proxyCapabilities) return
    val normalized = query.trim()
    if (normalized.isEmpty()) return
    loadSessionSearch(normalized, offset = 0, append = false)
  }

  fun loadMoreSessionSearch() {
    val current = mutableState.value
    if (WearProxyCapability.SessionSearchPagination !in current.proxyCapabilities) return
    val query = current.sessionSearchQuery ?: return
    val offset = current.sessionSearchNextOffset ?: return
    if (!current.sessionSearchHasMore) return
    loadSessionSearch(query, offset = offset, append = true)
  }

  fun clearSessionSearch() {
    sessionSearchJob?.cancel()
    mutableState.update {
      it.copy(
        sessionSearchQuery = null,
        sessionSearchResults = emptyList(),
        sessionSearchHasMore = false,
        sessionSearchNextOffset = null,
      )
    }
  }

  fun searchModels(query: String) {
    if (WearProxyCapability.ModelCatalogSearch !in mutableState.value.proxyCapabilities) return
    val normalized = query.trim()
    if (normalized.isEmpty()) return
    mutableState.value.selectedSession?.let { session -> loadModels(session, normalized) }
  }

  fun clearModelSearch() {
    cancelModelLoad()
    mutableState.update { it.copy(modelSearchQuery = null, modelSearchResults = emptyList()) }
  }

  fun closeSession() {
    endRealtimeTalkForNavigation()
    cancelModelLoad()
    sendAttemptTracker.reset()
    mutableState.update {
      it.copy(
        selectedSession = null,
        sending = false,
        messages = emptyList(),
        streamText = null,
        activeRunId = null,
        pendingReply = null,
        replyTerminal = null,
        replyCompletion = null,
        replyAbort = null,
        selectedModelRef = null,
        realtimeTalk = WearRealtimeTalkSnapshot(),
        talkBusy = false,
        talkStopping = false,
        failure = null,
      )
    }
    loadSessions()
  }

  private fun endRealtimeTalkForNavigation() {
    if (talkStartJob?.isActive == true) {
      talkStartJob?.cancel()
      talkStartJob = null
      realtimeTalkClient.disconnectLocal()
    } else if (mutableState.value.realtimeTalk.active) {
      stopRealtimeTalk()
    }
    talkAttemptId = null
  }

  fun cancelPendingRealtimeTalkStart() {
    if (talkStartJob?.isActive != true) return
    // Losing RESUMED revokes pending intent without changing an established call.
    // The canceled start still owns ambiguous phone-side Stop cleanup.
    talkStartJob?.cancel()
    talkStartJob = null
    talkAttemptId = null
    realtimeTalkClient.disconnectLocal()
    mutableState.update {
      it.copy(talkBusy = false, talkStopping = false, realtimeTalk = WearRealtimeTalkSnapshot())
    }
  }

  fun suspendRealtimeTalk() {
    cancelPendingRealtimeTalkStart()
    if (!mutableState.value.talkStopping && (mutableState.value.realtimeTalk.active || mutableState.value.realtimeCapturing)) {
      stopRealtimeTalk()
    } else {
      realtimeTalkClient.disconnectLocal()
    }
  }

  fun startRealtimeTalk() {
    val current = mutableState.value
    val selectedSession = current.selectedSession ?: return
    if (current.talkBusy || current.realtimeTalk.active) return
    val capabilities = current.proxyCapabilities
    val attemptId = "wear-${UUID.randomUUID()}"
    talkAttemptId = attemptId
    val startJob =
      viewModelScope.launch(start = CoroutineStart.LAZY) {
        mutableState.update { it.copy(talkBusy = true, talkStopping = false, failure = null) }
        try {
          val snapshot =
            realtimeTalkClient.start(
              selectedSession,
              attemptId,
              capabilities,
            )
          if (talkAttemptId != attemptId) return@launch
          mutableState.update { it.copy(realtimeTalk = snapshot, talkBusy = false, talkStopping = false) }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (talkAttemptId != attemptId) return@launch
          talkAttemptId = null
          mutableState.update {
            it.copy(talkBusy = false, talkStopping = false, failure = err.toWearConversationFailure())
          }
        } finally {
          if (talkStartJob === coroutineContext[Job]) talkStartJob = null
        }
      }
    talkStartJob = startJob
    startJob.start()
  }

  fun stopRealtimeTalk() {
    if (mutableState.value.talkBusy) return
    val attemptId = talkAttemptId
    viewModelScope.launch {
      // The Watch has stopped locally even while the phone's Stop is pending.
      // Keep the transcript, but never project stale remote Listening/Speaking.
      mutableState.update {
        it.copy(
          talkBusy = true,
          talkStopping = true,
          realtimeTalk =
            WearRealtimeTalkSnapshot(
              attemptId = it.realtimeTalk.attemptId,
              conversation = it.realtimeTalk.conversation,
            ),
        )
      }
      try {
        val snapshot = realtimeTalkClient.stop()
        if (talkAttemptId != attemptId) return@launch
        if (talkAttemptId == snapshot.attemptId) talkAttemptId = null
        mutableState.update { it.copy(realtimeTalk = snapshot, talkBusy = false, talkStopping = false) }
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        if (talkAttemptId != attemptId) return@launch
        talkAttemptId = null
        realtimeTalkClient.disconnectLocal()
        mutableState.update {
          it.copy(
            realtimeTalk = WearRealtimeTalkSnapshot(),
            talkBusy = false,
            talkStopping = false,
            failure = err.toWearConversationFailure(),
          )
        }
      }
    }
  }

  fun sendReply(
    text: String,
    onAccepted: (String) -> Unit = {},
  ): Boolean {
    val current = mutableState.value
    val session = current.selectedSession ?: return false
    val routeGeneration = phoneRouteGeneration
    val normalized = text.trim()
    if (normalized.isEmpty() || !current.canSubmitReply) return false
    val attempt =
      current.pendingReply?.let { pending ->
        sendAttemptTracker.retry(pending.runId, session.key, normalized, session.phoneNodeId) ?: return false
      } ?: sendAttemptTracker.begin(session.key, normalized, session.phoneNodeId)
    // Reserve the single owner before callbacks or coroutine dispatch can reenter admission.
    mutableState.update {
      it.copy(
        sending = true,
        failure = null,
        pendingReply = WearPendingReply(attempt.idempotencyKey),
        replyTerminal = null,
        replyCompletion = null,
        replyAbort = null,
      )
    }
    onAccepted(attempt.idempotencyKey)
    viewModelScope.launch {
      if (!isCurrentSessionAction(session, routeGeneration) || !sendAttemptTracker.isCurrent(attempt)) return@launch
      try {
        val controlCompleted = repository.send(attempt, requirePreferredPhone = true)
        if (!sendAttemptTracker.isCurrent(attempt) || !isCurrentSessionAction(session, routeGeneration)) return@launch
        if (controlCompleted) {
          sendAttemptTracker.retire(session.key, session.phoneNodeId, attempt.idempotencyKey)
          mutableState.update { state ->
            state.copy(
              sending = false,
              pendingReply = state.pendingReply?.takeUnless { it.runId == attempt.idempotencyKey },
              replyAbort = state.replyAbort?.takeUnless { it.replyRunId == attempt.idempotencyKey },
              replyCompletion =
                if (state.pendingReply?.runId == attempt.idempotencyKey) {
                  WearReplyTerminal(session.key, session.phoneNodeId, attempt.idempotencyKey, WearReplyOutcome.Canceled)
                } else {
                  state.replyCompletion
                },
            )
          }
        } else {
          sendAttemptTracker.markSucceeded(attempt)
        }
        reloadHistoryIfSelected(session, routeGeneration)
      } catch (err: CancellationException) {
        sendAttemptTracker.markAmbiguous(attempt)
        throw err
      } catch (err: Throwable) {
        if (!sendAttemptTracker.isCurrent(attempt) || !isCurrentSessionAction(session, routeGeneration)) return@launch
        if (err is WearProxyException && sendAttemptTracker.retireRejected(attempt, err.code)) {
          // Only a fresh rejected send releases input; a rejected retry remains uncertain.
          mutableState.update { state ->
            state.copy(
              sending = false,
              pendingReply = state.pendingReply?.takeUnless { it.runId == attempt.idempotencyKey },
              replyAbort = state.replyAbort?.takeUnless { it.replyRunId == attempt.idempotencyKey },
              failure = err.toWearConversationFailure(),
            )
          }
        } else {
          sendAttemptTracker.markAmbiguous(attempt)
          recordFailureForSession(err, session, routeGeneration)
        }
      } finally {
        mutableState.update { state ->
          if (sendAttemptTracker.isCurrent(attempt) && isCurrentSessionAction(session, routeGeneration, state)) {
            state.copy(
              sending = false,
              pendingReply =
                state.pendingReply?.let { pending ->
                  if (pending.runId == attempt.idempotencyKey) {
                    pending.copy(retryable = sendAttemptTracker.isAmbiguous(attempt) && state.replyCompletion?.runId != pending.runId)
                  } else {
                    pending
                  }
                },
            )
          } else {
            state
          }
        }
      }
    }
    return true
  }

  fun abort() {
    val current = mutableState.value
    val session = current.selectedSession ?: return
    val routeGeneration = phoneRouteGeneration
    val runId = current.abortRunId
    val replyRunId =
      if (runId == null) {
        // An anonymous live projection may cover the pending Watch send, but
        // cannot retroactively cancel a completion known before this request.
        current.pendingReply?.runId?.takeUnless { it == current.replyCompletion?.runId }
      } else {
        runId.takeIf { it == current.pendingReply?.runId || it == current.replyCompletion?.runId }
      }
    val pendingAbort = current.replyAbort
    // A follow-up request cannot revoke an already accepted same-reply intent.
    val acceptedAbort = pendingAbort?.takeIf { !it.awaitingAck && it.rpcRunId == null && it.replyRunId == replyRunId }
    if (pendingAbort?.awaitingAck == true && (pendingAbort.replyRunId == replyRunId || (runId != null && pendingAbort.rpcRunId == runId))) return
    val activity = eventSequenceTracker.beginReadOnlyResponseRequest()
    val abort = replyRunId?.let { WearReplyAbort(rpcRunId = runId, replyRunId = it) }
    if (abort != null) mutableState.update { it.copy(replyAbort = abort) }
    viewModelScope.launch {
      if (!isCurrentSessionAction(session, routeGeneration)) return@launch
      try {
        val aborted = repository.abort(session.key, runId, session.phoneNodeId)
        if (!isCurrentSessionAction(session, routeGeneration) || !mutableState.value.connected) return@launch
        if (abort != null && mutableState.value.replyAbort !== abort) return@launch
        if (aborted && runId != null) {
          val retired = sendAttemptTracker.retire(session.key, session.phoneNodeId, runId)
          mutableState.update { state ->
            state.copy(
              streamText = state.streamText.takeUnless { state.activeRunId == runId },
              activeRunId = state.activeRunId.takeUnless { it == runId },
              pendingReply = state.pendingReply?.takeUnless { it.runId == runId },
              replyAbort = state.replyAbort.takeUnless { it === abort },
              replyCompletion =
                if (state.pendingReply?.runId == runId || state.replyCompletion?.runId == runId) {
                  WearReplyTerminal(session.key, session.phoneNodeId, runId, WearReplyOutcome.Canceled)
                } else {
                  state.replyCompletion
                },
              sending = if (retired) false else state.sending,
            )
          }
        } else if (aborted && abort != null) {
          mutableState.update { state ->
            if (state.replyAbort === abort) {
              state.copy(replyAbort = abort.copy(awaitingAck = false)).reconcileReplyAbort()
            } else {
              state
            }
          }
        }
        // The anonymous live projection still needs canonical history; its null
        // RPC target never identifies the captured reply. Older responses cannot
        // replace newer live activity.
        if (activity == eventSequenceTracker.beginReadOnlyResponseRequest()) {
          reloadHistoryIfSelected(session, routeGeneration)
        }
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        if ((abort == null || mutableState.value.replyAbort === abort) && activity == eventSequenceTracker.beginReadOnlyResponseRequest()) {
          recordFailureForSession(err, session, routeGeneration)
        }
      } finally {
        mutableState.update { state ->
          if (abort != null && state.replyAbort === abort && isCurrentSessionAction(session, routeGeneration, state)) {
            state.copy(replyAbort = acceptedAbort).reconcileReplyAbort()
          } else {
            state
          }
        }
      }
    }
  }

  fun selectAgent(agentId: String) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    val routeGeneration = phoneRouteGeneration
    if (
      current.controlBusy ||
      current.talkBusy ||
      current.realtimeTalk.active ||
      current.realtimeCapturing ||
      current.realtimePlaying ||
      current.activeAgentId == agentId ||
      WearProxyCapability.AgentControls !in current.proxyCapabilities
    ) {
      return
    }
    val controlAction = beginControlAction(phoneNodeId, routeGeneration) ?: return
    viewModelScope.launch {
      try {
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        repository.selectAgent(agentId, phoneNodeId, current.proxyCapabilities)
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        mutableState.update { state ->
          if (isCurrentControlRoute(phoneNodeId, routeGeneration, state)) {
            sendAttemptTracker.reset()
            state.switchAgentContext(agentId)
          } else {
            state
          }
        }
        refresh()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForControlRoute(err, phoneNodeId, routeGeneration, loading = false)
      } finally {
        finishControlAction(controlAction)
      }
    }
  }

  fun selectModel(modelRef: String) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    val session = current.selectedSession ?: return
    val routeGeneration = phoneRouteGeneration
    if (
      current.controlBusy ||
      current.talkBusy ||
      current.realtimeTalk.active ||
      current.realtimeCapturing ||
      current.realtimePlaying ||
      current.selectedModelRef == modelRef ||
      !current.containsModelRef(modelRef) ||
      WearProxyCapability.ModelControls !in current.proxyCapabilities
    ) {
      return
    }
    val controlAction = beginControlAction(phoneNodeId, routeGeneration) ?: return
    viewModelScope.launch {
      try {
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        cancelModelLoad()
        val responseRequest = eventSequenceTracker.beginResponseRequest()
        val selection =
          repository.selectModel(
            sessionKey = session.key,
            modelRef = modelRef,
            phoneNodeId = phoneNodeId,
            capabilities = current.proxyCapabilities,
          )
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        val currentSession = mutableState.value.selectedSession ?: return@launch
        if (!wearSessionRequestIsCurrent(session, currentSession, selection.phoneNodeId)) return@launch
        if (
          !eventSequenceTracker.isResponseCurrent(
            responseRequest,
            selection.eventStreamId,
            selection.eventSequence,
          )
        ) {
          // A response older than the accepted event stream cannot overwrite newer session state.
          loadSessions(selection.phoneNodeId)
          return@launch
        }
        val acceptedModelRef = selection.selectedModelRef
        val updatedSession = currentSession.copy(modelRef = acceptedModelRef)
        mutableState.update { state ->
          if (!isCurrentControlRoute(phoneNodeId, routeGeneration, state)) return@update state
          val selectedSession = state.selectedSession ?: return@update state
          if (!wearSessionRequestIsCurrent(session, selectedSession, selection.phoneNodeId)) return@update state
          state.switchModelContext(acceptedModelRef)
        }
        if (isCurrentControlRoute(phoneNodeId, routeGeneration)) {
          loadModels(updatedSession)
        }
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForControlRoute(err, phoneNodeId, routeGeneration)
      } finally {
        finishControlAction(controlAction)
      }
    }
  }

  fun setGatewayEnabled(enabled: Boolean) {
    val current = mutableState.value
    val phoneNodeId = current.phoneNodeId ?: return
    val routeGeneration = phoneRouteGeneration
    if (
      current.controlBusy ||
      current.connected == enabled ||
      WearProxyCapability.GatewayControls !in current.proxyCapabilities
    ) {
      return
    }
    val controlAction = beginControlAction(phoneNodeId, routeGeneration) ?: return
    viewModelScope.launch {
      try {
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        if (!enabled) {
          talkStartJob?.cancel()
          talkStartJob = null
          talkAttemptId = null
          realtimeTalkClient.disconnectLocal()
        }
        val status = repository.setGatewayEnabled(enabled, phoneNodeId, current.proxyCapabilities)
        if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return@launch
        mutableState.update { state ->
          if (!isCurrentControlRoute(phoneNodeId, routeGeneration, state)) {
            state
          } else {
            applyWearGatewayControlStatus(state, status, enabled)
          }
        }
        refresh()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        recordFailureForControlRoute(err, phoneNodeId, routeGeneration, loading = false)
      } finally {
        finishControlAction(controlAction)
      }
    }
  }

  private fun loadSessions(expectedNodeId: String? = null) {
    sessionSearchJob?.cancel()
    invalidateAgentPulse(clearSnapshot = true)
    cancelLoad()
    cancelModelLoad()
    loadJob =
      viewModelScope.launch {
        mutableState.update { it.copy(loading = true, failure = null) }
        try {
          val status = repository.status(expectedNodeId)
          val agentList =
            if (status.connected && WearProxyCapability.AgentControls in status.capabilities) {
              repository.agents(status.phoneNodeId, status.capabilities)
            } else {
              WearAgentList(
                agents = emptyList(),
                eventStreamId = status.eventStreamId,
                eventSequence = status.eventSequence,
                phoneNodeId = status.phoneNodeId,
              )
            }
          val previousSession = mutableState.value.selectedSession
          val sessionList =
            if (status.connected) {
              repository.sessions(
                expectedNodeId = status.phoneNodeId,
                selectedSessionKey = previousSession?.key,
                capabilities = status.capabilities,
              )
            } else {
              WearSessionList(
                sessions = emptyList(),
                eventStreamId = status.eventStreamId,
                eventSequence = status.eventSequence,
                phoneNodeId = status.phoneNodeId,
              )
            }
          val activeSessionKey =
            coherentWearActiveSessionKey(
              statusAgentId = status.activeAgentId,
              statusSessionKey = status.activeSessionKey,
              sessionListAgentId = sessionList.activeAgentId,
            )
          val retainedSession =
            previousSession?.takeIf { previous ->
              sessionList.selectedSessionValid &&
                previous.phoneNodeId == sessionList.phoneNodeId &&
                sessionList.sessions.none { session -> session.key == previous.key }
            }
          val listedSessions = retainedSession?.let { listOf(it) + sessionList.sessions } ?: sessionList.sessions
          val projectedSessions =
            activeSessionKey
              ?.takeIf { activeKey -> listedSessions.none { session -> session.key == activeKey } }
              ?.let { activeKey ->
                listOf(
                  WearSession(
                    key = activeKey,
                    title = null,
                    updatedAt = null,
                    hasActiveRun = false,
                    phoneNodeId = sessionList.phoneNodeId,
                    agentId = sessionList.activeAgentId,
                  ),
                ) + listedSessions
              } ?: listedSessions
          val selectedSession =
            projectedSessions.firstOrNull { session -> session.key == previousSession?.key }
              ?: projectedSessions.firstOrNull { session -> session.key == activeSessionKey }
              ?: projectedSessions.firstOrNull()
          val selectedModelRef =
            selectedSession?.modelRef
              ?: wearSelectedModelRef(selectedSession?.key, activeSessionKey, status.selectedModelRef)
          val modelList =
            if (
              status.connected &&
              selectedSession != null &&
              WearProxyCapability.ModelControls in status.capabilities &&
              WearProxyCapability.SessionScopedModelCatalog in status.capabilities
            ) {
              repository.models(
                expectedNodeId = status.phoneNodeId,
                capabilities = status.capabilities,
                sessionKey = selectedSession.key,
                selectedModelRef = selectedModelRef,
              )
            } else {
              WearModelList(
                models = emptyList(),
                eventStreamId = sessionList.eventStreamId,
                eventSequence = sessionList.eventSequence,
                phoneNodeId = sessionList.phoneNodeId,
              )
            }
          if (
            !wearSnapshotSourcesMatch(
              firstPhoneNodeId = sessionList.phoneNodeId,
              firstStreamId = sessionList.eventStreamId,
              secondPhoneNodeId = modelList.phoneNodeId,
              secondStreamId = modelList.eventStreamId,
            )
          ) {
            loadSessions(status.phoneNodeId)
            return@launch
          }
          if (mutableState.value.selectedSession != previousSession) return@launch
          val selectionChanged = selectedSession?.key != previousSession?.key
          if (status.connected) {
            sendAttemptTracker.retainForTarget(selectedSession?.key, sessionList.phoneNodeId)
          } else {
            markDisconnectedContext(status.phoneNodeId)
          }
          val pendingEvents =
            finishSequenceSnapshot(
              // sessions.list owns the state snapshot. models.list is fetched later and cannot
              // cover session or transcript events emitted between the two responses.
              streamId = sessionList.eventStreamId,
              sequence = sessionList.eventSequence,
              sourceNodeId = sessionList.phoneNodeId,
            )
          loadJob = null
          mutableState.update {
            it.copy(
              loading = false,
              connected = status.connected,
              phoneNodeId = status.phoneNodeId,
              agents = agentList.agents,
              activeAgentId =
                sessionList.activeAgentId
                  ?: status.activeAgentId
                  ?: agentList.agents.firstOrNull(WearAgent::selected)?.id,
              selectedModelRef = selectedModelRef,
              models = modelList.models,
              modelCatalogRefreshFailed = modelList.refreshFailed,
              proxyCapabilities = status.capabilities,
              sessions = projectedSessions,
              selectedSession = selectedSession,
              phoneActiveSessionKey = activeSessionKey,
              sessionSearchQuery = null,
              sessionSearchResults = emptyList(),
              sessionSearchHasMore = false,
              sessionSearchNextOffset = null,
              modelSearchQuery = null,
              modelSearchResults = emptyList(),
              messages = if (selectionChanged || !status.connected) emptyList() else it.messages,
              streamText = if (selectionChanged || !status.connected) null else it.streamText,
              activeRunId = if (selectionChanged || !status.connected) null else it.activeRunId,
              sending = if (selectionChanged || !status.connected) false else it.sending,
              pendingReply = if (selectionChanged || !status.connected) null else it.pendingReply,
              replyTerminal = if (selectionChanged || !status.connected) null else it.replyTerminal,
              replyCompletion = if (selectionChanged || !status.connected) null else it.replyCompletion,
              replyAbort = if (selectionChanged || !status.connected) null else it.replyAbort,
            )
          }
          pendingEvents.forEach(::handleEvent)
          if (status.connected && selectedSession != null) {
            loadHistory(selectedSession)
          } else {
            restartAgentPulsePolling(forceLoading = true)
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          if (err is WearProxyException && err.code == "phone_changed") {
            loadJob = null
            reloadForPreferredPhone(nodeId = null)
            return@launch
          }
          markDisconnectedContext(mutableState.value.phoneNodeId)
          mutableState.update {
            it.copy(
              loading = false,
              connected = false,
              sending = false,
              streamText = null,
              activeRunId = null,
              pendingReply = null,
              replyTerminal = null,
              replyCompletion = null,
              replyAbort = null,
              phoneNodeId = null,
              agents = emptyList(),
              activeAgentId = null,
              selectedModelRef = null,
              models = emptyList(),
              modelCatalogRefreshFailed = false,
              proxyCapabilities = emptySet(),
              sessions = emptyList(),
              selectedSession = null,
              messages = emptyList(),
              failure = err.toWearConversationFailure(),
            )
          }
          loadJob = null
        }
      }
  }

  private fun loadHistory(
    session: WearSession,
    observedMessage: WearChatMessage? = null,
  ) {
    cancelLoad()
    val loadToken = historyLoadTracker.start(session.key)
    loadJob =
      viewModelScope.launch {
        mutableState.update { it.copy(loading = true, failure = null) }
        try {
          val transcript = repository.history(session.key, session.phoneNodeId)
          val currentSession = mutableState.value.selectedSession ?: return@launch
          if (
            !wearTranscriptRequestIsCurrent(session, currentSession, transcript.phoneNodeId) ||
            !historyLoadTracker.isCurrent(loadToken)
          ) {
            return@launch
          }
          val loadResult = historyLoadTracker.finish(loadToken)
          val retiredSend = sendAttemptTracker.reconcileTerminalHistory(transcript)
          val loadedSession =
            currentSession.copy(
              phoneNodeId = transcript.phoneNodeId,
              modelRef =
                if (currentSession.modelRef != session.modelRef) {
                  currentSession.modelRef
                } else {
                  transcript.selectedModelRef ?: session.modelRef
                },
            )
          val catalogScopeChanged = wearModelCatalogScopeChanged(currentSession, loadedSession)
          val pendingEvents =
            finishSequenceSnapshot(
              streamId = transcript.eventStreamId,
              sequence = transcript.eventSequence,
              sourceNodeId = transcript.phoneNodeId,
            )
          loadJob = null
          mutableState.update {
            it
              .copy(
                loading = false,
                connected = true,
                sending = if (retiredSend) false else it.sending,
                selectedSession = loadedSession,
                selectedModelRef = loadedSession.modelRef,
                models = if (catalogScopeChanged) emptyList() else it.models,
                modelCatalogRefreshFailed = !catalogScopeChanged && it.modelCatalogRefreshFailed,
                modelSearchQuery = if (catalogScopeChanged) null else it.modelSearchQuery,
                modelSearchResults = if (catalogScopeChanged) emptyList() else it.modelSearchResults,
                sessions =
                  it.sessions.map { item ->
                    if (item.key == session.key) {
                      item.copy(modelRef = loadedSession.modelRef)
                    } else {
                      item
                    }
                  },
                messages =
                  observedMessage?.let { message ->
                    mergeObservedMessageIntoSnapshot(transcript.messages, message)
                  } ?: transcript.messages,
                streamText =
                  loadResult.liveStream?.let { live ->
                    reconcileWearStreamSnapshot(transcript.activeText, live.text, live.complete) ?: live.text
                  } ?: transcript.activeText,
                activeRunId = loadResult.liveStream?.runId ?: transcript.activeRunId,
              ).reconcileReplyHistory(transcript)
          }
          pendingEvents.forEach(::handleEvent)
          restartAgentPulsePolling(forceLoading = true)
          if (catalogScopeChanged) loadModels(loadedSession)
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          val currentLoad = historyLoadTracker.isCurrent(loadToken)
          if (currentLoad) {
            historyLoadTracker.cancel()
            loadJob = null
          }
          if (currentLoad && err is WearProxyException && err.code == "phone_changed") {
            reloadForPreferredPhone(nodeId = null)
            return@launch
          }
          if (currentLoad && mutableState.value.selectedSession?.key == session.key) {
            recordFailure(err, loading = false)
            restartAgentPulsePolling(forceLoading = true)
          }
        }
      }
  }

  private fun loadSessionSearch(
    query: String,
    offset: Int,
    append: Boolean,
  ) {
    val current = mutableState.value
    if (WearProxyCapability.SessionSearchPagination !in current.proxyCapabilities) return
    val phoneNodeId = current.phoneNodeId ?: return
    if (!current.connected) return
    val routeGeneration = phoneRouteGeneration
    sessionSearchJob?.cancel()
    sessionSearchJob =
      viewModelScope.launch {
        try {
          val result =
            repository.sessions(
              expectedNodeId = phoneNodeId,
              capabilities = current.proxyCapabilities,
              limit = 50,
              offset = offset,
              search = query,
            )
          if (routeGeneration != phoneRouteGeneration || mutableState.value.phoneNodeId != result.phoneNodeId) {
            return@launch
          }
          mutableState.update { state ->
            val results =
              if (append && state.sessionSearchQuery == query) {
                (state.sessionSearchResults + result.sessions).distinctBy(WearSession::key)
              } else {
                result.sessions
              }
            state.copy(
              sessionSearchQuery = query,
              sessionSearchResults = results,
              sessionSearchHasMore = result.hasMore,
              sessionSearchNextOffset = result.nextOffset,
              failure = null,
            )
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          recordFailureForControlRoute(err, phoneNodeId, routeGeneration, loading = false)
        }
      }
  }

  private fun loadModels(
    session: WearSession,
    query: String? = null,
  ) {
    val current = mutableState.value
    val capabilities = current.proxyCapabilities
    if (
      WearProxyCapability.ModelControls !in capabilities ||
      WearProxyCapability.SessionScopedModelCatalog !in capabilities ||
      (query != null && WearProxyCapability.ModelCatalogSearch !in capabilities) ||
      !wearSessionRequestIsCurrent(session, current.selectedSession, session.phoneNodeId)
    ) {
      return
    }
    cancelModelLoad()
    val responseRequest = eventSequenceTracker.beginResponseRequest()
    modelLoadJob =
      viewModelScope.launch {
        try {
          val modelList =
            repository.models(
              expectedNodeId = session.phoneNodeId,
              capabilities = capabilities,
              sessionKey = session.key,
              selectedModelRef = session.modelRef,
              query = query,
            )
          val selectedSession = mutableState.value.selectedSession
          if (!wearSessionRequestIsCurrent(session, selectedSession, modelList.phoneNodeId)) return@launch
          if (
            !eventSequenceTracker.isResponseCurrent(
              responseRequest,
              modelList.eventStreamId,
              modelList.eventSequence,
            )
          ) {
            // Rebuild from a canonical snapshot instead of exposing a catalog from an old cursor.
            loadSessions(modelList.phoneNodeId)
            return@launch
          }
          mutableState.update { state ->
            if (!wearSessionRequestIsCurrent(session, state.selectedSession, modelList.phoneNodeId)) {
              state
            } else {
              if (query == null) {
                state.copy(
                  models = modelList.models,
                  modelCatalogRefreshFailed = modelList.refreshFailed,
                  modelSearchQuery = null,
                  modelSearchResults = emptyList(),
                )
              } else {
                state.copy(
                  modelCatalogRefreshFailed = modelList.refreshFailed,
                  modelSearchQuery = query,
                  modelSearchResults = modelList.models,
                )
              }
            }
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          val selectedSession = mutableState.value.selectedSession
          if (wearSessionRequestIsCurrent(session, selectedSession, session.phoneNodeId)) {
            recordFailure(err)
          }
        }
      }
  }

  private fun handleEvent(event: WearInboundEvent) {
    if (eventSourceTracker.changed(event.sourceNodeId)) {
      beginSequenceResync(event, sourceChanged = true)
      return
    }
    when (eventSequenceTracker.accept(event.streamId, event.sequence)) {
      WearSequenceDecision.GapOrReset -> {
        beginSequenceResync(event, sourceChanged = false)
        return
      }

      WearSequenceDecision.AwaitingSnapshot -> {
        resyncEventBuffer.append(event)
        return
      }

      WearSequenceDecision.Accepted -> {}
    }
    when (event.event) {
      WearEventType.Connection -> {
        handleConnectionEvent(event.payload as? JsonObject)
      }

      WearEventType.Chat -> {
        handleChatEvent(event)
      }

      WearEventType.Resync -> {
        refresh()
      }

      WearEventType.Talk -> {
        val payload = event.payload ?: return
        runCatching { WearRealtimeTalkCodec.decode(payload) }
          .getOrNull()
          ?.let { snapshot ->
            if (!shouldAcceptWearTalkSnapshot(snapshot, talkAttemptId)) return@let
            if (mutableState.value.talkStopping && snapshot.active) return@let
            if (!snapshot.active) {
              talkStartJob?.cancel()
              talkStartJob = null
              talkAttemptId = null
              realtimeTalkClient.disconnectLocal()
            }
            mutableState.update {
              it.copy(
                realtimeTalk = snapshot,
                talkBusy = talkStartJob?.isActive == true,
                talkStopping = false,
              )
            }
          }
      }
    }
  }

  private fun beginSequenceResync(
    event: WearInboundEvent,
    sourceChanged: Boolean,
  ) {
    // A source switch or sequence gap invalidates the old phone's live state.
    invalidateAgentPulse(clearSnapshot = true)
    // Buffer this boundary event until the selected phone supplies a watermark.
    eventSequenceTracker.requireSnapshot()
    resyncEventBuffer.start(event)
    if (sourceChanged) {
      // Session keys are phone-local identities. Resolve the new phone's catalog
      // before issuing any history, reply, or abort request against that source.
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
      resetForPhoneRouteChange(event.sourceNodeId)
      loadSessions(event.sourceNodeId)
      return
    }
    mutableState.update {
      it.copy(
        streamText = null,
        activeRunId = null,
        // The cursor invalidates live projection/order, not an accepted completion
        // whose run ID matched the Watch send. Actual context changes clear that fact.
        pendingReply = it.pendingReply?.copy(terminalAwaitingHistory = null),
      )
    }
    val selected = mutableState.value.selectedSession
    if (selected != null) {
      loadHistory(selected)
    } else {
      loadSessions(event.sourceNodeId)
    }
  }

  private fun reloadForPreferredPhone(nodeId: String?) {
    talkStartJob?.cancel()
    talkStartJob = null
    talkAttemptId = null
    realtimeTalkClient.disconnectLocal()
    cancelLoad()
    eventSequenceTracker.requireSnapshot()
    resyncEventBuffer.begin()
    if (nodeId == null) {
      eventSourceTracker.reset()
    } else {
      eventSourceTracker.adopt(nodeId)
    }
    resetForPhoneRouteChange(nodeId)
    loadSessions(nodeId)
  }

  private fun markDisconnectedContext(nodeId: String?) {
    // Repeated phone/session/run IDs do not restore authority to pre-disconnect RPCs.
    phoneRouteGeneration += 1
    sendAttemptTracker.markDisconnected(nodeId)
  }

  private fun resetForPhoneRouteChange(nodeId: String?) {
    invalidateAgentPulse(clearSnapshot = true)
    markDisconnectedContext(nodeId)
    controlBusyOwner.reset()
    mutableState.update(WearUiState::resetForPhoneChange)
  }

  private fun finishSequenceSnapshot(
    streamId: String?,
    sequence: Long?,
    sourceNodeId: String,
  ): List<WearInboundEvent> {
    eventSourceTracker.adopt(sourceNodeId)
    val pendingEvents = resyncEventBuffer.drainAfterSnapshot(streamId, sequence)
    eventSequenceTracker.adoptSnapshot(streamId, sequence)
    return pendingEvents
  }

  private fun handleConnectionEvent(payload: JsonObject?) {
    cancelLoad()
    val connected = payload.boolean("connected") ?: false
    if (!connected) {
      markDisconnectedContext(mutableState.value.phoneNodeId)
      invalidateAgentPulse(clearSnapshot = true)
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
    }
    mutableState.update {
      it.copy(
        loading = false,
        connected = connected,
        sending = if (connected) it.sending else false,
        streamText = if (connected) it.streamText else null,
        activeRunId = if (connected) it.activeRunId else null,
        pendingReply = if (connected) it.pendingReply else null,
        replyTerminal = if (connected) it.replyTerminal else null,
        replyCompletion = if (connected) it.replyCompletion else null,
        replyAbort = if (connected) it.replyAbort else null,
        realtimeTalk = if (connected) it.realtimeTalk else WearRealtimeTalkSnapshot(),
        talkBusy = if (connected) it.talkBusy else false,
        talkStopping = if (connected) it.talkStopping else false,
        failure = wearConversationFailureForConnection(payload),
      )
    }
    if (connected) refresh()
  }

  private fun handleChatEvent(inbound: WearInboundEvent) {
    val event = parseWearChatEvent(inbound.payload) ?: return
    val selected = mutableState.value.selectedSession ?: return
    if (event.sessionKey != selected.key) return
    when (event.state) {
      "delta" -> {
        mutableState.update { current ->
          val projectedText = event.streamText ?: event.message?.text
          val projectedComplete = event.streamTextComplete || event.message != null || event.replace
          val nextText =
            if (projectedText != null) {
              if (projectedComplete) {
                // Ordered Phone projections replace the live value, including shrink/clear.
                // Prefix preservation belongs only to a history/snapshot race.
                updateWearStreamText(current = null, delta = projectedText, replace = true)
              } else {
                reconcileWearStreamSnapshot(current.streamText, projectedText, liveComplete = false)
              }
            } else {
              updateWearStreamText(current = current.streamText, delta = event.deltaText, replace = event.replace)
            }
          historyLoadTracker.observeDelta(
            sessionKey = selected.key,
            text = nextText,
            complete = projectedComplete,
            runId = event.runId,
          )
          val nextRunId = event.runId ?: current.activeRunId
          current.copy(
            loading = false,
            streamText = nextText,
            activeRunId = nextRunId,
            pendingReply = current.pendingReply?.copy(terminalAwaitingHistory = null),
            // Stream activity supersedes conversation status, never the recorded
            // logical completion. History resolves when the live projection is inactive.
            replyTerminal = null,
          )
        }
      }

      "final", "aborted", "error" -> {
        val retiredSend = sendAttemptTracker.retire(selected.key, selected.phoneNodeId, event.runId)
        val transition = reduceWearTerminalChatEvent(mutableState.value, event)
        if (transition.reloadHistory) cancelLoad()
        mutableState.value =
          (if (retiredSend) transition.state.copy(sending = false) else transition.state).reconcileReplyAbort()
        if (transition.reloadHistory) {
          loadHistory(selected, observedMessage = transition.observedMessage)
        }
      }

      else -> {
        event.message?.let { message ->
          cancelLoad()
          mutableState.update { it.copy(messages = mergeEventMessage(it.messages, message)) }
          loadHistory(selected, observedMessage = message)
        }
      }
    }
  }

  private fun cancelLoad() {
    historyLoadTracker.cancel()
    loadJob?.cancel()
    loadJob = null
  }

  private fun cancelModelLoad() {
    modelLoadJob?.cancel()
    modelLoadJob = null
    eventSequenceTracker.invalidateResponseRequests()
  }

  private fun restartAgentPulsePolling(forceLoading: Boolean = false) {
    invalidateAgentPulse(clearSnapshot = false)
    val initialState = mutableState.value
    if (!shouldPollAgentPulse(initialState, agentPulseVisible)) {
      mutableState.update {
        it.copy(
          agentPulse = null,
          agentPulseLoading = false,
          agentPulseFailure = null,
        )
      }
      return
    }
    val phoneNodeId = initialState.phoneNodeId ?: return
    val activeAgentId = initialState.activeAgentId
    val selectedSessionKey = initialState.selectedSession?.key
    val routeGeneration = phoneRouteGeneration
    val requestGeneration = agentPulseRequestGeneration
    agentPulsePollJob =
      viewModelScope.launch {
        var showForcedLoading = forceLoading
        try {
          while (
            isCurrentAgentPulseRoute(
              phoneNodeId = phoneNodeId,
              activeAgentId = activeAgentId,
              selectedSessionKey = selectedSessionKey,
              routeGeneration = routeGeneration,
              requestGeneration = requestGeneration,
            )
          ) {
            mutableState.update { state ->
              if (
                isCurrentAgentPulseRoute(
                  phoneNodeId,
                  activeAgentId,
                  selectedSessionKey,
                  routeGeneration,
                  requestGeneration,
                  state,
                )
              ) {
                state.copy(
                  agentPulseLoading = showForcedLoading || state.agentPulse == null,
                  agentPulseFailure = null,
                )
              } else {
                state
              }
            }
            try {
              val responseRequest = eventSequenceTracker.beginReadOnlyResponseRequest()
              val pulse =
                repository.agentPulse(
                  expectedNodeId = phoneNodeId,
                  capabilities = initialState.proxyCapabilities,
                  selectedSessionKey = selectedSessionKey,
                )
              if (
                pulse.phoneNodeId != phoneNodeId ||
                !isCurrentAgentPulseRoute(
                  phoneNodeId,
                  activeAgentId,
                  selectedSessionKey,
                  routeGeneration,
                  requestGeneration,
                )
              ) {
                return@launch
              }
              if (
                !eventSequenceTracker.isReadOnlyResponseCurrent(
                  responseRequest,
                  pulse.eventStreamId,
                  pulse.eventSequence,
                )
              ) {
                // Rebuild from a canonical snapshot instead of exposing an old Phone cursor.
                loadSessions(pulse.phoneNodeId)
                return@launch
              }
              mutableState.update { state ->
                if (
                  isCurrentAgentPulseRoute(
                    phoneNodeId,
                    activeAgentId,
                    selectedSessionKey,
                    routeGeneration,
                    requestGeneration,
                    state,
                  )
                ) {
                  state.copy(
                    agentPulse = pulse,
                    agentPulseLoading = false,
                    agentPulseFailure = null,
                  )
                } else {
                  state
                }
              }
            } catch (err: CancellationException) {
              throw err
            } catch (err: Throwable) {
              if (
                err is WearProxyException &&
                err.code == "phone_changed" &&
                requestGeneration == agentPulseRequestGeneration
              ) {
                reloadForPreferredPhone(nodeId = null)
                return@launch
              }
              mutableState.update { state ->
                if (
                  isCurrentAgentPulseRoute(
                    phoneNodeId,
                    activeAgentId,
                    selectedSessionKey,
                    routeGeneration,
                    requestGeneration,
                    state,
                  )
                ) {
                  state.copy(
                    agentPulse = if (err.isConnectivityFailure()) null else state.agentPulse,
                    agentPulseLoading = false,
                    agentPulseFailure = err.toWearConversationFailure(),
                  )
                } else {
                  state
                }
              }
            }
            showForcedLoading = false
            delay(AGENT_PULSE_POLL_INTERVAL_MS)
          }
        } finally {
          if (agentPulsePollJob === coroutineContext[Job]) agentPulsePollJob = null
        }
      }
  }

  private fun isCurrentAgentPulseRoute(
    phoneNodeId: String,
    activeAgentId: String?,
    selectedSessionKey: String?,
    routeGeneration: Long,
    requestGeneration: Long,
    state: WearUiState = mutableState.value,
  ): Boolean =
    wearAgentPulseRouteIsCurrent(
      requestedPhoneNodeId = phoneNodeId,
      requestedAgentId = activeAgentId,
      requestedSessionKey = selectedSessionKey,
      requestedRouteGeneration = routeGeneration,
      currentRouteGeneration = phoneRouteGeneration,
      requestedGeneration = requestGeneration,
      currentGeneration = agentPulseRequestGeneration,
      pulseVisible = agentPulseVisible,
      state = state,
    )

  private fun invalidateAgentPulse(clearSnapshot: Boolean) {
    agentPulseRequestGeneration += 1
    agentPulsePollJob?.cancel()
    agentPulsePollJob = null
    mutableState.update {
      it.copy(
        agentPulse = if (clearSnapshot) null else it.agentPulse,
        agentPulseLoading = false,
        agentPulseFailure = null,
      )
    }
  }

  private fun reloadHistoryIfSelected(
    session: WearSession,
    routeGeneration: Long,
  ) {
    val current = mutableState.value
    if (!isCurrentSessionAction(session, routeGeneration, current)) return
    val selected = current.selectedSession ?: return
    loadHistory(selected)
  }

  private fun isCurrentSessionAction(
    session: WearSession,
    routeGeneration: Long,
    state: WearUiState = mutableState.value,
  ): Boolean =
    wearSessionActionIsCurrent(
      requestedSession = session,
      currentState = state,
      requestedRouteGeneration = routeGeneration,
      currentRouteGeneration = phoneRouteGeneration,
    )

  private fun isCurrentControlRoute(
    phoneNodeId: String,
    routeGeneration: Long,
    state: WearUiState = mutableState.value,
  ): Boolean =
    wearControlRouteIsCurrent(
      requestedPhoneNodeId = phoneNodeId,
      currentState = state,
      requestedRouteGeneration = routeGeneration,
      currentRouteGeneration = phoneRouteGeneration,
    )

  private fun beginControlAction(
    phoneNodeId: String,
    routeGeneration: Long,
  ): Long? {
    val owner = controlBusyOwner.claim() ?: return null
    while (true) {
      val state = mutableState.value
      if (state.controlBusy || !isCurrentControlRoute(phoneNodeId, routeGeneration, state)) {
        controlBusyOwner.release(owner)
        return null
      }
      if (mutableState.compareAndSet(state, state.copy(controlBusy = true, failure = null))) {
        return owner
      }
    }
  }

  private fun finishControlAction(owner: Long) {
    if (!controlBusyOwner.release(owner)) return
    mutableState.update { state -> state.copy(controlBusy = false) }
  }

  private fun recordFailure(
    error: Throwable,
    loading: Boolean = mutableState.value.loading,
  ) {
    val disconnected = error.isConnectivityFailure()
    if (disconnected) {
      markDisconnectedContext(mutableState.value.phoneNodeId)
      invalidateAgentPulse(clearSnapshot = true)
      talkStartJob?.cancel()
      talkStartJob = null
      talkAttemptId = null
      realtimeTalkClient.disconnectLocal()
    }
    mutableState.update {
      it.copy(
        loading = loading,
        connected = if (disconnected) false else it.connected,
        sending = if (disconnected) false else it.sending,
        streamText = if (disconnected) null else it.streamText,
        activeRunId = if (disconnected) null else it.activeRunId,
        pendingReply = if (disconnected) null else it.pendingReply,
        replyTerminal = if (disconnected) null else it.replyTerminal,
        replyCompletion = if (disconnected) null else it.replyCompletion,
        replyAbort = if (disconnected) null else it.replyAbort,
        realtimeTalk = if (disconnected) WearRealtimeTalkSnapshot() else it.realtimeTalk,
        talkBusy = if (disconnected) false else it.talkBusy,
        talkStopping = if (disconnected) false else it.talkStopping,
        failure = error.toWearConversationFailure(),
      )
    }
  }

  private fun recordFailureForSession(
    error: Throwable,
    session: WearSession,
    routeGeneration: Long,
  ) {
    val current = mutableState.value
    if (routeGeneration != phoneRouteGeneration || current.phoneNodeId != session.phoneNodeId) return
    if (error.isConnectivityFailure() || isCurrentSessionAction(session, routeGeneration, current)) {
      recordFailure(error)
    }
  }

  private fun recordFailureForControlRoute(
    error: Throwable,
    phoneNodeId: String,
    routeGeneration: Long,
    loading: Boolean = mutableState.value.loading,
  ) {
    if (!isCurrentControlRoute(phoneNodeId, routeGeneration)) return
    recordFailure(error, loading)
  }

  override fun onCleared() {
    sendAttemptTracker.reset()
    modelLoadJob?.cancel()
    agentPulseVisible = false
    agentPulseRequestGeneration += 1
    agentPulsePollJob?.cancel()
    agentPulsePollJob = null
    talkStartJob?.cancel()
    realtimeTalkClient.shutdown()
  }
}

private const val AGENT_PULSE_POLL_INTERVAL_MS = 15_000L

internal fun shouldPollAgentPulse(
  state: WearUiState,
  pulseVisible: Boolean,
): Boolean =
  pulseVisible &&
    state.connected &&
    !state.phoneNodeId.isNullOrBlank() &&
    WearProxyCapability.AgentPulse in state.proxyCapabilities

internal fun wearAgentPulseRouteIsCurrent(
  requestedPhoneNodeId: String,
  requestedAgentId: String?,
  requestedSessionKey: String?,
  requestedRouteGeneration: Long,
  currentRouteGeneration: Long,
  requestedGeneration: Long,
  currentGeneration: Long,
  pulseVisible: Boolean,
  state: WearUiState,
): Boolean =
  requestedRouteGeneration == currentRouteGeneration &&
    requestedGeneration == currentGeneration &&
    shouldPollAgentPulse(state, pulseVisible) &&
    state.phoneNodeId == requestedPhoneNodeId &&
    state.activeAgentId == requestedAgentId &&
    state.selectedSession?.key == requestedSessionKey

internal fun coherentWearActiveSessionKey(
  statusAgentId: String?,
  statusSessionKey: String?,
  sessionListAgentId: String?,
): String? {
  // A phone-side agent switch can land between status and sessions.list. The
  // later list owns session selection; never attach its agent to a stale key.
  return statusSessionKey.takeIf { sessionListAgentId == null || sessionListAgentId == statusAgentId }
}

internal fun wearSelectedModelRef(
  selectedSessionKey: String?,
  activeSessionKey: String?,
  selectedModelRef: String?,
): String? = selectedModelRef.takeIf { selectedSessionKey != null && selectedSessionKey == activeSessionKey }

internal fun wearModelCatalogScopeChanged(
  requestedSession: WearSession,
  loadedSession: WearSession,
): Boolean =
  loadedSession.phoneNodeId != requestedSession.phoneNodeId ||
    loadedSession.modelRef != requestedSession.modelRef

internal fun wearSessionRequestIsCurrent(
  requestedSession: WearSession,
  currentSession: WearSession?,
  responsePhoneNodeId: String,
): Boolean =
  currentSession?.key == requestedSession.key &&
    currentSession.phoneNodeId == requestedSession.phoneNodeId &&
    responsePhoneNodeId == requestedSession.phoneNodeId &&
    currentSession.modelRef == requestedSession.modelRef

internal fun wearTranscriptRequestIsCurrent(
  requestedSession: WearSession,
  currentSession: WearSession?,
  responsePhoneNodeId: String,
): Boolean =
  currentSession?.key == requestedSession.key &&
    currentSession.phoneNodeId == requestedSession.phoneNodeId &&
    responsePhoneNodeId == requestedSession.phoneNodeId

internal fun wearSessionActionIsCurrent(
  requestedSession: WearSession,
  currentState: WearUiState,
  requestedRouteGeneration: Long,
  currentRouteGeneration: Long,
): Boolean =
  requestedRouteGeneration == currentRouteGeneration &&
    currentState.phoneNodeId == requestedSession.phoneNodeId &&
    wearTranscriptRequestIsCurrent(
      requestedSession,
      currentState.selectedSession,
      requestedSession.phoneNodeId,
    )

internal fun wearControlRouteIsCurrent(
  requestedPhoneNodeId: String,
  currentState: WearUiState,
  requestedRouteGeneration: Long,
  currentRouteGeneration: Long,
): Boolean =
  requestedRouteGeneration == currentRouteGeneration &&
    currentState.phoneNodeId == requestedPhoneNodeId

internal class WearControlBusyOwner {
  private var nextOwner = 0L
  private var activeOwner: Long? = null

  fun claim(): Long? {
    if (activeOwner != null) return null
    nextOwner += 1
    return nextOwner.also { owner -> activeOwner = owner }
  }

  fun release(owner: Long): Boolean {
    if (activeOwner != owner) return false
    activeOwner = null
    return true
  }

  fun reset() {
    activeOwner = null
  }
}

internal fun applyWearGatewayControlStatus(
  state: WearUiState,
  status: WearProxyStatus,
  enabled: Boolean,
): WearUiState =
  state.copy(
    connected = status.connected,
    phoneNodeId = status.phoneNodeId,
    activeAgentId = status.activeAgentId ?: state.activeAgentId,
    selectedModelRef =
      wearSelectedModelRef(
        state.selectedSession?.key,
        status.activeSessionKey,
        status.selectedModelRef ?: state.selectedModelRef,
      ),
    proxyCapabilities = status.capabilities,
    realtimeTalk = if (enabled) state.realtimeTalk else WearRealtimeTalkSnapshot(),
    talkStopping = enabled && state.talkStopping,
  )

internal fun wearSnapshotSourcesMatch(
  firstPhoneNodeId: String,
  firstStreamId: String?,
  secondPhoneNodeId: String,
  secondStreamId: String?,
): Boolean = firstPhoneNodeId == secondPhoneNodeId && firstStreamId == secondStreamId

internal fun mergeEventMessage(
  messages: List<WearChatMessage>,
  message: WearChatMessage,
): List<WearChatMessage> {
  val matchIndex =
    messages.indexOfFirst { existing ->
      when {
        message.id != null -> {
          existing.id == message.id
        }

        message.timestamp != null -> {
          existing.id == null &&
            existing.timestamp == message.timestamp &&
            existing.role == message.role
        }

        else -> {
          false
        }
      }
    }
  val merged =
    if (matchIndex >= 0) {
      messages.toMutableList().also { it[matchIndex] = message }
    } else {
      messages + message
    }
  return merged.takeLast(MAX_TRANSCRIPT_MESSAGES)
}

internal fun mergeObservedMessageIntoSnapshot(
  messages: List<WearChatMessage>,
  message: WearChatMessage,
): List<WearChatMessage> {
  val canonicalTail = messages.lastOrNull()
  if (
    message.id == null &&
    canonicalTail != null &&
    canonicalTail.role == message.role &&
    canonicalTail.text == message.text &&
    (message.timestamp == null || canonicalTail.timestamp == message.timestamp)
  ) {
    // History is authoritative after a final event. A matching tail may have
    // gained an ID that the event lacked; appending it would duplicate the reply.
    return messages.takeLast(MAX_TRANSCRIPT_MESSAGES)
  }
  return mergeEventMessage(messages, message)
}

internal fun updateWearStreamText(
  current: String?,
  delta: String?,
  replace: Boolean,
): String? {
  val next = if (replace) delta else current.orEmpty() + delta.orEmpty()
  if (next.isNullOrEmpty()) return next
  val codePointCount = next.codePointCount(0, next.length)
  if (codePointCount <= MAX_STREAM_CODE_POINTS) return next
  val start = next.offsetByCodePoints(0, codePointCount - MAX_STREAM_CODE_POINTS)
  return next.substring(start)
}

internal data class WearLiveStreamSnapshot(
  val text: String?,
  val complete: Boolean,
  val runId: String?,
)

internal fun reconcileWearStreamSnapshot(
  snapshot: String?,
  live: String?,
  liveComplete: Boolean,
): String? {
  if (live.isNullOrEmpty()) return snapshot
  if (snapshot.isNullOrEmpty()) return live
  val merged =
    if (liveComplete) {
      when {
        live.startsWith(snapshot) -> live
        snapshot.startsWith(live) -> snapshot
        else -> live
      }
    } else {
      if (snapshot.startsWith(live)) {
        snapshot
      } else {
        val maxOverlap = minOf(snapshot.length, live.length)
        val overlap =
          (maxOverlap downTo 1).firstOrNull { count ->
            snapshot.hasCodePointBoundary(snapshot.length - count) &&
              live.hasCodePointBoundary(count) &&
              snapshot.endsWith(live.take(count))
          } ?: 0
        snapshot + live.drop(overlap)
      }
    }
  return updateWearStreamText(current = null, delta = merged, replace = true)
}

private fun String.hasCodePointBoundary(index: Int): Boolean = index <= 0 || index >= length || !(this[index - 1].isHighSurrogate() && this[index].isLowSurrogate())

internal data class WearHistoryLoadResult(
  val liveStream: WearLiveStreamSnapshot?,
)

internal class WearHistoryLoadTracker {
  private var generation = 0L
  private var sessionKey: String? = null
  private var liveStream: WearLiveStreamSnapshot? = null

  fun start(sessionKey: String): Long {
    generation += 1
    this.sessionKey = sessionKey
    liveStream = null
    return generation
  }

  fun cancel() {
    generation += 1
    sessionKey = null
    liveStream = null
  }

  fun observeDelta(
    sessionKey: String,
    text: String?,
    complete: Boolean,
    runId: String?,
  ) {
    if (this.sessionKey == sessionKey) {
      liveStream = WearLiveStreamSnapshot(text = text, complete = complete, runId = runId)
    }
  }

  fun isCurrent(token: Long): Boolean = token == generation && sessionKey != null

  fun finish(
    token: Long,
  ): WearHistoryLoadResult {
    if (!isCurrent(token)) return WearHistoryLoadResult(liveStream = null)
    val result = WearHistoryLoadResult(liveStream)
    sessionKey = null
    liveStream = null
    return result
  }
}

internal fun Throwable.toWearConversationFailure(): WearConversationFailure =
  when ((this as? WearProxyException)?.code) {
    "phone_unavailable", "unavailable", "timeout" -> WearConversationFailure.PHONE_UNAVAILABLE
    "unsupported_peer" -> WearConversationFailure.INCOMPATIBLE
    "not_found", "selection_not_found" -> WearConversationFailure.NOT_FOUND
    "action_rejected", "rejected" -> WearConversationFailure.ACTION_REJECTED
    else -> WearConversationFailure.INTERNAL_ERROR
  }

internal fun wearConversationFailureForConnection(payload: JsonObject?): WearConversationFailure? {
  if (payload.boolean("connected") == true) return null
  return when (WearConnectionFailure.fromWireValue(payload.string("failure"))) {
    WearConnectionFailure.Incompatible -> {
      WearConversationFailure.INCOMPATIBLE
    }

    WearConnectionFailure.GatewayOffline -> {
      WearConversationFailure.GATEWAY_OFFLINE
    }

    null -> {
      if (payload.string("status")?.contains("update", ignoreCase = true) == true) {
        // Older protocol-v1 phones only sent status text for incompatibility.
        WearConversationFailure.INCOMPATIBLE
      } else {
        WearConversationFailure.GATEWAY_OFFLINE
      }
    }
  }
}

private fun Throwable.isConnectivityFailure(): Boolean = this is WearProxyException && code in setOf("phone_unavailable", "unavailable", "timeout")

private fun JsonObject?.string(name: String): String? = (this?.get(name) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

private fun JsonObject?.boolean(name: String): Boolean? = (this?.get(name) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private const val MAX_TRANSCRIPT_MESSAGES = 20
private const val MAX_STREAM_CODE_POINTS = 2_000
