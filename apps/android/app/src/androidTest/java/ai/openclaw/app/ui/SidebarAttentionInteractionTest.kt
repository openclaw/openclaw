package ai.openclaw.app.ui

import ai.openclaw.app.MainActivity
import ai.openclaw.app.extraAndroidScreenshotMode
import ai.openclaw.app.extraAndroidScreenshotScene
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SidebarAttentionInteractionTest {
  @Test
  fun inactiveSessionAttentionSupportsTouchKeyboardAndAccessibility() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.serviceInfo =
      instrumentation.uiAutomation.serviceInfo.apply {
        flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      }
    val device = UiDevice.getInstance(instrumentation)
    instrumentation.targetContext.startActivity(
      Intent(instrumentation.targetContext, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        .putExtra(extraAndroidScreenshotMode, true)
        .putExtra(extraAndroidScreenshotScene, "attention"),
    )
    val sidebar = device.wait(Until.findObject(By.desc("Show Sidebar")), 15000)
    assertNotNull("Native chat should finish fixture startup", sidebar)
    sidebar.click()
    val questionLabel = "3 questions need answers\nWhich Android version should we test first?\n+2 more"
    val collapsedAttention = device.wait(Until.findObject(By.desc(questionLabel)), 5000)
    assertNotNull("Collapsed group exposes its oldest request through accessibility", collapsedAttention)
    collapsedAttention.click()
    assertTrue(device.wait(Until.hasObject(By.text("Which Android version should we test first?")), 5000))
    assertTrue(device.hasObject(By.text("+2 more")))
    device.pressBack()
    device.findObject(By.text("Pages")).click()
    device.findObject(By.text("Recent")).click()
    assertTrue(device.wait(Until.hasObject(By.text("Android QA")), 5000))
    assertTrue(device.hasObject(By.desc("3 approvals need review\npnpm android:test:integration\n+2 more")))
    assertTrue("Touch disclosure must keep the drawer open", device.hasObject(By.desc("Close navigation menu")))
    var focusedLabel: String? = null
    for (attempt in 0 until 25) {
      device.pressKeyCode(KeyEvent.KEYCODE_TAB, KeyEvent.META_SHIFT_ON)
      device.waitForIdle()
      focusedLabel = device.findObject(By.desc(questionLabel).focused(true))?.contentDescription
      if (focusedLabel == questionLabel) break
    }
    assertEquals("Keyboard traversal reaches the independent attention target", questionLabel, focusedLabel)
    assertTrue(device.wait(Until.hasObject(By.text("Which Android version should we test first?")), 5000))
    device.pressKeyCode(KeyEvent.KEYCODE_ESCAPE)
    assertTrue(device.wait(Until.gone(By.text("Which Android version should we test first?")), 5000))
    val point = device.findObject(By.desc(questionLabel)).visibleCenter
    val now = SystemClock.uptimeMillis()
    val properties =
      MotionEvent.PointerProperties().apply {
        id = 0
        toolType = MotionEvent.TOOL_TYPE_MOUSE
      }
    val coordinates =
      MotionEvent.PointerCoords().apply {
        x = point.x.toFloat()
        y = point.y.toFloat()
      }
    val hover = MotionEvent.obtain(now, now, MotionEvent.ACTION_HOVER_MOVE, 1, arrayOf(properties), arrayOf(coordinates), 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0)
    try {
      assertTrue(instrumentation.uiAutomation.injectInputEvent(hover, true))
      assertTrue("Pointer hover exposes the same pending question", device.wait(Until.hasObject(By.text("Which Android version should we test first?")), 5000))
    } finally {
      hover.recycle()
    }
  }
}
