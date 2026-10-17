package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.util.Base64
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatAttachmentMessageLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  @Config(qualifiers = "w412dp-h915dp-xxhdpi")
  fun sentPhotoAndVoiceNoteRenderAsOneBubbleWithoutPlaceholder() {
    render("sent", listOf(photo(), ChatMessageContent(type = "text", text = "See attached."), voice()))
    composeRule.onNodeWithText("See attached.").assertDoesNotExist()
    composeRule.onNodeWithText("Voice note").assertExists()
    composeRule.onNodeWithText("1:16").assertExists()
  }

  @Test
  @Config(qualifiers = "w412dp-h915dp-xxhdpi")
  fun transcribedMessageKeepsPhotoAndVoiceRowWithTranscriptUnderIt() {
    render("transcribed-tall", listOf(photo(), ChatMessageContent(type = "text", text = "See attached.\n**[Transcription]**\n> $TRANSCRIPT"), voice()))
    composeRule.onNodeWithTag("chat-voice-transcript", useUnmergedTree = true).assertExists()
    composeRule.onNodeWithText("Voice note").assertExists()
    assertFalse(composeRule.onAllNodes(hasText("[Transcription]", substring = true)).fetchSemanticsNodes().isNotEmpty())
    assertTrue(composeRule.onAllNodes(hasText(TRANSCRIPT.takeLast(30), substring = true)).fetchSemanticsNodes().isNotEmpty())
  }

  private fun render(
    name: String,
    content: List<ChatMessageContent>,
  ) {
    composeRule.setContent {
      ClawDesignTheme(dark = false) {
        Bubble(content)
      }
    }
    composeRule.waitForIdle()
    capture(name)
  }

  @Composable
  private fun Bubble(content: List<ChatMessageContent>) {
    Column(
      Modifier
        .testTag(ROOT)
        .background(ClawTheme.colors.canvas)
        .padding(12.dp)
        .fillMaxWidth(),
    ) {
      ChatBubble(
        messageId = "unified",
        entryId = null,
        role = "user",
        live = false,
        content = content,
        timestampMs = null,
        onReplyMessage = {},
        sessionActionsEnabled = false,
        onRewindMessage = {},
        onForkMessage = {},
        speechState = null,
        onToggleListen = { _, _ -> },
        inlineMediaPlaybackBlocked = false,
        inlineWidgetResolverReady = false,
        resolveInlineWidgetResource = { _, _ -> null },
        loadImageArtifact = { null },
        loadMediaArtifact = { _, _, _ -> null },
      )
    }
  }

  private fun capture(name: String) {
    val dir = System.getProperty("openclaw.proofDir") ?: System.getenv("OPENCLAW_PROOF_DIR") ?: return
    File(dir).mkdirs()
    File(dir, "after-$name.png").outputStream().use {
      check(
        composeRule
          .onNodeWithTag(ROOT)
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }

  private fun photo(): ChatMessageContent {
    val bitmap = Bitmap.createBitmap(240, 360, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).apply {
      drawColor(0xFFF3E9D2.toInt())
      drawCircle(120f, 180f, 70f, Paint().apply { color = 0xFFE88FB0.toInt() })
    }
    val bytes =
      ByteArrayOutputStream().use { out ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, 90, out))
        out.toByteArray()
      }
    return ChatMessageContent(type = "image", mimeType = "image/jpeg", fileName = "1000186721.jpg", base64 = Base64.encodeToString(bytes, Base64.NO_WRAP))
  }

  private fun voice() = ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "voice-note-b9526ed8-69ef-44d1-ad36-0123456789ab.m4a", durationMs = 76_000)

  private companion object {
    const val ROOT = "unified-root"
    const val TRANSCRIPT =
      "Приложение Jet из Google Play для самокатов. У меня есть подписка, я часто катаюсь на самокатах, я живу вот здесь, перекладываю точку, " +
        "28 улица. Я хочу сделать монитор, который будет запускаться на сервере, и через него смотреть ближайшие самокаты и бронировать их. " +
        "Они бронируются на 10 минут, и по кругу их бронировать. Если стоит несколько рядом, бронировать по очереди, когда один подходит к концу, " +
        "бронировать следующий, типа 1, 2, 3, 1, 2, 3, если их больше, то ещё как-то по кругу, конец."
  }
}
