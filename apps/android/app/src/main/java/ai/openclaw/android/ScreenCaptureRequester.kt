package ai.openclaw.android

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class ScreenCaptureRequester(private val activity: ComponentActivity) {
  data class CaptureResult(val resultCode: Int, val data: Intent)

  private val mutex = Mutex()
  private var pending: CompletableDeferred<CaptureResult?>? = null
  @Volatile private var cachedResult: CaptureResult? = null

  private val launcher: ActivityResultLauncher<Intent> =
    activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val p = pending
      pending = null
      val data = result.data
      if (result.resultCode == Activity.RESULT_OK && data != null) {
        val capture = CaptureResult(result.resultCode, data)
        cachedResult = capture
        p?.complete(capture)
      } else {
        p?.complete(null)
      }
    }

  suspend fun requestCapture(timeoutMs: Long = 20_000): CaptureResult? =
    mutex.withLock {
      // Return cached projection token if available (skip re-prompting)
      cachedResult?.let { return it }

      val mgr = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      val intent = mgr.createScreenCaptureIntent()

      val deferred = CompletableDeferred<CaptureResult?>()
      pending = deferred
      withContext(Dispatchers.Main) { launcher.launch(intent) }

      withContext(Dispatchers.Default) { withTimeout(timeoutMs) { deferred.await() } }
    }

  fun clearCachedCapture() {
    cachedResult = null
  }
}
