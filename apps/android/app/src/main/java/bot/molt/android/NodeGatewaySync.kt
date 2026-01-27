package bot.molt.android

import android.util.Log
import bot.molt.android.protocol.ClawdbotCanvasA2UICommand
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val TAG = "NodeGatewaySync"

// MARK: - Gateway Sync Extension

/**
 * Extension for gateway synchronization, branding, and wake word sync.
 * Separated from NodeRuntime for maintainability.
 */
internal suspend fun NodeRuntime.refreshBrandingFromGateway() {
    if (!isConnected.value) return
    try {
        val res = operatorSession.request("config.get", "{}")
        val root = jsonParser.parseToJsonElement(res).asObjectOrNull()
        val config = root?.get("config").asObjectOrNull()
        val ui = config?.get("ui").asObjectOrNull()
        val raw = ui?.get("seamColor").asStringOrNull()?.trim()
        val sessionCfg = config?.get("session").asObjectOrNull()
        val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())
        applyMainSessionKey(mainKey)

        val parsed = parseHexColorArgb(raw)
        setSeamColorArgb(parsed ?: DEFAULT_SEAM_COLOR_ARGB)
    } catch (e: Throwable) {
        Log.d(TAG, "Failed to refresh branding from gateway", e)
    }
}

internal suspend fun NodeRuntime.refreshWakeWordsFromGateway() {
    if (!isConnected.value) return
    try {
        val res = operatorSession.request("voicewake.get", "{}")
        val payload = jsonParser.parseToJsonElement(res).asObjectOrNull() ?: return
        val array = payload["triggers"] as? JsonArray ?: return
        val triggers = array.mapNotNull { it.asStringOrNull() }
        applyWakeWordsFromGateway(triggers)
    } catch (e: Throwable) {
        Log.d(TAG, "Failed to refresh wake words from gateway", e)
    }
}

internal fun NodeRuntime.handleGatewayEvent(event: String, payloadJson: String?) {
    if (event == "voicewake.changed") {
        if (payloadJson.isNullOrBlank()) return
        try {
            val payload = jsonParser.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
            val array = payload["triggers"] as? JsonArray ?: return
            val triggers = array.mapNotNull { it.asStringOrNull() }
            applyWakeWordsFromGateway(triggers)
        } catch (e: Throwable) {
            Log.w(TAG, "Failed to parse voicewake.changed event", e)
        }
        return
    }

    talkModeManager.handleGatewayEvent(event, payloadJson)
    chatController.handleGatewayEvent(event, payloadJson)
}

internal suspend fun NodeRuntime.scheduleWakeWordsSyncIfNeeded() {
    if (suppressWakeWordsSync) return
    if (!isConnected.value) return

    val snapshot = prefs.wakeWords.value
    wakeWordsSyncJob?.cancel()
    wakeWordsSyncJob = scope.launch {
        delay(650)
        val jsonList = snapshot.joinToString(separator = ",") { it.toJsonStringInternal() }
        val params = """{"triggers":[$jsonList]}"""
        try {
            operatorSession.request("voicewake.set", params)
        } catch (e: Throwable) {
            Log.d(TAG, "Failed to sync wake words to gateway", e)
        }
    }
}

// MARK: - A2UI URL Resolution

internal fun NodeRuntime.resolveA2uiHostUrl(): String? {
    val nodeRaw = nodeSession.currentCanvasHostUrl()?.trim().orEmpty()
    val operatorRaw = operatorSession.currentCanvasHostUrl()?.trim().orEmpty()
    val raw = if (nodeRaw.isNotBlank()) nodeRaw else operatorRaw
    if (raw.isBlank()) return null
    val base = raw.trimEnd('/')
    return "${base}/__clawdbot__/a2ui/?platform=android"
}

internal suspend fun NodeRuntime.ensureA2uiReady(a2uiUrl: String): Boolean {
    try {
        val already = canvas.eval(A2UI_READY_CHECK_JS)
        if (already == "true") return true
    } catch (e: Throwable) {
        Log.d(TAG, "A2UI ready check failed (will retry)", e)
    }

    canvas.navigate(a2uiUrl)
    repeat(50) {
        try {
            val ready = canvas.eval(A2UI_READY_CHECK_JS)
            if (ready == "true") return true
        } catch (e: Throwable) {
            Log.v(TAG, "A2UI ready poll failed, retrying...", e)
        }
        delay(120)
    }
    return false
}

internal fun NodeRuntime.maybeNavigateToA2uiOnConnect() {
    val a2uiUrl = resolveA2uiHostUrl() ?: return
    val current = canvas.currentUrl()?.trim().orEmpty()
    if (current.isEmpty() || current == lastAutoA2uiUrl) {
        lastAutoA2uiUrl = a2uiUrl
        canvas.navigate(a2uiUrl)
    }
}

internal fun NodeRuntime.showLocalCanvasOnDisconnect() {
    lastAutoA2uiUrl = null
    canvas.navigate("")
}

// MARK: - A2UI Message Decoding

