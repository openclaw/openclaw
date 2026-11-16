package ai.openclaw.wear

import android.app.Application
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.wear.compose.foundation.LocalReduceMotion
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.TimeSource
import androidx.wear.compose.material3.TimeText
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w192dp-h192dp-round-xhdpi", application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WearRoundLayoutTest {
  @get:Rule val compose = createEmptyComposeRule()
  private var controller: ActivityController<ComponentActivity>? = null
  private var snapshot by mutableStateOf<WearConversationSnapshot?>(null)
  private var loading by mutableStateOf(true)
  private var refreshes = 0
  private var reduceMotion = false
  private var themeMode = WearThemeMode.Dark
  private var previousAnimationScale = 1f
  private val timeSource =
    object : TimeSource {
      @Composable override fun currentTime(): String = "10:09"
    }

  @After fun cleanup() {
    controller?.pause()?.stop()?.destroy()
    RuntimeEnvironment.setFontScale(1f)
    Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousAnimationScale)
  }

  @Test fun compactConnection() = connection()

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-xhdpi")
  fun largeConnection() = connection()

  @Test fun compactControls() = controls()

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-xhdpi")
  fun largeControls() = controls()

  @Test fun compactLargeTextConnection() {
    RuntimeEnvironment.setFontScale(1.3f)
    connection(largeText = true)
  }

  @Test fun compactLargeTextControls() {
    RuntimeEnvironment.setFontScale(1.3f)
    controls()
  }

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-xhdpi")
  fun largeTextConnection() {
    RuntimeEnvironment.setFontScale(1.3f)
    connection(largeText = true)
  }

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-xhdpi")
  fun largeTextControls() {
    RuntimeEnvironment.setFontScale(1.3f)
    controls()
  }

  @Test fun compactReducedMotionControls() {
    reduceMotion = true
    controls()
  }

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-xhdpi")
  fun largeReducedMotionControls() {
    reduceMotion = true
    controls()
  }

  @Test fun compactLightConnection() {
    themeMode = WearThemeMode.Light
    connection()
  }

  @Test
  @Config(qualifiers = "de-rDE-w192dp-h192dp-round-xhdpi")
  fun compactGermanCheckingPhone() {
    show(WearHomePage.Chat)
    compose.onNodeWithText(RuntimeEnvironment.getApplication().getString(R.string.retry)).assertIsDisplayed().assertIsNotEnabled()
    capture("checking-german-initial")
  }

  @Test fun removingSelectedPulseReturnsToChat() {
    snapshot = WearScreenshotFixture.snapshot.copy(agentPulseSupported = true)
    loading = false
    show(WearHomePage.Pulse)
    compose.onNodeWithText("PULSE").assertIsDisplayed()
    capture("pulse-before-removal")

    compose.runOnIdle {
      snapshot = WearScreenshotFixture.snapshot.copy(agentPulseSupported = false)
    }

    assertChatAndCapture("after-pulse-removal")
  }

  @Test fun changingPulseAvailabilityPreservesControls() {
    snapshot = WearScreenshotFixture.snapshot.copy(agentPulseSupported = true)
    loading = false
    show(WearHomePage.Controls)
    compose.onNodeWithText("CONTROLS").assertIsDisplayed()

    compose.runOnIdle { snapshot = WearScreenshotFixture.snapshot }
    compose.onNodeWithText("CONTROLS").assertIsDisplayed()
    capture("controls-without-pulse")

    compose.runOnIdle { snapshot = WearScreenshotFixture.snapshot.copy(agentPulseSupported = true) }
    compose.onNodeWithText("CONTROLS").assertIsDisplayed()
    capture("controls-with-pulse")
  }

  @Test fun reconnectingWithoutPulseReturnsToChat() {
    snapshot = WearScreenshotFixture.snapshot.copy(agentPulseSupported = true)
    loading = false
    show(WearHomePage.Pulse)
    compose.onNodeWithText("PULSE").assertIsDisplayed()

    compose.runOnIdle { snapshot = null }
    compose.onNodeWithText("Retry").assertIsDisplayed()
    compose.runOnIdle { snapshot = WearScreenshotFixture.snapshot }

    assertChatAndCapture("chat-after-reconnect")
  }

  @Test fun restoringWithoutSelectedPulseReturnsToChat() {
    snapshot = WearScreenshotFixture.snapshot.copy(agentPulseSupported = true)
    loading = false
    show(WearHomePage.Pulse)
    compose.onNodeWithText("PULSE").assertIsDisplayed()
    val savedState = Bundle()
    compose.runOnIdle {
      checkNotNull(controller)
        .pause()
        .saveInstanceState(savedState)
        .stop()
        .destroy()
      snapshot = WearScreenshotFixture.snapshot
    }

    show(WearHomePage.Chat, savedState)

    assertChatAndCapture("chat-after-restoration")
  }

  @Test fun repeatedUnidentifiedChatMessagesRemainReadable() {
    val reply = WearChatMessage(id = null, role = "assistant", text = "All set.", timestamp = null)
    snapshot = WearScreenshotFixture.snapshot.copy(messages = listOf(reply))
    loading = false
    show(WearHomePage.Chat)
    compose.onNodeWithText("All set.").assertIsDisplayed()
    capture("chat-before-repeated-message")

    compose.runOnIdle {
      val current = checkNotNull(snapshot)
      snapshot = current.copy(messages = mergeEventMessage(current.messages, reply))
    }

    compose.onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).performScrollToIndex(3)
    capture("chat-after-repeated-message")
    compose.onAllNodesWithText("All set.").assertCountEquals(2)
  }

  @Test fun chatMessageIdDoesNotCollideWithEndAnchor() {
    snapshot =
      WearScreenshotFixture.snapshot.copy(
        messages = listOf(WearChatMessage(id = "chat-end", role = "assistant", text = "Reply received.", timestamp = 1)),
      )
    loading = false
    show(WearHomePage.Chat)

    compose.onNodeWithText("Reply received.").assertIsDisplayed()
    compose.onNodeWithText("Speak latest reply").assertIsDisplayed()
  }

  private fun assertChatAndCapture(name: String) {
    compose.onNodeWithText("Speak latest reply").assertIsDisplayed()
    compose.onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).performScrollToIndex(0)
    capture(name)
    compose.onNodeWithText("CHAT").assertIsDisplayed()
  }

  private fun connection(largeText: Boolean = false) {
    show(WearHomePage.Chat)
    if (largeText) {
      compose
        .onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
        .performScrollToNode(hasText("Checking phone"))
    }
    compose.onNodeWithText("Retry").assertIsDisplayed().assertIsNotEnabled()
    val layouts = mutableListOf<TextLayoutResult>()
    compose
      .onNodeWithText("Checking phone", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertTrue(
      "Recovery title must stay readable on the black canvas",
      (
        layouts
          .single()
          .layoutInput.style.color
          .luminance() + 0.05f
      ) / 0.05f >= 4.5f,
    )
    capture("checking-initial")
    compose.runOnIdle { loading = false }
    if (largeText) {
      compose
        .onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange))
        .performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, 10000f) }
    }
    compose.onNodeWithText("Retry").assertIsDisplayed().performClick()
    assertEquals(1, refreshes)
    capture("disconnected-initial")
  }

  private fun controls() {
    snapshot = WearScreenshotFixture.snapshot
    loading = false
    show(WearHomePage.Controls)
    capture("controls-initial")
    compose.onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).performScrollToIndex(1)
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
    compose.mainClock.advanceTimeBy(4000)
    capture("controls-first-card-idle")
    compose.onNode(hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).performScrollToNode(hasText("Refresh"))
    capture("controls-end")
    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(4))
    compose.mainClock.advanceTimeBy(4000)
    capture("controls-end-idle")
    println("REVIEW_REFRESH bounds=" + compose.onNodeWithText("Refresh").fetchSemanticsNode().boundsInRoot)
  }

  private fun capture(name: String) {
    val config = RuntimeEnvironment.getApplication().resources.configuration
    val bitmap = compose.onRoot().captureToImage().asAndroidBitmap()
    val radius = bitmap.width / 2f
    val clockInset = 32 * bitmap.width / config.screenWidthDp
    // TimeText can move off the top while scrolling; verify the app's list content separately.
    compose
      .onAllNodes(hasAnyAncestor(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)), useUnmergedTree = true)
      .fetchSemanticsNodes()
      .filter { it.boundsInRoot.height > 0f }
      .forEach {
        assertTrue("$name: list content overlaps clock: ${it.boundsInRoot}", it.boundsInRoot.top >= clockInset)
      }
    var clippedPixels = 0
    for (y in clockInset until bitmap.height) {
      for (x in 0 until bitmap.width) {
        val dx = x + 0.5f - radius
        val dy = y + 0.5f - bitmap.height / 2f
        if (dx * dx + dy * dy > radius * radius) {
          val pixel = bitmap.getPixel(x, y)
          if (android.graphics.Color.red(pixel) > 8 || android.graphics.Color.green(pixel) > 8 || android.graphics.Color.blue(pixel) > 8) clippedPixels++
        }
      }
    }
    System.getenv("WEAR_ROUND_PROOF_DIR")?.let { output ->
      val out = File(output, "$name-${config.screenWidthDp}-${config.fontScale}-${themeMode.rawValue}-reduce$reduceMotion.png")
      checkNotNull(out.parentFile).mkdirs()
      out.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    assertTrue("$name: $clippedPixels content pixels outside round display", clippedPixels == 0)
  }

  private fun show(
    page: WearHomePage,
    savedState: Bundle? = null,
  ) {
    if (savedState == null) {
      previousAnimationScale = Settings.Global.getFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
      Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    }
    val activity = Robolectric.buildActivity(ComponentActivity::class.java)
    if (savedState == null) activity.setup() else activity.setup(savedState)
    activity.visible()
    controller = activity
    activity.get().setContent {
      CompositionLocalProvider(LocalReduceMotion provides reduceMotion) {
        OpenClawWearTheme(themeMode) {
          AppScaffold(timeText = { TimeText(timeSource = timeSource) }) {
            OpenClawWearScreens(
              snapshot = snapshot,
              failure = WearConversationFailure.PHONE_UNAVAILABLE,
              loading = loading,
              interaction = WearInteractionState.READY,
              speaking = false,
              realtimeCapturing = false,
              realtimePlaying = false,
              realtimeMouthLevel = 0f,
              realtimePlaybackFailed = false,
              realtimeThinkingOverride = false,
              actionBusy = false,
              inputEnabled = true,
              canAbort = false,
              themeMode = themeMode,
              autoSpeak = false,
              notificationsGranted = true,
              initialPage = page,
              voiceSwipeHintEnabled = false,
              onTalk = {},
              onType = {},
              onRealtimeTalk = {},
              onAbort = {},
              onSelectAgent = {},
              onSelectSession = {},
              onSelectModel = {},
              onRefresh = { refreshes++ },
              onGatewayEnabledChange = {},
              onThemeModeChange = {},
              onAutoSpeakChange = {},
              onRequestNotifications = {},
              onOpenNotificationSettings = {},
              onSpeakLatest = {},
              onStopSpeaking = {},
            )
          }
        }
      }
    }
  }
}
