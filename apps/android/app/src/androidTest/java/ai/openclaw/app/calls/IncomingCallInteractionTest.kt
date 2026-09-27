package ai.openclaw.app.calls

import ai.openclaw.app.MainActivity
import ai.openclaw.app.NodeApp
import ai.openclaw.app.extraAndroidScreenshotMode
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.Manifest
import android.app.NotificationManager
import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.regex.Pattern

/** Synthetic platform/UI proof only: no provider, microphone recording, or real Gateway credentials. */
@RunWith(AndroidJUnit4::class)
class IncomingCallInteractionTest {
  @Test
  fun notificationAnswerMuteAndHangup() =
    runBlocking {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val context = instrumentation.targetContext
      val app = context.applicationContext as NodeApp
      val device = UiDevice.getInstance(instrumentation)
      listOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS).forEach {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, it)
      }
      context.startActivity(
        Intent(context, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
          .putExtra(extraAndroidScreenshotMode, true),
      )
      assertNotNull(device.wait(Until.findObject(By.desc("Show Sidebar")), 20_000))
      val screenshots = File(context.getExternalFilesDir(null), "incoming-call-proof").apply { mkdirs() }
      assertTrue(device.takeScreenshot(File(screenshots, "before-invitation.png")))
      val runtime = app.ensureBackgroundRuntime()
      val field = runtime.javaClass.getDeclaredField("incomingCalls\$delegate").apply { isAccessible = true }
      val previous = field.get(runtime)
      val previousGateway = app.prefs.gatewayRegistry.activeStableId.value
      val fixtureGateway = "synthetic-instrumentation-gateway"
      val previousEntry =
        app.prefs.gatewayRegistry.entries.value
          .firstOrNull { it.stableId == fixtureGateway }
      app.prefs.gatewayRegistry.upsert(GatewayRegistryEntry(fixtureGateway, GatewayRegistryEntryKind.MANUAL, "Synthetic Gateway"))
      app.prefs.gatewayRegistry.setActive(fixtureGateway)
      val previousEnabled = app.prefs.incomingCallsEnabled.value
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
      var starts = 0
      var stopped = false
      var muted = false
      val controller =
        IncomingCallController(
          context,
          scope,
          app.prefs,
          gatewayId = { app.prefs.gatewayRegistry.activeStableId.value },
          captureAuthority = { { true } },
          isBusy = { false },
          startAudio = { _, _ -> starts++ },
          stopAudio = { stopped = true },
          setMuted = { muted = it },
        )
      try {
        field.set(runtime, lazyOf(controller))
        app.prefs.setIncomingCallsEnabled(true)
        val id = UUID.randomUUID().toString()
        val result =
          controller.invoke(
            "talk.incoming",
            buildJsonObject {
              put("callId", id)
              put("sessionKey", "agent:assistant:synthetic-ui-proof")
              put("callerName", "Assistant · test fixture")
              put("topic", "Synthetic interaction proof; no real call audio")
              put("expiresAtMs", System.currentTimeMillis() + 60_000)
            }.toString(),
          )
        assertTrue(result.error?.message.orEmpty(), result.ok)
        val notifications = context.getSystemService(NotificationManager::class.java)
        val deadline = SystemClock.elapsedRealtime() + 10_000
        while (notifications.activeNotifications.none { it.id == IncomingCallController.NOTIFICATION_ID } && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100)
        val incoming = notifications.activeNotifications.firstOrNull { it.id == IncomingCallController.NOTIFICATION_ID }
        assertNotNull("Telecom must authorize CallStyle notification", incoming)
        device.openNotification()
        val notification = device.wait(Until.findObject(By.text("Assistant · test fixture")), 5_000)
        assertNotNull("Incoming call must be discoverable in the notification shade", notification)
        notification.click()

        // Native Button themes can uppercase their accessible text.
        fun button(label: String) = By.text(Pattern.compile(Pattern.quote(label), Pattern.CASE_INSENSITIVE))
        val answer = device.wait(Until.findObject(button("Answer")), 10_000)
        assertNotNull(answer)
        assertEquals(0, starts)
        assertTrue(device.takeScreenshot(File(screenshots, "after-ringing.png")))
        answer.click()
        assertTrue(device.wait(Until.hasObject(By.text("Connected · microphone on")), 10_000))
        assertEquals(1, starts)
        assertTrue(device.takeScreenshot(File(screenshots, "after-active.png")))
        device.findObject(button("Mute microphone")).click()
        assertTrue(device.wait(Until.hasObject(button("Unmute microphone")), 5_000))
        assertTrue(muted)
        assertTrue(device.takeScreenshot(File(screenshots, "after-active-muted.png")))
        device.findObject(button("End call")).click()
        assertTrue(device.wait(Until.hasObject(By.text("Call ended")), 5_000))
        assertTrue(stopped)
        assertEquals(IncomingCallStatus.Ended, controller.state.value?.status)
        assertTrue(device.takeScreenshot(File(screenshots, "after-ended.png")))
      } catch (error: Throwable) {
        device.takeScreenshot(File(screenshots, "failure-before-cleanup.png"))
        device.dumpWindowHierarchy(File(screenshots, "failure-window.xml"))
        throw error
      } finally {
        withContext(Dispatchers.Main.immediate) { controller.invalidate() }
        scope.cancel()
        field.set(runtime, previous)
        app.prefs.setIncomingCallsEnabled(previousEnabled)
        if (previousEntry == null) app.prefs.gatewayRegistry.remove(fixtureGateway) else app.prefs.gatewayRegistry.upsert(previousEntry)
        app.prefs.gatewayRegistry.setActive(previousGateway)
      }
    }
}
