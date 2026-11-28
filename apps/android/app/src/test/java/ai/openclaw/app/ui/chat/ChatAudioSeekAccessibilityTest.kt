package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.gateway.GatewayLoadedMedia
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Application
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.core.os.LocaleListCompat
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.util.concurrent.PausedExecutorService
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatAudioSeekAccessibilityTest {
  @get:Rule
  val composeRule =
    createComposeRule(
      effectContext =
        object : MotionDurationScale {
          override val scaleFactor = 0f
        },
    )

  @Test
  fun audioSeekControlKeepsItsLabelAcrossAvailabilityChanges() {
    val application: Application = RuntimeEnvironment.getApplication()
    NativeStringResources.install(application)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
    val network = PausedExecutorService()
    val client =
      OkHttpClient
        .Builder()
        .dispatcher(Dispatcher(network))
        .build()
    val blocked = mutableStateOf(false)
    val visible = mutableStateOf(true)
    val content =
      ChatMessageContent(
        type = "audio",
        artifactId = "seek-label-audio",
        fileName = "Field notes.mp3",
        mimeType = "audio/mpeg",
        durationMs = 60_000,
      )
    try {
      composeRule.setContent {
        ClawDesignTheme {
          if (visible.value) {
            ChatBubble(
              messageId = "audio-seek-accessibility",
              entryId = null,
              role = "assistant",
              live = false,
              content = listOf(content),
              timestampMs = null,
              onReplyMessage = {},
              sessionActionsEnabled = false,
              onRewindMessage = {},
              onForkMessage = {},
              speechState = null,
              onToggleListen = { _, _ -> },
              inlineMediaPlaybackBlocked = blocked.value,
              inlineWidgetResolverReady = false,
              resolveInlineWidgetResource = { _, _ -> null },
              loadImageArtifact = { null },
              loadMediaArtifact = { _, _, _ ->
                GatewayLoadedMedia.Streaming(
                  url = "https://media.invalid/field-notes.mp3",
                  headers = emptyMap(),
                  client = client,
                  mimeType = "audio/mpeg",
                  retryPreparingPlayback = false,
                )
              },
            )
          }
        }
      }
      val seek = composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo))
      seek.assertIsDisplayed()
      seek.assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Audio position")))
      seek.assertIsNotEnabled()
      composeRule.onNodeWithContentDescription("Play audio").performClick()
      composeRule.waitForIdle()
      seek.assertIsEnabled()
      seek.assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Audio position")))
      composeRule.runOnIdle { blocked.value = true }
      seek.assertIsNotEnabled()
      seek.assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Audio position")))
      composeRule.runOnIdle { blocked.value = false }
      seek.assertIsEnabled()
      seek.assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Audio position")))
    } finally {
      composeRule.runOnIdle { visible.value = false }
      composeRule.waitForIdle()
      client.dispatcher.cancelAll()
      network.shutdownNow()
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }
}
