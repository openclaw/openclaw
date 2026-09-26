package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import android.graphics.Bitmap
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.wear.compose.material3.AppScaffold
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowSystemClock
import java.io.File
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WearVoiceLayoutTest {
  @get:Rule
  val compose = createEmptyComposeRule()

  private var controller: ActivityController<ComponentActivity>? = null

  @After
  fun disposeActivity() {
    controller?.pause()?.stop()?.destroy()
  }

  private val fontScale = mutableStateOf(1f)
  private val scenario = mutableStateOf(Scenario("idle"))
  private var liveClicks = 0
  private var recoveryClicks = 0

  private data class Scenario(
    val name: String,
    val status: WearRealtimeTalkStatus = WearRealtimeTalkStatus.OFF,
    val active: Boolean = false,
    val capturing: Boolean = false,
    val playing: Boolean = false,
    val stopping: Boolean = false,
    val audioFailed: Boolean = false,
    val permissionRequired: Boolean = false,
    val settingsRequired: Boolean = false,
    val label: Int? = null,
  )

  @Test
  @Config(qualifiers = "en-rUS-w192dp-h192dp-round-mdpi")
  fun smallEnglishRound() = assertVoiceLayout()

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun largerEnglishRound() = assertVoiceLayout()

  @Test
  @Config(qualifiers = "de-rDE-w192dp-h192dp-round-mdpi")
  fun smallGermanRound() = assertVoiceLayout()

  @Test
  @Config(qualifiers = "de-rDE-w227dp-h227dp-round-mdpi")
  fun largerGermanRound() = assertVoiceLayout()

  @Test
  @Config(qualifiers = "ja-rJP-w192dp-h192dp-round-mdpi")
  fun localizedVoiceActionsRemainCompleteAndTappable() = assertLocalizedVoiceActions()

  @Test
  @Config(qualifiers = "ru-rRU-w192dp-h192dp-round-mdpi")
  fun russianVoiceActionsRemainCompleteAndTappable() = assertLocalizedVoiceActions()

  @Test
  @Config(qualifiers = "en-rUS-w192dp-h192dp-round-mdpi")
  fun recoveryActionRevealsCompleteFeedback() = assertRecoveryFeedback()

  @Test
  @Config(qualifiers = "ru-rRU-w192dp-h192dp-round-mdpi")
  fun russianRecoveryActionRevealsCompleteFeedback() = assertRecoveryFeedback()

  private fun assertRecoveryFeedback() {
    val app = RuntimeEnvironment.getApplication()
    val originalScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    try {
      fontScale.value = 1.3f
      scenario.value = Scenario("recovery-feedback", permissionRequired = true)
      render()
      centerVoiceTarget(hasContentDescription(app.getString(R.string.talk)))
      val talk = compose.onNodeWithContentDescription(app.getString(R.string.talk))
      val target = talk.fetchSemanticsNode().boundsInRoot
      assertTrue("Recovery keeps a complete accessible target", target.width >= 48f && target.height >= 48f)
      val before = recoveryClicks
      compose.onRoot().performTouchInput { click(target.center) }
      compose.mainClock.advanceTimeBy(600)
      compose.waitForIdle()
      assertEquals("Recovery callback runs exactly once without changing the supplied state", before + 1, recoveryClicks)
      talk.assertIsDisplayed()
      val feedback = compose.onNodeWithText(app.getString(R.string.microphone_permission_required), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
      assertTrue("Recovery explanation must not cover the control", feedback.top >= talk.fetchSemanticsNode().boundsInRoot.bottom)
      val key = "${app.resources.configuration.locales[0].language}-192-1.3-recovery-feedback"
      capture(key)
      val failures = textErrors(key, app.getString(R.string.microphone_permission_required))
      assertTrue("Recovery reveals complete feedback without another scroll: ${failures.joinToString("; ")}", failures.isEmpty())
    } finally {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private fun assertLocalizedVoiceActions() {
    val app = RuntimeEnvironment.getApplication()
    val originalScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val failures = mutableListOf<String>()
    try {
      render()
      for (scale in listOf(1f, 1.3f)) {
        compose.runOnIdle { fontScale.value = scale }
        val key = "${app.resources.configuration.locales[0].language}-192-$scale-actions"
        capture(key)
        for (label in listOf(R.string.hold, R.string.dictate, R.string.tap, R.string.live, R.string.double_tap, R.string.thread)) {
          centerVoiceTarget(hasText(app.getString(label)))
          failures += textErrors(key, app.getString(label))
        }
        val scrollable = centerVoiceTarget(hasText(app.getString(R.string.live)))
        val liveLabel = compose.onNodeWithText(app.getString(R.string.live), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val before = liveClicks
        compose.onRoot().performTouchInput { click(liveLabel.center) }
        compose.waitForIdle()
        assertEquals("The localized Live label remains a working touch target at $scale", before + 1, liveClicks)
        if (scrollable) compose.onNodeWithContentDescription(app.getString(R.string.talk)).assertIsDisplayed()
        centerVoiceTarget(hasText(app.getString(R.string.thread)))
        val thread = threadTarget().fetchSemanticsNode().boundsInRoot
        if (!scrollable) {
          val talk = compose.onNodeWithContentDescription(app.getString(R.string.talk)).fetchSemanticsNode().boundsInRoot
          assertTrue("Thread and Talk retain separate touch targets at $scale", thread.bottom <= talk.top)
        }
        val beforeThread = liveClicks
        compose.onRoot().performTouchInput { doubleClick(thread.center) }
        compose.mainClock.advanceTimeBy(600)
        threadTarget().assertDoesNotExist()
        assertEquals("Thread never starts Talk at $scale", beforeThread, liveClicks)
        compose.onRoot().performTouchInput { swipeRight() }
        compose.mainClock.advanceTimeBy(600)
      }
      assertTrue("Voice actions must remain complete within the round screen: ${failures.joinToString("; ")}", failures.isEmpty())
    } finally {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  @Test
  @Config(qualifiers = "en-rUS-w192dp-h192dp-round-mdpi")
  fun talkTargetReceivesRealTapsOnSmallRoundWatch() = assertTalkHitTargets()

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun talkTargetReceivesRealTapsOnLargerRoundWatch() = assertTalkHitTargets()

  @Test
  @Config(qualifiers = "de-rDE-w192dp-h192dp-round-mdpi")
  fun germanTalkTargetsRemainSeparate() = assertTalkHitTargets()

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun largerRoundTalkUpperTapIsAPositiveControl() {
    val app = RuntimeEnvironment.getApplication()
    val originalScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    try {
      render()
      val orb = compose.onNodeWithContentDescription(RuntimeEnvironment.getApplication().getString(R.string.talk)).fetchSemanticsNode().boundsInRoot
      for (sample in listOf(orb.center, Offset(orb.center.x, orb.top + 4f))) {
        val before = liveClicks
        compose.onRoot().performTouchInput { click(sample) }
        compose.mainClock.advanceTimeBy(600)
        compose.waitForIdle()
        assertEquals(before + 1, liveClicks)
      }
    } finally {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private fun assertTalkHitTargets() {
    val app = RuntimeEnvironment.getApplication()
    val originalScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    try {
      render()
      val modes =
        listOf(
          Scenario("idle-pointer"),
          Scenario("active-pointer", active = true, capturing = true),
          Scenario("recovery-retry", permissionRequired = true),
          Scenario("recovery-settings", permissionRequired = true, settingsRequired = true),
        )
      for (scale in listOf(1f, 0.85f, 1.3f)) {
        for (mode in modes) {
          compose.runOnIdle {
            fontScale.value = scale
            scenario.value = mode
          }
          centerVoiceTarget(hasContentDescription(app.getString(R.string.talk)))
          val orb = compose.onNodeWithContentDescription(RuntimeEnvironment.getApplication().getString(R.string.talk)).fetchSemanticsNode().boundsInRoot
          assertTrue("Talk keeps an accessible target", orb.width >= 48f && orb.height >= 48f)
          val samples =
            listOf(Offset(orb.width / 2f, orb.height / 2f), Offset(orb.width / 2f, 4f)) +
              listOf(0.1f, 0.5f, 0.9f).flatMap { x ->
                listOf(0.1f, 0.5f, 0.9f).map { y -> Offset(orb.width * x, orb.height * y) }
              }
          for (relativeSample in samples) {
            // Revealing feedback may recenter the group; test every point on its current target.
            val currentOrb = compose.onNodeWithContentDescription(app.getString(R.string.talk)).fetchSemanticsNode().boundsInRoot
            assertTrue("Talk keeps an accessible target", currentOrb.width >= 48f && currentOrb.height >= 48f)
            val sample = currentOrb.topLeft + relativeSample
            val before = if (mode.permissionRequired) recoveryClicks else liveClicks
            compose.onRoot().performTouchInput { click(sample) }
            compose.mainClock.advanceTimeBy(600)
            compose.waitForIdle()
            assertEquals("Talk tap at $sample, scale=$scale, mode=$mode", before + 1, if (mode.permissionRequired) recoveryClicks else liveClicks)
          }
          centerVoiceTarget(hasText(app.getString(R.string.thread)))
          val thread = threadTarget().fetchSemanticsNode().boundsInRoot
          println("VOICE_TARGETS scale=$scale mode=$mode orb=$orb thread=$thread")
          assertTrue("Thread keeps its complete accessible target", thread.width >= 48f && thread.height >= 48f)
          // Scrollable controls need not be visible together; compare only the same viewport.
          compose.onAllNodes(hasContentDescription(app.getString(R.string.talk))).fetchSemanticsNodes().forEach { talk ->
            val visibleTalk = talk.boundsInRoot
            assertTrue("Complete Thread and Talk targets must be disjoint", thread.bottom <= visibleTalk.top || visibleTalk.bottom <= thread.top)
          }
        }
      }
      // Thread deliberately requires two pointer taps, while accessibility has one named action.
      for (scale in listOf(1f, 0.85f, 1.3f)) {
        for (mode in modes) {
          compose.runOnIdle {
            fontScale.value = scale
            scenario.value = mode
          }
          for (fraction in listOf(0.1f, 0.5f, 0.9f)) {
            centerVoiceTarget(hasText(app.getString(R.string.thread)))
            val thread = threadTarget().fetchSemanticsNode().boundsInRoot
            assertTrue("Thread keeps its complete accessible target", thread.width >= 48f && thread.height >= 48f)
            val sample = Offset(thread.center.x, thread.top + thread.height * fraction)
            val before = liveClicks + recoveryClicks
            compose.onRoot().performTouchInput { click(sample) }
            compose.mainClock.advanceTimeBy(600)
            threadTarget().assertExists()
            assertEquals(before, liveClicks + recoveryClicks)
            compose.onRoot().performTouchInput { doubleClick(sample) }
            compose.mainClock.advanceTimeBy(600)
            compose.waitForIdle()
            threadTarget().assertDoesNotExist()
            assertEquals(before, liveClicks + recoveryClicks)
            compose.onRoot().performTouchInput { swipeRight() }
            compose.mainClock.advanceTimeBy(600)
            threadTarget().assertExists()
          }
        }
      }
    } finally {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private fun threadTarget() =
    compose.onNode(
      SemanticsMatcher("Open thread target") {
        SemanticsActions.OnClick in it.config && it.config[SemanticsActions.OnClick].label == RuntimeEnvironment.getApplication().getString(R.string.open_thread)
      },
    )

  private fun centerVoiceTarget(matcher: SemanticsMatcher): Boolean {
    val verticalList = hasScrollToIndexAction() and SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)
    if (compose.onAllNodes(verticalList).fetchSemanticsNodes().isEmpty()) return false
    val list = compose.onNode(verticalList)
    list.performScrollToNode(matcher)
    val center =
      compose
        .onNode(matcher, useUnmergedTree = true)
        .fetchSemanticsNode()
        .boundsInRoot.center.y
    val viewportCenter =
      compose
        .onRoot()
        .fetchSemanticsNode()
        .size.height / 2f
    list.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, center - viewportCenter) }
    return true
  }

  private fun assertVoiceLayout() {
    val app = RuntimeEnvironment.getApplication()
    val resources = app.resources
    val originalScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val failures = mutableListOf<String>()
    try {
      render()
      val cases =
        listOf(
          Scenario("idle"),
          Scenario("connecting", status = WearRealtimeTalkStatus.CONNECTING, active = true, label = R.string.connecting),
          Scenario("listening", status = WearRealtimeTalkStatus.LISTENING, active = true, capturing = true, label = R.string.listening),
          Scenario("thinking", status = WearRealtimeTalkStatus.THINKING, active = true, label = R.string.thinking),
          Scenario("speaking", active = true, playing = true, label = R.string.speaking),
          Scenario("stopping", stopping = true, label = R.string.stopping),
          Scenario("channel-error", audioFailed = true, label = R.string.real_time_audio_failed),
          Scenario("remote-error", status = WearRealtimeTalkStatus.ERROR, label = R.string.real_time_audio_failed),
          Scenario("audio-error-active", active = true, audioFailed = true, label = R.string.real_time_audio_failed),
          Scenario("microphone-retry", permissionRequired = true, label = R.string.microphone_permission_required),
          Scenario("microphone-settings", permissionRequired = true, settingsRequired = true, label = R.string.microphone_permission_required),
        )
      for (scale in listOf(1f, 1.3f)) {
        for (next in cases) {
          compose.runOnIdle {
            fontScale.value = scale
            scenario.value = next
          }
          val key = "${resources.configuration.locales[0].language}-${resources.configuration.screenWidthDp}-$scale-${next.name}"
          val root = compose.onRoot().fetchSemanticsNode()
          assertEquals(resources.configuration.screenWidthDp, root.size.width)
          assertEquals(root.size.width, root.size.height)
          assertTrue(resources.configuration.isScreenRound)
          val label = next.label?.let { resources.getString(it) }
          val status = label?.let { if (next.active) "$it · 0:00" else it }
          val texts =
            if (next.permissionRequired) {
              listOfNotNull(status, resources.getString(if (next.settingsRequired) R.string.open_settings else R.string.retry))
            } else {
              listOfNotNull(status)
            }
          capture(key)
          for (text in texts) {
            failures += textErrors(key, text)
          }
          if (next.permissionRequired) {
            val before = recoveryClicks
            compose.onNodeWithText(texts.last()).performClick()
            // Recovery now shares Live's double-tap recognizer, like the pointer checks above.
            compose.mainClock.advanceTimeBy(600)
            compose.waitForIdle()
            compose.runOnIdle { assertEquals(before + 1, recoveryClicks) }
          } else {
            compose.onNodeWithContentDescription(resources.getString(R.string.talk)).assertExists()
            if (next.name == "idle") {
              val before = liveClicks
              compose.onNodeWithContentDescription(resources.getString(R.string.talk)).performSemanticsAction(SemanticsActions.OnClick) { assertTrue(it()) }
              compose.runOnIdle { assertEquals(before + 1, liveClicks) }
              println("VOICE_LAYOUT key=$key status=absent root=${root.size}")
            }
          }
          if (!next.permissionRequired) {
            failures += textErrors(key, resources.getString(R.string.double_tap))
            failures += textErrors(key, resources.getString(R.string.thread))
            val threadBounds = compose.onNodeWithText(resources.getString(R.string.thread), useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val orbBounds = compose.onNodeWithContentDescription(resources.getString(R.string.talk)).fetchSemanticsNode().boundsInRoot
            if (threadBounds.bottom > orbBounds.top) failures += "$key Thread overlaps the Talk control: $threadBounds / $orbBounds"
          }
          if (!next.permissionRequired && status != null) {
            val statusBounds = compose.onNodeWithText(status, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
            val orbBounds = compose.onNodeWithContentDescription(resources.getString(R.string.talk)).fetchSemanticsNode().boundsInRoot
            if (orbBounds.bottom > statusBounds.top) failures += "$key status overlaps the Talk control: $orbBounds / $statusBounds"
          }
        }
        compose.runOnIdle { scenario.value = Scenario("idle") }
        compose.runOnIdle { scenario.value = Scenario("elapsed", status = WearRealtimeTalkStatus.CONNECTING, active = true) }
        compose.onNodeWithText("${resources.getString(R.string.connecting)} · 0:00").assertExists()
        for ((advance, expected) in listOf(59L to "0:59", 1L to "1:00", 694L to "12:34")) {
          ShadowSystemClock.advanceBy(Duration.ofSeconds(advance))
          compose.mainClock.advanceTimeBy(256L)
          val key = "${resources.configuration.locales[0].language}-${resources.configuration.screenWidthDp}-$scale-elapsed-$expected"
          capture(key)
          failures += textErrors(key, "${resources.getString(R.string.connecting)} · $expected")
        }
        compose.runOnIdle { scenario.value = Scenario("idle") }
      }
      assertTrue("Voice text must remain complete and within its round viewport: ${failures.joinToString("; ")}", failures.isEmpty())
    } finally {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private fun textErrors(
    key: String,
    text: String,
  ): List<String> {
    val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
    val results = mutableListOf<TextLayoutResult>()
    compose.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
      assertTrue(it(results))
    }
    val result = results.single()
    val root = compose.onRoot().fetchSemanticsNode()
    val radius = root.size.width / 2f
    val errors = mutableListOf<String>()
    val visibleBounds = node.boundsInRoot
    if (visibleBounds.width < result.size.width || visibleBounds.height < result.size.height) {
      errors += "$key ancestor clips text: $text"
    }
    val ellipsized = (0 until result.lineCount).any(result::isLineEllipsized)
    if (result.hasVisualOverflow || ellipsized) errors += "$key overflow: $text"
    val outside =
      text.indices.filter { !text[it].isWhitespace() }.filter { index ->
        val box = result.getBoundingBox(index).translate(node.positionInRoot)
        listOf(box.topLeft, box.topRight, box.bottomLeft, box.bottomRight).any {
          val x = it.x - radius
          val y = it.y - root.size.height / 2f
          x * x + y * y > radius * radius || it.x < 0 || it.y < 0 || it.x > root.size.width || it.y > root.size.height
        }
      }
    if (outside.isNotEmpty()) errors += "$key characters outside round/root: $outside"
    println("VOICE_LAYOUT key=$key text='$text' width=${result.size.width} height=${result.size.height} lines=${result.lineCount} overflow=${result.hasVisualOverflow} ellipsis=$ellipsized bounds=${node.boundsInRoot} outside=$outside")
    return errors
  }

  private fun capture(name: String) {
    val output = System.getenv("WEAR_VOICE_PROOF_DIR") ?: return
    val file = File(output, "$name.png")
    checkNotNull(file.parentFile).mkdirs()
    file.outputStream().use {
      check(
        compose
          .onRoot()
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }

  private fun render() {
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().visible()
    controller = activity
    activity.get().setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale.value)) {
        OpenClawWearTheme(themeMode = WearThemeMode.Dark) {
          val value = scenario.value
          AppScaffold {
            OpenClawWearScreens(
              snapshot =
                WearConversationSnapshot(
                  gatewayState = WearGatewayState.CONNECTED,
                  activeSessionId = "agent:fixture:chat",
                  realtimeTalk = WearRealtimeTalkSnapshot(status = value.status, active = value.active),
                ),
              failure = null,
              loading = false,
              interaction = WearInteractionState.READY,
              speaking = false,
              realtimeCapturing = value.capturing,
              realtimePlaying = value.playing,
              realtimeMouthLevel = 0.4f,
              realtimePlaybackFailed = value.audioFailed,
              realtimeThinkingOverride = false,
              realtimeStopping = value.stopping,
              microphonePermissionRequired = value.permissionRequired,
              microphoneSettingsRequired = value.settingsRequired,
              onMicrophoneRecovery = { recoveryClicks++ },
              actionBusy = value.active || value.stopping,
              inputEnabled = true,
              canAbort = false,
              themeMode = WearThemeMode.Dark,
              autoSpeak = false,
              notificationsGranted = true,
              voiceSwipeHintEnabled = false,
              initialPage = WearHomePage.Voice,
              onTalk = {},
              onType = {},
              onRealtimeTalk = { liveClicks++ },
              onAbort = {},
              onSelectAgent = {},
              onSelectSession = {},
              onSelectModel = {},
              onRefresh = {},
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
