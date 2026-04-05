package ai.openclaw.wear

import android.app.Application
import android.os.PowerManager
import android.util.Log
import ai.openclaw.wear.R
import ai.openclaw.wear.chat.WearChatController
import ai.openclaw.wear.gateway.GatewayClientInterface
import ai.openclaw.wear.gateway.PhoneProxyClient
import ai.openclaw.wear.gateway.SharedPrefsWearGatewayTlsPinStore
import ai.openclaw.wear.gateway.WearGatewayClient
import ai.openclaw.wear.gateway.WearGatewayConfig
import ai.openclaw.wear.gateway.WearGatewayConfigStore
import ai.openclaw.wear.gateway.resolveWearGatewayStableId
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

private const val TAG = "WearApp"

internal fun activateWearGatewayClient(
  currentClient: GatewayClientInterface,
  nextClient: GatewayClientInterface,
  setActiveClient: (GatewayClientInterface) -> Unit,
  switchClient: (GatewayClientInterface) -> Unit,
  onConnected: () -> Unit,
) {
  if (currentClient === nextClient) {
    return
  }
  setActiveClient(nextClient)
  switchClient(nextClient)
  if (nextClient.connected.value) {
    onConnected()
  }
}

@OptIn(ExperimentalCoroutinesApi::class)
class WearApp : Application() {
  private data class DirectConnectionSpec(
    val host: String,
    val port: Int,
    val token: String,
    val bootstrapToken: String,
    val password: String,
    val useTls: Boolean,
  )

  val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  lateinit var configStore: WearGatewayConfigStore
  lateinit var chatController: WearChatController
  private lateinit var replyNotifier: WearReplyNotifier
  private lateinit var tlsPinStore: SharedPrefsWearGatewayTlsPinStore
  private val _config = MutableStateFlow(WearGatewayConfig())
  val config: StateFlow<WearGatewayConfig> = _config

  // Emits the current active client — derived flows auto-switch via flatMapLatest
  private val _activeClientFlow = MutableStateFlow<GatewayClientInterface?>(null)
  @Volatile
  private var activityVisible = false

  lateinit var activeClient: GatewayClientInterface
    private set

  lateinit var directClient: WearGatewayClient
    private set
  lateinit var proxyClient: PhoneProxyClient
    private set

  private var proxyPolicyJob: Job? = null
  private var proxyStarted = false
  private var directStarted = false
  private var lastDirectSpec: DirectConnectionSpec? = null
  private var reconnectPaused = false

  /** Always tracks the CURRENT active client's connected state. */
  val connected: StateFlow<Boolean> by lazy {
    _activeClientFlow.flatMapLatest { client ->
      client?.connected ?: MutableStateFlow(false)
    }.stateIn(scope, SharingStarted.Eagerly, false)
  }

  /** Always tracks the CURRENT active client's status text. */
  val statusText: StateFlow<String> by lazy {
    _activeClientFlow.flatMapLatest { client ->
      client?.statusText ?: MutableStateFlow(getString(R.string.wear_status_offline))
    }.stateIn(scope, SharingStarted.Eagerly, getString(R.string.wear_status_offline))
  }

  private var connectionWatcherJob: Job? = null
  private var replyNotificationJob: Job? = null

  override fun onCreate() {
    super.onCreate()
    configStore = WearGatewayConfigStore(this)
    replyNotifier = WearReplyNotifier(this)
    tlsPinStore = SharedPrefsWearGatewayTlsPinStore(this)
    val initialConfig = configStore.load()
    _config.value = initialConfig

    directClient = WearGatewayClient(this, tlsPinStore)
    proxyClient = PhoneProxyClient(this, onGatewayConfigSynced = ::applySyncedGatewayConfig)
    activeClient = if (initialConfig.usePhoneProxy) proxyClient else directClient

    _activeClientFlow.value = activeClient
    chatController = WearChatController(scope, activeClient, ::getString)

    // Watch connection state — uses flatMapLatest so it auto-tracks client switches
    startConnectionWatcher()
    startReplyNotificationWatcher()
    applyConnectionPolicy(forceReconnect = true)
    startProxyPolicyWatcher()
  }

  private fun startConnectionWatcher() {
    connectionWatcherJob?.cancel()
    connectionWatcherJob = scope.launch {
      connected.collect { isConnected ->
        Log.i(TAG, "Connection state changed: $isConnected")
        if (isConnected) {
          chatController.onConnected()
        } else {
          chatController.onDisconnected()
        }
      }
    }
  }

  private fun startReplyNotificationWatcher() {
    replyNotificationJob?.cancel()
    replyNotificationJob = scope.launch {
      chatController.assistantReplies.collect { reply ->
        if (shouldNotifyForReply()) {
          replyNotifier.showAssistantReply(reply)
        }
      }
    }
  }

  fun onActivityVisibilityChanged(visible: Boolean) {
    activityVisible = visible
    if (visible) {
      replyNotifier.dismissReplyNotification()
    }
  }

  private fun shouldNotifyForReply(): Boolean {
    val powerManager = getSystemService(PowerManager::class.java)
    val isScreenInteractive = powerManager?.isInteractive ?: true
    return !activityVisible || !isScreenInteractive
  }

