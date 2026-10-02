package ai.openclaw.wear

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayBootstrapHandoff
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.GatewayConnectOptions
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayHelloSummary
import ai.openclaw.app.gateway.GatewayOperatorScopePolicy
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.gateway.GatewayTlsProbeRunner
import ai.openclaw.app.gateway.GatewayTlsTrustDecision
import ai.openclaw.app.gateway.decideGatewayTlsTrust
import ai.openclaw.app.gateway.isGatewayTlsSystemTrustCandidate
import ai.openclaw.app.gateway.probeGatewayTlsFingerprint
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextPage
import ai.openclaw.wear.shared.WearReplyTextStatus
import ai.openclaw.wear.shared.projectWearFullReply
import ai.openclaw.wear.shared.wearReplyEntryId
import ai.openclaw.wear.shared.wearReplyIsSynthetic
import ai.openclaw.wear.shared.wearReplyIsTruncated
import ai.openclaw.wear.shared.wearReplyText
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.UUID

internal val wearOperatorScopePolicy =
  GatewayOperatorScopePolicy(
    requestedScopes = setOf("operator.read", "operator.write", "operator.approvals"),
    rejectedGrantScopes = setOf("operator.admin", "operator.pairing"),
  )

internal data class WearDirectSend(
  val sessionKey: String,
  val message: String,
  val agentId: String?,
  val key: String = "wear-${UUID.randomUUID()}",
)

internal data class WearDirectSession(
  val key: String,
  val title: String,
  val agentId: String?,
)

internal data class WearDirectReply(
  val message: WearChatMessage,
  val readPage: suspend (Int, String?) -> WearReplyTextPage,
)

internal data class WearTrustPrompt(
  val generation: Long,
  val fingerprint: String,
  val previous: String?,
)

internal data class WearInputOwner(
  val revision: Long,
  val gatewayId: String?,
  val sessionKey: String?,
)

internal class WearApprovalAttempt(
  val id: String,
) {
  // Runtime-lock owned: a queued frame, not a started coroutine, makes the outcome uncertain.
  var submitted = false
}

internal data class WearDirectState(
  val selected: GatewayRegistryEntry? = null,
  val gateways: List<GatewayRegistryEntry> = emptyList(),
  val connected: Boolean = false,
  val busy: Boolean = false,
  val connectionManagementRequired: Boolean = false,
  val status: String = "Disconnected",
  val error: String? = null,
  val trust: WearTrustPrompt? = null,
  val sessionKey: String? = null,
  val sessionAgentId: String? = null,
  val sessions: List<WearDirectSession> = emptyList(),
  val messages: List<WearChatMessage> = emptyList(),
  val streamText: String? = null,
  val runId: String? = null,
  val pendingSend: WearDirectSend? = null,
  val sending: Boolean = false,
  val sendUnknown: Boolean = false,
  val approvals: List<WearApproval> = emptyList(),
  val approvalsReady: Boolean = false,
  val approvalsIncomplete: Boolean = false,
  val resolving: Map<String, WearApprovalAttempt> = emptyMap(),
)