internal fun NodeRuntime.decodeA2uiMessages(command: String, paramsJson: String?): String {
    val raw = paramsJson?.trim().orEmpty()
    if (raw.isBlank()) throw IllegalArgumentException("INVALID_REQUEST: paramsJSON required")

    val obj = jsonParser.parseToJsonElement(raw) as? JsonObject
        ?: throw IllegalArgumentException("INVALID_REQUEST: expected object params")

    val jsonlField = (obj["jsonl"] as? JsonPrimitive)?.content?.trim().orEmpty()
    val hasMessagesArray = obj["messages"] is JsonArray

    if (command == ClawdbotCanvasA2UICommand.PushJSONL.rawValue || (!hasMessagesArray && jsonlField.isNotBlank())) {
        val jsonl = jsonlField
        if (jsonl.isBlank()) throw IllegalArgumentException("INVALID_REQUEST: jsonl required")
        val messages = jsonl
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .mapIndexed { idx, line ->
                val el = jsonParser.parseToJsonElement(line)
                val msg = el as? JsonObject
                    ?: throw IllegalArgumentException("A2UI JSONL line ${idx + 1}: expected a JSON object")
                validateA2uiV0_8(msg, idx + 1)
                msg
            }
            .toList()
        return JsonArray(messages).toString()
    }

    val arr = obj["messages"] as? JsonArray
        ?: throw IllegalArgumentException("INVALID_REQUEST: messages[] required")
    val out = arr.mapIndexed { idx, el ->
        val msg = el as? JsonObject
            ?: throw IllegalArgumentException("A2UI messages[${idx}]: expected a JSON object")
        validateA2uiV0_8(msg, idx + 1)
        msg
    }
    return JsonArray(out).toString()
}

private fun validateA2uiV0_8(msg: JsonObject, lineNumber: Int) {
    if (msg.containsKey("createSurface")) {
        throw IllegalArgumentException(
            "A2UI JSONL line $lineNumber: looks like A2UI v0.9 (`createSurface`). Canvas supports v0.8 messages only.",
        )
    }
    val allowed = setOf("beginRendering", "surfaceUpdate", "dataModelUpdate", "deleteSurface")
    val matched = msg.keys.filter { allowed.contains(it) }
    if (matched.size != 1) {
        val found = msg.keys.sorted().joinToString(", ")
        throw IllegalArgumentException(
            "A2UI JSONL line $lineNumber: expected exactly one of ${allowed.sorted().joinToString(", ")}; found: $found",
        )
    }
}

// MARK: - Helper Methods

internal fun NodeRuntime.invokeErrorFromThrowable(err: Throwable): Pair<String, String> {
    val raw = (err.message ?: "").trim()
    if (raw.isEmpty()) return "UNAVAILABLE" to "UNAVAILABLE: camera error"

    val idx = raw.indexOf(':')
    if (idx <= 0) return "UNAVAILABLE" to raw
    val code = raw.substring(0, idx).trim().ifEmpty { "UNAVAILABLE" }
    val message = raw.substring(idx + 1).trim().ifEmpty { raw }
    return code to "$code: $message"
}

internal fun NodeRuntime.parseLocationParams(paramsJson: String?): Triple<Long?, Long, String?> {
    if (paramsJson.isNullOrBlank()) {
        return Triple(null, 10_000L, null)
    }
    val root = try {
        jsonParser.parseToJsonElement(paramsJson).asObjectOrNull()
    } catch (e: Throwable) {
        Log.d(TAG, "Failed to parse location params JSON", e)
        null
    }
    val maxAgeMs = (root?.get("maxAgeMs") as? JsonPrimitive)?.content?.toLongOrNull()
    val timeoutMs = (root?.get("timeoutMs") as? JsonPrimitive)?.content?.toLongOrNull()?.coerceIn(1_000L, 60_000L)
        ?: 10_000L
    val desiredAccuracy = (root?.get("desiredAccuracy") as? JsonPrimitive)?.content?.trim()?.lowercase()
    return Triple(maxAgeMs, timeoutMs, desiredAccuracy)
}

// MARK: - A2UI JavaScript Constants

internal const val A2UI_READY_CHECK_JS: String = """
(() => {
  try {
    return !!globalThis.clawdbotA2UI && typeof globalThis.clawdbotA2UI.applyMessages === 'function';
  } catch (_) {
    return false;
  }
})()
"""

internal const val A2UI_RESET_JS: String = """
(() => {
  try {
    if (!globalThis.clawdbotA2UI) return { ok: false, error: "missing clawdbotA2UI" };
    return globalThis.clawdbotA2UI.reset();
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
})()
"""

internal fun a2uiApplyMessagesJS(messagesJson: String): String {
    return """
    (() => {
      try {
        if (!globalThis.clawdbotA2UI) return { ok: false, error: "missing clawdbotA2UI" };
        const messages = $messagesJson;
        return globalThis.clawdbotA2UI.applyMessages(messages);
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    })()
    """.trimIndent()
}

internal const val DEFAULT_SEAM_COLOR_ARGB: Long = 0xFF4F7A9A

internal fun parseHexColorArgb(raw: String?): Long? {
    val trimmed = raw?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val hex = if (trimmed.startsWith("#")) trimmed.drop(1) else trimmed
    if (hex.length != 6) return null
    val rgb = hex.toLongOrNull(16) ?: return null
    return 0xFF000000L or rgb
}

// MARK: - JSON Helpers

internal fun kotlinx.serialization.json.JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

internal fun kotlinx.serialization.json.JsonElement?.asStringOrNull(): String? =
    when (this) {
        is kotlinx.serialization.json.JsonNull -> null
        is JsonPrimitive -> content
        else -> null
    }

private fun String.toJsonStringInternal(): String {
    val escaped = this
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
    return "\"$escaped\""
}
