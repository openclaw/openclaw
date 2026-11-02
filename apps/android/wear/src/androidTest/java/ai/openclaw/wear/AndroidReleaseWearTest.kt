package ai.openclaw.wear

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
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest

/** Real Wear launcher, native RemoteInput, repository, wire codec, Phone bridge and Gateway. */
@RunWith(AndroidJUnit4::class)
class AndroidReleaseWearTest {
  @Test
  fun releasePhase() {
    val phase = InstrumentationRegistry.getArguments().getString("releasePhase")
    assumeTrue("Release gate is explicitly host-phased", phase != null)
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val app = instrumentation.targetContext.applicationContext as WearApplication
    val ui = ReleaseValidationUi(instrumentation)
    attachReleaseWearTransport(app).use { transport ->
      try {
        ui.launch(MainActivity::class.java.name)
        when (phase) {
          "initial" -> {
            ui.reply(marker("PHONE_SECOND"))
            send(ui, "WEAR_FIRST")
            send(ui, "WEAR_SECOND")
            ui.capture("wear-initial-second-reply")
            transport.checkHealthy()
            ui.ready("initial")
          }

          "relaunch" -> {
            ui.reply(marker("WEAR_SECOND"))
            send(ui, "WEAR_RELAUNCH")
            ui.capture("wear-relaunch-history")
            transport.checkHealthy()
            ui.ready("relaunch")
            transport.awaitContinue()
            // Keep this native owner alive across the phone process restart.
            val retainedActivity = observedActivity()
            ui.refreshWear()
            assertTrue("Native Refresh must retain the candidate foreground", ui.device.currentPackageName == app.packageName)
            ui.launch(MainActivity::class.java.name)
            assertSame("Normal Chat navigation must retain the Watch activity", retainedActivity, observedActivity())
            ui.reply(marker("PHONE_RELAUNCH"))
            send(ui, "PHONE_RESTART")
            ui.capture("wear-phone-restart-reply")
            transport.checkHealthy()
            ui.ready("phone-restart")
            transport.awaitContinue()
            ui.wearSend(marker("LONG_REPLY"))
            awaitSettled(ui)
            ui.clickRevealed(By.text("Read full reply"), "Long Wear reply did not expose its full reader")
            ui.wearLongReplyEdge(tail = false)
            ui.capture("wear-reader-head")
            ui.wearLongReplyEdge(tail = true)
            ui.capture("wear-reader-tail")
            ui.device.pressBack()
            ui.reveal(By.text("Read full reply"), "Back did not return from the full reader to Chat")
            ui.capture("wear-reader-returned")
            transport.checkHealthy()
            ui.ready("long-reply")
          }

          else -> {
            error("Select releasePhase=initial or relaunch for the Android release gate")
          }
        }
        transport.awaitFinish()
      } catch (error: Throwable) {
        // Capture while the native owner and its adapted transport still exist.
        runCatching { captureFailure(ui, phase, transport.diagnostics()) }
        throw error
      }
    }
  }

  private fun send(
    ui: ReleaseValidationUi,
    name: String,
  ) {
    ui.wearSend(marker(name))
    ui.reply(marker(name))
    awaitSettled(ui, marker(name))
    ui.reply(marker(name))
    assertTrue("Settled Wear assistant reply must appear once", ui.device.findObjects(By.text(marker(name))).size == 1)
  }