/** One foreground connection intent owns all direct transport, storage and conversation effects. */
internal class WearDirectRuntime(
  context: Context,
  private val scope: CoroutineScope,
  private val store: WearGatewayStore = WearGatewayStore.create(context),
) {
  private val identity = DeviceIdentityStore.withPrefs(context, store)
  private val tokens = DeviceAuthStore(store)
  private val lock = Any()
  private val cleanup = Mutex()
  private val tlsProbe = GatewayTlsProbeRunner(scope, ::probeGatewayTlsFingerprint)
  private var generation = 0L
  private var phoneProxyRevision = 0L
  private var selectionRevision = 0L
  private var visible = false
  private var stopped = false
  private var owner: Owner? = null
  private var feed = WearApprovalFeed()
  private var conversation = 0L
  private var historyRevision = 0L
  private var chatRevision = 0L
  private var transcriptRevision = 0L
  private val mutableState =
    MutableStateFlow(
      WearDirectState(selected = store.registry.activeEntry(), gateways = store.registry.entries.value),
    )
  val state = mutableState.asStateFlow()

  private data class Owner(
    val generation: Long,
    val endpoint: GatewayEndpoint,
    val session: GatewaySession,
    val handoff: GatewayBootstrapHandoff?,
  )

  private val connectivity = context.getSystemService(ConnectivityManager::class.java)
  private val networkCallback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        val current = synchronized(lock) { owner.takeIf { visible && !stopped } }
        current?.session?.retryAfterNetworkRestore()
      }
    }

  fun isPhoneProxySelected(): Boolean =
    synchronized(lock) {
      val state = mutableState.value
      state.selected == null && !state.busy && !state.connectionManagementRequired
    }

  fun capturePhoneProxy(): WearProxyEnqueueGuard {
    val selected =
      synchronized(lock) {
        if (!isPhoneProxySelected()) throw WearProxyException("phone_changed", "Phone Proxy is not selected")
        phoneProxyRevision
      }
    return { enqueue ->
      synchronized(lock) {
        // Pending phone acknowledgments survive direct visibility and failed setup attempts.
        // Only a committed departure from Phone Proxy retires this route, including a round trip.
        if (phoneProxyRevision != selected || store.registry.activeStableId.value != null) throw WearProxyException("phone_changed", "Watch connection changed")
        enqueue()
      }
    }
  }

  fun inputOwner(): WearInputOwner =
    synchronized(lock) {
      WearInputOwner(selectionRevision, mutableState.value.selected?.stableId, mutableState.value.sessionKey)
    }

  private fun invalidateInput() {
    synchronized(lock) { selectionRevision += 1 }
  }

  fun setVisible(value: Boolean) {
    synchronized(lock) {
      if (visible == value) return
      visible = value
    }
    if (value) {
      connectivity.registerDefaultNetworkCallback(networkCallback)
      if (!stopped && state.value.selected != null) reconnect()
    } else {
      runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
      // Phone Proxy keeps receiving replies in the background; only direct work retires here.
      if (!isPhoneProxySelected()) changeIntent { publish(it) { copy(status = "Paused") } }
    }
  }

  fun setup(raw: String) {
    synchronized(lock) {
      mutableState.value = mutableState.value.copy(connectionManagementRequired = true, error = null)
    }
    val setup =
      try {
        parseWearGatewaySetup(raw)
      } catch (error: IllegalArgumentException) {
        synchronized(lock) { mutableState.value = mutableState.value.copy(error = error.message) }
        return
      }
    invalidateInput()
    stopped = false
    changeIntent { intent ->
      val deviceId = identity.loadOrCreate().deviceId
      synchronized(lock) {
        if (generation != intent) return@changeIntent
        store.replace(setup, deviceId)
        phoneProxyRevision += 1
      }
      publishRegistry(intent, clearConversation = true)
      connect(intent, setup.endpoint)
    }
  }

  fun cancelSetup() {
    invalidateInput()
    changeIntent { intent ->
      publishRegistry(intent, clearConversation = false)
      publish(intent) { copy(connectionManagementRequired = false, error = null) }
      store.registry.activeEntry()?.let { connect(intent, it.endpoint()) }
    }
  }

  fun selectGateway(stableId: String) {
    invalidateInput()
    stopped = false
    changeIntent { intent ->
      synchronized(lock) {
        if (generation != intent) return@changeIntent
        check(store.registry.setActiveSynchronously(stableId)) { "Could not save the selected Gateway." }
        phoneProxyRevision += 1
      }
      publishRegistry(intent, clearConversation = true)
      store.registry.activeEntry()?.let { connect(intent, it.endpoint()) }
    }
  }

  fun selectPhoneProxy() {
    invalidateInput()
    changeIntent { intent ->
      synchronized(lock) {
        if (generation != intent) return@changeIntent
        check(store.registry.setActiveSynchronously(null)) { "Could not save Phone Proxy selection." }
      }
      publishRegistry(intent, clearConversation = true)
    }
  }

  fun forget(stableId: String) {
    val id = stableId.trim()
    scope.launch {
      cleanup.withLock {
        // Classify under the same lock that admits retirement; an inactive removal
        // must not retire another gateway's transport, input or conversation.
        changeIntent(admit = {
          if (store.registry.activeStableId.value == id) {
            selectionRevision += 1
            true
          } else {
            try {
              store.forget(id, identity.loadOrCreate().deviceId)
              mutableState.value = mutableState.value.copy(gateways = store.registry.entries.value)
            } catch (error: CancellationException) {
              throw error
            } catch (_: Exception) {
              mutableState.value = mutableState.value.copy(error = "Could not remove the saved Gateway. Try Forget again.")
            }
            false
          }
        }) { intent ->
          val deviceId = identity.loadOrCreate().deviceId
          synchronized(lock) {
            if (generation != intent) return@changeIntent
            store.forget(id, deviceId)
          }
          publishRegistry(intent, clearConversation = true)
        }
      }
    }
  }

  fun disconnect() {
    invalidateInput()
    stopped = true
    changeIntent { publish(it) { copy(status = "Disconnected") } }
  }

  fun reconnect() {
    stopped = false
    changeIntent { intent ->
      store.registry.activeEntry()?.let { connect(intent, it.endpoint()) }
    }
  }

  private fun changeIntent(
    admit: () -> Boolean = { true },
    action: suspend (Long) -> Unit,
  ) {
    val (intent, retired) =
      synchronized(lock) {
        if (!admit()) return
        generation += 1
        conversation += 1
        val retired = owner
        retired?.handoff?.invalidate()
        owner = null
        feed = WearApprovalFeed()
        mutableState.value =
          mutableState.value.copy(
            connected = false,
            busy = true,
            trust = null,
            error = null,
            approvalsReady = false,
            sending = false,
            sendUnknown = mutableState.value.sendUnknown || mutableState.value.sending,
          )
        generation to retired
      }
    // Never take a GatewaySession lock while holding the runtime lock: callbacks use the reverse order.
    retired?.session?.disconnect()
    tlsProbe.cancel()
    scope.launch {
      cleanup.withLock {
        retired?.session?.disconnectAndJoin()
        tlsProbe.cancelAndJoin()
        if (!current(intent)) return@withLock
        try {
          action(intent)
        } catch (error: CancellationException) {
          throw error
        } catch (_: Exception) {
          // A failed route change must retain recovery UI even when Phone Proxy was selected.
          publish(intent) { copy(connectionManagementRequired = true, error = "Could not update the watch connection. Retry or enter a new limited setup code.") }
        } finally {
          publish(intent) { copy(busy = false) }
        }
      }
    }
  }

  private fun publishRegistry(
    intent: Long,
    clearConversation: Boolean,
  ) = publish(intent) {
    val next = if (clearConversation) WearDirectState() else this
    next.copy(selected = store.registry.activeEntry(), gateways = store.registry.entries.value)
  }

  private suspend fun connect(
    intent: Long,
    endpoint: GatewayEndpoint,
    acceptedFingerprint: String? = null,
  ) {
    if (!current(intent) || !visible || stopped) return
    publish(intent) { copy(status = "Connecting") }
    var fingerprint = acceptedFingerprint
    if (endpoint.tlsEnabled && fingerprint == null) {
      val probe = tlsProbe.probe(endpoint.host, endpoint.port)
      if (!current(intent)) return
      when (val trust = decideGatewayTlsTrust(store.getString("gateway.tls.${endpoint.stableId}"), isGatewayTlsSystemTrustCandidate(endpoint.host), probe)) {
        GatewayTlsTrustDecision.SystemTrusted -> {}

        is GatewayTlsTrustDecision.PinnedTrust -> {
          fingerprint = trust.fingerprintSha256
        }

        is GatewayTlsTrustDecision.PromptRequired -> {
          publish(intent) {
            copy(
              status = "Verify Gateway certificate",
              trust = trust.fingerprintSha256?.let { WearTrustPrompt(intent, it, trust.previousFingerprintSha256) },
              error = if (trust.fingerprintSha256 == null) "No certificate was received. Check the Gateway TLS endpoint." else null,
            )
          }
          return
        }

        is GatewayTlsTrustDecision.Failed -> {
          publish(intent) { copy(error = "Gateway TLS is unavailable. Check the endpoint and retry.") }
          return
        }
      }
    }
    val bootstrap = store.bootstrap(endpoint.stableId)
    val handoff = bootstrap?.let { store.handoff(endpoint.stableId, it) }
    val role = if (bootstrap == null) "operator" else "node"
    val session =
      GatewaySession(
        scope = scope,
        identityStore = identity,
        deviceAuthStore = tokens,
        onConnected = { hello -> connected(intent, endpoint, hello) },
        onDisconnected = {
          // The closed physical lease cannot commit its send failure, so settle the visible attempt here.
          publish(intent) {
            copy(
              connected = false,
              approvalsReady = false,
              status = "Disconnected",
              sending = false,
              sendUnknown = sendUnknown || sending,
            )
          }
        },
        onConnectFailure = { error, _ ->
          publish(intent) {
            copy(
              error =
                if (error.details?.code == "CLIENT_SCOPE_POLICY") {
                  "Full-access credentials are not accepted. Enter a new limited setup code."
                } else {
                  "Gateway connection failed. Check connectivity or enter a new limited setup code."
                },
            )
          }
        },
        onEvent = { event, payload -> receive(intent, event, payload) },
      )
    val accepted =
      synchronized(lock) {
        if (generation != intent) {
          false
        } else {
          owner = Owner(intent, endpoint, session, handoff)
          true
        }
      }
    if (!accepted) return
    session.connect(
      endpoint,
      token = null,
      bootstrapToken = bootstrap,
      password = null,
      options =
        GatewayConnectOptions(
          role = role,
          scopes = if (role == "operator") wearOperatorScopePolicy.requestedScopes.toList() else emptyList(),
          caps = if (role == "operator") listOf("session-scoped-events", "approvals") else emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client =
            GatewayClientInfo(
              "openclaw-android",
              "OpenClaw Watch",
              "1",
              "android ${Build.VERSION.RELEASE}",
              if (role == "node") "node" else "ui",
              identity.loadOrCreate().deviceId,
              "android",
              Build.MODEL,
            ),
          operatorScopePolicy = wearOperatorScopePolicy,
        ),
      tls = if (endpoint.tlsEnabled) GatewayTlsParams(true, fingerprint, false, endpoint.stableId) else null,
      bootstrapHandoff = handoff,
    )
    if (!current(intent)) session.disconnect()
  }

  fun acceptCertificate(prompt: WearTrustPrompt) {
    scope.launch {
      cleanup.withLock {
        // Intent retirement does not take cleanup; pin admission and commit share its runtime lock.
        val endpoint =
          synchronized(lock) {
            if (generation != prompt.generation || mutableState.value.trust != prompt) return@withLock
            val selected = mutableState.value.selected?.endpoint() ?: return@withLock
            if (!store.putStringSynchronously("gateway.tls.${selected.stableId}", prompt.fingerprint)) {
              mutableState.value = mutableState.value.copy(error = "Could not save certificate trust.")
              return@withLock
            }
            mutableState.value = mutableState.value.copy(trust = null)
            selected
          }
        connect(prompt.generation, endpoint, prompt.fingerprint)
      }
    }
  }

  private fun connected(
    intent: Long,
    endpoint: GatewayEndpoint,
    hello: GatewayHelloSummary,
  ) {
    if (!current(intent)) return
    if (hello.authRole == "node") {
      scope.launch {
        cleanup.withLock {
          val bootstrapOwner = synchronized(lock) { owner?.takeIf { it.generation == intent } } ?: return@withLock
          bootstrapOwner.session.disconnectAndJoin()
          if (!current(intent)) return@withLock
          if (bootstrapOwner.handoff?.completed != true || store.bootstrap(endpoint.stableId) != null) {
            publish(intent) { copy(error = "Pairing was not saved. Enter a new limited setup code.") }
          } else {
            connect(intent, endpoint)
          }
        }
      }
      return
    }
    publish(intent) {
      copy(connected = true, status = "Connected directly", error = null, sessionKey = sessionKey ?: hello.mainSessionKey)
    }
    refresh()
  }

  fun selectSession(
    key: String,
    agentId: String? = null,
  ) {
    synchronized(lock) {
      if (mutableState.value.sessionKey == key && (agentId == null || mutableState.value.sessionAgentId == agentId)) return
      invalidateInput()
      conversation += 1
      feed = WearApprovalFeed()
      mutableState.value =
        mutableState.value.copy(
          sessionKey = key,
          sessionAgentId = agentId,
          messages = emptyList(),
          approvals = emptyList(),
          approvalsReady = false,
          streamText = null,
          runId = null,
          pendingSend = null,
          sending = false,
          sendUnknown = false,
          resolving = emptyMap(),
        )
    }
    // Replacing the socket drops all old session subscriptions and their late events.
    reconnect()
  }

  private data class RequestContext(
    val intent: Long,
    val conversation: Long,
    val lease: GatewaySession.RequestLease,
    val replay: Long? = null,
    val approval: WearApprovalAttempt? = null,
  )

  private fun capture(): RequestContext? {
    val snapshot = synchronized(lock) { owner?.let { Triple(it, generation, conversation) } } ?: return null
    val lease = snapshot.first.session.captureRequestLease() ?: return null
    return RequestContext(snapshot.second, snapshot.third, lease).takeIf { requestCurrent(it) }
  }

  private fun requestCurrent(request: RequestContext): Boolean =
    synchronized(lock) {
      generation == request.intent && conversation == request.conversation && visible && !stopped &&
        (request.replay == null || feed.isCurrent(request.replay)) &&
        (request.approval == null || mutableState.value.resolving[request.approval.id] === request.approval)
    }

  private suspend fun request(
    request: RequestContext,
    method: String,
    params: JsonObject,
    onEnqueued: (() -> Unit)? = null,
  ): JsonObject {
    val raw =
      request.lease.request(method, params.toString(), withEnqueue = { enqueue ->
        synchronized(lock) {
          if (!requestCurrent(request)) throw GatewayRequestNotEnqueued("Watch route changed")
          enqueue()
          onEnqueued?.invoke()
        }
      })
    return Json.parseToJsonElement(raw) as? JsonObject ?: error("Invalid Gateway result")
  }

  private fun commit(
    request: RequestContext,
    action: () -> Unit,
  ): Boolean {
    var committed = false
    request.lease.commitIfCurrent {
      synchronized(lock) {
        if (requestCurrent(request)) {
          action()
          committed = true
        }
      }
    }
    return committed
  }

  fun refresh() {
    val captured = capture() ?: return
    var admitted: RequestContext? = null
    commit(captured) {
      // The replay owner fences the whole refresh, including the initial list await.
      admitted = captured.copy(replay = feed.begin())
      mutableState.value = mutableState.value.copy(approvalsReady = false)
    }
    val request = admitted ?: return
    scope.launch {
      try {
        val result =
          request(
            request,
            "sessions.list",
            buildJsonObject {
              put("limit", 30)
              put("includeGlobal", false)
              put("includeUnknown", false)
            },
          )
        val sessions =
          (result["sessions"] as? JsonArray).orEmpty().take(30).mapNotNull {
            val obj = it as? JsonObject ?: return@mapNotNull null
            val key = obj.text("key") ?: return@mapNotNull null
            WearDirectSession(key, (obj.text("displayName") ?: obj.text("label") ?: key).take(160), obj.text("agentId"))
          }
        if (!commit(request) {
            mutableState.value = mutableState.value.copy(sessions = sessions, error = null)
          }
        ) {
          return@launch
        }
        if (!subscribe(request)) return@launch
        loadHistory(request)
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        commit(request) { mutableState.value = mutableState.value.copy(error = "Could not refresh this conversation. Retry.") }
      }
    }
  }

  private suspend fun subscribe(request: RequestContext): Boolean {
    val selected = state.value
    val key = selected.sessionKey ?: return false
    val subscribed =
      request(
        request,
        "sessions.messages.subscribe",
        buildJsonObject {
          put("key", key)
          selected.sessionAgentId?.let { put("agentId", it) }
          put("includeApprovals", true)
        },
      )
    if (!commit(request) {
        // The subscription response owns routing, independently of approval replay validity.
        mutableState.value = mutableState.value.copy(sessionKey = subscribed.text("key") ?: key, sessionAgentId = subscribed.text("agentId"))
        val snapshot = subscribed["approvalReplay"] as? JsonObject
        if (subscribed.flag("subscribed") != true || snapshot == null || !feed.replay(snapshot)) {
          mutableState.value = mutableState.value.copy(error = "Approval replay is unavailable. Reconnect to refresh.", approvalsReady = false)
        } else {
          publishApprovals()
        }
      }
    ) {
      return false
    }
    state.value.resolving
      .values
      .toList()
      .forEach { attempt -> reconcileApproval(request.copy(approval = attempt), attempt.id) }
    return true
  }

  private suspend fun loadHistory(
    request: RequestContext,
    expectedChatRevision: Long? = null,
  ) {
    // Newer loads, admitted sends, send acknowledgements, and events supersede this snapshot.
    var admitted: Triple<String, String?, Long>? = null
    commit(request) {
      if (expectedChatRevision != null && chatRevision != expectedChatRevision) return@commit
      val key = mutableState.value.sessionKey ?: return@commit
      historyRevision += 1
      admitted = Triple(key, mutableState.value.sessionAgentId, historyRevision)
    }
    val (key, agentId, revision) = admitted ?: return
    val result =
      request(
        request,
        "chat.history",
        buildJsonObject {
          put("sessionKey", key)
          agentId?.let { put("agentId", it) }
          put("limit", 20)
          put("maxChars", 2000)
        },
      )
    val messages = (result["messages"] as? JsonArray).orEmpty().takeLast(20).mapNotNull(::directChatMessage)
    val inFlight = result["inFlightRun"] as? JsonObject
    commit(request) {
      if (revision == historyRevision) {
        mutableState.value =
          mutableState.value.copy(
            messages = messages,
            runId = inFlight?.text("runId"),
            streamText = inFlight?.text("text")?.take(4000),
          )
      }
    }
  }

  fun openReply(
    message: WearChatMessage,
    selection: WearDirectState,
  ): WearDirectReply {
    val captured = capture()
    var selected: JsonObject? = null
    if (captured != null) {
      commit(captured) {
        val state = mutableState.value
        if (selection.selected?.stableId != state.selected?.stableId ||
          selection.sessionKey != state.sessionKey || selection.sessionAgentId != state.sessionAgentId
        ) {
          return@commit
        }
        val key = state.sessionKey ?: return@commit
        val entry = message.entryId ?: return@commit
        selected =
          buildJsonObject {
            put("sessionKey", key)
            state.sessionAgentId?.let { put("agentId", it) }
            put("messageId", entry)
            put("maxChars", WearReplyText.MAX_TEXT_LENGTH)
          }
      }
    }
    val params = selected
    // A reader retains its physical lease and conversation, never a fresh route on each page.
    return WearDirectReply(message) { offset, revision ->
      when {
        captured == null || params == null -> {
          WearReplyTextPage(WearReplyTextStatus.Unavailable)
        }

        !commit(captured) {} -> {
          WearReplyTextPage(WearReplyTextStatus.Changed)
        }

        !captured.lease.supportsMethod("chat.message.get") -> {
          WearReplyTextPage(WearReplyTextStatus.Unsupported)
        }

        else -> {
          val result =
            try {
              request(captured, "chat.message.get", params)
            } catch (error: Exception) {
              if (error is CancellationException || commit(captured) {}) throw error
              return@WearDirectReply WearReplyTextPage(WearReplyTextStatus.Changed)
            }
          val page = projectWearFullReply(result, checkNotNull(message.entryId), captured.intent.toString() + ":" + captured.conversation + ":" + params, offset, revision)
          if (commit(captured) {}) page else WearReplyTextPage(WearReplyTextStatus.Changed)
        }
      }
    }
  }

  fun send(
    message: String,
    input: WearInputOwner,
  ) {
    val text = message.trim().takeIf { it.isNotEmpty() && it.length <= 4000 } ?: return
    val attempt =
      synchronized(lock) {
        val state = mutableState.value
        if (input != inputOwner() || state.pendingSend != null || state.sending || state.sendUnknown) return
        // Input can return before foreground reconnection is ready. Retain it without automatic replay.
        WearDirectSend(state.sessionKey ?: return, text, state.sessionAgentId).also {
          mutableState.value = state.copy(pendingSend = it, error = null)
        }
      }
    send(attempt)
  }

  fun retrySend() {
    val attempt = synchronized(lock) { mutableState.value.pendingSend } ?: return
    send(attempt)
  }

  fun discardPendingSend(expected: WearDirectSend) {
    synchronized(lock) {
      val state = mutableState.value
      if (state.pendingSend !== expected || state.sending || state.sendUnknown) return
      mutableState.value = state.copy(pendingSend = null)
    }
  }

  private fun send(attempt: WearDirectSend) {
    val request = capture() ?: return
    var admitted: Pair<Long, Long>? = null
    commit(request) {
      val state = mutableState.value
      if (state.pendingSend !== attempt || state.sending) return@commit
      historyRevision += 1
      mutableState.value = state.copy(sending = true, error = null)
      admitted = chatRevision to transcriptRevision
    }
    val (revision, transcript) = admitted ?: return
    scope.launch {
      val result =
        try {
          request(
            request,
            "chat.send",
            buildJsonObject {
              put("sessionKey", attempt.sessionKey)
              attempt.agentId?.let { put("agentId", it) }
              put("message", attempt.message)
              put("idempotencyKey", attempt.key)
              put("deliver", false)
            },
          )
        } catch (error: Exception) {
          commit(request) {
            val unknown = error !is GatewayRequestDefinitiveFailure
            mutableState.value =
              mutableState.value.copy(
                sending = false,
                sendUnknown = unknown,
                error = if (unknown) "Delivery is unconfirmed. Refresh history before retrying." else "Message was not accepted. Retry.",
              )
          }
          if (error is CancellationException) throw error
          return@launch
        }
      var reconcile = false
      commit(request) {
        // ACK settles delivery; newer chat events retain ownership of run state and history.
        val unchanged = chatRevision == revision
        val active = result.text("status") in setOf("started", "in_flight")
        val adoptRun = unchanged && active
        // Transcript events can belong to another run. Settle the ACK, then read
        // fresh canonical state instead of treating an earlier snapshot as completion.
        reconcile = unchanged && (!active || transcriptRevision != transcript)
        if (adoptRun) historyRevision += 1
        mutableState.value =
          mutableState.value.copy(
            sending = false,
            pendingSend = null,
            sendUnknown = false,
            runId = if (adoptRun) result.text("runId") else mutableState.value.runId,
            error =
              mutableState.value.error ?: "This message's run ended or was cancelled. Check history before sending again.".takeIf {
                unchanged && mutableState.value.pendingSend === attempt && result.text("status") == "timeout"
              },
          )
      }
      if (reconcile) {
        try {
          loadHistory(request, expectedChatRevision = revision)
        } catch (error: CancellationException) {
          throw error
        } catch (_: Exception) {
          commit(request) { mutableState.value = mutableState.value.copy(error = "Could not refresh this conversation. Retry.") }
        }
      }
    }
  }

  fun abort() {
    val request = capture() ?: return
    var target: Triple<String, String?, String>? = null
    commit(request) {
      val state = mutableState.value
      val key = state.sessionKey ?: return@commit
      val run = state.runId ?: return@commit
      target = Triple(key, state.sessionAgentId, run)
    }
    val (key, agentId, run) = target ?: return
    scope.launch {
      try {
        // Exact-run sessions.abort also reaches recovered embedded owners without retargeting a replacement.
        request(
          request,
          "sessions.abort",
          buildJsonObject {
            put("key", key)
            agentId?.let { put("agentId", it) }
            put("runId", run)
          },
        )
        loadHistory(request)
      } catch (_: Exception) {
        commit(request) { mutableState.value = mutableState.value.copy(error = "Stop is unconfirmed. Refresh the conversation.") }
      }
    }
  }

  fun resolve(
    approval: WearApproval,
    decision: String,
  ) {
    val captured = capture() ?: return
    val attempt = WearApprovalAttempt(approval.id)
    var admitted = false
    commit(captured) {
      val state = mutableState.value
      if (state.approvalsReady && approval.id !in state.resolving &&
        approval.canResolve(decision, System.currentTimeMillis())
      ) {
        mutableState.value = state.copy(resolving = state.resolving + (approval.id to attempt))
        admitted = true
      }
    }
    if (!admitted) return
    val request = captured.copy(approval = attempt)
    scope.launch {
      try {
        val fresh =
          parseWearApproval(request(request, "approval.get", buildJsonObject { put("id", approval.id) })["approval"])
            ?: error("Invalid approval")
        check(fresh.id == approval.id && fresh.kind == approval.kind)
        if (!fresh.sameReview(approval) || !fresh.canResolve(decision, System.currentTimeMillis())) {
          commit(request) {
            feed.replace(fresh)
            mutableState.value = mutableState.value.copy(resolving = mutableState.value.resolving - approval.id)
            publishApprovals()
          }
          return@launch
        }
        val result =
          request(
            request,
            "approval.resolve",
            buildJsonObject {
              put("id", approval.id)
              put("kind", approval.kind)
              put("decision", decision)
            },
            onEnqueued = { attempt.submitted = true },
          )
        val terminal = parseWearApproval(result["approval"]) ?: error("Invalid approval result")
        check(terminal.id == approval.id && terminal.kind == approval.kind && terminal.status != "pending" && result.flag("applied") != null)
        commit(request) {
          feed.replace(terminal)
          mutableState.value = mutableState.value.copy(resolving = mutableState.value.resolving - approval.id)
          publishApprovals()
        }
      } catch (error: Exception) {
        commit(request) {
          mutableState.value =
            mutableState.value.copy(
              error = if (attempt.submitted) "Approval outcome is unconfirmed. Refresh to reconcile it." else "Could not review this approval. Retry.",
            )
        }
        if (error is CancellationException) throw error
      } finally {
        // Retirement can invalidate the lease while retaining conversation state. Only this
        // unsubmitted attempt may release its slot; an overlapping replacement owns its own.
        synchronized(lock) {
          if (!attempt.submitted && mutableState.value.resolving[attempt.id] === attempt) {
            mutableState.value = mutableState.value.copy(resolving = mutableState.value.resolving - attempt.id)
          }
        }
      }
    }
  }

  private suspend fun reconcileApproval(
    request: RequestContext,
    id: String,
  ) {
    try {
      val result = parseWearApproval(request(request, "approval.get", buildJsonObject { put("id", id) })["approval"]) ?: error("Invalid approval")
      check(result.id == id)
      commit(request) {
        feed.replace(result)
        mutableState.value = mutableState.value.copy(resolving = mutableState.value.resolving - id)
        publishApprovals()
      }
    } catch (error: CancellationException) {
      throw error
    } catch (_: Exception) {
      // One unavailable approval must remain visible without blocking canonical chat history.
      commit(request) { mutableState.value = mutableState.value.copy(error = "Approval outcome is unconfirmed. Refresh to reconcile it.") }
    }
  }

  private fun receive(
    intent: Long,
    event: String,
    payload: String?,
  ) {
    if (!current(intent)) return
    if (event == "seqGap") {
      synchronized(lock) {
        feed.begin()
        mutableState.value = mutableState.value.copy(approvalsReady = false)
      }
      refresh()
      return
    }
    val obj = payload?.let { runCatching { Json.parseToJsonElement(it) as? JsonObject }.getOrNull() } ?: return
    synchronized(lock) {
      if (generation != intent) return
      if (event == "session.approval") {
        parseWearApprovalTransition(obj)?.let(feed::accept)
        publishApprovals()
      } else if (event == "chat" && matchesSelectedSession(obj)) {
        val state = mutableState.value
        val message = directChatMessage(obj["message"])
        val terminal = obj.text("state") in setOf("final", "aborted", "error")
        val run = obj.text("runId")
        val settlesRun = state.runId == null || state.runId == run
        // A displayed run and a newly submitted send can differ. Settling the former
        // must not fence the latter's ACK; foreign terminals still reconcile history.
        val ownsAcknowledgement = state.pendingSend?.let { it.key == run } ?: settlesRun
        if (!terminal || ownsAcknowledgement) chatRevision += 1
        historyRevision += 1
        mutableState.value =
          state.copy(
            streamText =
              when {
                !terminal -> message?.text
                settlesRun -> null
                else -> state.streamText
              },
            runId =
              when {
                !terminal -> run
                settlesRun -> null
                else -> state.runId
              },
            messages = if (terminal && message != null) (state.messages + message).takeLast(20) else state.messages,
          )
        if (terminal) scope.launch { capture()?.let { runCatching { loadHistory(it) } } }
      } else if ((event == "session.message" || (event == "sessions.changed" && obj.text("phase") == "message")) && matchesSelectedSession(obj)) {
        transcriptRevision += 1
        historyRevision += 1
        scope.launch { capture()?.let { runCatching { loadHistory(it) } } }
      }
    }
  }

  private fun matchesSelectedSession(event: JsonObject): Boolean {
    val selected = mutableState.value
    val key = event.text("sessionKey") ?: return false
    if (key != selected.sessionKey) return false
    // Unqualified keys are agent-local; only canonical agent keys identify their owner alone.
    val agentId = event.text("agentId")
    return if (agentId == null) key.startsWith("agent:") else agentId == selected.sessionAgentId
  }

  private fun publishApprovals() {
    mutableState.value =
      mutableState.value.copy(
        approvals = feed.approvals,
        approvalsReady = feed.ready,
        approvalsIncomplete = feed.incomplete,
      )
  }

  private fun current(intent: Long): Boolean = synchronized(lock) { generation == intent }

  private fun publish(
    intent: Long,
    update: WearDirectState.() -> WearDirectState,
  ) {
    synchronized(lock) { if (generation == intent) mutableState.value = mutableState.value.update() }
  }
}

internal fun directChatMessage(value: kotlinx.serialization.json.JsonElement?): WearChatMessage? {
  val obj = value as? JsonObject ?: return null
  val role = obj.text("role")?.takeIf { it in setOf("user", "assistant", "system") } ?: return null
  val text = wearReplyText(obj, maxChars = 4001)
  if (text.isBlank()) return null
  val preview = text.take(4000).let { if (it.lastOrNull()?.isHighSurrogate() == true) it.dropLast(1) else it }
  return WearChatMessage(
    obj.text("id"),
    role,
    preview,
    obj.number("timestamp"),
    entryId = wearReplyEntryId(obj)?.takeIf { it.length <= 512 && !wearReplyIsSynthetic(obj) },
    textTruncated = preview != text || wearReplyIsTruncated(obj, 2000),
  )
}