  /** Updates whether the watch should prefer the phone proxy over direct fallback. */
  fun switchConnectionMode(usePhoneProxy: Boolean) {
    saveConnectionConfig(_config.value.copy(usePhoneProxy = usePhoneProxy))
  }

  fun saveChatConfig(config: WearGatewayConfig) {
    persistConfig(config)
  }

  fun saveConnectionConfig(config: WearGatewayConfig) {
    val previous = _config.value
    persistConfig(config)
    if (!reconnectPaused) {
      applyConnectionPolicy(forceReconnect = hasConnectionRelevantChanges(previous, config))
    }
  }

  fun reconnect() {
    reconnectPaused = false
    applyConnectionPolicy(forceReconnect = true)
  }

  fun disconnect() {
    reconnectPaused = true
    stopDirectClient()
    stopProxyClient()
  }

  private fun startProxyPolicyWatcher() {
    proxyPolicyJob?.cancel()
    proxyPolicyJob =
      scope.launch {
        proxyClient.connected.collect {
          if (!reconnectPaused && _config.value.usePhoneProxy) {
            applyConnectionPolicy(forceReconnect = false)
          }
        }
      }
  }

  private fun persistConfig(config: WearGatewayConfig) {
    configStore.save(config)
    _config.value = config
  }

  private fun applySyncedGatewayConfig(config: WearGatewayConfig, tlsFingerprintSha256: String?) {
    val previous = _config.value
    val merged =
      previous.copy(
        host = config.host,
        port = config.port,
        token = config.token,
        bootstrapToken = config.bootstrapToken,
        password = config.password,
        useTls = config.useTls,
      )

    tlsFingerprintSha256?.trim()?.takeIf { it.isNotEmpty() }?.let { fingerprint ->
      tlsPinStore.save(resolveWearGatewayStableId(merged), fingerprint)
    }

    if (merged == previous) {
      if (!reconnectPaused && previous.usePhoneProxy) {
        applyConnectionPolicy(forceReconnect = false)
      }
      return
    }

    persistConfig(merged)
    if (!reconnectPaused) {
      applyConnectionPolicy(forceReconnect = activeClient === directClient && hasConnectionRelevantChanges(previous, merged))
    }
  }

  private fun applyConnectionPolicy(forceReconnect: Boolean) {
    val config = _config.value
    Log.i(
      TAG,
      "Applying connection policy: usePhoneProxy=${config.usePhoneProxy} directConfigured=${config.hasDirectConnection} forceReconnect=$forceReconnect",
    )

    if (config.usePhoneProxy) {
      startProxyClient(forceReconnect = forceReconnect)
      if (proxyClient.connected.value) {
        activateClient(proxyClient)
        stopDirectClient()
        return
      }

      if (config.hasDirectConnection) {
        activateClient(directClient)
        startDirectClient(config, forceReconnect = forceReconnect)
      } else {
        activateClient(proxyClient)
        stopDirectClient()
      }
      return
    }

    stopProxyClient()
    activateClient(directClient)
    if (config.hasDirectConnection) {
      startDirectClient(config, forceReconnect = forceReconnect)
    } else {
      stopDirectClient()
    }
  }

  private fun activateClient(client: GatewayClientInterface) {
    activateWearGatewayClient(
      currentClient = activeClient,
      nextClient = client,
      setActiveClient = { nextClient ->
        activeClient = nextClient
        _activeClientFlow.value = nextClient
      },
      switchClient = chatController::switchClient,
      onConnected = chatController::onConnected,
    )
  }

  private fun startProxyClient(forceReconnect: Boolean) {
    if (forceReconnect && proxyStarted) {
      proxyClient.disconnect()
      proxyStarted = false
    }
    if (!proxyStarted) {
      Log.i(TAG, "Starting phone proxy connection")
      proxyStarted = true
      proxyClient.connect()
    }
  }

  private fun stopProxyClient() {
    if (!proxyStarted) {
      return
    }
    proxyStarted = false
    proxyClient.disconnect()
  }

  private fun startDirectClient(config: WearGatewayConfig, forceReconnect: Boolean) {
    val spec = config.toDirectConnectionSpec()
    directClient.configure(config)
    if (!directStarted || forceReconnect || lastDirectSpec != spec) {
      Log.i(TAG, "Starting direct gateway connection")
      directStarted = true
      lastDirectSpec = spec
      directClient.connect()
    }
  }

  private fun stopDirectClient() {
    if (!directStarted && !directClient.connected.value) {
      lastDirectSpec = null
      return
    }
    directStarted = false
    lastDirectSpec = null
    directClient.disconnect()
  }

  private fun hasConnectionRelevantChanges(previous: WearGatewayConfig, current: WearGatewayConfig): Boolean {
    return previous.host != current.host ||
      previous.port != current.port ||
      previous.token != current.token ||
      previous.bootstrapToken != current.bootstrapToken ||
      previous.password != current.password ||
      previous.useTls != current.useTls ||
      previous.usePhoneProxy != current.usePhoneProxy
  }

  private fun WearGatewayConfig.toDirectConnectionSpec(): DirectConnectionSpec {
    return DirectConnectionSpec(
      host = host,
      port = port,
      token = token,
      bootstrapToken = bootstrapToken,
      password = password,
      useTls = useTls,
    )
  }
}
