package ai.openclaw.wear

import android.app.Application
import android.os.PowerManager
import android.util.Log
import ai.openclaw.wear.R
import ai.openclaw.wear.chat.WearChatController
import ai.openclaw.wear.gateway.GatewayClientInterface
import ai.openclaw.wear.gateway.PhoneProxyClient
import ai.openclaw.wear.gateway.WearGatewayClient
import ai.openclaw.wear.gateway.WearGatewayConfigStore
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

@OptIn(ExperimentalCoroutinesApi::class)
class WearApp : Application() {
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  lateinit var configStore: WearGatewayConfigStore
  lateinit var chatController: WearChatController
  private lateinit var replyNotifier: WearReplyNotifier

  // Emits the current active client — derived flows auto-switch via flatMapLatest
  private val _activeClientFlow = MutableStateFlow<GatewayClientInterface?>(null)
  @Volatile
  private var activityVisible = false

  lateinit var activeClient: GatewayClientInterface
    private set

  var directClient: WearGatewayClient? = null
    private set
  var proxyClient: PhoneProxyClient? = null
    private set

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
    val config = configStore.load()

    if (config.usePhoneProxy) {
      val proxy = PhoneProxyClient(this)
      proxyClient = proxy
      activeClient = proxy
    } else {
      val direct = WearGatewayClient(this)
      directClient = direct
      activeClient = direct
    }

    _activeClientFlow.value = activeClient
    chatController = WearChatController(scope, activeClient, ::getString)

    // Connect with the configured mode
    if (config.usePhoneProxy) {
      Log.i(TAG, "Starting phone proxy connection")
      proxyClient?.connect()
    } else if (config.isValid) {
      Log.i(TAG, "Starting direct gateway connection")
      directClient?.configure(config)
      directClient?.connect()
    }

    // Watch connection state — uses flatMapLatest so it auto-tracks client switches
    startConnectionWatcher()
    startReplyNotificationWatcher()
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

  /**
   * Switch between direct and phone proxy mode.
   * Disconnects the current client and connects the new one.
   */
  fun switchConnectionMode(usePhoneProxy: Boolean) {
    Log.i(TAG, "Switching connection mode: usePhoneProxy=$usePhoneProxy")

    // Disconnect current
    directClient?.shutdown()
    proxyClient?.disconnect()

    val config = configStore.load()

    if (usePhoneProxy) {
      directClient = null
      val proxy = PhoneProxyClient(this)
      proxyClient = proxy
      activeClient = proxy
      _activeClientFlow.value = proxy // triggers flatMapLatest → ViewModel sees new flows
      chatController.switchClient(proxy)
      Log.i(TAG, "Created PhoneProxyClient, calling connect()")
      proxy.connect()
    } else {
      proxyClient = null
      val direct = WearGatewayClient(this)
      directClient = direct
      activeClient = direct
      _activeClientFlow.value = direct
      chatController.switchClient(direct)
      if (config.isValid) {
        direct.configure(config)
        direct.connect()
      }
    }
  }
}
