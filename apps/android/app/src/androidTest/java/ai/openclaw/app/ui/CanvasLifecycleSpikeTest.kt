package ai.openclaw.app.ui

import android.content.pm.ActivityInfo
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class CanvasLifecycleSpikeTest {
  @get:Rule
  val activityRule = ActivityScenarioRule(CanvasLifecycleSpikeActivity::class.java)

  @Before
  fun resetMetrics() {
    CanvasLifecycleSpikeMetrics.reset()
  }

  @Test
  fun hiddenHostRetainsOneWebViewWithoutBlockingShellInput() {
    activityRule.scenario.onActivity { activity ->
      assertFalse(activity.host.isCanvasVisible)
      assertNull(activity.host.currentWebView)
      assertEquals(0, activity.host.webViewCreateCount)
      assertEquals(0, activity.host.childCount)
    }

    val pageFinished = activityRule.scenario.readActivity { activity -> activity.host.nextPageFinished() }
    val presentElapsedMs = activityRule.scenario.readActivity { activity -> activity.presentSlowPage() }

    assertTrue(
      "present waited for the remote page: ${presentElapsedMs}ms",
      presentElapsedMs < canvasLifecycleSlowPageDelayMs / 2,
    )
    assertTrue("slow page never finished", pageFinished.await(5, TimeUnit.SECONDS))

    activityRule.scenario.onActivity { activity ->
      assertEquals(1, activity.host.webViewCreateCount)
      assertEquals(1, activity.host.childCount)
      assertTrue(activity.host.isCanvasVisible)
      activity.hideCanvas()
      assertFalse(activity.host.isCanvasVisible)
    }

    val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    assertTrue(device.click(device.displayWidth / 2, device.displayHeight / 2))
    device.waitForIdle()

    activityRule.scenario.onActivity { activity ->
      assertEquals(1, activity.underlayClickCount)
      repeat(3) {
        activity.presentFastPage()
        activity.hideCanvas()
      }
      assertEquals(1, activity.host.webViewCreateCount)
      assertEquals(1, activity.host.childCount)
    }
  }

  @Test
  fun stalePageCompletionCannotReshowCanvasAfterHide() {
    val pageFinished = activityRule.scenario.readActivity { activity -> activity.host.nextPageFinished() }

    activityRule.scenario.onActivity { activity ->
      activity.presentSlowPage()
      activity.hideCanvas()
    }

    assertTrue("slow page never finished", pageFinished.await(5, TimeUnit.SECONDS))
    activityRule.scenario.onActivity { activity ->
      assertFalse(activity.host.isCanvasVisible)
      assertEquals(1, activity.host.webViewCreateCount)
    }
  }

  @Test
  fun rendererTerminationDestroysInvalidWebViewAndNextPresentRecreatesIt() {
    val pageFinished = activityRule.scenario.readActivity { activity -> activity.host.nextPageFinished() }
    activityRule.scenario.onActivity { activity -> activity.presentFastPage() }
    assertTrue("initial page never finished", pageFinished.await(5, TimeUnit.SECONDS))

    val rendererGone = activityRule.scenario.readActivity { activity -> activity.host.nextRendererGone() }
    val terminated = activityRule.scenario.readActivity { activity -> activity.host.terminateRenderer() }
    assertTrue("WebView renderer did not terminate", terminated)
    assertTrue("onRenderProcessGone was not called", rendererGone.await(5, TimeUnit.SECONDS))

    activityRule.scenario.onActivity { activity ->
      assertFalse(activity.host.isCanvasVisible)
      assertNull(activity.host.currentWebView)
      assertEquals(0, activity.host.childCount)
      assertEquals(1, activity.host.webViewDestroyCount)

      activity.presentFastPage()
      assertTrue(activity.host.isCanvasVisible)
      assertNotNull(activity.host.currentWebView)
      assertEquals(1, activity.host.childCount)
      assertEquals(2, activity.host.webViewCreateCount)
    }
  }

  @Test
  fun configurationChangesKeepTheSameHostAndWebView() {
    activityRule.scenario.onActivity { activity ->
      activity.presentFastPage()
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
    }
    UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).waitForIdle()

    activityRule.scenario.onActivity { activity ->
      assertEquals(1, activity.host.webViewCreateCount)
      assertEquals(1, activity.host.childCount)
      activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }
  }
}

@RunWith(AndroidJUnit4::class)
class CanvasLifecycleReleaseSpikeTest {
  @Before
  fun resetMetrics() {
    CanvasLifecycleSpikeMetrics.reset()
  }

  @Test
  fun activityTeardownReleasesTheHostAndWebView() {
    ActivityScenario.launch(CanvasLifecycleSpikeActivity::class.java).use { scenario ->
      scenario.onActivity { activity -> activity.presentFastPage() }
    }

    assertTrue(
      "AndroidView onRelease was not called",
      waitUntil { CanvasLifecycleSpikeMetrics.hostReleaseCount.get() == 1 },
    )
    assertEquals(1, CanvasLifecycleSpikeMetrics.webViewDestroyCount.get())
  }
}

private inline fun <T> ActivityScenario<CanvasLifecycleSpikeActivity>.readActivity(crossinline block: (CanvasLifecycleSpikeActivity) -> T): T {
  var result: Result<T>? = null
  onActivity { activity -> result = runCatching { block(activity) } }
  return checkNotNull(result).getOrThrow()
}

private fun waitUntil(
  timeoutMs: Long = 5_000L,
  predicate: () -> Boolean,
): Boolean {
  val deadline = SystemClock.elapsedRealtime() + timeoutMs
  while (SystemClock.elapsedRealtime() < deadline) {
    if (predicate()) return true
    SystemClock.sleep(20)
  }
  return predicate()
}
