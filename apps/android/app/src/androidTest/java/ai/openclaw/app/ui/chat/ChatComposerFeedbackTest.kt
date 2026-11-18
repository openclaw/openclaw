package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.MainActivity
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.extraAndroidScreenshotMode
import ai.openclaw.app.extraAndroidScreenshotScene
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import androidx.lifecycle.ViewModelProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class ChatComposerFeedbackTest {
  @Test
  fun pendingPhotoImportShowsProgressAndPreservesTheCaption() =
    runBlocking<Unit> {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val context = instrumentation.targetContext
      val device = UiDevice.getInstance(instrumentation)
      val before = InstrumentationRegistry.getArguments().getString("proofStage") == "before"
      val stage = if (before) "before" else "after"
      val proofDirectory = checkNotNull(context.getExternalFilesDir(null))
      val prefs = (context.applicationContext as NodeApp).prefs
      prefs.gatewayRegistry.upsert(
        GatewayRegistryEntry(AndroidScreenshotFixture.gatewayId, GatewayRegistryEntryKind.MANUAL, "Screenshot fixture"),
      )
      prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
      val intent =
        Intent(context, MainActivity::class.java)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
          .putExtra(extraAndroidScreenshotMode, true)
          .putExtra(extraAndroidScreenshotScene, "branches")
      val entered = CompletableDeferred<Unit>()
      val release = CompletableDeferred<List<PendingAttachment>>()
      ActivityScenario.launch<MainActivity>(intent).use { scenario ->
        assertNotNull(device.wait(Until.findObject(By.desc("Add attachment")), 15000))
        lateinit var model: MainViewModel
        scenario.onActivity { activity -> model = ViewModelProvider(activity)[MainViewModel::class.java] }
        val owner = model.captureChatShareOwner()
        val caption = "What do you think of this photo?"
        val bitmap = Bitmap.createBitmap(240, 160, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(63, 129, 169)) }
        val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        val photo = PendingAttachment("sample-photo", "sample-photo.png", "image/png", Base64.getEncoder().encodeToString(bytes))
        try {
          scenario.onActivity {
            model.chatComposerState.textDrafts[owner] = caption
            val authorization = checkNotNull(model.chatComposerState.beginMediaAcquisition(owner))
            model.importChatComposerAttachments(owner, authorization, model.mainSessionKey.value, expectedCount = 1) {
              entered.complete(Unit)
              release.await()
            }
          }
          withTimeout(5000) { entered.await() }
          assertNotNull(device.wait(Until.findObject(By.text(caption)), 5000))
          val send = device.wait(Until.findObject(By.desc("Send")), 5000)
          assertNotNull(send)
          assertTrue(model.chatComposerState.hasPendingImport(owner))
          assertEquals(ChatComposerSendStartResult.Unavailable, model.chatComposerState.beginSend(owner).result)
          if (!before) assertTrue(device.wait(Until.hasObject(By.text("Preparing attachments…")), 5000))
          device.takeScreenshot(File(proofDirectory, "android-$stage-photo-preparing.png"))
          release.complete(listOf(photo))
          assertTrue(device.wait(Until.hasObject(By.desc("Remove attachment")), 5000))
          assertTrue(device.wait(Until.gone(By.text("Preparing attachments…")), 5000))
          assertEquals(caption, model.chatComposerState.textDrafts[owner])
          assertEquals(listOf(photo), model.chatComposerState.attachments.value[owner])
          device.takeScreenshot(File(proofDirectory, "android-$stage-photo-ready.png"))
        } finally {
          release.complete(emptyList())
        }
      }
    }
}
