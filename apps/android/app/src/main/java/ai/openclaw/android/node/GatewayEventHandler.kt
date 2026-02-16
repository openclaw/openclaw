package ai.openclaw.android.node

import ai.openclaw.android.SecurePrefs
import ai.openclaw.android.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray

class GatewayEventHandler(
  private val scope: CoroutineScope,
  private val prefs: SecurePrefs,
  private val json: Json,
  private val operatorSession: GatewaySession,
  private val isConnected: () -> Boolean,
) {
  private var suppressWakeWordsSync = false
  private var wakeWordsSyncJob: Job? = null

  fun applyWakeWordsFromGateway(words: List<String>) {
    suppressWakeWordsSync = true
    prefs.setWakeWords(words)
    suppressWakeWordsSync = false
  }

  fun scheduleWakeWordsSyncIfNeeded() {
    if (suppressWakeWordsSync) return
    if (!isConnected()) return

    val snapshot = prefs.wakeWords.value
    wakeWordsSyncJob?.cancel()
    wakeWordsSyncJob =
      scope.launch {
        delay(650)
        val jsonList = snapshot.joinToString(separator = ",") { it.toJsonString() }
        val params = """{"triggers":[$jsonList]}"""
        try {
          operatorSession.request("voicewake.set", params)
        } catch (_: Throwable) {
          // ignore
        }
      }
  }

  suspend fun refreshWakeWordsFromGateway() {
    if (!isConnected()) return
    try {
      val res = operatorSession.request("voicewake.get", "{}")
      val payload = json.parseToJsonElement(res).asObjectOrNull() ?: return
      val array = payload["triggers"] as? JsonArray ?: return
      val triggers = array.mapNotNull { it.asStringOrNull() }
      applyWakeWordsFromGateway(triggers)
    } catch (_: Throwable) {
      // ignore
    }
  }

  fun handleVoiceWakeChangedEvent(payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    try {
      val payload = json.parseToJsonElement(payloadJson).asObjectOrNull() ?: return
      val array = payload["triggers"] as? JsonArray ?: return
      val triggers = array.mapNotNull { it.asStringOrNull() }
      applyWakeWordsFromGateway(triggers)
    } catch (_: Throwable) {
      // ignore
    }
  }
}