  private fun awaitSettled(
    ui: ReleaseValidationUi,
    expectedReply: String? = null,
  ) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val activity = observedActivity()
    lateinit var viewModel: WearViewModel
    instrumentation.runOnMainSync {
      viewModel = ViewModelProvider(activity)[WearViewModel::class.java]
    }
    assertTrue(
      "Actual Wear send must settle before phase completion",
      ui.device.wait(
        Condition<UiDevice, Boolean> {
          val state = viewModel.state.value
          state.connected && !state.loading && !state.sending && !state.hasActiveStream && state.pendingReply == null
        },
        30_000,
      ),
    )
    if (expectedReply != null) {
      assertTrue(
        "Settled Wear history must contain exactly one canonical assistant reply",
        viewModel.state.value.messages
          .count { it.role == "assistant" && it.text == expectedReply } == 1,
      )
    }
  }

  private fun observedActivity(): MainActivity {
    lateinit var activity: MainActivity
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      activity =
        ActivityLifecycleMonitorRegistry
          .getInstance()
          .getActivitiesInStage(Stage.RESUMED)
          .filterIsInstance<MainActivity>()
          .single()
    }
    return activity
  }

  private fun captureFailure(
    ui: ReleaseValidationUi,
    phase: String?,
    transportDiagnostics: String,
  ) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val directory = File(instrumentation.targetContext.filesDir, "release-validation-failure").apply { mkdirs() }
    val name = if (phase == "initial") "wear-initial" else "wear-relaunch"
    var observed: WearUiState? = null
    instrumentation.runOnMainSync {
      val activities = ActivityLifecycleMonitorRegistry.getInstance()
      val activity =
        listOf(Stage.RESUMED, Stage.STARTED, Stage.STOPPED, Stage.CREATED)
          .flatMap(activities::getActivitiesInStage)
          .filterIsInstance<MainActivity>()
          .firstOrNull()
      if (activity != null) observed = ViewModelProvider(activity)[WearViewModel::class.java].state.value
    }
    val facts =
      JSONObject()
        .put("phase", name)
        .put("activePackage", ui.device.currentPackageName)
        .put("stateObserved", observed != null)
        .put("transport", transportDiagnostics)
        .put("reader", ui.readerDiagnostics())
    observed?.let { state ->
      facts
        .put("connected", state.connected)
        .put("loading", state.loading)
        .put("sending", state.sending)
        .put("failure", state.failure?.name ?: "none")
        .put("hasActiveStream", state.hasActiveStream)
        .put("pendingReply", state.pendingReply != null)
        .put("selectedSession", state.selectedSession != null)
        .put("messageCount", state.messages.size)
      val roles = JSONObject()
      for (role in listOf("assistant", "user", "system", "tool", "toolResult")) {
        roles.put(role, state.messages.count { it.role == role })
      }
      roles.put("other", state.messages.count { it.role !in listOf("assistant", "user", "system", "tool", "toolResult") })
      facts.put("roles", roles)
      val markers = JSONObject()
      val exactMarkers = JSONObject()
      val visibleMarkers = JSONObject()
      for (suffix in diagnosticMarkers) {
        markers.put(suffix, state.messages.count { it.role == "assistant" && it.text.contains(marker(suffix)) })
        exactMarkers.put(suffix, state.messages.count { it.role == "assistant" && it.text == marker(suffix) })
        visibleMarkers.put(suffix, ui.device.findObjects(By.pkg(instrumentation.targetContext.packageName).text(marker(suffix))).size)
      }
      facts.put("assistantMarkers", markers)
      facts.put("exactAssistantMarkers", exactMarkers)
      facts.put("visibleExactMarkers", visibleMarkers)
      val identities = JSONArray()
      for (message in state.messages.filter { it.role == "assistant" }) {
        val suffix = diagnosticMarkers.firstOrNull { message.text.contains(marker(it)) } ?: continue
        identities.put(identityFacts(message).put("marker", suffix))
      }
      facts.put("assistantIdentities", identities)
    }
    File(directory, "$name.json").writeText(facts.toString(2))
    assertTrue("Could not capture private Wear failure UI", ui.device.takeScreenshot(File(directory, "$name.png")))
  }

  private fun identityFacts(message: WearChatMessage): JSONObject =
    JSONObject()
      .put("idPresent", message.id != null)
      .put("idHash", identityHash(message.id))
      .put("timestamp", message.timestamp ?: JSONObject.NULL)
      .put("entryPresent", message.entryId != null)
      .put("entryHash", identityHash(message.entryId))
      .put("idempotencyKeyPresent", message.idempotencyKey != null)
      .put("idempotencyKeyHash", identityHash(message.idempotencyKey))

  private fun identityHash(value: String?): Any =
    value?.let {
      MessageDigest
        .getInstance("SHA-256")
        .digest(it.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }
        .take(12)
    } ?: JSONObject.NULL

  private val diagnosticMarkers = listOf("PHONE_FIRST", "PHONE_SECOND", "WEAR_FIRST", "WEAR_SECOND", "WEAR_RELAUNCH", "PHONE_RELAUNCH", "PHONE_RESTART", "LONG_REPLY")
}
