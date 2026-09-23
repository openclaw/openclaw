package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatActiveRunPresentation
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.provider.Settings
import android.util.Base64
import android.view.View
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.AbstractComposeView
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.UUID

/** ChatScreen, reader and composer together, using the existing isolated runtime mode. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatMediaTranscriptLayoutTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun captionedPhotosStayReadableBesideTheActualChatComposer() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val runtimeField = NodeApp::class.java.getDeclaredField("runtimeInstance").apply { isAccessible = true }
    val originalScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("media-transcript-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    var root: AbstractComposeView? = null
    try {
      runtimeField.set(app, runtime)
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("chat", model)
      model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
      composeRule.setContent {
        val view = LocalView.current
        SideEffect { root = generateSequence(view) { it.parent as? View }.filterIsInstance<AbstractComposeView>().single() }
        ClawDesignTheme {
          Box(Modifier.fillMaxSize().background(ClawTheme.colors.canvas).testTag("full-chat")) {
            ChatScreen(model, false, true, {}, {}, {}, {})
          }
        }
      }
      composeRule.waitUntil { model.chatMessages.value.isNotEmpty() && !model.chatHistoryLoading.value }
      val controller =
        ChatController::class.java.cast(
          NodeRuntime::class.java
            .getDeclaredField("chat")
            .apply { isAccessible = true }
            .get(runtime),
        )
      val image = gardenImage()
      composeRule.runOnIdle {
        @Suppress("UNCHECKED_CAST")
        val messages =
          ChatController::class.java
            .getDeclaredField("_messages")
            .apply { isAccessible = true }
            .get(controller) as MutableStateFlow<List<ChatMessage>>

        @Suppress("UNCHECKED_CAST")
        val pending =
          ChatController::class.java
            .getDeclaredField("_pendingRunCount")
            .apply { isAccessible = true }
            .get(controller) as MutableStateFlow<Int>

        @Suppress("UNCHECKED_CAST")
        val active =
          ChatController::class.java
            .getDeclaredField("selectedActiveRunPresentationState")
            .apply { isAccessible = true }
            .get(controller) as MutableStateFlow<ChatActiveRunPresentation>
        pending.value = 0
        active.value = ChatActiveRunPresentation()
        messages.value =
          listOf(
            ChatMessage("garden-question", "user", listOf(ChatMessageContent(text = "Which garden layout works best?"), image, image), null),
            ChatMessage("garden-answer", "assistant", listOf(ChatMessageContent(text = "The sunny bed has room for herbs. Keep a clear path between the planters.")), null),
          )
      }
      composeRule.waitUntil { composeRule.onAllNodesWithContentDescription("Open image preview").fetchSemanticsNodes().size == 2 }
      composeRule.onNodeWithText("Which garden layout works best?", useUnmergedTree = true).assertIsDisplayed()
      composeRule.onNodeWithText("The sunny bed has room for herbs. Keep a clear path between the planters.", useUnmergedTree = true).assertIsDisplayed()
      System.getenv("OPENCLAW_MEDIA_PROOF_DIR")?.let { directory ->
        val bitmap = composeRule.onNodeWithTag("full-chat").captureToImage().asAndroidBitmap()
        assertEquals(360, bitmap.width)
        assertEquals(800, bitmap.height)
        val file = File(directory, "phone-full-chat.png")
        file.parentFile!!.mkdirs()
        file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
      }
    } finally {
      // Finish real consumers before closing their runtime or restoring application state.
      root?.let { composeRule.runOnUiThread { it.disposeComposition() } }
      models.clear()
      closeNodeRuntimeTestFixture(runtime)
      runtimeField.set(app, previousRuntime)
      AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
      Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private fun gardenImage(): ChatMessageContent {
    val bitmap = Bitmap.createBitmap(480, 320, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).apply {
      drawColor(Color.rgb(30, 68, 67))
      val paint = Paint().apply { color = Color.rgb(147, 185, 126) }
      drawRect(32f, 32f, 448f, 288f, paint)
      paint.color = Color.rgb(229, 188, 117)
      drawCircle(240f, 160f, 75f, paint)
      paint.color = Color.rgb(35, 72, 60)
      paint.textSize = 28f
      drawText("GARDEN PLAN", 145f, 170f, paint)
    }
    val bytes =
      ByteArrayOutputStream().use {
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        it.toByteArray()
      }
    bitmap.recycle()
    return ChatMessageContent(type = "image", mimeType = "image/png", base64 = Base64.encodeToString(bytes, Base64.NO_WRAP))
  }
}
