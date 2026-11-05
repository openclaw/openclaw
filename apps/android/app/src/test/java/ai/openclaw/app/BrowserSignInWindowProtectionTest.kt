package ai.openclaw.app

import android.app.Activity
import android.view.WindowManager
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrowserSignInWindowProtectionTest {
  @Test fun ordinaryDebugBuildProtectsTheRealWindow() = verify(true, false, true)

  @Test fun releaseProtectsTheRealWindowEvenWithOptInRequested() {
    verify(false, false, true)
    verify(false, true, true)
  }

  @Test fun explicitDebugRecordingCanBeRestoredWithoutChangingData() {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    try {
      val window = controller.get().window
      window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      applyBrowserSignInWindowProtection(window, debuggable = true, recordingOptIn = true)
      assertFalse(window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
      applyBrowserSignInWindowProtection(window, debuggable = true, recordingOptIn = false)
      assertTrue(window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    } finally {
      controller.pause().stop().destroy()
    }
  }

  private fun verify(
    debuggable: Boolean,
    optIn: Boolean,
    expectedProtected: Boolean,
  ) {
    val controller = Robolectric.buildActivity(Activity::class.java).setup()
    try {
      val window = controller.get().window
      applyBrowserSignInWindowProtection(window, debuggable, optIn)
      org.junit.Assert.assertEquals(expectedProtected, window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
    } finally {
      controller.pause().stop().destroy()
    }
  }
}
