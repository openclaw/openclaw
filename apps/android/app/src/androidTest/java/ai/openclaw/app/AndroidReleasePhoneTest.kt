package ai.openclaw.app

import ai.openclaw.releasevalidation.ReleaseValidationUi
import ai.openclaw.releasevalidation.ReleaseValidationUi.Companion.marker
import androidx.lifecycle.ViewModelProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Host-phased release proof against a real isolated Gateway; only Wear delivery is adapted. */
@RunWith(AndroidJUnit4::class)
class AndroidReleasePhoneTest {
  @Test
  fun releasePhase() {
    val phase = InstrumentationRegistry.getArguments().getString("releasePhase")
    assumeTrue("Release gate is explicitly host-phased", phase != null)
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val app = instrumentation.targetContext.applicationContext as NodeApp
    val ui = ReleaseValidationUi(instrumentation)
    attachReleaseWearTransport(app).use { transport ->
      ui.launch(MainActivity::class.java.name)
      when (phase) {
        "initial" -> {
          onboard(ui, app)
          ui.requireObject(By.desc("Show Sidebar"), "Native sidebar was not available").click()
          ui.clickText("Overview")
          ui.requireObject(By.text("Online"), "Paired Gateway was not online in Overview")
          ui.capture("phone-initial-overview-online")
          ui.requireObject(By.desc("Show Sidebar"), "Overview sidebar was not available").click()
          ui.clickText("Home")
          ui.phoneSend(marker("PHONE_FIRST"))
          ui.verifyPhoneDraft(marker("PHONE_FIRST"), "phone-initial-keyboard")
          ui.phoneSend(marker("PHONE_SECOND"))
          ui.capture("phone-initial-second-reply")
          transport.checkHealthy()
          ui.ready("initial")
        }

        "relaunch" -> {
          assertFalse("Saved pairing must not reopen onboarding", ui.device.hasObject(By.text("Scan QR or setup code")))
          ui.requireObject(By.desc("Show Sidebar"), "Saved pairing did not return to the native shell").click()
          ui.clickText("Home")
          ui.reply(marker("PHONE_SECOND"))
          ui.reply(marker("WEAR_RELAUNCH"))
          ui.phoneSend(marker("PHONE_RELAUNCH"))
          ui.capture("phone-relaunch-history")
          transport.checkHealthy()
          ui.ready("relaunch")
          transport.awaitContinue()
          runCatching { captureReader(ui, "phone-reader-before", transport.diagnostics()) }
          try {
            ui.phoneLongReplyEdge(tail = false)
            ui.capture("phone-reader-head")
            ui.phoneLongReplyEdge(tail = true)
            ui.capture("phone-reader-tail")
            ui.device.findObject(By.desc("Jump to latest"))?.click()
            ui.verifyPhoneDraft("TRAILING SENTINEL", "phone-reader-returned-keyboard", longReply = true)
            assertTrue(ui.device.hasObject(By.clazz("android.widget.EditText")))
            transport.checkHealthy()
            ui.ready("reader")
          } catch (error: Throwable) {
            // Retain paired native state before instrumentation destroys the activity.
            runCatching { captureReader(ui, "phone-reader", transport.diagnostics()) }
            throw error
          }
        }

        else -> {
          error("Select releasePhase=initial or relaunch for the Android release gate")
        }
      }
      transport.awaitFinish()
    }
  }

  private fun captureReader(
    ui: ReleaseValidationUi,
    name: String,
    transportDiagnostics: String,
  ) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val directory = File(instrumentation.targetContext.filesDir, "release-validation-failure").apply { mkdirs() }
    val facts = ui.readerDiagnostics().put("transport", transportDiagnostics)
    instrumentation.runOnMainSync {
      val activities = ActivityLifecycleMonitorRegistry.getInstance()
      val activity =
        listOf(Stage.RESUMED, Stage.STARTED, Stage.STOPPED, Stage.CREATED)
          .flatMap(activities::getActivitiesInStage)
          .filterIsInstance<MainActivity>()
          .firstOrNull()
      facts.put("stateObserved", activity != null)
      if (activity != null) {
        val viewModel = ViewModelProvider(activity)[MainViewModel::class.java]
        val messages = viewModel.chatMessages.value
        facts
          .put("loading", viewModel.chatHistoryLoading.value)
          .put("healthy", viewModel.chatHealthOk.value)
          .put("pendingRuns", viewModel.pendingRunCount.value)
          .put("streaming", viewModel.chatStreamingAssistantText.value != null)
          .put("errorPresent", viewModel.chatError.value != null)
          .put("messageCount", messages.size)
        val counts = JSONObject()
        for (sentinel in listOf("HEAD SENTINEL", "TRAILING SENTINEL")) {
          counts.put(sentinel, messages.count { message -> message.role == "assistant" && message.content.any { it.text?.contains(sentinel) == true } })
        }
        facts.put("assistantSentinels", counts)
      }
    }
    File(directory, "$name.json").writeText(facts.toString(2))
    assertTrue("Could not capture private phone reader UI", ui.device.takeScreenshot(File(directory, "$name.png")))
  }

  private fun onboard(
    ui: ReleaseValidationUi,
    app: NodeApp,
  ) {
    ui.clickText("Continue")
    ui.clickText("Scan QR or setup code")
    ui.clickText("Enter setup code")
    val code = File(app.filesDir, "release-setup-code").readText().trim()
    check(code.isNotEmpty()) { "Host did not provide the private setup code" }
    ui.requireObject(By.clazz("android.widget.EditText"), "Setup code field was not available").text = code
    ui.clickText("Use setup code")
    ui.requireObject(By.text("Gateway paired"), "Real Gateway setup-code pairing did not complete", 60_000)
    ui.clickText("Continue")
    repeat(4) {
      val next =
        ui.device.wait(
          Condition<UiDevice, String?> {
            when {
              ui.device.hasObject(By.desc("Show Sidebar")) -> "done"
              ui.device.hasObject(By.text("Approve access and continue").enabled(true)) -> "Approve access and continue"
              ui.device.hasObject(By.text("Continue").enabled(true)) -> "Continue"
              else -> null
            }
          },
          60_000,
        )
      checkNotNull(next) { "Native onboarding did not reach a continuation" }
      if (next == "done") return
      ui.clickText(next)
    }
    ui.requireObject(By.desc("Show Sidebar"), "Native onboarding did not reach Chat")
  }
}
