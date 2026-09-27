package ai.openclaw.app.calls

import android.annotation.SuppressLint
import android.content.Context
import android.os.PowerManager

/** Call-owned display blanking; Android owns the sensor and near/far transitions. */
internal class IncomingCallProximity(
  context: Context,
) {
  private val wakeLock =
    context.getSystemService(PowerManager::class.java)?.let { power ->
      if (power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) {
        power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "openclaw:incoming-call-proximity").apply {
          setReferenceCounted(false)
        }
      } else {
        null
      }
    }

  @SuppressLint("WakelockTimeout") // The controller releases on route/terminal/service/Gateway changes, not an arbitrary call length.
  fun setEarpieceCallActive(active: Boolean) {
    val lock = wakeLock ?: return
    if (active) {
      if (!lock.isHeld) lock.acquire()
    } else if (lock.isHeld) {
      // No WAIT_FOR_NO_PROXIMITY: changing output or ending must restore the display immediately.
      lock.release()
    }
  }
}
