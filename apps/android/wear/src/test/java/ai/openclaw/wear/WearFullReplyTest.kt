package ai.openclaw.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRealtimeTalkEntry
import ai.openclaw.wear.shared.WearRealtimeTalkRole
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextPage
import ai.openclaw.wear.shared.WearReplyTextStatus
import ai.openclaw.wear.shared.WearRpcMethod
import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w192dp-h192dp-round-mdpi", application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WearFullReplyTest {
  @get:Rule val compose = createEmptyComposeRule()
  private var controller: ActivityController<ComponentActivity>? = null
  private var previousScale = 1f
  private var snapshot by mutableStateOf(
    WearConversationSnapshot(
      gatewayState = WearGatewayState.CONNECTED,
      activeSessionId = "fixture",
      messages = listOf(WearChatMessage("reply", "assistant", (1..20).joinToString("\n") { "Line $it: readable reply" } + "\nTRAILING SENTINEL", 1L, textTruncated = false)),
    ),
  )
  private val busy = false
  private var fontScale by mutableStateOf(1f)
  private var initialPage = WearHomePage.Chat
  private var launchState by mutableStateOf(WearLaunchState())
  private var canceledReads = 0
  private var talkActions = 0
  private var remoteText = "HEAD SENTINEL\n" + (1..180).joinToString("\n") { "Line $it: Grüße 👩🏽‍🚀" } + "\nTRAILING SENTINEL"
  private var responseGate: CompletableDeferred<Unit>? = null
  private var remoteStatus: WearReplyTextStatus? = null
  private var requestCount = 0
  private val repository =
    WearGatewayRepository(
      object : WearRpcRequester {
        override suspend fun request(
          method: WearRpcMethod,
          params: JsonObject,
          expectedNodeId: String?,
          requirePreferredNode: Boolean,
        ): WearRpcResult {
          assertEquals(WearRpcMethod.ReplyText, method)
          assertEquals("phone", expectedNodeId)
          assertTrue(requirePreferredNode)
          requestCount++
          try {
            responseGate?.await()
          } catch (error: CancellationException) {
            canceledReads++
            throw error
          }
          val page = remoteStatus?.let { WearReplyTextPage(it) } ?: WearReplyText.page(remoteText, "owner", params.getValue("offset").jsonPrimitive.int, params["revision"]?.jsonPrimitive?.content)
          val encoded = WearProtocolCodec.encode(WearMessage.Response(requestId = "page", ok = true, result = WearReplyText.encode(page)))
          val response = (WearProtocolCodec.decode(encoded) as WearDecodeResult.Success).message as WearMessage.Response
          return WearRpcResult(response.result!!, 1L, "phone")
        }
      },
    )

  @Before fun disableAnimations() {
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    previousScale = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After fun cleanup() {
    controller?.pause()?.stop()?.destroy()
    Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
  }

  @Test fun opensLongReply() {
    show()
    compose.onAllNodes(hasScrollToIndexAction())[1].performScrollToNode(hasText(snapshot.messages.single().text))
    capture("compact")
    compose.onAllNodes(hasScrollToIndexAction())[1].performScrollToNode(hasText("Read full reply"))
    compose.onNodeWithText("Read full reply").performClick()
    compose.onAllNodes(hasScrollToIndexAction()).let { lists -> lists[lists.fetchSemanticsNodes().lastIndex].performScrollToNode(hasText("TRAILING SENTINEL")) }
    compose.onNodeWithText("TRAILING SENTINEL").assertIsDisplayed()
    capture("tail")
  }

  private fun capture(name: String) {
    val output = System.getenv("WEAR_FULL_REPLY_PROOF_DIR") ?: return
    val config = RuntimeEnvironment.getApplication().resources.configuration
    val file = File(output, "${config.locales[0].language}-${config.screenWidthDp}-$fontScale-$name.png")
    file.parentFile!!.mkdirs()
    file.outputStream().use {
      compose
        .onRoot()
        .captureToImage()
        .asAndroidBitmap()
        .compress(Bitmap.CompressFormat.PNG, 100, it)
    }
  }

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun normalEnglishRemoteReply() = remoteFlow()

  @Test
  @Config(qualifiers = "de-rDE-w192dp-h192dp-round-mdpi")
  fun smallGermanRemoteReplyLargeText() {
    fontScale = 1.3f
    assertGermanLocaleAndRecordResolvedLabels()
    remoteFlow()
  }

  @Test
  @Config(qualifiers = "de-rDE-w227dp-h227dp-round-mdpi")
  fun normalGermanRemoteReply() {
    assertGermanLocaleAndRecordResolvedLabels()
    remoteFlow()
  }

  private fun assertGermanLocaleAndRecordResolvedLabels() {
    assertEquals(
      "de",
      RuntimeEnvironment
        .getApplication()
        .resources.configuration.locales[0]
        .language,
    )
    assertTrue(remoteText.contains("Grüße"))
    println("WEAR_REPLY_LOCALE de read=${label(R.string.read_full_reply)} next=${label(R.string.reply_next_page)} previous=${label(R.string.reply_previous_page)} close=${label(R.string.close)}")
  }

  @Test fun smallEnglishRemoteReplyLargeText() {
    fontScale = 1.3f
    remoteFlow()
  }

  private fun prepareRemote() {
    snapshot =
      snapshot.copy(
        phoneNodeId = "phone",
        activeAgentId = "agent",
        replyTextSupported = true,
        messages = listOf(WearChatMessage("row", "assistant", remoteText.take(250), 1L, entryId = "entry", textTruncated = true)),
      )
  }

  private fun label(id: Int) = RuntimeEnvironment.getApplication().getString(id)

  private fun reveal(text: String) {
    compose.onAllNodes(hasScrollToIndexAction()).let { lists -> lists[lists.fetchSemanticsNodes().lastIndex].performScrollToNode(hasText(text)) }
  }

  private fun openRemote() {
    reveal(label(R.string.read_full_reply))
    val action = compose.onNodeWithText(label(R.string.read_full_reply))
    val delta =
      action
        .fetchSemanticsNode()
        .boundsInRoot.center.y - compose
        .onRoot()
        .fetchSemanticsNode()
        .size.height / 2f
    compose.onAllNodes(hasScrollToIndexAction()).let { lists -> lists[lists.fetchSemanticsNodes().lastIndex].performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, delta) } }
    capture("open-action")
    action.performClick()
  }

  private fun remoteFlow() {
    prepareRemote()
    show()
    openRemote()
    reveal("HEAD SENTINEL")
    compose.onNodeWithText("HEAD SENTINEL").assertIsDisplayed()
    capture("head")
    assertEquals(1, requestCount)
    reveal(label(R.string.reply_next_page))
    compose.onNodeWithText(label(R.string.reply_next_page)).performClick()
    reveal("TRAILING SENTINEL")
    val node = compose.onNodeWithText("TRAILING SENTINEL")
    node.assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
    assertFalse(layouts.single().hasVisualOverflow)
    capture("remote-tail")
    assertEquals(2, requestCount)
    reveal(label(R.string.reply_previous_page))
    compose.onNodeWithText(label(R.string.reply_previous_page)).performClick()
    reveal("HEAD SENTINEL")
    compose.onNodeWithText("HEAD SENTINEL").assertIsDisplayed()
    compose.onRoot().performTouchInput { swipeRight() }
    compose.mainClock.advanceTimeBy(600)
    reveal(label(R.string.read_full_reply))
  }

  @Test fun stalePagesShowRetryAndRestartWithoutMixingRevisions() {
    prepareRemote()
    show()
    openRemote()
    reveal(label(R.string.reply_next_page))
    remoteText = "replacement\n" + remoteText
    compose.onNodeWithText(label(R.string.reply_next_page)).performClick()
    reveal(label(R.string.reply_changed))
    compose.onNodeWithText(label(R.string.reply_changed)).assertIsDisplayed()
    reveal(label(R.string.retry))
    compose.onNodeWithText(label(R.string.retry)).performClick()
    reveal("replacement")
    compose.onNodeWithText("replacement").assertIsDisplayed()
  }

  @Test fun changingPhoneWhileLoadingRetiresTheReader() {
    prepareRemote()
    responseGate = CompletableDeferred()
    show()
    openRemote()
    reveal(label(R.string.reply_loading))
    compose.runOnIdle { snapshot = snapshot.copy(phoneNodeId = "other-phone") }
    responseGate!!.complete(Unit)
    compose.waitForIdle()
    compose.onNodeWithText(label(R.string.reply_loading)).assertDoesNotExist()
    compose.onNodeWithText("HEAD SENTINEL").assertDoesNotExist()
  }

  @Test fun oldPhoneAndUnavailableTextRemainExplicit() {
    prepareRemote()
    snapshot = snapshot.copy(replyTextSupported = false)
    show()
    openRemote()
    reveal(label(R.string.reply_unsupported))
    compose.onNodeWithText(label(R.string.reply_unsupported)).assertIsDisplayed()
    assertEquals(0, requestCount)
    compose.runOnIdle { controller!!.get().onBackPressedDispatcher.onBackPressed() }
    compose.runOnIdle { snapshot = snapshot.copy(replyTextSupported = true) }
    remoteStatus = WearReplyTextStatus.Unavailable
    openRemote()
    reveal(label(R.string.reply_unavailable))
    compose.onNodeWithText(label(R.string.reply_unavailable)).assertIsDisplayed()
  }

  @Test fun failedFullReadOffersRetryWithoutDiscardingThePreview() {
    prepareRemote()
    val preview = snapshot.messages.single()
    remoteStatus = WearReplyTextStatus.Failed
    show()
    openRemote()
    reveal(label(R.string.reply_failed))
    compose.onNodeWithText(label(R.string.reply_failed)).assertIsDisplayed()
    reveal(label(R.string.retry))
    compose.onNodeWithText(label(R.string.retry)).assertIsDisplayed()
    capture("failed-full-read")
    assertEquals(preview, snapshot.messages.single())
    assertEquals(1, requestCount)
    remoteStatus = null
    compose.onNodeWithText(label(R.string.retry)).performClick()
    reveal("HEAD SENTINEL")
    compose.onNodeWithText("HEAD SENTINEL").assertIsDisplayed()
    assertEquals(2, requestCount)
    capture("retried-full-read")
  }

  @Test fun shortAndEmptyRepliesDoNotGainDisclosure() {
    snapshot = snapshot.copy(messages = listOf(WearChatMessage("short", "assistant", "Short reply", 1L, textTruncated = false)))
    show()
    reveal("Short reply")
    compose.onNodeWithText(label(R.string.read_full_reply)).assertDoesNotExist()
    compose.runOnIdle { snapshot = snapshot.copy(messages = emptyList()) }
    compose.onNodeWithText(label(R.string.read_full_reply)).assertDoesNotExist()
  }

  @Test fun talkThreadReadsFullTextAndBackReturnsToThread() {
    initialPage = WearHomePage.Voice
    snapshot =
      snapshot.copy(
        phoneNodeId = "phone",
        activeAgentId = "agent",
        replyTextSupported = true,
        realtimeTalk = WearRealtimeTalkSnapshot(attemptId = "attempt", conversation = listOf(WearRealtimeTalkEntry("talk-entry", WearRealtimeTalkRole.ASSISTANT, remoteText.take(250), streaming = true, textTruncated = true, fullTextAvailable = true))),
      )
    show()
    compose
      .onNode(
        androidx.compose.ui.test.SemanticsMatcher("Open Thread") {
          SemanticsActions.OnClick in it.config && it.config[SemanticsActions.OnClick].label == label(R.string.open_thread)
        },
      ).performClick()
    openRemote()
    capture("talk-opened")
    compose.runOnIdle { assertEquals("Talk opened reader", 1, requestCount) }
    reveal(label(R.string.reply_next_page))
    compose.onNodeWithText(label(R.string.reply_next_page)).performClick()
    reveal("TRAILING SENTINEL")
    compose.onNodeWithText("TRAILING SENTINEL").assertIsDisplayed()
    compose.runOnIdle { snapshot = snapshot.copy(realtimeTalk = snapshot.realtimeTalk.copy(conversation = snapshot.realtimeTalk.conversation.map { it.copy(streaming = false) })) }
    compose.onNodeWithText("TRAILING SENTINEL").assertDoesNotExist()
    reveal(label(R.string.read_full_reply))
  }

  @Test
  fun finalTalkTextRetiresThePreviouslyOpenedLivePrefix() {
    initialPage = WearHomePage.Voice
    val prefix = (1..18).joinToString("\n") { "Live line $it" } + "\nLIVE PREFIX"
    snapshot =
      snapshot.copy(
        phoneNodeId = "phone",
        activeAgentId = "agent",
        replyTextSupported = true,
        realtimeTalk = WearRealtimeTalkSnapshot(attemptId = "attempt", conversation = listOf(WearRealtimeTalkEntry("entry", WearRealtimeTalkRole.ASSISTANT, prefix, streaming = true, fullTextAvailable = true))),
      )
    show()
    compose
      .onNode(
        androidx.compose.ui.test.SemanticsMatcher("Open Thread") {
          SemanticsActions.OnClick in it.config && it.config[SemanticsActions.OnClick].label == label(R.string.open_thread)
        },
      ).performClick()
    openRemote()
    reveal("LIVE PREFIX")
    compose.onNodeWithText("LIVE PREFIX").assertIsDisplayed()
    compose.runOnIdle {
      snapshot =
        snapshot.copy(
          realtimeTalk =
            snapshot.realtimeTalk.copy(
              conversation =
                listOf(
                  snapshot.realtimeTalk.conversation
                    .single()
                    .copy(text = remoteText.take(250), streaming = false, textTruncated = true),
                ),
            ),
        )
    }
    compose.onNodeWithText("LIVE PREFIX").assertDoesNotExist()
    openRemote()
    reveal(label(R.string.reply_next_page))
    compose.onNodeWithText(label(R.string.reply_next_page)).performClick()
    reveal("TRAILING SENTINEL")
    compose.onNodeWithText("TRAILING SENTINEL").assertIsDisplayed()
  }

  @Test
  fun tailOnlyTalkRevisionRetiresAReaderEvenWhenPreviewDidNotChange() {
    initialPage = WearHomePage.Voice
    val entry = WearRealtimeTalkEntry("entry", WearRealtimeTalkRole.ASSISTANT, remoteText.take(250), streaming = true, textTruncated = true, fullTextAvailable = true, textRevision = 1)
    snapshot =
      snapshot.copy(
        phoneNodeId = "phone",
        activeAgentId = "agent",
        replyTextSupported = true,
        realtimeTalk = WearRealtimeTalkSnapshot(attemptId = "attempt", conversation = listOf(entry)),
      )
    show()
    compose
      .onNode(
        androidx.compose.ui.test.SemanticsMatcher("Open Thread") {
          SemanticsActions.OnClick in it.config && it.config[SemanticsActions.OnClick].label == label(R.string.open_thread)
        },
      ).performClick()
    openRemote()
    reveal("HEAD SENTINEL")
    compose.onNodeWithText("HEAD SENTINEL").assertIsDisplayed()
    compose.runOnIdle { snapshot = snapshot.copy(realtimeTalk = snapshot.realtimeTalk.copy(conversation = listOf(entry.copy(textRevision = 2)))) }
    compose.onNodeWithText("HEAD SENTINEL").assertDoesNotExist()
    reveal(label(R.string.read_full_reply))
  }

  private fun warmLaunch(target: WearLaunchTarget) {
    compose.runOnIdle { launchState = launchState.next(Intent().putExtra(extraWearLaunchTarget, target.rawValue)) }
    compose.waitForIdle()
  }

  private fun openLocalTail() {
    openRemote()
    reveal("TRAILING SENTINEL")
    compose.onNodeWithText("TRAILING SENTINEL").assertIsDisplayed()
  }

  @Test
  fun warmVoiceAndRepeatedChatLaunchesDismissStoredReply() {
    show()
    openLocalTail()
    warmLaunch(WearLaunchTarget.Voice)
    capture("warm-voice-after-launch")
    compose.onNodeWithText("TRAILING SENTINEL").assertDoesNotExist()
    compose.onNodeWithText(label(R.string.dictate)).assertIsDisplayed()
    warmLaunch(WearLaunchTarget.Chat)
    repeat(2) {
      openLocalTail()
      warmLaunch(WearLaunchTarget.Chat)
      compose.onNodeWithText("TRAILING SENTINEL").assertDoesNotExist()
      reveal(label(R.string.read_full_reply))
    }
    compose.runOnIdle {
      assertEquals(4, launchState.nextRequestId)
      assertEquals(null, launchState.navigationRequest)
      assertEquals(0, requestCount)
    }
  }

  @Test
  fun warmLaunchCancelsLoadingPageAndReaderCanReopen() {
    prepareRemote()
    val gate = CompletableDeferred<Unit>()
    responseGate = gate
    show()
    openRemote()
    reveal(label(R.string.reply_loading))
    compose.runOnIdle { assertEquals(1, requestCount) }
    warmLaunch(WearLaunchTarget.Voice)
    compose.onNodeWithText(label(R.string.reply_loading)).assertDoesNotExist()
    compose.onNodeWithText(label(R.string.dictate)).assertIsDisplayed()
    compose.runOnIdle { assertEquals(1, canceledReads) }
    gate.complete(Unit)
    compose.waitForIdle()
    compose.onNodeWithText("HEAD SENTINEL").assertDoesNotExist()
    warmLaunch(WearLaunchTarget.Chat)
    openRemote()
    reveal("HEAD SENTINEL")
    compose.onNodeWithText("HEAD SENTINEL").assertIsDisplayed()
    compose.runOnIdle { assertEquals(2, requestCount) }
  }

  @Test
  fun explicitChatLaunchDismissesReaderWithoutStoppingActiveTalk() {
    val talk = WearRealtimeTalkSnapshot(attemptId = "active-attempt", active = true, listening = true)
    snapshot = snapshot.copy(realtimeTalk = talk)
    show()
    openLocalTail()
    warmLaunch(WearLaunchTarget.Chat)
    compose.onNodeWithText("TRAILING SENTINEL").assertDoesNotExist()
    compose.onNodeWithText(label(R.string.dictate)).assertIsDisplayed()
    compose.runOnIdle {
      assertEquals(talk, snapshot.realtimeTalk)
      assertEquals(0, talkActions)
      assertEquals(null, launchState.navigationRequest)
    }
  }

  private fun show(theme: WearThemeMode = WearThemeMode.Dark) {
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().visible()
    controller = activity
    activity.get().setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
        OpenClawWearTheme(theme) {
          AppScaffold {
            OpenClawWearScreens(
              snapshot = snapshot,
              initialPage = initialPage,
              navigationRequest = launchState.navigationRequest,
              onNavigationRequestHandled = { launchState = launchState.handled(it) },
              readReply = repository::replyText,
              failure = null,
              loading = false,
              interaction = WearInteractionState.READY,
              speaking = false,
              realtimeCapturing = false,
              realtimePlaying = false,
              realtimeMouthLevel = 0f,
              realtimePlaybackFailed = false,
              realtimeThinkingOverride = false,
              actionBusy = busy,
              inputEnabled = true,
              canAbort = false,
              themeMode = theme,
              autoSpeak = false,
              notificationsGranted = true,
              voiceSwipeHintEnabled = false,
              onTalk = {},
              onType = {},
              onRealtimeTalk = { talkActions++ },
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
