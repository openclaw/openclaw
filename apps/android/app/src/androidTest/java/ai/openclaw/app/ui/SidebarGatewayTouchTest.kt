package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.MainActivity
import ai.openclaw.app.NodeApp
import ai.openclaw.app.extraAndroidScreenshotMode
import ai.openclaw.app.extraAndroidScreenshotScene
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.graphics.Rect
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class SidebarGatewayTouchTest {
  @Test
  fun fingerSwipesKeepThePickerAndGatewayWhileBackStillDismisses() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.serviceInfo =
      instrumentation.uiAutomation.serviceInfo.apply {
        flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      }
    val app = instrumentation.targetContext.applicationContext as NodeApp
    val device = UiDevice.getInstance(instrumentation)
    val registry = app.prefs.gatewayRegistry
    val previousEntries = registry.entries.value
    val previousActive = registry.activeStableId.value
    val previousConnections = registry.connectedStableIds.value
    val previousTheme = app.prefs.appearanceThemeMode.value
    val entries =
      (1..30).map { index ->
        val id = if (index == 1) AndroidScreenshotFixture.gatewayId else "touch-proof-$index"
        GatewayRegistryEntry(id, GatewayRegistryEntryKind.MANUAL, "Research %02d".format(index), "gateway-$index.example", 443, true)
      }
    val proofDirectory = checkNotNull(app.getExternalFilesDir(null))

    fun capture(name: String) {
      assertTrue(device.takeScreenshot(File(proofDirectory, "gateway-touch-$name.png")))
    }
    try {
      previousEntries.forEach { assertTrue(registry.remove(it.stableId)) }
      entries.forEach(registry::upsert)
      registry.setActive(entries.first().stableId)
      app.prefs.setAppearanceThemeMode(AppearanceThemeMode.Dark)
      app.startActivity(
        Intent(app, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "attention"),
      )
      val sidebar = device.wait(Until.findObject(By.desc("Show Sidebar")), 15000)
      assertNotNull("Native chat should finish fixture startup", sidebar)
      sidebar.click()
      val control = device.wait(Until.findObject(By.text("30 gateways")), 5000)
      assertNotNull("The saved Gateway control must be visible", control)
      control.click()
      val search = device.wait(Until.findObject(By.text("Search gateways")), 5000)
      assertNotNull("The actual native Gateway sheet must open", search)
      val runtime = checkNotNull(app.peekRuntime())
      val focused = runtime.gatewayConnectionHandoff.value.focusedStableId
      assertEquals(entries.first().stableId, focused)
      val manage = device.findObject(By.text("Manage Gateways"))
      val x = search.visibleCenter.x
      val top = search.visibleBounds.bottom + 60
      val bottom = manage.visibleBounds.top - 40
      capture("opened")
      assertTrue(device.swipe(x, top, x, bottom, 25))
      device.waitForIdle()
      capture("after-down")
      assertTrue("A finger swipe down at the list start must not dismiss", device.hasObject(By.text("Manage Gateways")))
      repeat(2) {
        assertTrue(device.swipe(x, bottom, x, top, 35))
        device.waitForIdle()
      }
      assertTrue("Upward finger swipes must scroll the list", !device.hasObject(By.text("Research 01")))
      capture("middle")
      assertTrue(device.swipe(x, top, x, bottom, 35))
      device.waitForIdle()
      assertTrue(device.hasObject(By.text("Manage Gateways")))
      assertTrue(device.swipe(x, bottom, x, top, 35))
      device.waitForIdle()
      assertTrue(device.hasObject(By.text("Manage Gateways")))
      assertEquals("Swiping must not select a Gateway", focused, runtime.gatewayConnectionHandoff.value.focusedStableId)
      device.pressBack()
      assertTrue("Back must still dismiss the native sheet", device.wait(Until.gone(By.text("Manage Gateways")), 5000))
      assertTrue(device.hasObject(By.text("30 gateways")))
      capture("explicit-dismiss")
      device.findObject(By.text("30 gateways")).click()
      val field = device.wait(Until.findObject(By.clazz("android.widget.EditText")), 5000)
      assertNotNull(field)
      field.click()
      field.text = "Research 2"
      assertTrue(device.wait(Until.hasObject(By.text("Research 20")), 5000))
      device.waitForIdle()
      val keyboard =
        device.wait(
          Condition<UiDevice, AccessibilityWindowInfo?> {
            instrumentation.uiAutomation.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }
          },
          5000,
        )
      assertNotNull("Search should open the real Android keyboard", keyboard)
      val keyboardBounds = Rect().also { checkNotNull(keyboard).getBoundsInScreen(it) }
      val resultsTop = field.visibleBounds.bottom + 20
      assertTrue(device.swipe(x, resultsTop, x, keyboardBounds.top - 20, 25))
      device.waitForIdle()
      assertTrue("Filtered-list overscroll with the IME must not dismiss", device.hasObject(By.clazz("android.widget.EditText")))
      assertEquals(focused, runtime.gatewayConnectionHandoff.value.focusedStableId)
      capture("keyboard")
      device.pressBack()
      assertTrue("The first Back closes the IME, not the picker", device.hasObject(By.clazz("android.widget.EditText")))
      device.pressBack()
      assertTrue(device.wait(Until.gone(By.clazz("android.widget.EditText")), 5000))
      device.findObject(By.text("30 gateways")).click()
      assertTrue(device.wait(Until.hasObject(By.text("Search gateways")), 5000))
      device.pressHome()
      assertTrue(
        "Home must stop the native owner before resuming it",
        device.wait(
          Condition<UiDevice, Boolean> {
            var stopped = false
            instrumentation.runOnMainSync {
              stopped = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.STOPPED).any { it is MainActivity }
            }
            stopped
          },
          5000,
        ),
      )
      app.startActivity(
        Intent(app, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT),
      )
      assertTrue(device.wait(Until.hasObject(By.text("30 gateways")), 5000))
      assertTrue("A backgrounded native owner must not reopen its old sheet", !device.hasObject(By.text("Search gateways")))
      assertEquals(focused, runtime.gatewayConnectionHandoff.value.focusedStableId)
      capture("owner-revoked")
    } finally {
      registry.entries.value.forEach { assertTrue(registry.remove(it.stableId)) }
      previousEntries.forEach(registry::upsert)
      registry.setActive(previousActive)
      // setActive enables its entry; restore the original connection list independently.
      previousActive?.let { registry.setConnectionEnabled(it, false) }
      previousConnections.forEach { registry.setConnectionEnabled(it, true) }
      app.prefs.setAppearanceThemeMode(previousTheme)
      assertEquals(previousEntries, registry.entries.value)
      assertEquals(previousActive, registry.activeStableId.value)
      assertEquals(previousConnections, registry.connectedStableIds.value)
    }
  }
}
