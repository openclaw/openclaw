package ai.openclaw.app.calls

import android.annotation.SuppressLint
import android.content.Context
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch

/** Call-owned display blanking; Android owns the sensor and near/far transitions. */
internal class IncomingCallProximity(
  context: Context,
  private val scope: CoroutineScope,
) {
  private val power =
    context.getSystemService(PowerManager::class.java)?.takeIf {
      it.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)
    }
  private var wakeLock: PowerManager.WakeLock? = null
  private var holdJob: Job? = null

  @SuppressLint("WakelockTimeout") // Call lifecycle and scope cancellation release the lock, not an arbitrary call length.
  fun setEarpieceCallActive(active: Boolean) {
    if (!active) {
      val lock = wakeLock
      wakeLock = null
      holdJob?.cancel()
      holdJob = null
      // Do not wait for coroutine dispatch or a far-sensor event to restore the display.
      if (lock?.isHeld == true) lock.release()
      return
    }
    val manager = power ?: return
    if (holdJob?.isActive == true) return
    holdJob =
      scope.launch(Dispatchers.Main.immediate) {
        // A cancelled lease may finish after the next route change; it must release only its own lock.
        val lock = manager.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "openclaw:incoming-call-proximity")
        lock.setReferenceCounted(false)
        wakeLock = lock
        try {
          lock.acquire()
          awaitCancellation()
        } finally {
          if (lock.isHeld) lock.release()
        }
      }
  }
}
