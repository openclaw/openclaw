package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceThemeFamily
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.PendingAttachment
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.clawColorsForTheme
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Rect
import android.provider.Settings
import android.view.inspector.WindowInspector
import androidx.activity.ComponentDialog
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.material3.LocalAbsoluteTonalElevation
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowInfoTrackerDecorator
import androidx.window.layout.WindowLayoutInfo
import com.google.mlkit.common.sdkinternal.MlKitContext
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.QueueDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowToast
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.net.InetAddress
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real sidebar, ViewModel/runtime and composer; no replacement picker is installed on the base. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarGatewayPickerTest {
  @get:Rule val composeRule = createComposeRule()
  private val store = ViewModelStore()
  private val restoration = StateRestorationTester(composeRule)
  private val mounted = mutableStateOf(true)
  private val themeMode = mutableStateOf(AppearanceThemeMode.Dark)
  private val themeFamily = mutableStateOf(AppearanceThemeFamily.Claw)
  private val accentArgb = mutableStateOf<Long?>(null)
  private val tonalElevation = mutableStateOf(0.dp)
  private val servers = mutableListOf<MockWebServer>()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-gateway-proof", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    store.put("sidebar", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  @SuppressLint("RestrictedApi")
  fun tearDown() {
    composeRule.runOnIdle { mounted.value = false }
    store.clear()
    bindNodeRuntimeTestFixture(app, originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    servers.forEach { it.shutdown() }
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    WindowInfoTracker.reset()
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-mdpi")
  fun addGatewayStartsScannerAndBackPreservesTheConversation() {
    val alpha = savedGateway("Gateway Alpha")
    savedGateway("Gateway Beta")
    focus(alpha)
    showSidebarAndComposer(showShell = true)
    // Enter through the live composer after its owner is ready, not a pre-render alias.
    composeRule.onNode(hasSetTextAction()).assertIsEnabled().performTextReplacement("Keep this draft")
    val owner = composeRule.runOnIdle { model.captureChatShareOwner() }
    val attachment = PendingAttachment("kept-file", "keep.txt", "text/plain", "QQ==")
    composeRule.runOnIdle {
      assertEquals("Keep this draft", model.chatComposerState.textDrafts[owner])
      model.chatComposerState.addAttachments(owner, listOf(attachment))
    }
    val saved = prefs.gatewayRegistry.entries.value
    composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
    openPicker()
    composeRule.onNodeWithText("Add Gateway").performClick()
    capture("add-gateway-entry", preferredDialogTag = "gateway-addition")
    composeRule.onNodeWithTag("gateway-addition").assertIsDisplayed()
    composeRule.runOnIdle {
      assertTrue(prefs.onboardingCompleted.value)
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertEquals(saved, prefs.gatewayRegistry.entries.value)
      assertEquals("Keep this draft", model.chatComposerState.textDrafts[owner])
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[owner])
    }
    composeRule.runOnUiThread {
      (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed()
    }
    composeRule.onNodeWithTag("gateway-addition").assertDoesNotExist()
    composeRule.onNodeWithText("Manage Gateways").assertIsDisplayed()
    composeRule.runOnIdle {
      assertTrue(prefs.onboardingCompleted.value)
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertEquals(saved, prefs.gatewayRegistry.entries.value)
      assertEquals("Keep this draft", model.chatComposerState.textDrafts[owner])
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[owner])
    }
    capture("add-gateway-cancelled", popup = true)
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-mdpi")
  fun setupCodeWaitsForConfirmationAndPreservesPreviousOwners() {
    val alpha = savedGateway("Gateway Alpha")
    savedGateway("Gateway Beta")
    focus(alpha)
    val before = prefs.gatewayRegistry.entries.value
    val server =
      MockWebServer().apply {
        (dispatcher as QueueDispatcher).setFailFast(MockResponse().setResponseCode(503))
        start(InetAddress.getByName("127.0.0.1"), 0)
      }
    servers += server
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, false)
    val code =
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        kotlinx.serialization.json
          .JsonObject(
            mapOf(
              "url" to kotlinx.serialization.json.JsonPrimitive("http://127.0.0.1:" + server.port),
              "token" to kotlinx.serialization.json.JsonPrimitive("fixture-add-token"),
            ),
          ).toString()
          .toByteArray(),
      )
    showSidebarAndComposer(showShell = true)
    composeRule.onNode(hasSetTextAction()).assertIsEnabled().performTextReplacement("Unsent on Alpha")
    val owner = composeRule.runOnIdle { model.captureChatShareOwner() }
    val attachment = PendingAttachment("preserved-file", "keep.txt", "text/plain", "QQ==")
    composeRule.runOnIdle {
      assertEquals("Unsent on Alpha", model.chatComposerState.textDrafts[owner])
      model.chatComposerState.addAttachments(owner, listOf(attachment))
    }
    composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
    openPicker()
    composeRule.onNodeWithText("Add Gateway").performClick()
    composeRule.onNodeWithText("Enter setup code").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-add-code").performTextReplacement("not a setup code")
    composeRule.onNodeWithText("Continue").performScrollTo().performClick()
    composeRule.onNodeWithText("Setup code has invalid gateway URL.").assertIsDisplayed()
    composeRule.onNodeWithText("Setup code", useUnmergedTree = true).assertIsDisplayed()
    composeRule.onNodeWithTag("gateway-add-preview").assertDoesNotExist()
    composeRule.runOnIdle { assertEquals(before, prefs.gatewayRegistry.entries.value) }
    composeRule.onNodeWithTag("gateway-add-code").performTextReplacement(code)
    composeRule.onNodeWithText("Setup code has invalid gateway URL.").assertDoesNotExist()
    composeRule.onNodeWithText("Continue").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-add-preview").assertIsDisplayed()
    capture("add-gateway-confirmation", preferredDialogTag = "gateway-addition")
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertEquals(before, prefs.gatewayRegistry.entries.value)
      assertEquals("captured=" + owner + " live=" + model.captureChatShareOwner() + " drafts=" + model.chatComposerState.textDrafts.snapshot(), "Unsent on Alpha", model.chatComposerState.textDrafts[owner])
    }
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-addition").assertDoesNotExist()
    composeRule.runOnIdle { assertEquals(before, prefs.gatewayRegistry.entries.value) }
    composeRule.onNodeWithText("Add Gateway").performClick()
    composeRule.onNodeWithText("Enter setup code").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-add-code").performTextReplacement(code)
    composeRule.onNodeWithText("Continue").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-add-connect").performScrollTo().performClick()
    composeRule.waitUntil {
      runtime.gatewayConnectionHandoff.value.let { !it.pending && it.focusedStableId == endpoint.stableId }
    }
    composeRule.onNodeWithTag("gateway-addition").assertDoesNotExist()
    composeRule.runOnIdle {
      assertTrue(prefs.onboardingCompleted.value)
      assertEquals(before.size + 1, prefs.gatewayRegistry.entries.value.size)
      assertEquals("Unsent on Alpha", model.chatComposerState.textDrafts[owner])
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[owner])
    }
  }

  @Test
  fun staleAdditionCannotConnectOrDismissANewerRequest() {
    val alpha = savedGateway("Gateway Alpha")
    focus(alpha)
    showSidebarAndComposer(showComposer = false)
    awaitFocus(alpha)
    model.openGatewayAddition()
    val stale = requireNotNull(model.gatewayAdditionRequest.value)
    model.dismissGatewayAddition(stale)
    model.openGatewayAddition()
    val current = requireNotNull(model.gatewayAdditionRequest.value)
    val plan = GatewayConnectPlan(GatewayConnectConfig("127.0.0.1", 19876, false, "", "fixture-token", ""), GatewaySavedAuthAction.REPLACE_SETUP)
    model.dismissGatewayAddition(stale)
    model.saveGatewayConfigAndConnect(plan, stale)
    assertTrue(model.gatewayAdditionRequest.value === current)
    assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
    assertFalse(runtime.gatewayConnectionHandoff.value.pending)
    assertEquals(1, prefs.gatewayRegistry.entries.value.size)
    model.dismissGatewayAddition(current)
  }

  @Test
  fun addingASavedGatewayDoesNotReplaceCredentialsOrDrafts() {
    val alpha = savedGateway("Gateway Alpha")
    val beta = savedGateway("Gateway Beta")
    prefs.saveGatewayCredentials(beta.stableId, token = "fixture-original-token")
    focus(alpha)
    val owner = model.captureChatShareOwner()
    model.chatComposerState.textDrafts[owner] = "Keep Alpha"
    showSidebarAndComposer(showComposer = false)
    model.openGatewayAddition()
    val request = requireNotNull(model.gatewayAdditionRequest.value)
    val config = GatewayConnectConfig(requireNotNull(beta.host), requireNotNull(beta.port), false, "", "fixture-replacement-token", "")
    composeRule.runOnIdle { model.saveGatewayConfigAndConnect(GatewayConnectPlan(config, GatewaySavedAuthAction.REPLACE_SETUP), request) }
    awaitFocus(beta)
    assertNull(model.gatewayAdditionRequest.value)
    assertEquals("fixture-original-token", prefs.loadGatewayCredentials(beta.stableId).token)
    assertEquals("Keep Alpha", model.chatComposerState.textDrafts[owner])
    assertEquals(2, prefs.gatewayRegistry.entries.value.size)
  }

  @Test
  fun gatewaySelectorUsesNativeSheetAndDistinguishesMatchingNamesByEndpoint() {
    val alpha = savedGateway("Research")
    val beta = savedGateway("Research")
    focus(alpha)
    showSidebarAndComposer(showComposer = false)
    capture("sheet-footer")
    openPicker()
    capture("sheet-picker", popup = true)
    composeRule.onNode(isDialog()).assertExists()
    composeRule.onNodeWithText("ws://127.0.0.1:${alpha.port}").assertIsDisplayed()
    composeRule.onNodeWithText("ws://127.0.0.1:${beta.port}").assertIsDisplayed()
  }

  @Test
  fun searchResultsStayReachableWithTheNativeKeyboardLeavingAShortPane() {
    val gateways = (1..10).map { savedGateway("Research $it") }
    focus(gateways.first())
    showSidebarAndComposer(showComposer = false)
    openPicker()
    composeRule.onNodeWithTag("gateway-picker-search").performClick().performTextReplacement("Research")
    composeRule.onNodeWithTag("gateway-picker-search").assertIsFocused()
    composeRule.runOnIdle {
      ViewCompat.dispatchApplyWindowInsets(
        checkNotNull(ShadowDialog.getLatestDialog().window).decorView,
        WindowInsetsCompat
          .Builder()
          .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 600))
          .setVisible(WindowInsetsCompat.Type.ime(), true)
          .build(),
      )
    }
    composeRule.waitForIdle()
    composeRule.onNodeWithTag("gateway-picker-search").assertIsFocused().performTextReplacement("Research 10")
    assertTrue(
      "Search results must retain a scrollable viewport",
      composeRule
        .onNodeWithTag("gateway-picker-list")
        .fetchSemanticsNode()
        .size.height > 0,
    )
    composeRule.onNodeWithTag("gateway-picker-list").performScrollToNode(
      hasText(gateways.last().name) and isSelectable(),
    )
    gatewayItem(gateways.last()).assertIsDisplayed()
    capture("ime-short-pane", popup = true)
    gatewayItem(gateways.last()).performClick()
    awaitFocus(gateways.last())
  }

  @Test
  fun growingRegistrySearchesNamesAndEndpoints() {
    val gateways = (1..4).map { savedGateway("Research $it") }.toMutableList()
    focus(gateways.first())
    showSidebarAndComposer(showComposer = false)
    openPicker()
    composeRule.onNodeWithTag("gateway-picker-search").assertDoesNotExist()
    capture("four-gateways", popup = true)
    composeRule.runOnIdle { gateways += (5..10).map { savedGateway("Research $it") } }
    composeRule.onNodeWithTag("gateway-picker-search").assertIsDisplayed()
    composeRule.waitForIdle()
    capture("ten-gateways", popup = true)
    composeRule.onNodeWithText("Manage Gateways").assertIsDisplayed()
    val search = composeRule.onNodeWithTag("gateway-picker-search")
    search.performTextReplacement("not present")
    composeRule.onNodeWithText("No matching gateways").assertIsDisplayed()
    search.performTextReplacement(gateways.last().port.toString())
    gatewayItem(gateways.last()).assertIsDisplayed().assertIsNotSelected().assertIsEnabled()
    search.performTextReplacement("Research 10")
    gatewayItem(gateways.last()).assertIsDisplayed()
    search.performTextReplacement("")
    composeRule.onNodeWithTag("gateway-picker-list").performScrollToNode(hasText(gateways.last().name))
    gatewayItem(gateways.last()).performClick()
    awaitFocus(gateways.last())
    openPicker()
    search.performTextReplacement(gateways.last().port.toString())
    gatewayItem(gateways.last()).assertIsSelected()
    composeRule.runOnIdle { prefs.gatewayRegistry.remove(gateways.last().stableId) }
    composeRule.onNodeWithText("No matching gateways").assertIsDisplayed()
    search.performTextReplacement("")
    composeRule.onNodeWithText("Manage Gateways").assertIsDisplayed().performClick()
  }

  @Test
  fun openSheetRecolorsThroughExistingDarkLightAndSystemThemeAndDismissesNatively() = assertThemeSwitching()

  @Test
  @Config(qualifiers = "w1000dp-h800dp-night-mdpi")
  fun systemDarkThemeRecolorsTheExistingSheet() = assertThemeSwitching(startLight = true)

  private fun assertThemeSwitching(startLight: Boolean = false) {
    val alpha = savedGateway("Research")
    savedGateway("Documentation")
    focus(alpha)
    showSidebarAndComposer(showComposer = false)
    openPicker()
    val windows = WindowInspector.getGlobalWindowViews().filter { it.isAttachedToWindow }
    val modes = if (startLight) listOf(AppearanceThemeMode.Light, AppearanceThemeMode.Dark, AppearanceThemeMode.System) else listOf(AppearanceThemeMode.Dark, AppearanceThemeMode.Light, AppearanceThemeMode.System)
    val families = listOf(AppearanceThemeFamily.Crt) + AppearanceThemeFamily.entries.filterNot { it == AppearanceThemeFamily.Crt }
    for (family in families) {
      for (mode in modes) {
        for (accent in listOf(null, 0xFF37A6C8L)) {
          composeRule.runOnIdle {
            themeFamily.value = family
            themeMode.value = mode
            accentArgb.value = accent
            // A native sheet must not inherit a parent's surface tint, even when canvas == surface.
            tonalElevation.value = 12.dp
          }
          composeRule.waitForIdle()
          val systemDark = app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
          val palette = sidebarPalette(clawColorsForTheme(dark = mode.isDark(systemDark), family = family, accentArgb = accent))
          val sheet = composeRule.onNodeWithTag("gateway-picker-sheet").captureToImage().toPixelMap()
          val row = gatewayItem(alpha).captureToImage().toPixelMap()
          val navigation =
            composeRule
              .onNodeWithText("Home")
              .assertIsSelected()
              .captureToImage()
              .toPixelMap()
          val sidebar = composeRule.onNodeWithTag("gateway-proof").captureToImage().toPixelMap()
          if (family == AppearanceThemeFamily.Crt || family == AppearanceThemeFamily.Claw) {
            capture("palette-$family-$mode-${accent != null}", popup = true)
          }
          assertEquals("Sheet background must match sidebar: $family/$mode/$accent", palette.background.toArgb(), sheet[0, 0].toArgb())
          assertEquals("Sidebar background remains canonical: $family/$mode/$accent", palette.background.toArgb(), sidebar[0, sidebar.height / 2].toArgb())
          // Compare actual rasterized owners, not float compositing against 8-bit pixels.
          assertEquals("Selected gateway must match sidebar selection: $family/$mode/$accent", navigation[navigation.width / 2, 4].toArgb(), row[row.width / 2, 4].toArgb())
          gatewayItem(alpha).assertIsSelected()
          assertEquals(windows, WindowInspector.getGlobalWindowViews().filter { it.isAttachedToWindow })
        }
      }
    }
    capture("theme-custom-accent", popup = true)
    composeRule
      .onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.Dismiss))
      .performSemanticsAction(SemanticsActions.Dismiss)
    composeRule.waitForIdle()
    composeRule.onAllNodes(isDialog()).assertCountEquals(0)
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    composeRule.runOnUiThread {
      (ShadowDialog.getLatestDialog() as ComponentDialog).onBackPressedDispatcher.onBackPressed()
    }
    composeRule.waitForIdle()
    composeRule.onAllNodes(isDialog()).assertCountEquals(0)
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-mdpi")
  fun manualGatewayAdditionKeepsPopulatedLabelsWithoutSavingBeforeReview() {
    val gateway = savedGateway("Local QA Gateway")
    savedGateway("Local QA Secondary")
    focus(gateway)
    showSidebarAndComposer(showShell = true)
    val entries = prefs.gatewayRegistry.entries.value
    composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
    openPicker()
    composeRule.onNodeWithText("Add Gateway").performClick()
    composeRule.onNodeWithText("Set up manually").performScrollTo().performClick()
    val fields =
      listOf(
        "Gateway URL" to "wss://gateway.example.test",
        "Token (optional)" to "synthetic-token",
        "Password (optional)" to "synthetic-password",
      )
    for ((label, value) in fields) {
      composeRule.onNodeWithContentDescription(label).performScrollTo().performTextReplacement(value)
      composeRule.onNodeWithText(label, useUnmergedTree = true).assertIsDisplayed()
    }
    composeRule.onNodeWithText("Continue").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-add-preview").assertIsDisplayed()
    composeRule.runOnIdle { assertEquals(entries, prefs.gatewayRegistry.entries.value) }
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-addition").assertDoesNotExist()
    composeRule.runOnIdle { assertEquals(entries, prefs.gatewayRegistry.entries.value) }
  }

  @Test
  fun emptyRegistryOffersCancellableGatewayAddition() {
    prefs.gatewayRegistry.entries.value
      .forEach { prefs.gatewayRegistry.remove(it.stableId) }
    showSidebarAndComposer()
    capture("empty-registry")
    composeRule.onNodeWithText("Add Gateway").assertIsDisplayed().performClick()
    composeRule.runOnIdle {
      assertNull(model.requestedSettingsRoute.value)
      assertTrue(model.gatewayAdditionRequest.value != null)
      assertTrue(prefs.onboardingCompleted.value)
    }
  }

  @Test
  fun queuedGatewayHandoffProtectsTheActualComposer() {
    val target =
      GatewayRegistryEntry(
        stableId = "manual|127.0.0.1|19876",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "Local QA B",
        host = "127.0.0.1",
        port = 19876,
        tls = false,
      )
    prefs.gatewayRegistry.upsert(target)
    showSidebarAndComposer()
    val barrier = ReflectionHelpers.getField<Mutex>(runtime, "gatewaySwitchMutex")
    check(barrier.tryLock())
    try {
      composeRule.runOnIdle { model.switchToGateway(target.stableId) }
      composeRule.waitUntil {
        ReflectionHelpers.getField<Any?>(runtime, "gatewayConnectionOperation") != null
      }
      capture("queued-handoff")
      composeRule.onNodeWithText("Message OpenClaw").assertIsNotEnabled()
    } finally {
      // Retire queued work before releasing the barrier: no real endpoint is contacted.
      composeRule.runOnIdle { runtime.disconnect() }
      barrier.unlock()
    }
  }

  @Test
  fun savedOfflineGatewaysSwitchBothWaysWithoutMovingFinishedDraftsOrAttachments() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("Alpha draft")
    val alphaOwner = model.captureChatShareOwner()
    val attachment = PendingAttachment("alpha-file", "alpha.txt", "text/plain", "QQ==")
    composeRule.runOnIdle { model.chatComposerState.addAttachments(alphaOwner, listOf(attachment)) }
    openPicker()
    gatewayItem(alpha).assertIsSelected().performClick()
    composeRule.runOnIdle { assertFalse(runtime.gatewayConnectionHandoff.value.pending) }
    choose(beta)
    composeRule.onNodeWithText("Message OpenClaw").assertIsEnabled()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("Beta draft")
    choose(alpha)
    composeRule.runOnIdle { assertEquals("Restored composer owner", alphaOwner, model.captureChatShareOwner()) }
    composeRule.onNodeWithText("Alpha draft").assertIsEnabled()
    composeRule.runOnIdle {
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[alphaOwner])
      assertEquals("Alpha draft", model.chatComposerState.textDrafts[alphaOwner])
    }
    capture("multiple-offline-after-switch")
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    gatewayItem(beta).assertIsNotSelected()
    capture("native-gateway-menu", popup = true)
    composeRule.onNodeWithText("Manage Gateways").performClick()
    composeRule.runOnIdle { assertEquals(SettingsRoute.Gateway, model.requestedSettingsRoute.value) }
  }

  @Test
  fun quickSwitchReadsRecordingImportAndSendOwnersAtSelectionTime() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer()
    openPicker()
    composeRule.runOnIdle { assertTrue(runtime.tryAcquireVoiceNoteMic()) }
    composeRule.onNodeWithText(beta.name).performClick()
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertTrue(ShadowToast.getTextOfLatestToast().contains("Finish recording"))
      runtime.releaseVoiceNoteMic()
    }
    val owner = model.captureChatShareOwner()
    val media = requireNotNull(model.chatComposerState.beginMediaAcquisition(owner))
    val importing = requireNotNull(model.chatComposerState.beginMediaImport(owner, media, model.mainSessionKey.value))
    openPicker()
    composeRule.onNodeWithText(beta.name).performClick()
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertTrue(ShadowToast.getTextOfLatestToast().contains("Finish importing"))
      model.chatComposerState.cancelMediaImport(importing)
      model.chatComposerState.textDrafts[owner] = "Pending admission"
    }
    val send = requireNotNull(model.chatComposerState.beginSend(owner).request)
    openPicker()
    composeRule.onNodeWithText(beta.name).performClick()
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      model.chatComposerState.completeSend(send, false)
      model.acknowledgeChatComposerSendAdmission(owner, send.commandId)
    }
    choose(beta)
  }

  @Test
  fun quickSwitchDoesNotHoldRuntimeAdmissionWhileWaitingForServiceControl() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer(showComposer = false)
    awaitFocus(alpha)
    val serviceControl = ReflectionHelpers.getField<Any>(app, "nodeServiceControlLock")
    val runtimeAdmission = ReflectionHelpers.getField<Any>(runtime, "gatewayLifecycleIntentLock")
    val runtimeAvailable = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    val quickSwitch =
      Thread {
        try {
          model.switchGatewayFromSidebar(beta.stableId)
        } catch (error: Throwable) {
          failure.set(error)
        }
      }.apply { isDaemon = true }
    val cleanupProbe =
      Thread { synchronized(runtimeAdmission) { runtimeAvailable.countDown() } }
        .apply { isDaemon = true }
    var admittedCleanup = false
    try {
      synchronized(serviceControl) {
        quickSwitch.start()
        // Stop cleanup owns this monitor. Wait for actual contention, not just thread startup.
        composeRule.waitUntil(timeoutMillis = 5_000) {
          quickSwitch.state == Thread.State.BLOCKED &&
            quickSwitch.stackTrace.firstOrNull()?.className == NodeApp::class.java.name
        }
        cleanupProbe.start()
        admittedCleanup = runtimeAvailable.await(1, TimeUnit.SECONDS)
      }
    } finally {
      // Release the simulated Stop monitor before joining either contender, including on failure.
      quickSwitch.join(5_000)
      cleanupProbe.join(5_000)
    }
    failure.get()?.let { throw AssertionError("Quick switch failed", it) }
    assertFalse("Quick-switch worker must finish", quickSwitch.isAlive)
    assertFalse("Cleanup probe must finish", cleanupProbe.isAlive)
    assertTrue("Stop cleanup must be able to enter runtime admission while service control is held", admittedCleanup)
    awaitFocus(beta)
  }

  @Test
  fun completedSendReceiptDoesNotBlockQuickSwitchWithoutAChatScreen() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer(showComposer = false)
    awaitFocus(alpha)
    val owner = model.captureChatShareOwner()
    composeRule.runOnIdle {
      model.chatComposerState.textDrafts[owner] = "Admitted before leaving Chat"
      val send = requireNotNull(model.chatComposerState.beginSend(owner).request)
      model.chatComposerState.completeSend(send, true)
      val completed = requireNotNull(model.chatComposerState.sendStates.value[owner])
      assertTrue(completed.activeOperationIds.isEmpty())
      assertEquals(setOf(send.commandId), completed.pendingAdmissionIds)
    }
    openPicker()
    gatewayItem(beta).performClick()
    composeRule.runOnIdle {
      val handoff = runtime.gatewayConnectionHandoff.value
      assertTrue("A completed send's UI receipt must not block Gateway navigation", handoff.pending || handoff.focusedStableId == beta.stableId)
    }
    awaitFocus(beta)
    composeRule.runOnIdle {
      assertTrue(
        "The receipt stays owned by the absent Chat screen",
        model.chatComposerState.sendStates.value[owner]
          ?.pendingAdmissionIds
          ?.isNotEmpty() == true,
      )
    }
  }

  @Test
  fun registryUpdatesDoNotRelabelTheActualFocusWithSavedIntent() {
    val alpha = savedGateway("Local QA Alpha")
    focus(alpha)
    showSidebarAndComposer()
    composeRule.onNodeWithTag("sidebar-gateway-control").performClick()
    composeRule.runOnIdle { assertEquals(SettingsRoute.Gateway, model.requestedSettingsRoute.value) }
    val beta = savedGateway("Local QA Beta")
    composeRule.runOnIdle { prefs.gatewayRegistry.setActive(beta.stableId) }
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    gatewayItem(beta).assertIsNotSelected()
    composeRule.runOnIdle { prefs.gatewayRegistry.remove(alpha.stableId) }
    composeRule.onNodeWithText("Gateways").assertIsDisplayed()
    // Removing the focused registration must not select the remaining saved entry.
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
    }
  }

  @Test
  fun supersedingQueuedSwitchKeepsProtectionUntilTheWinningOfflineCommit() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    val gamma = savedGateway("Local QA Gamma")
    focus(alpha)
    showSidebarAndComposer()
    val barrier = ReflectionHelpers.getField<Mutex>(runtime, "gatewaySwitchMutex")
    check(barrier.tryLock())
    try {
      openPicker()
      gatewayItem(beta).performClick()
      composeRule.runOnIdle {
        assertTrue("Admission is published before dispatch returns", runtime.gatewayConnectionHandoff.value.pending)
        assertFalse(runtime.tryAcquireDictationMic())
        model.switchGatewayFromSidebar(alpha.stableId)
        assertTrue(runtime.gatewayConnectionHandoff.value.pending)
        // Settings/notification-style consumers still supersede through the existing owner.
        model.switchToGateway(gamma.stableId)
      }
      composeRule.onNodeWithText("Message OpenClaw").assertIsNotEnabled()
    } finally {
      barrier.unlock()
    }
    awaitFocus(gamma)
    composeRule.onNodeWithText("Message OpenClaw").assertIsEnabled()
    composeRule.runOnIdle { assertFalse(runtime.gatewayConnectionDisplay.value.isConnected) }
  }

  @Test
  fun unavailableDiscoveryKeepsFocusAndLateAuthorizedMediaStaysWithItsOwner() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    val unavailable = GatewayRegistryEntry("bonjour-missing", GatewayRegistryEntryKind.DISCOVERED, "Saved offline gateway")
    prefs.gatewayRegistry.upsert(unavailable)
    focus(alpha)
    showSidebarAndComposer()
    openPicker()
    gatewayItem(unavailable).performClick()
    composeRule.waitUntil {
      composeRule.runOnIdle { model.requestedSettingsRoute.value == SettingsRoute.Gateway }
    }
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertFalse(runtime.gatewayConnectionHandoff.value.pending)
    }
    val owner = model.captureChatShareOwner()
    val authorization = requireNotNull(model.chatComposerState.beginMediaAcquisition(owner))
    // Another existing navigation consumer can switch while the external picker is away.
    composeRule.runOnIdle { model.switchToGateway(beta.stableId) }
    awaitFocus(beta)
    val attachment = PendingAttachment("late-file", "late-alpha.txt", "text/plain", "QQ==")
    composeRule.runOnIdle {
      model.chatComposerState.addAuthorizedAttachments(owner, authorization, listOf(attachment))
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[owner])
      assertTrue(
        model.chatComposerState.attachments.value[model.captureChatShareOwner()]
          .isNullOrEmpty(),
      )
    }
  }

  @Test
  @Config(qualifiers = "w360dp-h800dp-mdpi")
  fun phoneLightLargeTextKeepsLongNamesAndManagementReachable() {
    assertLongNameProfile(dark = false, fontScale = 1.5f, showComposer = false, name = "phone-light-large")
  }

  @Test
  fun tabletDarkLargeTextKeepsLongNamesAndManagementReachable() {
    assertLongNameProfile(dark = true, fontScale = 2f, showComposer = true, name = "tablet-dark-large")
  }

  @Test
  @SuppressLint("RestrictedApi")
  fun actualGatewayPickerStaysOnItsSideOfASeparatingFold() {
    val hinge = Rect(480, 0, 500, 800)
    WindowInfoTracker.overrideDecorator(
      object : WindowInfoTrackerDecorator {
        override fun decorate(tracker: WindowInfoTracker): WindowInfoTracker =
          object : WindowInfoTracker by tracker {
            override fun windowLayoutInfo(activity: Activity) =
              flow {
                emit(WindowLayoutInfo(listOf(testFold(hinge))))
                awaitCancellation()
              }
          }
      },
    )
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer()
    openPicker()
    val bounds = composeRule.onNodeWithTag("gateway-picker-sheet").fetchSemanticsNode().boundsInWindow
    assertTrue("The native sheet content must not cross the hinge", bounds.right <= hinge.left || bounds.left >= hinge.right)
    capture("folded-picker", popup = true)
    gatewayItem(beta).performClick()
    awaitFocus(beta)
    composeRule.onNodeWithText("Message OpenClaw").assertIsEnabled()
  }

  @Test
  fun remountRetiresThePickerWithoutDroppingOwnerBoundDrafts() {
    val alpha = savedGateway("Local QA Alpha")
    savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("Retained after remount")
    openPicker()
    composeRule.runOnIdle { mounted.value = false }
    composeRule.waitForIdle()
    composeRule.runOnIdle { mounted.value = true }
    composeRule.waitForIdle()
    composeRule.onAllNodes(isDialog()).assertCountEquals(0)
    composeRule.onNodeWithText("Retained after remount").assertIsEnabled()
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    restoration.emulateSavedInstanceStateRestore()
    composeRule.onAllNodes(isDialog()).assertCountEquals(0)
    composeRule.onNodeWithText("Retained after remount").assertIsEnabled()
  }

  private fun assertLongNameProfile(
    dark: Boolean,
    fontScale: Float,
    showComposer: Boolean,
    name: String,
  ) {
    val alpha = savedGateway("Local research and engineering gateway with a deliberately long descriptive name Alpha")
    val beta = savedGateway("Local documentation and release verification gateway with a long descriptive name Beta")
    focus(alpha)
    showSidebarAndComposer(dark = dark, fontScale = fontScale, showComposer = showComposer)
    capture("$name-footer")
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    gatewayItem(beta).performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Manage Gateways").assertIsDisplayed()
    capture("$name-menu", popup = true)
    gatewayItem(beta).performScrollTo().performClick()
    awaitFocus(beta)
    openPicker()
    gatewayItem(beta).assertIsSelected()
    composeRule.onNodeWithText("Manage Gateways").performClick()
    composeRule.runOnIdle { assertEquals(SettingsRoute.Gateway, model.requestedSettingsRoute.value) }
  }

  private fun savedGateway(name: String): GatewayRegistryEntry {
    val server =
      MockWebServer().apply {
        (dispatcher as QueueDispatcher).setFailFast(MockResponse().setResponseCode(503))
        start(InetAddress.getByName("127.0.0.1"), 0)
      }
    servers += server
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, false)
    return GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, name, endpoint.host, endpoint.port, false).also {
      prefs.gatewayRegistry.upsert(it)
    }
  }

  private fun focus(entry: GatewayRegistryEntry) {
    // Replace the screenshot-only main-session key with the real device-owned offline route.
    runtime.prepareForGatewaySetup()
    drainWithMainLooper { withTimeout(5_000) { runtime.switchToGateway(entry.stableId) } }
  }

  private fun gatewayItem(entry: GatewayRegistryEntry) =
    composeRule.onNode(
      hasText(entry.name) and
        androidx.compose.ui.test
          .isSelectable() and hasAnyAncestor(isDialog()),
    )

  private fun openPicker() {
    composeRule.onNodeWithTag("sidebar-gateway-control").performClick()
    composeRule.onNodeWithText("Manage Gateways").assertIsDisplayed()
  }

  private fun choose(entry: GatewayRegistryEntry) {
    openPicker()
    gatewayItem(entry).performClick()
    awaitFocus(entry)
  }

  private fun awaitFocus(entry: GatewayRegistryEntry) {
    composeRule.waitUntil {
      composeRule.runOnIdle {
        runtime.gatewayConnectionHandoff.value.let { !it.pending && it.focusedStableId == entry.stableId }
      }
    }
    composeRule.waitForIdle()
  }

  private fun showSidebarAndComposer(
    dark: Boolean = true,
    fontScale: Float = 1f,
    showComposer: Boolean = true,
    showShell: Boolean = false,
  ) {
    if (showShell) MlKitContext.initializeIfNeeded(app)
    themeMode.value = if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light
    restoration.setContent {
      if (mounted.value) {
        val connection by model.gatewayConnectionDisplay.collectAsState()
        val agents by model.gatewayAgents.collectAsState()
        val sessions by model.chatSessions.collectAsState()
        val sessionKey by model.chatSessionKey.collectAsState()
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale), LocalAbsoluteTonalElevation provides tonalElevation.value) {
          OpenClawTheme(themeMode = themeMode.value) {
            ClawDesignTheme(dark = LocalResolvedAppearanceIsDark.current, family = themeFamily.value, accentArgb = accentArgb.value) {
              if (showShell) {
                Box(Modifier.fillMaxSize().testTag("gateway-proof")) { ShellScreen(viewModel = model) }
                return@ClawDesignTheme
              }
              Row(Modifier.fillMaxSize().testTag("gateway-proof")) {
                Box(Modifier.width(300.dp)) {
                  OpenClawSidebar(
                    viewModel = model,
                    agents = agents,
                    selectedAgentId = null,
                    sessions = sessions,
                    activeSessionKey = sessionKey,
                    activeDestination = SidebarDestination.Home,
                    connection = connection,
                    visible = true,
                    showCloseButton = false,
                    onClose = {},
                    onDragActiveChange = {},
                    onNewSession = {},
                    onSelectAgent = {},
                    onSelectSession = {},
                    onSelectCatalogSession = {},
                    onCreateCatalogSession = {},
                    onSelectDestination = {},
                  )
                }
                Box(Modifier.weight(1f)) {
                  if (showComposer) {
                    ChatScreen(
                      viewModel = model,
                      talkActive = false,
                      showSidebarButton = false,
                      onOpenSidebar = {},
                      onToggleTalk = {},
                      onOpenDashboard = {},
                      onOpenGatewaySettings = {},
                    )
                  }
                }
              }
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun capture(
    name: String,
    popup: Boolean = false,
    preferredDialogTag: String? = null,
  ) {
    val directory = System.getenv("OPENCLAW_GATEWAY_PROOF_DIR") ?: return
    val target = File(directory, "$name.png")
    requireNotNull(target.parentFile).mkdirs()
    target.outputStream().use { output ->
      val node =
        when {
          preferredDialogTag != null && composeRule.onAllNodesWithTag(preferredDialogTag).fetchSemanticsNodes().isNotEmpty() -> composeRule.onNode(isDialog() and hasAnyDescendant(hasTestTag(preferredDialogTag)))
          popup -> composeRule.onNode(isDialog())
          else -> composeRule.onNodeWithTag("gateway-proof")
        }
      node.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, output)
    }
  }
}
