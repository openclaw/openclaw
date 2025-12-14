package com.steipete.clawdis.node

import android.content.Context
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

  private val discovery = BridgeDiscovery(appContext)
  val bridges: StateFlow<List<BridgeEndpoint>> = discovery.bridges

  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

  private val _statusText = MutableStateFlow("Not connected")
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
      onDisconnected = { message ->
        _statusText.value = message
        _serverName.value = null
        _remoteAddress.value = null
        _isConnected.value = false
      },
      onEvent = { event, payloadJson ->
        handleBridgeEvent(event, payloadJson)
      },
      onInvoke = { req ->
        handleInvoke(req.command, req.paramsJson)
      },
    )

  val instanceId: StateFlow<String> = prefs.instanceId
  val displayName: StateFlow<String> = prefs.displayName
  val cameraEnabled: StateFlow<Boolean> = prefs.cameraEnabled
  val wakeWords: StateFlow<List<String>> = prefs.wakeWords
  val manualEnabled: StateFlow<Boolean> = prefs.manualEnabled
  val manualHost: StateFlow<String> = prefs.manualHost
  val manualPort: StateFlow<Int> = prefs.manualPort
  val lastDiscoveredStableId: StateFlow<String> = prefs.lastDiscoveredStableId

  private var didAutoConnect = false
  private var suppressWakeWordsSync = false
  private var wakeWordsSyncJob: Job? = null

  data class ChatMessage(val id: String, val role: String, val text: String, val timestampMs: Long?)

  private val _chatMessages = MutableStateFlow<List<ChatMessage>>(emptyList())
  val chatMessages: StateFlow<List<ChatMessage>> = _chatMessages.asStateFlow()

  private val _chatError = MutableStateFlow<String?>(null)
  val chatError: StateFlow<String?> = _chatError.asStateFlow()

  private val pendingRuns = mutableSetOf<String>()
  private val _pendingRunCount = MutableStateFlow(0)
  val pendingRunCount: StateFlow<Int> = _pendingRunCount.asStateFlow()

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
      val resolved =
        if (storedToken.isNullOrBlank()) {
          _statusText.value = "Pairing…"
          BridgePairingClient().pairAndHello(
            endpoint = endpoint,
            hello =
              BridgePairingClient.Hello(
                nodeId = instanceId.value,
                displayName = displayName.value,
                token = null,
                platform = "Android",
                version = "dev",
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
    scope.launch {
      _chatError.value = null
      try {
        // Best-effort; push events are optional, but improve latency.
        session.sendEvent("chat.subscribe", """{"sessionKey":"$sessionKey"}""")
      } catch (_: Throwable) {
        // ignore
      }

      try {
        val res = session.request("chat.history", """{"sessionKey":"$sessionKey"}""")
        _chatMessages.value = parseHistory(res)
      } catch (e: Exception) {
        _chatError.value = e.message
      }
    }
  }

  fun sendChat(sessionKey: String = "main", message: String, thinking: String = "off") {
    val trimmed = message.trim()
    if (trimmed.isEmpty()) return
    scope.launch {
      _chatError.value = null
      val idem = java.util.UUID.randomUUID().toString()

      _chatMessages.value =
        _chatMessages.value +
          ChatMessage(
            id = java.util.UUID.randomUUID().toString(),
            role = "user",
            text = trimmed,
            timestampMs = System.currentTimeMillis(),
          )

      try {
        val params =
          """{"sessionKey":"$sessionKey","message":${trimmed.toJsonString()},"thinking":"$thinking","timeoutMs":30000,"idempotencyKey":"$idem"}"""
        val res = session.request("chat.send", params)
        val runId = parseRunId(res) ?: idem
        pendingRuns.add(runId)
        _pendingRunCount.value = pendingRuns.size
      } catch (e: Exception) {
        _chatError.value = e.message
      }
    }
  }

  private fun handleBridgeEvent(event: String, payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return

    if (event == "voicewake.changed") {
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

    if (event != "chat") return

    try {
      val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
      val state = payload["state"].asStringOrNull()
      val runId = payload["runId"].asStringOrNull()
      if (!runId.isNullOrBlank()) {
        pendingRuns.remove(runId)
        _pendingRunCount.value = pendingRuns.size
      }

      when (state) {
        "final" -> {
          val msgObj = payload["message"].asObjectOrNull()
          val role = msgObj?.get("role").asStringOrNull() ?: "assistant"
          val text = extractTextFromMessage(msgObj)
          if (!text.isNullOrBlank()) {
            _chatMessages.value =
              _chatMessages.value +
                ChatMessage(
                  id = java.util.UUID.randomUUID().toString(),
                  role = role,
                  text = text,
                  timestampMs = System.currentTimeMillis(),
                )
          }
        }
        "error" -> {
          _chatError.value = payload["errorMessage"].asStringOrNull() ?: "Chat failed"
        }
      }
    } catch (_: Throwable) {
      // ignore
    }
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

  private fun parseHistory(historyJson: String): List<ChatMessage> {
    val root = json.parseToJsonElement(historyJson).asObjectOrNull() ?: return emptyList()
    val raw = root["messages"] ?: return emptyList()
    val array = raw as? JsonArray ?: return emptyList()
    return array.mapNotNull { item ->
      val obj = item as? JsonObject ?: return@mapNotNull null
      val role = obj["role"].asStringOrNull() ?: return@mapNotNull null
      val text = extractTextFromMessage(obj) ?: return@mapNotNull null
      ChatMessage(
        id = java.util.UUID.randomUUID().toString(),
        role = role,
        text = text,
        timestampMs = null,
      )
    }
  }

  private fun extractTextFromMessage(msgObj: JsonObject?): String? {
    if (msgObj == null) return null
    val content = msgObj["content"] ?: return null
    return when (content) {
      is JsonPrimitive -> content.asStringOrNull()
      else -> {
        val arr = (content as? JsonArray) ?: return null
        arr.mapNotNull { part ->
          val p = part as? JsonObject ?: return@mapNotNull null
          p["text"].asStringOrNull()
        }.joinToString("\n").trim().ifBlank { null }
      }
    }
  }

  private fun parseRunId(resJson: String): String? {
    return try {
      json.parseToJsonElement(resJson).asObjectOrNull()?.get("runId").asStringOrNull()
    } catch (_: Throwable) {
      null
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
