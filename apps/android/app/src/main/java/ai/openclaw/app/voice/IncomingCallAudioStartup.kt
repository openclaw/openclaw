package ai.openclaw.app.voice

import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first

/** One attempt's readiness and feedback boundary; the call controller retains authority. */
internal class IncomingCallAudioStartup(
  val resuming: Boolean,
  val interruptedAtMs: Long?,
  val beforeCapture: (() -> Unit)?,
) {
  // A provider can announce readiness before the session-create response is adopted.
  // Retain only a bounded set for this attempt; only its exact returned relay ID can unlock capture.
  private val readyRelayIds = MutableStateFlow<Set<String>>(emptySet())

  fun noteProviderReady(sessionId: String) {
    if (!resuming || sessionId.isBlank()) return
    readyRelayIds.value = (readyRelayIds.value + sessionId).toList().takeLast(8).toSet()
  }

  suspend fun awaitProviderReady(sessionId: String) {
    if (resuming) readyRelayIds.first { sessionId in it }
  }

  fun isProviderReady(sessionId: String): Boolean = sessionId in readyRelayIds.value

  fun interruptedForMs(): Long? =
    interruptedAtMs?.takeIf { resuming }?.let {
      (SystemClock.elapsedRealtime() - it).coerceIn(0L, 30_000L)
    }
}
