package ai.openclaw.app

import android.view.Window
import android.view.WindowManager

/** Normal builds always protect credentials. Only an explicitly opted-in debug proof build may record. */
internal fun applyBrowserSignInWindowProtection(
  window: Window,
  debuggable: Boolean,
  recordingOptIn: Boolean,
) {
  if (debuggable && recordingOptIn) {
    window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
  } else {
    window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
  }
}
