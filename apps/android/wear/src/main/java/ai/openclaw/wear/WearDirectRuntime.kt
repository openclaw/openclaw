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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
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
  val key: String = "wear-${UUID.randomUUID()}",
)

internal data class WearDirectSession(
  val key: String,
  val title: String,
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
  val resolving: Set<String> = emptySet(),
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
  private var selectionRevision = 0L
  private var visible = false
  private var stopped = false
  private var owner: Owner? = null
  private var feed = WearApprovalFeed()
  private var conversation = 0L
  private var historyRevision = 0L
  private var chatRevision = 0L
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
        generation
      }
    return { enqueue ->
      synchronized(lock) {
        if (generation != selected || !isPhoneProxySelected()) throw WearProxyException("phone_changed", "Watch connection changed")
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
      changeIntent { publish(it) { copy(status = "Paused") } }
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
        check(store.registry.setActive(stableId)) { "Could not save the selected Gateway." }
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
        check(store.registry.setActive(null)) { "Could not save Phone Proxy selection." }
      }
      publishRegistry(intent, clearConversation = true)
    }
  }

  fun forget(stableId: String) {
    invalidateInput()
    changeIntent { intent ->
      val deviceId = identity.loadOrCreate().deviceId
      synchronized(lock) {
        if (generation != intent) return@changeIntent
        store.forget(stableId, deviceId)
      }
      publishRegistry(intent, clearConversation = true)
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

  private fun changeIntent(action: suspend (Long) -> Unit) {
    val (intent, retired) =
      synchronized(lock) {
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
          publish(intent) { copy(error = "Could not update the watch connection. Retry or enter a new limited setup code.") }
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

  fun selectSession(key: String) {
    invalidateInput()
    synchronized(lock) {
      conversation += 1
      feed = WearApprovalFeed()
      mutableState.value =
        mutableState.value.copy(
          sessionKey = key,
          messages = emptyList(),
          approvals = emptyList(),
          approvalsReady = false,
          streamText = null,
          runId = null,
          pendingSend = null,
          sending = false,
          sendUnknown = false,
          resolving = emptySet(),
        )
    }
    // Replacing the socket drops all old session subscriptions and their late events.
    reconnect()
  }

  private data class RequestContext(
    val intent: Long,
    val conversation: Long,
    val lease: GatewaySession.RequestLease,
  )

  private fun capture(): RequestContext? {
    val snapshot = synchronized(lock) { owner?.let { Triple(it, generation, conversation) } } ?: return null
    val lease = snapshot.first.session.captureRequestLease() ?: return null
    return RequestContext(snapshot.second, snapshot.third, lease).takeIf { requestCurrent(it) }
  }

  private fun requestCurrent(request: RequestContext): Boolean = synchronized(lock) { generation == request.intent && conversation == request.conversation && visible && !stopped }

  private suspend fun request(
    request: RequestContext,
    method: String,
    params: JsonObject,
  ): JsonObject {
    val raw =
      request.lease.request(method, params.toString(), withEnqueue = { enqueue ->
        synchronized(lock) {
          if (!requestCurrent(request)) throw GatewayRequestNotEnqueued("Watch route changed")
          enqueue()
        }
      })
    return Json.parseToJsonElement(raw) as? JsonObject ?: error("Invalid Gateway result")
  }

  private fun commit(
    request: RequestContext,
    action: () -> Unit,
  ) {
    request.lease.commitIfCurrent {
      synchronized(lock) { if (requestCurrent(request)) action() }
    }
  }

  fun refresh() {
    val request = capture() ?: return
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
            WearDirectSession(key, (obj.text("displayName") ?: obj.text("label") ?: key).take(160))
          }
        commit(request) {
          mutableState.value = mutableState.value.copy(sessions = sessions, error = null)
        }
        subscribe(request)
        loadHistory(request)
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        commit(request) { mutableState.value = mutableState.value.copy(error = "Could not refresh this conversation. Retry.") }
      }
    }
  }

  private suspend fun subscribe(request: RequestContext) {
    val key = state.value.sessionKey ?: return
    commit(request) {
      feed.begin()
      mutableState.value = mutableState.value.copy(approvalsReady = false)
    }
    val subscribed =
      request(
        request,
        "sessions.messages.subscribe",
        buildJsonObject {
          put("key", key)
          put("includeApprovals", true)
        },
      )
    commit(request) {
      val replay = subscribed["approvalReplay"] as? JsonObject
      if (subscribed.flag("subscribed") != true || replay == null || !feed.replay(replay)) {
        mutableState.value = mutableState.value.copy(error = "Approval replay is unavailable. Reconnect to refresh.", approvalsReady = false)
      } else {
        mutableState.value = mutableState.value.copy(sessionKey = subscribed.text("key") ?: key)
        publishApprovals()
      }
    }
    request(request, "chat.subscribe", buildJsonObject { put("sessionKey", state.value.sessionKey ?: key) })
    state.value.resolving
      .toList()
      .forEach { id -> reconcileApproval(request, id) }
  }

  private suspend fun loadHistory(
    request: RequestContext,
    expectedChatRevision: Long? = null,
  ) {
    // Newer loads, admitted sends, send acknowledgements, and events supersede this snapshot.
    var admitted: Pair<String, Long>? = null
    commit(request) {
      if (expectedChatRevision != null && chatRevision != expectedChatRevision) return@commit
      val key = mutableState.value.sessionKey ?: return@commit
      historyRevision += 1
      admitted = key to historyRevision
    }
    val (key, revision) = admitted ?: return
    val result =
      request(
        request,
        "chat.history",
        buildJsonObject {
          put("sessionKey", key)
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
        WearDirectSend(state.sessionKey ?: return, text).also {
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
    var admitted: Long? = null
    commit(request) {
      val state = mutableState.value
      if (state.pendingSend !== attempt || state.sending) return@commit
      historyRevision += 1
      mutableState.value = state.copy(sending = true, error = null)
      admitted = chatRevision
    }
    val revision = admitted ?: return
    scope.launch {
      val result =
        try {
          request(
            request,
            "chat.send",
            buildJsonObject {
              put("sessionKey", attempt.sessionKey)
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
        reconcile = unchanged && !active
        if (adoptRun) historyRevision += 1
        mutableState.value =
          mutableState.value.copy(
            sending = false,
            pendingSend = null,
            sendUnknown = false,
            runId = if (adoptRun) result.text("runId") else mutableState.value.runId,
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
    var target: Pair<String, String>? = null
    commit(request) {
      val state = mutableState.value
      val key = state.sessionKey ?: return@commit
      val run = state.runId ?: return@commit
      target = key to run
    }
    val (key, run) = target ?: return
    scope.launch {
      try {
        // Exact-run sessions.abort also reaches recovered embedded owners without retargeting a replacement.
        request(
          request,
          "sessions.abort",
          buildJsonObject {
            put("key", key)
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
    val request = capture() ?: return
    val admitted =
      synchronized(lock) {
        val state = mutableState.value
        if (!state.approvalsReady || approval.id in state.resolving ||
          !approval.canResolve(decision, System.currentTimeMillis())
        ) {
          false
        } else {
          mutableState.value = state.copy(resolving = state.resolving + approval.id)
          true
        }
      }
    if (!admitted) return
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
          mutableState.value = mutableState.value.copy(error = "Approval outcome is unconfirmed. Refresh to reconcile it.")
        }
        if (error is CancellationException) throw error
      }
    }
  }

  private suspend fun reconcileApproval(
    request: RequestContext,
    id: String,
  ) {
    val result = parseWearApproval(request(request, "approval.get", buildJsonObject { put("id", id) })["approval"]) ?: return
    if (result.id != id) return
    commit(request) {
      feed.replace(result)
      mutableState.value = mutableState.value.copy(resolving = mutableState.value.resolving - id)
      publishApprovals()
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
      } else if (event == "chat" && obj.text("sessionKey") == mutableState.value.sessionKey) {
        chatRevision += 1
        historyRevision += 1
        val message = directChatMessage(obj["message"])
        val terminal = obj.text("state") in setOf("final", "aborted", "error")
        mutableState.value =
          mutableState.value.copy(
            streamText = if (terminal) null else message?.text,
            runId = if (terminal) null else obj.text("runId"),
            messages = if (terminal && message != null) (mutableState.value.messages + message).takeLast(20) else mutableState.value.messages,
          )
        if (terminal) scope.launch { capture()?.let { runCatching { loadHistory(it) } } }
      } else if (event == "session.message" && obj.text("sessionKey") == mutableState.value.sessionKey) {
        historyRevision += 1
        scope.launch { capture()?.let { runCatching { loadHistory(it) } } }
      }
    }
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
  val content = obj["content"]
  val text =
    if (content is JsonPrimitive) {
      content.contentOrNull
    } else {
      (content as? JsonArray)
        ?.take(20)
        ?.mapNotNull { (it as? JsonObject)?.takeIf { part -> part.text("type") == "text" }?.text("text") }
        ?.joinToString("\n")
    }
  return text?.takeIf { it.isNotBlank() }?.let { WearChatMessage(obj.text("id"), role, it.take(4000), obj.number("timestamp")) }
}
