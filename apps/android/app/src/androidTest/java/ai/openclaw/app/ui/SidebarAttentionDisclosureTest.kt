package ai.openclaw.app.ui

import ai.openclaw.app.MainActivity
import ai.openclaw.app.NodeApp
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.extraAndroidScreenshotMode
import ai.openclaw.app.extraAndroidScreenshotScene
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class SidebarAttentionDisclosureTest {
  @Test
  fun tappedDisclosureSurvivesOtherExpiriesUntilItsDisplayedRequestRetires() =
    runBlocking<Unit> {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      instrumentation.uiAutomation.serviceInfo =
        instrumentation.uiAutomation.serviceInfo.apply {
          flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
      val device = UiDevice.getInstance(instrumentation)
      val proofDirectory = checkNotNull(instrumentation.targetContext.getExternalFilesDir(null))
      instrumentation.targetContext.startActivity(
        Intent(instrumentation.targetContext, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "attention-expiry"),
      )
      val sidebar = device.wait(Until.findObject(By.desc("Show Sidebar")), 15000)
      assertNotNull("Native chat should finish fixture startup", sidebar)
      sidebar.click()
      val preview = "Which Android version should we test first?"
      val attention = device.wait(Until.findObject(By.desc("3 questions need answers\n$preview\n+2 more")), 5000)
      assertNotNull("The mixed pending group must be visible before its deadlines", attention)
      val runtime = checkNotNull((instrumentation.targetContext.applicationContext as NodeApp).peekRuntime())
      assertEquals(3, runtime.execApprovalInbox.value.approvals.size)
      attention.click()
      assertTrue(device.wait(Until.hasObject(By.text(preview)), 5000))

      // Observe the actual lifecycle owner, not elapsed time or a UI-only replacement list.
      withTimeout(15000) { runtime.execApprovalInbox.first { it.approvals.size == 2 } }
      assertEquals(
        3,
        runtime.chatQuestions.value
          .filter { it.status() == ChatQuestionStatus.Pending }
          .sumOf { it.record.questions.size },
      )
      device.waitForIdle()
      assertTrue("An approval expiry must not close the tapped question disclosure", device.hasObject(By.text(preview)))
      device.takeScreenshot(File(proofDirectory, "attention-disclosure-background-expired.png"))

      withTimeout(10000) { runtime.chatQuestions.first { prompts -> prompts.count { it.status() == ChatQuestionStatus.Pending } == 1 } }
      assertTrue("The same disclosure updates its count while remaining open", device.wait(Until.hasObject(By.text("2 questions need answers")), 5000))
      assertTrue(device.hasObject(By.text(preview)))
      assertTrue(device.hasObject(By.text("+1 more")))
      device.takeScreenshot(File(proofDirectory, "attention-disclosure-count-updated.png"))

      withTimeout(10000) { runtime.chatQuestions.first { prompts -> prompts.none { it.status() == ChatQuestionStatus.Pending } } }
      assertTrue("Retiring the displayed request removes its disclosure", device.wait(Until.gone(By.text(preview)), 5000))
      device.takeScreenshot(File(proofDirectory, "attention-disclosure-retired.png"))
    }
}
