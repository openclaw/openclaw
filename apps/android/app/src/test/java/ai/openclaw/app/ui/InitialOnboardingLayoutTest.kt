package ai.openclaw.app.ui

import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.R
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.MascotMood
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import com.google.mlkit.common.sdkinternal.MlKitContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.job
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.util.UUID

private const val OnboardingViewportTag = "initial-onboarding-viewport"

@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "w360dp-h720dp-420dpi")
class InitialOnboardingLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Before
  fun setUp() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    MlKitContext.initializeIfNeeded(context)
    Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @Test
  fun gatewayCredentialsAndSetupCodeAreMasked() {
    withOnboarding {
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Set up manually").performClick()
      assertInputPresentation("Host", "127.0.0.1", secret = false, scroll = true)
      assertInputPresentation("18789", "18790", secret = false, scroll = true)
      assertInputPresentation("Paste token", "synthetic-token", secret = true, scroll = true)
      assertInputPresentation("Password optional", "synthetic-password", secret = true, scroll = true)
      composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToIndex(0)
      composeRule.onNodeWithContentDescription("Back").performClick()
      composeRule.onNodeWithText("Scan QR or setup code").performClick()
      composeRule.onNodeWithText("Enter setup code").performClick()
      assertInputPresentation("Paste setup code", "synthetic-setup-code", secret = true)
    }
  }

  @Test
  @Config(qualifiers = "w480dp-h800dp-420dpi")
  fun horizontalTransportChoicesExposeSelectionAndKeepForcedTlsDisabled() = verifyTransportChoices(fontScale = 1f)

  @Test
  @Config(qualifiers = "w480dp-h800dp-420dpi")
  fun stackedTransportChoicesExposeSelectionAndKeepForcedTlsDisabled() = verifyTransportChoices(fontScale = 2f)

  private fun verifyTransportChoices(fontScale: Float) {
    withOnboarding(fontScale = fontScale, viewportWidth = 480.dp) {
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Set up manually").performClick()

      fun changeHost(
        previous: String,
        next: String,
      ) {
        composeRule.onNode(hasSetTextAction() and hasText(previous)).performScrollTo().performTextReplacement(next)
      }
      changeHost("Host", "127.0.0.1")
      val cleartext = composeRule.onNodeWithText("Unencrypted")
      val tls = composeRule.onNodeWithText("Secure (TLS)")

      fun assertTransport(
        tlsSelected: Boolean,
        cleartextEnabled: Boolean = true,
      ) {
        tls.performScrollTo().assertIsDisplayed().assertIsEnabled()
        cleartext.assertIsDisplayed()
        if (tlsSelected) {
          tls.assertIsSelected()
          cleartext.assertIsNotSelected()
        } else {
          cleartext.assertIsSelected()
          tls.assertIsNotSelected()
        }
        for (choice in listOf(cleartext, tls)) {
          choice.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
          val bounds = choice.fetchSemanticsNode().touchBoundsInRoot
          val minimum = with(composeRule.density) { 48.dp.toPx() }
          assertTrue("Transport choice keeps its minimum touch width", bounds.width >= minimum)
          assertTrue("Transport choice keeps its minimum touch height", bounds.height >= minimum)
        }
        if (cleartextEnabled) cleartext.assertIsEnabled() else cleartext.assertIsNotEnabled()
      }
      assertTransport(tlsSelected = false)
      val clearBounds = cleartext.getUnclippedBoundsInRoot()
      val tlsBounds = tls.getUnclippedBoundsInRoot()
      if (fontScale == 1f) {
        assertEquals(clearBounds.top, tlsBounds.top)
        assertTrue("Normal font exercises the horizontal choices", tlsBounds.left >= clearBounds.right)
      } else {
        assertEquals(clearBounds.left, tlsBounds.left)
        assertTrue("Large font exercises the stacked choices", tlsBounds.top >= clearBounds.bottom)
      }
      tls.performClick()
      assertTransport(tlsSelected = true)
      changeHost("127.0.0.1", "gateway.example.com")
      assertTransport(tlsSelected = true, cleartextEnabled = false)
      cleartext.performClick()
      assertTransport(tlsSelected = true, cleartextEnabled = false)
      // Returning local exposes an accidental disabled callback that forced TLS would hide.
      changeHost("gateway.example.com", "127.0.0.1")
      assertTransport(tlsSelected = true)
      cleartext.performClick()
      assertTransport(tlsSelected = false)
      changeHost("127.0.0.1", "gateway.example.com")
      assertTransport(tlsSelected = true, cleartextEnabled = false)
      changeHost("gateway.example.com", "127.0.0.1")
      assertTransport(tlsSelected = false)
    }
  }

  private fun withOnboarding(
    fontScale: Float = 1f,
    viewportWidth: Dp = 360.dp,
    verify: () -> Unit,
  ) {
    val app = ApplicationProvider.getApplicationContext<NodeApp>()
    val prefs = SecurePrefs(app, app.getSharedPreferences("onboarding-input-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    try {
      MlKitContext.initializeIfNeeded(app)
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      models.put("onboarding", viewModel)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(viewModel, "runtimeRef").value = runtime
      setContent(fontScale = fontScale, viewportHeight = 720.dp, viewportWidth = viewportWidth) { OnboardingFlow(viewModel) }
      verify()
    } finally {
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }

  @Test
  fun dismissedNodeApprovalDialogStaysClosedAcrossBackgroundRefreshes() {
    val app = ApplicationProvider.getApplicationContext<NodeApp>()
    val prefs = SecurePrefs(app, app.getSharedPreferences("onboarding-approval-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(false)
    prefs.setManualTls(false)
    val previousRuntime = app.peekRuntime()
    val gateway = OnboardingApprovalGateway(DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate().deviceId)
    var ownedRuntime: NodeRuntime? = null
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    var viewModelJob: Job? = null
    try {
      val runtime = NodeRuntime(app, prefs).also { ownedRuntime = it }
      bindNodeRuntimeTestFixture(app, runtime)
      val viewModel = MainViewModel(app, prefs, SavedStateHandle())
      models.put("onboarding", viewModel)
      viewModelJob = viewModel.viewModelScope.coroutineContext.job
      setContent(fontScale = 1f, viewportHeight = 720.dp) {
        if (mounted.value) OnboardingFlow(viewModel)
      }

      fun awaitUnapprovedRefreshCompletion() {
        composeRule.waitUntil(timeoutMillis = 10_000) {
          runtime.gatewayConnectionDisplay.value.isConnected &&
            runtime.nodeCapabilityApproval.value == GatewayNodeCapabilityApproval.Unapproved &&
            !runtime.nodesDevicesRefreshing.value
        }
      }

      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Set up manually").performClick()
      composeRule.onNode(hasSetTextAction() and hasText("Host")).performScrollTo().performTextReplacement("127.0.0.1")
      composeRule.onNode(hasSetTextAction() and hasText("18789")).performScrollTo().performTextReplacement(gateway.port.toString())
      composeRule.onNodeWithText("Test connection").performClick()
      awaitUnapprovedRefreshCompletion()
      composeRule.onNodeWithText("Continue").assertIsEnabled().performClick()

      fun awaitHeldRefresh() {
        composeRule.waitUntil(timeoutMillis = 10_000) {
          gateway.hasHeldNodeLists && runtime.nodesDevicesRefreshing.value
        }
        composeRule.onNodeWithText("Checking approval…").assertIsDisplayed()
      }

      fun checkUnapprovedNode() {
        gateway.holdNodeLists()
        composeRule
          .onNodeWithText("I have approved")
          .assertIsEnabled()
          .performSemanticsAction(SemanticsActions.OnClick) { click -> assertTrue(click()) }
        awaitHeldRefresh()
        gateway.releaseNodeLists()
        awaitUnapprovedRefreshCompletion()
        composeRule.onNodeWithText("Still waiting for approval").assertIsDisplayed()
      }

      checkUnapprovedNode()
      composeRule.onNodeWithText("OK").performClick()
      composeRule.onNodeWithText("Still waiting for approval").assertDoesNotExist()

      repeat(2) {
        gateway.holdNodeLists()
        composeRule.runOnIdle { runtime.refreshNodesDevices() }
        awaitHeldRefresh()
        gateway.releaseNodeLists()
        awaitUnapprovedRefreshCompletion()
        composeRule.onNodeWithText("Still waiting for approval").assertDoesNotExist()
        composeRule.onNodeWithText("I have approved").assertIsDisplayed().assertIsEnabled()
      }

      // A new user check can report waiting again; dismissal does not suppress later feedback.
      checkUnapprovedNode()
      composeRule.onNodeWithText("OK").performClick()
      composeRule.onNodeWithText("Still waiting for approval").assertDoesNotExist()
    } finally {
      gateway.releaseNodeLists()
      try {
        composeRule.runOnIdle { mounted.value = false }
        composeRule.waitForIdle()
      } finally {
        try {
          models.clear()
          drainWithMainLooper { withTimeout(10_000) { viewModelJob?.cancelAndJoin() } }
        } finally {
          try {
            ownedRuntime?.let(::closeNodeRuntimeTestFixture)
          } finally {
            try {
              bindNodeRuntimeTestFixture(app, previousRuntime)
            } finally {
              gateway.close()
            }
          }
        }
      }
    }
  }

  @Test
  fun defaultFontKeepsWelcomeContentAndActionVisible() {
    var connectClicked = false
    setContent(fontScale = 1f, viewportHeight = 720.dp) {
      WelcomeScreen(mascotMood = MascotMood.Idle, onConnect = { connectClicked = true })
    }

    composeRule.onNodeWithText("Security notice").assertIsDisplayed()
    composeRule.onNodeWithText("Continue").assertIsDisplayed().performClick()
    assertTrue(connectClicked)
  }

  @Test
  fun largeFontKeepsWelcomeActionFixedWhileContentScrolls() {
    var connectClicked = false
    setContent(fontScale = 1.3f, viewportHeight = 480.dp) {
      WelcomeScreen(mascotMood = MascotMood.Idle, onConnect = { connectClicked = true })
    }

    val viewport = composeRule.onNodeWithTag(OnboardingViewportTag)
    val content = composeRule.onNodeWithText("Security notice")
    val action = composeRule.onNodeWithText("Continue").assertIsDisplayed()
    val scrollable = composeRule.onNode(hasScrollAction()).assertExists()
    val viewportBounds = viewport.getUnclippedBoundsInRoot()
    val contentBeforeScroll = content.getUnclippedBoundsInRoot()
    val actionBeforeScroll = action.getUnclippedBoundsInRoot()
    assertFullyInside(actionBeforeScroll, viewportBounds, "Welcome action")

    scrollable.performTouchInput { swipeUp() }
    composeRule.waitForIdle()

    val contentAfterScroll = content.getUnclippedBoundsInRoot()
    val actionAfterScroll = action.getUnclippedBoundsInRoot()
    assertTrue("Welcome content should move upward after a swipe", contentAfterScroll.top < contentBeforeScroll.top)
    assertEquals("Welcome action should remain fixed while content scrolls", actionBeforeScroll, actionAfterScroll)
    assertFullyInside(actionAfterScroll, viewportBounds, "Welcome action")

    content.performScrollTo().assertIsDisplayed()
    composeRule.waitForIdle()

    val actionAfterContentReached = action.getUnclippedBoundsInRoot()
    assertEquals("Welcome action should remain fixed when content is reached", actionBeforeScroll, actionAfterContentReached)
    assertFullyInside(actionAfterContentReached, viewportBounds, "Welcome action")
    action.assertIsDisplayed().performClick()
    assertTrue(connectClicked)
  }

  @Test
  fun defaultFontKeepsGatewayContentAndActionsVisible() {
    var manualSetupClicked = false
    setContent(fontScale = 1f, viewportHeight = 720.dp) {
      GatewaySetupScreen(
        nearbyGateway = null,
        onBack = {},
        onSetupCode = {},
        onManualSetup = { manualSetupClicked = true },
      )
    }

    composeRule.onNodeWithText("Android setup guide").assertIsDisplayed()
    composeRule.onNodeWithText("Scan QR or setup code").assertIsDisplayed()
    composeRule.onNodeWithText("Set up manually").assertIsDisplayed().performClick()
    assertTrue(manualSetupClicked)
  }

  @Test
  fun largeFontKeepsGatewayActionsFixedWhileContentScrolls() {
    var setupCodeClicked = false
    setContent(fontScale = 1.3f, viewportHeight = 480.dp) {
      GatewaySetupScreen(
        nearbyGateway = null,
        onBack = {},
        onSetupCode = { setupCodeClicked = true },
        onManualSetup = {},
      )
    }

    val viewport = composeRule.onNodeWithTag(OnboardingViewportTag)
    val content = composeRule.onNodeWithText("Android setup guide")
    val primaryAction = composeRule.onNodeWithText("Scan QR or setup code").assertIsDisplayed()
    val secondaryAction = composeRule.onNodeWithText("Set up manually").assertIsDisplayed()
    val scrollable = composeRule.onNode(hasScrollAction()).assertExists()
    val viewportBounds = viewport.getUnclippedBoundsInRoot()
    val contentBeforeScroll = content.getUnclippedBoundsInRoot()
    val primaryActionBeforeScroll = primaryAction.getUnclippedBoundsInRoot()
    val secondaryActionBeforeScroll = secondaryAction.getUnclippedBoundsInRoot()
    assertFullyInside(primaryActionBeforeScroll, viewportBounds, "Gateway primary action")
    assertFullyInside(secondaryActionBeforeScroll, viewportBounds, "Gateway secondary action")

    scrollable.performTouchInput { swipeUp() }
    composeRule.waitForIdle()

    val contentAfterScroll = content.getUnclippedBoundsInRoot()
    val primaryActionAfterScroll = primaryAction.getUnclippedBoundsInRoot()
    val secondaryActionAfterScroll = secondaryAction.getUnclippedBoundsInRoot()
    assertTrue("Gateway content should move upward after a swipe", contentAfterScroll.top < contentBeforeScroll.top)
    assertEquals("Gateway primary action should remain fixed while content scrolls", primaryActionBeforeScroll, primaryActionAfterScroll)
    assertEquals("Gateway secondary action should remain fixed while content scrolls", secondaryActionBeforeScroll, secondaryActionAfterScroll)
    assertFullyInside(primaryActionAfterScroll, viewportBounds, "Gateway primary action")
    assertFullyInside(secondaryActionAfterScroll, viewportBounds, "Gateway secondary action")

    content.performScrollTo().assertIsDisplayed()
    composeRule.waitForIdle()

    val primaryActionAfterContentReached = primaryAction.getUnclippedBoundsInRoot()
    val secondaryActionAfterContentReached = secondaryAction.getUnclippedBoundsInRoot()
    assertEquals("Gateway primary action should remain fixed when content is reached", primaryActionBeforeScroll, primaryActionAfterContentReached)
    assertEquals("Gateway secondary action should remain fixed when content is reached", secondaryActionBeforeScroll, secondaryActionAfterContentReached)
    assertFullyInside(primaryActionAfterContentReached, viewportBounds, "Gateway primary action")
    assertFullyInside(secondaryActionAfterContentReached, viewportBounds, "Gateway secondary action")
    primaryAction.assertIsDisplayed().performClick()
    assertTrue(setupCodeClicked)
  }

  @Test
  fun capturedGatewayTrustKeepsPinSystemTrustAndDeclineActionsDistinct() {
    val accepted = mutableListOf<String?>()
    var systemTrustCount = 0
    var declineCount = 0
    composeRule.setContent {
      ClawDesignTheme {
        GatewayTrustDialog(
          prompt =
            gatewayTrustPrompt.copy(
              fingerprintSha256 = "ab".repeat(32),
              previousFingerprintSha256 = "cd".repeat(32),
              systemTrustAvailable = true,
            ),
          confirmLabel = stringResource(R.string.trust_and_continue),
          cancelLabel = stringResource(R.string.cancel),
          onAccept = { accepted.add(it) },
          onUseSystemTrust = { systemTrustCount++ },
          onDecline = { declineCount++ },
        )
      }
    }

    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
    composeRule.onNodeWithText("Old SHA-256:", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Trust and continue").assertIsEnabled().performClick()
    composeRule.onNodeWithText("Use system trust").performClick()
    composeRule.onNodeWithText("Cancel").performClick()
    assertEquals(listOf<String?>(null), accepted)
    assertEquals(1, systemTrustCount)
    assertEquals(1, declineCount)
  }

  @Test
  fun manualGatewayTrustValidatesThePinWithoutConflatingSystemTrustOrDecline() {
    val accepted = mutableListOf<String?>()
    var systemTrustCount = 0
    var declineCount = 0
    composeRule.setContent {
      ClawDesignTheme {
        GatewayTrustDialog(
          prompt = gatewayTrustPrompt.copy(systemTrustAvailable = true),
          confirmLabel = "Trust and continue",
          cancelLabel = "Cancel",
          onAccept = { accepted.add(it) },
          onUseSystemTrust = { systemTrustCount++ },
          onDecline = { declineCount++ },
        )
      }
    }
    val input = composeRule.onNode(hasSetTextAction())
    val trust = composeRule.onNodeWithText("Trust and continue")
    trust.performScrollTo().assertIsNotEnabled().performClick()
    input.performScrollTo().performTextReplacement("not-a-fingerprint")
    trust.performScrollTo().assertIsNotEnabled()
    assertTrue(accepted.isEmpty())
    input.performScrollTo().performTextReplacement(List(32) { "AB" }.joinToString(":"))
    trust.performScrollTo().assertIsEnabled().performClick()
    composeRule.onNodeWithText("Use system trust").performScrollTo().performClick()
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    assertEquals(listOf("ab".repeat(32)), accepted)
    assertEquals(1, systemTrustCount)
    assertEquals(1, declineCount)
  }

  private val gatewayTrustPrompt =
    NodeRuntime.GatewayTrustPrompt(
      endpoint = GatewayEndpoint(stableId = "test-gateway", name = "Test gateway", host = "gateway.test", port = 443),
      fingerprintSha256 = null,
      auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
      probeFailure = GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT,
    )

  private fun setContent(
    fontScale: Float,
    viewportHeight: Dp,
    viewportWidth: Dp = 360.dp,
    content: @Composable () -> Unit,
  ) {
    composeRule.setContent {
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fontScale)) {
        ClawDesignTheme {
          Box(
            modifier =
              Modifier
                .size(width = viewportWidth, height = viewportHeight)
                .clipToBounds()
                .testTag(OnboardingViewportTag),
          ) {
            content()
          }
        }
      }
    }
  }

  private fun assertFullyInside(
    child: DpRect,
    parent: DpRect,
    label: String,
  ) {
    assertTrue("$label should stay inside the viewport's left edge", child.left >= parent.left)
    assertTrue("$label should stay inside the viewport's top edge", child.top >= parent.top)
    assertTrue("$label should stay inside the viewport's right edge", child.right <= parent.right)
    assertTrue("$label should stay inside the viewport's bottom edge", child.bottom <= parent.bottom)
  }

  private fun assertInputPresentation(
    initialText: String,
    value: String,
    secret: Boolean,
    scroll: Boolean = false,
  ) {
    val input = composeRule.onNode(hasSetTextAction() and hasText(initialText))
    if (scroll) input.performScrollTo()
    input.performClick().performTextReplacement(value)
    val focusedInput = composeRule.onNode(hasSetTextAction() and isFocused())
    val layouts = mutableListOf<TextLayoutResult>()
    focusedInput.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      "$initialText must use the expected visible input presentation",
      if (secret) "\u2022".repeat(value.length) else value,
      layouts
        .single()
        .layoutInput.text.text,
    )
    focusedInput.assert(
      if (secret) SemanticsMatcher.keyIsDefined(SemanticsProperties.Password) else SemanticsMatcher.keyNotDefined(SemanticsProperties.Password),
    )
  }
}

private class OnboardingApprovalGateway(
  private val selfNodeId: String,
) : AutoCloseable {
  private val server = MockWebServer()
  private val nodeListLock = Any()
  private var holdNodeListResponses = false
  private val heldNodeLists = mutableListOf<Pair<WebSocket, JsonElement>>()
  val port: Int get() = server.port
  val hasHeldNodeLists: Boolean get() = synchronized(nodeListLock) { heldNodeLists.isNotEmpty() }

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          if (request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
            MockResponse().withWebSocketUpgrade(listener())
          } else {
            MockResponse().setResponseCode(404)
          }
      }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
  }

  fun holdNodeLists() {
    synchronized(nodeListLock) {
      check(!holdNodeListResponses && heldNodeLists.isEmpty())
      holdNodeListResponses = true
    }
  }

  fun releaseNodeLists() {
    val responses =
      synchronized(nodeListLock) {
        holdNodeListResponses = false
        heldNodeLists.toList().also { heldNodeLists.clear() }
      }
    responses.forEach { (socket, id) -> reply(socket, id, nodeList()) }
  }

  private fun nodeList() =
    buildJsonObject {
      put(
        "nodes",
        buildJsonArray {
          add(
            buildJsonObject {
              put("nodeId", selfNodeId)
              put("paired", false)
              put("connected", false)
              put("approvalState", "unapproved")
            },
          )
        },
      )
    }

  private fun listener() =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"onboarding-approval","ts":${System.currentTimeMillis()}}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = Json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = frame.getValue("id")
        val method = frame.getValue("method").jsonPrimitive.content
        if (method == "node.list") {
          // Keep the listener free for reconnect traffic while the current refresh is held.
          val held =
            synchronized(nodeListLock) {
              if (holdNodeListResponses) {
                heldNodeLists.add(webSocket to id)
                true
              } else {
                false
              }
            }
          if (!held) reply(webSocket, id, nodeList())
          return
        }
        val payload =
          when (method) {
            "connect" -> {
              val role =
                frame
                  .getValue("params")
                  .jsonObject
                  .getValue("role")
                  .jsonPrimitive.content
              if (role == "node") {
                reply(
                  webSocket,
                  id,
                  Json.parseToJsonElement("""{"code":"NOT_PAIRED","message":"pairing required","details":{"code":"PAIRING_REQUIRED"}}"""),
                  ok = false,
                )
                return
              }
              check(role == "operator")
              Json.parseToJsonElement("""{"type":"hello-ok","server":{"host":"onboarding-approval"},"features":{"methods":["node.list","health","chat.history","chat.metadata","sessions.list","sessions.subscribe","sessions.observer.visibility"]},"auth":{"role":"operator","scopes":["operator.read","operator.write"]},"snapshot":{}}""")
            }

            "health" -> {
              Json.parseToJsonElement("""{"ok":true}""")
            }

            "chat.history" -> {
              Json.parseToJsonElement("""{"sessionId":"onboarding-approval","messages":[]}""")
            }

            "chat.metadata" -> {
              Json.parseToJsonElement("""{"models":[],"commands":[]}""")
            }

            "sessions.list" -> {
              Json.parseToJsonElement("""{"sessions":[]}""")
            }

            "sessions.subscribe", "sessions.observer.visibility" -> {
              buildJsonObject {}
            }

            else -> {
              reply(webSocket, id, Json.parseToJsonElement("""{"code":"UNSUPPORTED_METHOD","message":"Read-only onboarding fixture"}"""), ok = false)
              return
            }
          }
        reply(webSocket, id, payload)
      }

      override fun onClosing(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) {
        webSocket.close(code, reason)
      }

      override fun onClosed(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) {
        synchronized(nodeListLock) { heldNodeLists.removeAll { it.first === webSocket } }
      }
    }

  private fun reply(
    socket: WebSocket,
    id: JsonElement,
    value: JsonElement,
    ok: Boolean = true,
  ) {
    socket.send(
      buildJsonObject {
        put("type", "res")
        put("id", id)
        put("ok", ok)
        put(if (ok) "payload" else "error", value)
      }.toString(),
    )
  }

  override fun close() {
    releaseNodeLists()
    server.shutdown()
  }
}
