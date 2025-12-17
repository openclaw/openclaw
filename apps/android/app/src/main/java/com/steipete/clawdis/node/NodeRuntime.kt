package com.steipete.clawdis.node

import android.content.Context
import android.os.Build
import com.steipete.clawdis.node.chat.ChatController
import com.steipete.clawdis.node.chat.ChatMessage
import com.steipete.clawdis.node.chat.ChatPendingToolCall
import com.steipete.clawdis.node.chat.ChatSessionEntry
import com.steipete.clawdis.node.chat.OutgoingAttachment
import com.steipete.clawdis.node.bridge.BridgeDiscovery
import com.steipete.clawdis.node.bridge.BridgeEndpoint
import com.steipete.clawdis.node.bridge.BridgePairingClient
import com.steipete.clawdis.node.bridge.BridgeSession
import com.steipete.clawdis.node.node.CameraCaptureManager
import com.steipete.clawdis.node.node.CanvasController
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class NodeRuntime(context: Context) {
  private val appContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  val prefs = SecurePrefs(appContext)
  val canvas = CanvasController()
  val camera = CameraCaptureManager(appContext)
  private val json = Json { ignoreUnknownKeys = true }

  private val discovery = BridgeDiscovery(appContext, scope = scope)
  val bridges: StateFlow<List<BridgeEndpoint>> = discovery.bridges

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

  private val _statusText = MutableStateFlow("Offline")
  val statusText: StateFlow<String> = _statusText.asStateFlow()

  private val _serverName = MutableStateFlow<String?>(null)
  val serverName: StateFlow<String?> = _serverName.asStateFlow()

  private val _remoteAddress = MutableStateFlow<String?>(null)
  val remoteAddress: StateFlow<String?> = _remoteAddress.asStateFlow()

  private val _isForeground = MutableStateFlow(true)
  val isForeground: StateFlow<Boolean> = _isForeground.asStateFlow()

  private val session =
    BridgeSession(
      scope = scope,
      onConnected = { name, remote ->
        _statusText.value = "Connected"
        _serverName.value = name
        _remoteAddress.value = remote
        _isConnected.value = true
        scope.launch { refreshWakeWordsFromGateway() }
      },
      onDisconnected = { message -> handleSessionDisconnected(message) },
      onEvent = { event, payloadJson ->
        handleBridgeEvent(event, payloadJson)
      },
      onInvoke = { req ->
        handleInvoke(req.command, req.paramsJson)
      },
    )

  private val chat = ChatController(scope = scope, session = session, json = json)

  private fun handleSessionDisconnected(message: String) {
    _statusText.value = message
    _serverName.value = null
    _remoteAddress.value = null
    _isConnected.value = false
    chat.onDisconnected(message)
  }

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val preventSleep: StateFlow<Boolean> = prefs.preventSleep
  val wakeWords: StateFlow<List<String>> = prefs.wakeWords
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId

  private var didAutoConnect = false
  private var suppressWakeWordsSync = false
  private var wakeWordsSyncJob: Job? = null

  val chatSessionKey: StateFlow<String> = chat.sessionKey
  val chatSessionId: StateFlow<String?> = chat.sessionId
  val chatMessages: StateFlow<List<ChatMessage>> = chat.messages
  val chatError: StateFlow<String?> = chat.errorText
  val chatHealthOk: StateFlow<Boolean> = chat.healthOk
  val chatThinkingLevel: StateFlow<String> = chat.thinkingLevel
  val chatStreamingAssistantText: StateFlow<String?> = chat.streamingAssistantText
  val chatPendingToolCalls: StateFlow<List<ChatPendingToolCall>> = chat.pendingToolCalls
  val chatSessions: StateFlow<List<ChatSessionEntry>> = chat.sessions
  val pendingRunCount: StateFlow<Int> = chat.pendingRunCount

  init {
    scope.launch(Dispatchers.Default) {
      bridges.collect { list ->
        if (list.isNotEmpty()) {
          // Persist the last discovered bridge (best-effort UX parity with iOS).
          prefs.setLastDiscoveredStableId(list.last().stableId)
        }

        if (didAutoConnect) return@collect
        if (_isConnected.value) return@collect

        val token = prefs.loadBridgeToken()
        if (token.isNullOrBlank()) return@collect

        if (manualEnabled.value) {
          val host = manualHost.value.trim()
          val port = manualPort.value
          if (host.isNotEmpty() && port in 1..65535) {
            didAutoConnect = true
            connect(BridgeEndpoint.manual(host = host, port = port))
          }
          return@collect
        }

        val targetStableId = lastDiscoveredStableId.value.trim()
        if (targetStableId.isEmpty()) return@collect
        val target = list.firstOrNull { it.stableId == targetStableId } ?: return@collect
        didAutoConnect = true
        connect(target)
      }
    }
  }

  fun setForeground(value: Boolean) {
    _isForeground.value = value
  }

  fun setDisplayName(value: String) {
    prefs.setDisplayName(value)
  }

  fun setCameraEnabled(value: Boolean) {
    prefs.setCameraEnabled(value)
  }

  fun setPreventSleep(value: Boolean) {
    prefs.setPreventSleep(value)
  }

  fun setManualEnabled(value: Boolean) {
    prefs.setManualEnabled(value)
  }

  fun setManualHost(value: String) {
    prefs.setManualHost(value)
  }

  fun setManualPort(value: Int) {
    prefs.setManualPort(value)
  }

  fun setWakeWords(words: List<String>) {
    prefs.setWakeWords(words)
    scheduleWakeWordsSyncIfNeeded()
  }

  fun resetWakeWordsDefaults() {
    setWakeWords(SecurePrefs.defaultWakeWords)
  }

  fun connect(endpoint: BridgeEndpoint) {
    scope.launch {
      _statusText.value = "Connecting…"
      val storedToken = prefs.loadBridgeToken()
      val modelIdentifier = listOfNotNull(Build.MANUFACTURER, Build.MODEL)
        .joinToString(" ")
        .trim()
        .ifEmpty { null }
      val resolved =
        if (storedToken.isNullOrBlank()) {
          _statusText.value = "Pairing…"
          val caps = buildList {
            add("canvas")
            if (cameraEnabled.value) add("camera")
          }
          BridgePairingClient().pairAndHello(
            endpoint = endpoint,
            hello =
              BridgePairingClient.Hello(
                nodeId = instanceId.value,
                displayName = displayName.value,
                token = null,
                platform = "Android",
                version = "dev",
                deviceFamily = "Android",
                modelIdentifier = modelIdentifier,
                caps = caps,
              ),
          )
        } else {
          BridgePairingClient.PairResult(ok = true, token = storedToken.trim())
        }

      if (!resolved.ok || resolved.token.isNullOrBlank()) {
        _statusText.value = "Failed: pairing required"
        return@launch
      }

      val authToken = requireNotNull(resolved.token).trim()
      prefs.saveBridgeToken(authToken)
      session.connect(
        endpoint = endpoint,
        hello =
          BridgeSession.Hello(
            nodeId = instanceId.value,
            displayName = displayName.value,
            token = authToken,
            platform = "Android",
            version = "dev",
            deviceFamily = "Android",
            modelIdentifier = modelIdentifier,
            caps =
              buildList {
                add("canvas")
                if (cameraEnabled.value) add("camera")
              },
          ),
      )
    }
  }

  fun connectManual() {
    val host = manualHost.value.trim()
    val port = manualPort.value
    if (host.isEmpty() || port <= 0 || port > 65535) {
      _statusText.value = "Failed: invalid manual host/port"
      return
    }
    connect(BridgeEndpoint.manual(host = host, port = port))
  }

  fun disconnect() {
    session.disconnect()
  }

  fun loadChat(sessionKey: String = "main") {
    chat.load(sessionKey)
  }

  fun refreshChat() {
    chat.refresh()
  }

  fun refreshChatSessions(limit: Int? = null) {
    chat.refreshSessions(limit = limit)
  }

  fun setChatThinkingLevel(level: String) {
    chat.setThinkingLevel(level)
  }

  fun switchChatSession(sessionKey: String) {
    chat.switchSession(sessionKey)
  }

  fun abortChat() {
    chat.abort()
  }

  fun sendChat(message: String, thinking: String, attachments: List<OutgoingAttachment>) {
    chat.sendMessage(message = message, thinkingLevel = thinking, attachments = attachments)
  }

  private fun handleBridgeEvent(event: String, payloadJson: String?) {
    if (event == "voicewake.changed") {
      if (payloadJson.isNullOrBlank()) return
      try {
        val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
        val array = payload["triggers"] as? JsonArray ?: return
        val triggers = array.mapNotNull { it.asStringOrNull() }
        applyWakeWordsFromGateway(triggers)
      } catch (_: Throwable) {
        // ignore
      }
      return
    }

    chat.handleBridgeEvent(event, payloadJson)
  }

  private fun applyWakeWordsFromGateway(words: List<String>) {
    suppressWakeWordsSync = true
    prefs.setWakeWords(words)
    suppressWakeWordsSync = false
  }

  private fun scheduleWakeWordsSyncIfNeeded() {
    if (suppressWakeWordsSync) return
    if (!_isConnected.value) return

    val snapshot = prefs.wakeWords.value
    wakeWordsSyncJob?.cancel()
    wakeWordsSyncJob =
      scope.launch {
        delay(650)
        val jsonList = snapshot.joinToString(separator = ",") { it.toJsonString() }
        val params = """{"triggers":[$jsonList]}"""
        try {
          session.request("voicewake.set", params)
        } catch (_: Throwable) {
          // ignore
        }
      }
  }

  private suspend fun refreshWakeWordsFromGateway() {
    if (!_isConnected.value) return
    try {
      val res = session.request("voicewake.get", "{}")
      val payload = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val array = payload["triggers"] as? JsonArray ?: return
      val triggers = array.mapNotNull { it.asStringOrNull() }
      applyWakeWordsFromGateway(triggers)
    } catch (_: Throwable) {
      // ignore
    }
  }

  private suspend fun handleInvoke(command: String, paramsJson: String?): BridgeSession.InvokeResult {
    if (command.startsWith("screen.") || command.startsWith("camera.")) {
      if (!isForeground.value) {
        return BridgeSession.InvokeResult.error(
          code = "NODE_BACKGROUND_UNAVAILABLE",
          message = "NODE_BACKGROUND_UNAVAILABLE: screen/camera commands require foreground",
        )
      }
    }
    if (command.startsWith("camera.") && !cameraEnabled.value) {
      return BridgeSession.InvokeResult.error(
        code = "CAMERA_DISABLED",
        message = "CAMERA_DISABLED: enable Camera in Settings",
      )
    }

    return when (command) {
      "screen.show" -> BridgeSession.InvokeResult.ok(null)
      "screen.hide" -> BridgeSession.InvokeResult.ok(null)
      "screen.setMode" -> {
        val mode = CanvasController.parseMode(paramsJson)
        canvas.setMode(mode)
        BridgeSession.InvokeResult.ok(null)
      }
      "screen.navigate" -> {
        val url = CanvasController.parseNavigateUrl(paramsJson)
        if (url != null) canvas.navigate(url)
        BridgeSession.InvokeResult.ok(null)
      }
      "screen.eval" -> {
        val js =
          CanvasController.parseEvalJs(paramsJson)
            ?: return BridgeSession.InvokeResult.error(
              code = "INVALID_REQUEST",
              message = "INVALID_REQUEST: javaScript required",
            )
        val result =
          try {
            canvas.eval(js)
          } catch (err: Throwable) {
            return BridgeSession.InvokeResult.error(
              code = "NODE_BACKGROUND_UNAVAILABLE",
              message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
            )
          }
        BridgeSession.InvokeResult.ok("""{"result":${result.toJsonString()}}""")
      }
      "screen.snapshot" -> {
        val maxWidth = CanvasController.parseSnapshotMaxWidth(paramsJson)
        val base64 =
          try {
            canvas.snapshotPngBase64(maxWidth = maxWidth)
          } catch (err: Throwable) {
            return BridgeSession.InvokeResult.error(
              code = "NODE_BACKGROUND_UNAVAILABLE",
              message = "NODE_BACKGROUND_UNAVAILABLE: canvas unavailable",
            )
          }
        BridgeSession.InvokeResult.ok("""{"format":"png","base64":"$base64"}""")
      }
      "camera.snap" -> {
        val res = camera.snap(paramsJson)
        BridgeSession.InvokeResult.ok(res.payloadJson)
      }
      "camera.clip" -> {
        val res = camera.clip(paramsJson)
        BridgeSession.InvokeResult.ok(res.payloadJson)
      }
      else ->
        BridgeSession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: unknown command",
        )
    }
  }
}

private fun String.toJsonString(): String {
  val escaped =
    this.replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
  return "\"$escaped\""
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }
