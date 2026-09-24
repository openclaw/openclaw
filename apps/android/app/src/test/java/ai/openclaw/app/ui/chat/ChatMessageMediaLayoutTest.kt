package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.util.Base64
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.awaitCancellation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.io.File

/** Native production message boundary; synthetic bytes, no Gateway, account, or device state. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatMessageMediaLayoutTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun userGalleryPrecedesCaptionAndKeepsImagesOutsideTheTextSurface() {
    val images = (1..3).map { image(it) }
    show(listOf(ChatMessageContent(text = "Which garden layout works best?")) + images)
    awaitImages(3)
    capture("phone-user-gallery")
    val first = bounds("Garden 1")
    val second = bounds("Garden 2")
    val third = bounds("Garden 3")
    val caption = composeRule.onNodeWithText("Which garden layout works best?", useUnmergedTree = true).getUnclippedBoundsInRoot()
    assertEquals("Adjacent photos share a compact row", first.top.value, second.top.value, 1f)
    assertTrue("Third photo wraps on a phone", third.top >= first.bottom)
    assertTrue("User attachments precede their caption", caption.top > third.bottom)
    assertTrue("Media aligns to the user's trailing edge", second.right.value >= 320f)
    val pixels = composeRule.onNodeWithTag("transcript").captureToImage().asAndroidBitmap()
    assertEquals("Media has canvas, not a text bubble, beside it", pixels.getPixel(0, 0), pixels.getPixel(first.left.value.toInt() - 2, first.top.value.toInt() + 20))
  }

  @Test
  fun fifthImageIsReachableWithoutComposingMoreThanFourPreviews() {
    val requested = mutableListOf<String>()
    show((1..5).map { image(it) }, requests = requested)
    awaitImages(4)
    capture("five-images-first-page")
    assertEquals(listOf("garden-1", "garden-2", "garden-3", "garden-4"), requested)
    composeRule.onNodeWithText("Next images").performClick()
    awaitImages(1)
    composeRule.onNodeWithContentDescription("Garden 5", useUnmergedTree = true).assertIsDisplayed()
    capture("five-images-next-page")
    composeRule.onNodeWithContentDescription("Open image preview").performClick()
    composeRule.onNodeWithContentDescription("Close image preview").assertIsDisplayed().performClick()
    composeRule.onNodeWithText("Previous images").performClick()
    awaitImages(4)
  }

  @Test
  fun portraitAndPanoramaStayBoundedAndAssistantOrderIsUnchanged() {
    show(listOf(ChatMessageContent(text = "Before"), image(1), ChatMessageContent(text = "After"), image(2)), role = "assistant", dimensions = mapOf("garden-1" to (240 to 960), "garden-2" to (960 to 160)))
    awaitImages(2)
    capture("assistant-ordered-portrait-panorama")
    val first = bounds("Garden 1")
    val second = bounds("Garden 2")
    val before = composeRule.onNodeWithText("Before", useUnmergedTree = true).getUnclippedBoundsInRoot()
    val after = composeRule.onNodeWithText("After", useUnmergedTree = true).getUnclippedBoundsInRoot()
    assertTrue(before.bottom <= first.top)
    assertTrue(first.bottom <= after.top)
    assertTrue(after.bottom <= second.top)
    assertTrue("A portrait never consumes the transcript viewport", (first.bottom - first.top) <= 320.dp)
    assertEquals("Portrait preserves its natural ratio", 0.25f, (first.right - first.left).value / (first.bottom - first.top).value, 0.01f)
    assertEquals("Panorama preserves its natural ratio", 6f, (second.right - second.left).value / (second.bottom - second.top).value, 0.1f)
    assertEquals("Text and media share the agent inset", before.left.value, first.left.value, 1f)
  }

  @Test
  fun extremeAspectImagesKeepBothBoundsAndAnOperablePreview() {
    show(listOf(image(1), ChatMessageContent(text = "Tall image"), image(2)), role = "assistant", dimensions = mapOf("garden-1" to (1600 to 1), "garden-2" to (1 to 1600)))
    awaitImages(2)
    for (label in listOf("Garden 1", "Garden 2")) {
      val image = bounds(label)
      assertTrue("$label width remains inside the message", image.right - image.left <= 328.dp)
      assertTrue("$label height remains bounded", image.bottom - image.top <= 320.dp)
      assertTrue("$label keeps an operable preview", image.right - image.left >= 48.dp && image.bottom - image.top >= 48.dp)
    }
  }

  @Test
  fun singleImageAndCaptionUseIndependentSurfacesInBothThemes() {
    val dark = mutableStateOf(true)
    val content = listOf(image(1), ChatMessageContent(text = "A sunny place for herbs."))
    val bytes = fixtureImage(480, 320)
    composeRule.setContent {
      ClawDesignTheme(dark = dark.value) {
        Column(
          Modifier
            .fillMaxSize()
            .background(ClawTheme.colors.canvas)
            .testTag("transcript")
            .padding(16.dp),
          verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
          Message(content, "user", bytes = { bytes })
          Message(content, "assistant", bytes = { bytes })
        }
      }
    }
    awaitImages(2)
    capture("single-dark")
    composeRule.runOnIdle { dark.value = false }
    capture("single-light")
  }

  @Test
  @Config(qualifiers = "en-rUS-w800dp-h800dp-mdpi")
  fun tabletGalleryUsesAvailableWidthWithoutExpandingEachThumbnail() {
    show((1..3).map { image(it) })
    awaitImages(3)
    capture("tablet-three-images")
    val first = bounds("Garden 1")
    val third = bounds("Garden 3")
    assertEquals(first.top.value, third.top.value, 1f)
    assertTrue((first.right - first.left) <= 160.dp)
  }

  @Test
  fun changingTheImagePageCancelsPreviousLoadsAcrossSeparatedAssistantRuns() {
    val active = mutableSetOf<String>()
    var peak = 0
    val parts = (1..5).flatMap { listOf(ChatMessageContent(text = "Step $it"), image(it)) }
    composeRule.setContent {
      ClawDesignTheme {
        ChatBubble(
          messageId = "loading",
          entryId = null,
          role = "assistant",
          live = false,
          content = parts,
          timestampMs = null,
          onReplyMessage = {},
          sessionActionsEnabled = false,
          onRewindMessage = {},
          onForkMessage = {},
          speechState = null,
          onToggleListen = { _, _ -> },
          inlineMediaPlaybackBlocked = false,
          inlineWidgetResolverReady = true,
          resolveInlineWidgetResource = { _, _ -> null },
          loadImageArtifact = { id ->
            active += id
            peak = maxOf(peak, active.size)
            try {
              awaitCancellation()
            } finally {
              active -= id
            }
          },
          loadMediaArtifact = { _, _, _ -> null },
        )
      }
    }
    composeRule.runOnIdle { assertEquals((1..4).map { "garden-$it" }.toSet(), active) }
    composeRule.onNodeWithText("Next images").performClick()
    composeRule.runOnIdle {
      assertEquals(setOf("garden-5"), active)
      assertTrue("The message-wide load window remains bounded", peak <= 4)
    }
    (1..5).forEach { composeRule.onNodeWithText("Step $it", useUnmergedTree = true).assertExists() }
  }

  @Test
  fun inlineAndManagedAttachmentsShareTheSameCompactLayout() {
    val encoded = Base64.encodeToString(fixtureImage(480, 320), Base64.NO_WRAP)
    show(listOf(ChatMessageContent(type = "image", mimeType = "image/png", base64 = encoded), image(2)))
    awaitImages(2)
    capture("mixed-inline-managed-two-images")
    val inline = bounds("image/png")
    val managed = bounds("Garden 2")
    assertEquals(inline.top.value, managed.top.value, 1f)
    assertEquals((inline.right - inline.left).value, (managed.right - managed.left).value, 1f)
  }

  @Test
  fun shortAndLongTextKeepTheirGuttersAndOnlyTheActualMessageHasActions() {
    val text = mutableStateOf("Looks good.")
    val bytes = fixtureImage(480, 320)
    composeRule.setContent {
      ClawDesignTheme {
        Column(
          Modifier
            .fillMaxSize()
            .background(ClawTheme.colors.canvas)
            .testTag("transcript")
            .padding(16.dp),
          verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
          Message(listOf(ChatMessageContent(text = text.value)), "user", bytes = { bytes })
          Message(listOf(ChatMessageContent(text = "A short reply.")), "assistant", bytes = { bytes })
        }
      }
    }
    val user = composeRule.onNodeWithContentDescription("You")
    val short = user.getUnclippedBoundsInRoot()
    val assistant = composeRule.onNodeWithContentDescription("OpenClaw").getUnclippedBoundsInRoot()
    val userText = composeRule.onNodeWithText("Looks good.", useUnmergedTree = true).getUnclippedBoundsInRoot()
    val agentText = composeRule.onNodeWithText("A short reply.", useUnmergedTree = true).getUnclippedBoundsInRoot()
    assertTrue("Short messages do not force a wide surface", (short.right - short.left).value < 160f)
    assertEquals(12f, (userText.left - short.left).value, 1f)
    assertEquals("Both roles use the same text inset", (userText.left - short.left).value, (agentText.left - assistant.left).value, 1f)
    composeRule.onNodeWithTag("transcript").performTouchInput { longClick(Offset(20f, (short.top.value + short.bottom.value) / 2)) }
    composeRule.onNodeWithText("Reply").assertDoesNotExist()
    user.performTouchInput { longClick(center) }
    composeRule.onNodeWithText("Reply").assertIsDisplayed().performClick()
    capture("text-short-gutters")
    composeRule.runOnIdle { text.value = "Keep a clear path between the planters and leave enough space for the herbs to grow. ".repeat(5) }
    val long = user.getUnclippedBoundsInRoot()
    assertTrue("Long user text keeps the original 78% budget", (long.right - long.left).value <= 328f * 0.78f + 1f)
    assertEquals("User messages remain right aligned", short.right.value, long.right.value, 1f)
    capture("text-long-gutters")
  }

  @Test
  fun adjacentAssistantGalleriesWrapAndPagingPausesAutomaticFollowing() {
    val count = mutableStateOf(2)
    var pauses = 0
    val bytes = fixtureImage(480, 320)
    composeRule.setContent {
      val scope = rememberCoroutineScope()
      val navigation = remember { ChatReaderNavigation(scope, pauseFollowing = { pauses++ }) }
      CompositionLocalProvider(LocalChatReaderNavigation provides navigation) {
        ClawDesignTheme {
          Column(
            Modifier
              .fillMaxSize()
              .background(ClawTheme.colors.canvas)
              .testTag("transcript")
              .padding(16.dp),
          ) {
            Message((1..count.value).map { image(it) }, "assistant", bytes = { bytes })
          }
        }
      }
    }
    for (size in listOf(2, 3, 5)) {
      composeRule.runOnIdle { count.value = size }
      awaitImages(minOf(size, 4))
      assertEquals(bounds("Garden 1").top.value, bounds("Garden 2").top.value, 1f)
      capture("assistant-gallery-$size")
    }
    composeRule.onNodeWithText("Next images").performClick()
    awaitImages(1)
    assertEquals(1, pauses)
    composeRule.onNodeWithContentDescription("Garden 5", useUnmergedTree = true).assertIsDisplayed()
    capture("assistant-gallery-next-page")
  }

  private fun show(
    content: List<ChatMessageContent>,
    role: String = "user",
    requests: MutableList<String> = mutableListOf(),
    dimensions: Map<String, Pair<Int, Int>> = emptyMap(),
  ) {
    val defaultBytes = fixtureImage(480, 320)
    val imageBytes = dimensions.mapValues { (_, size) -> fixtureImage(size.first, size.second) }
    composeRule.setContent {
      ClawDesignTheme {
        Column(
          Modifier
            .fillMaxSize()
            .background(ClawTheme.colors.canvas)
            .testTag("transcript")
            .padding(16.dp),
        ) {
          Message(content, role, bytes = { id ->
            requests += id
            imageBytes[id] ?: defaultBytes
          })
        }
      }
    }
  }

  @Composable
  private fun Message(
    content: List<ChatMessageContent>,
    role: String,
    bytes: (String) -> ByteArray,
  ) {
    ChatBubble(
      messageId = "media-$role",
      entryId = "entry-$role",
      role = role,
      live = false,
      content = content,
      timestampMs = null,
      onReplyMessage = {},
      sessionActionsEnabled = true,
      onRewindMessage = {},
      onForkMessage = {},
      speechState = null,
      onToggleListen = { _, _ -> },
      inlineMediaPlaybackBlocked = false,
      inlineWidgetResolverReady = true,
      resolveInlineWidgetResource = { _, _ -> null },
      loadImageArtifact = { GatewayLoadedImage(bytes(it), "image/png") },
      loadMediaArtifact = { _, _, _ -> null },
    )
  }

  private fun awaitImages(count: Int) {
    composeRule.waitUntil { composeRule.onAllNodesWithContentDescription("Open image preview").fetchSemanticsNodes().size == count }
    composeRule.onAllNodesWithContentDescription("Open image preview").assertCountEquals(count)
  }

  private fun bounds(label: String) = composeRule.onNodeWithContentDescription(label, useUnmergedTree = true).getUnclippedBoundsInRoot()

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_MEDIA_PROOF_DIR") ?: return
    val file = File(directory, "$name.png")
    file.parentFile!!.mkdirs()
    file.outputStream().use {
      assertTrue(
        composeRule
          .onNodeWithTag("transcript")
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }

  private fun image(index: Int) = ChatMessageContent(type = "image", artifactId = "garden-$index", alt = "Garden $index")

  private fun fixtureImage(
    width: Int,
    height: Int,
  ): ByteArray {
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    Canvas(bitmap).apply {
      drawColor(Color.rgb(30, 68, 67))
      val paint = Paint().apply { color = Color.rgb(147, 185, 126) }
      drawRect(width * 0.08f, height * 0.12f, width * 0.92f, height * 0.88f, paint)
      paint.color = Color.rgb(229, 188, 117)
      drawCircle(width * 0.5f, height * 0.5f, minOf(width, height) * 0.24f, paint)
      paint.color = Color.rgb(35, 72, 60)
      paint.textSize = minOf(width, height) * 0.09f
      drawText("GARDEN PLAN", width * 0.17f, height * 0.52f, paint)
    }
    return ByteArrayOutputStream().use { output ->
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
      bitmap.recycle()
      output.toByteArray()
    }
  }
}
