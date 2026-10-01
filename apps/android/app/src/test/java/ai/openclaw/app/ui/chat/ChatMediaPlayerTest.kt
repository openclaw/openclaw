package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.gateway.GatewayLoadedMedia
import ai.openclaw.app.gateway.GatewayMediaKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.media3.common.Player
import kotlinx.coroutines.awaitCancellation
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.android.util.concurrent.PausedExecutorService
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class ChatMediaPlayerTest {
  private class FakePlayer {
    var released = false

    fun release() {
      released = true
    }
  }

  private class FakeSession {
    var released = false
  }

  @get:Rule
  val composeRule =
    createComposeRule(
      effectContext =
        object : MotionDurationScale {
          override val scaleFactor = 0f
        },
    )

  @Test
  @Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun preparingVideoCanBePlayedAgainAfterAnotherCardClaimsPlayback() {
    val requestEnqueued = CountDownLatch(1)
    // Hold the real Media3 HTTP request before READY without a server, sleeps, or player mocks.
    val network =
      object : PausedExecutorService() {
        override fun execute(command: Runnable) {
          super.execute(command)
          requestEnqueued.countDown()
        }
      }
    val client = OkHttpClient.Builder().dispatcher(Dispatcher(network)).build()
    val requests = mutableListOf<Triple<String, GatewayMediaKind, Boolean>>()
    val blocked = mutableStateOf(false)
    val visible = mutableStateOf(true)
    val video =
      ChatMessageContent(
        type = "video",
        artifactId = "preparing-video",
        mimeType = "video/mp4",
        fileName = "Trail camera.mp4",
        playback = "transcode",
      )
    val audio = ChatMessageContent(type = "audio", artifactId = "other-audio", fileName = "Field notes.m4a")
    try {
      composeRule.setContent {
        ClawDesignTheme {
          Box(Modifier.fillMaxSize().background(ClawTheme.colors.canvas).padding(16.dp)) {
            if (visible.value) {
              ChatBubble(
                messageId = "media-handoff",
                entryId = null,
                role = "assistant",
                live = false,
                content = listOf(video, audio),
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
                loadMediaArtifact = { id, kind, rendition ->
                  requests.add(Triple(id, kind, rendition))
                  if (id == audio.artifactId) awaitCancellation()
                  GatewayLoadedMedia.Streaming(
                    url = "https://media.invalid/video.mp4?playback=1",
                    headers = emptyMap(),
                    client = client,
                    mimeType = "video/mp4",
                    retryPreparingPlayback = true,
                  )
                },
              )
            }
          }
        }
      }
      composeRule.onNodeWithContentDescription("Play video").performClick()
      composeRule.onNodeWithText("Preparing playback…").assertIsDisplayed()
      assertTrue("Media3 must be preparing the first card, not awaiting its artifact", requestEnqueued.await(5, TimeUnit.SECONDS))

      composeRule.onNodeWithContentDescription("Play audio").assertIsEnabled().performClick()
      System.getenv("OPENCLAW_MEDIA_PROOF_DIR")?.let { directory ->
        val file = File(directory, "playback-handoff.png")
        checkNotNull(file.parentFile).mkdirs()
        file.outputStream().use { output ->
          assertTrue(
            composeRule
              .onRoot()
              .captureToImage()
              .asAndroidBitmap()
              .compress(Bitmap.CompressFormat.PNG, 100, output),
          )
        }
      }
      composeRule.onNodeWithText("Preparing playback…").assertDoesNotExist()
      composeRule.onNodeWithContentDescription("Play video").assertIsDisplayed().assertIsEnabled()

      composeRule.runOnIdle { blocked.value = true }
      composeRule.onNodeWithContentDescription("Play video").assertIsNotEnabled()
      composeRule.runOnIdle { blocked.value = false }
      composeRule.onNodeWithContentDescription("Play video").assertIsEnabled().performClick()
      composeRule.onNodeWithText("Preparing playback…").assertIsDisplayed()
      composeRule.runOnIdle {
        assertEquals(
          listOf(
            Triple("preparing-video", GatewayMediaKind.Video, true),
            Triple("other-audio", GatewayMediaKind.Audio, false),
            Triple("preparing-video", GatewayMediaKind.Video, true),
          ),
          requests,
        )
      }
    } finally {
      // Release the actual player and cancel pending artifact work before discarding HTTP tasks.
      composeRule.runOnIdle { visible.value = false }
      composeRule.waitForIdle()
      client.dispatcher.cancelAll()
      network.shutdownNow()
    }
  }

  @Test
  fun claimHandoffReleasesPreviousPlaybackInstance() {
    val first = FakePlayer()
    val second = FakePlayer()
    val claims = ChatMediaPlaybackClaims<FakePlayer>(pause = {}, release = FakePlayer::release)

    claims.claim(first)
    claims.claim(second)

    assertTrue(first.released)
    assertFalse(second.released)
    assertSame(second, claims.active)
  }

  @Test
  fun pauseThenReclaimRetainsPlaybackInstance() {
    val player = FakePlayer()
    val claims = ChatMediaPlaybackClaims<FakePlayer>(pause = {}, release = FakePlayer::release)

    claims.claim(player)
    claims.pauseIf { it === player }
    claims.claim(player)

    assertFalse(player.released)
    assertSame(player, claims.active)
  }

  @Test
  fun playbackClaimsCreateAndReleaseOnlyOneMediaSession() {
    val first = FakePlayer()
    val second = FakePlayer()
    val sessions = ChatMediaSessionLifecycle<FakePlayer, FakeSession> { it.released = true }
    val claims =
      ChatMediaPlaybackClaims<FakePlayer>(
        pause = { player -> sessions.release(player) },
        release = { player -> sessions.release(player) },
      )

    claims.claim(first)
    val firstSession = sessions.activate(first) { FakeSession() }
    assertSame(firstSession, sessions.activate(first) { error("duplicate session") })

    claims.claim(second)
    val secondSession = sessions.activate(second) { FakeSession() }
    assertTrue(firstSession.released)
    assertFalse(secondSession.released)

    claims.pauseIf { it === second }
    assertTrue(secondSession.released)
  }

  @Test
  fun mediaSessionControllersCannotReplaceInlineMediaItem() {
    val commands =
      inlineMediaSessionPlayerCommands(
        Player.Commands
          .Builder()
          .addAllCommands()
          .build(),
      )

    assertTrue(commands.contains(Player.COMMAND_PLAY_PAUSE))
    assertTrue(commands.contains(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM))
    assertFalse(commands.contains(Player.COMMAND_SET_MEDIA_ITEM))
    assertFalse(commands.contains(Player.COMMAND_CHANGE_MEDIA_ITEMS))
    assertFalse(commands.contains(Player.COMMAND_STOP))
  }

  @Test
  fun legacyMediaPartsRenderLabelsWithoutPlayControlsOrClaims() {
    val audio =
      ChatMessageContent(
        type = "audio",
        mimeType = "audio/mpeg",
        fileName = "legacy.mp3",
        durationMs = 4_000,
      )
    val video =
      ChatMessageContent(
        type = "video",
        mimeType = "video/mp4",
        fileName = "legacy.mp4",
        durationMs = 9_000,
      )
    var loadCount = 0

    composeRule.setContent {
      ChatBubble(
        messageId = "legacy-media",
        entryId = null,
        role = "assistant",
        live = false,
        content = listOf(audio, video),
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
        loadMediaArtifact = { _, _, _ ->
          loadCount += 1
          null
        },
      )
    }

    composeRule.onNodeWithText("legacy.mp3").assertIsDisplayed()
    composeRule.onNodeWithText("legacy.mp4").assertIsDisplayed()
    composeRule.onNodeWithText("0:04").assertIsDisplayed()
    composeRule.onNodeWithText("0:09").assertIsDisplayed()
    composeRule.onAllNodesWithContentDescription("Play audio").assertCountEquals(0)
    composeRule.onAllNodesWithContentDescription("Play video").assertCountEquals(0)
    composeRule.runOnIdle {
      assertEquals(0, loadCount)
      assertFalse(audio.hasPlayableMediaArtifact())
      assertFalse(video.hasPlayableMediaArtifact())
    }
  }
}
