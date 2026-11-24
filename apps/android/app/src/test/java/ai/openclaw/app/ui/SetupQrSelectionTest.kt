package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.ChatDraft
import ai.openclaw.app.ChatDraftPlacement
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayCredentials
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayProxyCredentials
import ai.openclaw.app.gateway.GatewayProxySaveResult
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.media.Image
import android.media.ImageReader
import android.net.Uri
import android.os.Looper
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageInfo
import androidx.camera.core.ImageProxy
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.mlkit.common.sdkinternal.MlKitContext
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.barcode.common.internal.BarcodeSource
import com.google.mlkit.vision.common.InputImage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/** Scanner output is external I/O; selection, validation, callbacks and review UI are production. */
@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  qualifiers = "w412dp-h900dp-mdpi",
  shadows = [SetupQrScannerFactory::class, SetupQrInputImage::class],
)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SetupQrSelectionTest {
  @get:Rule val composeRule = createComposeRule()
  private val mounted = mutableStateOf(true)
  private val store = ViewModelStore()
  private val results = ArrayDeque<TaskCompletionSource<List<Barcode>>>()
  private val tlsAttempt = CompletableDeferred<Pair<String, Int>>()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var activity: ComponentActivity
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null
  private val scanner =
    object : BarcodeScanner by ReflectionHelpers.createNullProxy(BarcodeScanner::class.java) {
      override fun process(image: InputImage): Task<List<Barcode>> = results.removeFirst().task
    }

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    MlKitContext.initializeIfNeeded(app)
    prefs = SecurePrefs(app, app.getSharedPreferences("setup-qr-selection", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime =
      NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture, tlsFingerprintProbe = { host, port ->
        // ScreenshotFixture isolates storage but does not suppress explicit connections.
        // Hold the existing external TLS boundary; no DNS, socket, or gateway is contacted.
        tlsAttempt.complete(host to port)
        awaitCancellation()
      })
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    store.put("qr-selection", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    SetupQrScannerFactory.scanner = scanner
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    composeRule.runOnIdle { mounted.value = false }
    composeRule.waitForIdle()
    store.clear()
    bindNodeRuntimeTestFixture(app, originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
  }

  @Test
  @androidx.annotation.OptIn(ExperimentalGetImage::class)
  fun cameraIgnoresUnsuitableFramesThenDeliversTheFirstValidCandidateOnlyOnce() {
    val accepted = mutableListOf<String>()
    val processing = AtomicBoolean(false)
    val handled = AtomicBoolean(false)
    val active = AtomicBoolean(true)
    val valid = setupCode("wss://gateway.invalid/openclaw")
    // Exercise the existing CameraX callback without exporting a production test hook or
    // requiring camera hardware. Native image conversion and ML Kit are external boundaries.
    val analyze =
      Class
        .forName("ai.openclaw.app.ui.OnboardingFlowKt")
        .getDeclaredMethod(
          "analyzeSetupQrFrame",
          ImageProxy::class.java,
          BarcodeScanner::class.java,
          AtomicBoolean::class.java,
          AtomicBoolean::class.java,
          AtomicBoolean::class.java,
          Function1::class.java,
        ).apply { isAccessible = true }
    ImageReader.newInstance(2, 2, PixelFormat.RGBA_8888, 1).use { reader ->
      val surface = reader.surface
      val canvas = surface.lockCanvas(null)
      canvas.drawColor(Color.WHITE)
      surface.unlockCanvasAndPost(canvas)
      checkNotNull(reader.acquireNextImage()).use { image ->
        fun frame(vararg rawValues: String?) {
          val result = TaskCompletionSource<List<Barcode>>()
          results.addLast(result)
          var closed = 0
          val proxy =
            object : ImageProxy by ReflectionHelpers.createNullProxy(ImageProxy::class.java) {
              override fun getImage(): Image = image

              override fun getImageInfo(): ImageInfo = ReflectionHelpers.createNullProxy(ImageInfo::class.java)

              override fun close() {
                closed++
              }
            }
          val callback: (String) -> Unit = { accepted += it }
          analyze.invoke(null, proxy, scanner, processing, handled, active, callback)
          result.setResult(rawValues.map(::barcode))
          shadowOf(Looper.getMainLooper()).idle()
          // Releasing every frame is necessary for CameraX to offer the next candidate.
          assertEquals(1, closed)
          results.clear() // A frame arriving after success is intentionally not processed.
        }
        frame(null, " ")
        frame("https://unrelated.invalid/menu")
        assertTrue("An unrelated QR must not stop the live scanner", accepted.isEmpty())
        frame(setupCode("ws://insecure.invalid:18789"))
        assertTrue("A rejected endpoint must not stop the live scanner", accepted.isEmpty())
        frame("https://unrelated.invalid/menu", valid, setupCode("wss://other.invalid"))
        assertEquals(listOf(valid), accepted)
        frame(valid)
        assertEquals("A successful scan must be delivered only once", listOf(valid), accepted)
      }
    }
  }

  @Test
  fun galleryKeepsInvalidImageErrorsThenReviewsALaterValidCandidateWithoutConnecting() {
    model.openGatewayAddition()
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current) as ComponentActivity
      if (mounted.value) {
        ClawDesignTheme(dark = true) {
          val request by model.gatewayAdditionRequest.collectAsState()
          request?.let { GatewayAdditionDialog(model, it) }
        }
      }
    }
    val saved = prefs.gatewayRegistry.entries.value
    val handoff = model.gatewayConnectionHandoff.value
    val manualHost = model.manualHost.value

    chooseImage(null, " ")
    composeRule.onNodeWithText("No QR code found in the selected image.").assertIsDisplayed()
    composeRule.onNodeWithTag("gateway-add-connect").assertDoesNotExist()
    chooseImage("https://unrelated.invalid/menu")
    composeRule.onNodeWithText("QR code did not contain a valid setup code.").assertIsDisplayed()
    capture("gallery-invalid-only")
    composeRule.onNodeWithTag("gateway-add-connect").assertDoesNotExist()

    val valid = setupCode("wss://gateway.invalid/openclaw")
    chooseImage(
      null,
      " ",
      "https://unrelated.invalid/menu",
      setupCode("ws://insecure.invalid:18789"),
      """{"setupCode":"$valid"}""",
      setupCode("wss://other.invalid"),
    )
    // Capture before the assertion so an unchanged base also exports the incorrect error UI.
    capture("gallery-mixed-candidates")
    composeRule.onNodeWithTag("gateway-add-preview").assertTextEquals("wss://gateway.invalid:443/openclaw")
    composeRule.onNodeWithText("Connect to this gateway?").assertIsDisplayed()
    composeRule.onNodeWithTag("gateway-add-connect").performScrollTo().assertIsEnabled()
    composeRule.runOnIdle {
      assertEquals("Scanning must not save a gateway", saved, prefs.gatewayRegistry.entries.value)
      assertEquals("Scanning must not start a connection", handoff, model.gatewayConnectionHandoff.value)
      assertEquals(manualHost, model.manualHost.value)
      assertFalse(tlsAttempt.isCompleted)
    }
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    composeRule.onNodeWithTag("gateway-addition").assertDoesNotExist()
  }

  @Test
  fun onboardingGalleryRetriesInvalidImageThenUsesALaterValidCandidate() {
    runtime.prepareForGatewaySetup()
    composeRule.setContent {
      activity = requireNotNull(LocalActivity.current) as ComponentActivity
      if (mounted.value) {
        Box(Modifier.fillMaxSize().testTag("onboarding-qr-proof")) { OnboardingFlow(model) }
      }
    }
    composeRule.onNodeWithText("Continue").performClick()
    composeRule.onNodeWithText("Scan QR or setup code").performClick()
    chooseImage("https://unrelated.invalid/menu", scroll = false)
    composeRule.onNodeWithText("QR code not accepted").assertIsDisplayed()
    composeRule.onNodeWithText("Choose another image").assertIsEnabled()
    composeRule.onNode(hasText("Enter setup code") and hasAnyAncestor(isDialog())).assertIsEnabled()
    assertFalse(tlsAttempt.isCompleted)
    capture("onboarding-invalid-only")

    chooseImage(
      "https://unrelated.invalid/menu",
      setupCode("ws://insecure.invalid:18789"),
      setupCode("wss://onboarding.invalid/openclaw"),
      setupCode("wss://other.invalid"),
      action = "Choose another image",
    )
    capture("onboarding-mixed-candidates")
    composeRule.onNodeWithText("QR code not accepted").assertDoesNotExist()
    composeRule.onNodeWithText("Connect to this Gateway?").assertIsDisplayed()
    assertFalse(tlsAttempt.isCompleted)
    composeRule.onNodeWithText("Connect").performClick()
    composeRule.onNodeWithText("Pair Gateway").assertIsDisplayed()
    drainWithMainLooper {
      withTimeout(5_000) { assertEquals("onboarding.invalid" to 443, tlsAttempt.await()) }
    }
    composeRule.runOnIdle {
      assertEquals("onboarding.invalid", model.manualHost.value)
      val saved =
        prefs.gatewayRegistry.entries.value
          .single { it.host == "onboarding.invalid" }
      assertEquals(443, saved.port)
      assertEquals(true, saved.tls)
      assertEquals("/openclaw", saved.contextPath)
      assertFalse("A pending fixture TLS probe must not connect to a gateway", model.gatewayConnectionDisplay.value.isConnected)
    }
  }

  @Test
  fun proxySaveFailureAndRestoredIdentityRecoveryPreservePairingAndDraft() {
    runtime.prepareForGatewaySetup()
    prefs.setOnboardingCompleted(false)
    val endpoint = GatewayEndpoint.manual("gateway.invalid", 443, true)
    val original = GatewayCredentials(token = "saved-token", password = "saved-password")
    prefs.saveGatewayCredentials(endpoint.stableId, original)
    prefs.saveGatewayCustomHeaders(endpoint.stableId, mapOf("Authorization" to "Bearer existing-proxy"))
    prefs.gatewayRegistry.upsert(GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, name = "Home", host = endpoint.host, port = endpoint.port, tls = true))
    prefs.gatewayRegistry.setActive(endpoint.stableId)
    val deviceId = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate().deviceId
    val tokens = DeviceAuthStore(prefs)
    for (role in listOf("node", "operator")) assertTrue(tokens.saveToken(endpoint.stableId, deviceId, role, "saved-$role"))
    val restoration = StateRestorationTester(composeRule)
    restoration.setContent {
      activity = requireNotNull(LocalActivity.current) as ComponentActivity
      ClawDesignTheme {
        if (mounted.value) Box(Modifier.fillMaxSize().testTag("onboarding-qr-proof")) { RootScreen(model) }
      }
    }
    composeRule.onNodeWithText("Continue").performClick()
    composeRule.onNodeWithText("Scan QR or setup code").performClick()
    val setup = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"url":"wss://gateway.invalid","bootstrapToken":"replacement-setup"}""".toByteArray())
    chooseImage(setup, scroll = false)
    composeRule.onNodeWithText("HTTP Basic").performClick()
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("alice")
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("discarded")
    composeRule.onAllNodesWithText("Cancel").onLast().performClick()
    assertFalse(prefs.hasGatewayProxyCredentials(endpoint.stableId))
    composeRule.onNodeWithText("HTTP Basic").performClick()
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("alice")
    composeRule.onNodeWithTag("proxy-save").assertIsNotEnabled()
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("replacement")
    composeRule.onNodeWithTag("proxy-save").performScrollTo().performClick()
    val draft = ChatDraft("Keep this draft", ChatDraftPlacement.Replace, ChatComposerOwner(endpoint.stableId, "main", "main"))
    composeRule.runOnIdle { model.setChatDraft(draft) }
    composeRule.onNodeWithText("Connect").performClick()
    drainWithMainLooper { withTimeout(5_000) { model.gatewayConnectionDisplay.first { it.problem?.code == "PROXY_AUTH_SAVE_FAILED" } } }
    composeRule.onNodeWithText("Could not save proxy login.", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Go back").assertIsDisplayed()
    assertEquals(original, prefs.loadGatewayCredentials(endpoint.stableId))
    assertEquals(draft, model.chatDraft.value)
    for (role in listOf("node", "operator")) assertEquals("saved-$role", tokens.loadToken(endpoint.stableId, deviceId, role))
    assertFalse(tlsAttempt.isCompleted)
    capture("onboarding-proxy-save-failure")

    val failure = requireNotNull(model.gatewayConnectionDisplay.value.problem)

    fun reportProblem(
      code: String,
      reason: String? = null,
    ) {
      val problem = failure.copy(code = code, reason = reason, message = "Sign-in required")
      composeRule.runOnIdle {
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_nodeConnected").value = true
        ReflectionHelpers.getField<MutableStateFlow<GatewayConnectionDisplay>>(runtime, "_gatewayConnectionDisplay").value =
          GatewayConnectionDisplay(false, "Gateway error: sign-in required", problem)
      }
      drainWithMainLooper { withTimeout(5_000) { model.gatewayConnectionDisplay.first { it.problem == problem } } }
    }
    reportProblem("PROXY_AUTH_REQUIRED")
    restoration.emulateSavedInstanceStateRestore()
    composeRule.onNodeWithText("Configure proxy login").performClick()
    composeRule.onNodeWithText("HTTP Basic").performClick()
    composeRule.onNodeWithTag("proxy-destination").assertTextEquals("https://gateway.invalid:443")
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("unsaved-secret")
    restoration.emulateSavedInstanceStateRestore()
    composeRule.onNodeWithText("Configure proxy login").performClick()
    composeRule.onNodeWithText("HTTP Basic").performClick()
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("alice")
    composeRule.onNodeWithTag("proxy-save").assertIsNotEnabled()
    composeRule.onAllNodesWithText("Cancel").onLast().performClick()
    composeRule.onNodeWithText("Cancel").performClick()

    reportProblem("AUTH_UNAUTHORIZED", "trusted_proxy_user_missing")
    restoration.emulateSavedInstanceStateRestore()
    composeRule.onNodeWithText("Verified sign-in required").assertIsDisplayed()
    composeRule.onNodeWithText("View details").performScrollTo().performClick()
    composeRule.onNodeWithText("Chat/operator connected: false", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Node connected: true", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Close").performClick()
    capture("onboarding-proxy-identity-recovery")
    composeRule.onNodeWithText("Use authenticated setup code").performClick()
    composeRule.onNodeWithText("Enter setup code").assertIsDisplayed()
    assertEquals(original, prefs.loadGatewayCredentials(endpoint.stableId))
    assertFalse(model.onboardingCompleted.value)
  }

  @Test
  fun failedSavedGatewayProxyEditKeepsItsAdditionRequestForRetry() {
    runtime.prepareForGatewaySetup()
    val endpoint = GatewayEndpoint.manual("gateway.invalid", 443, true)
    prefs.gatewayRegistry.upsert(GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, name = "Home", host = endpoint.host, port = endpoint.port, tls = true))
    prefs.saveGatewayCredentials(endpoint.stableId, token = "original")
    prefs.saveGatewayCustomHeaders(endpoint.stableId, mapOf("Authorization" to "Bearer existing-proxy"))
    model.openGatewayAddition()
    val addition = requireNotNull(model.gatewayAdditionRequest.value)
    val config = GatewayConnectConfig(endpoint.host, endpoint.port, true, "", "", "")
    val action = GatewayProxyAuthAction.Save(GatewayProxyCredentials("alice", "replacement"))
    model.saveGatewayConfigAndConnect(GatewayConnectPlan(config, GatewaySavedAuthAction.PRESERVE, action), addition)
    drainWithMainLooper {
      withTimeout(5_000) {
        assertEquals(GatewayProxySaveResult.FAILED, addition.proxySaveFailure.first { it != null })
      }
    }
    assertEquals(addition, model.gatewayAdditionRequest.value)
    assertEquals("original", prefs.loadGatewayCredentials(endpoint.stableId).token)
    assertFalse(prefs.hasGatewayProxyCredentials(endpoint.stableId))
    assertFalse(tlsAttempt.isCompleted)
  }

  private fun chooseImage(
    vararg rawValues: String?,
    action: String = "Choose from gallery",
    scroll: Boolean = true,
  ) {
    val result = TaskCompletionSource<List<Barcode>>()
    results.addLast(result)
    val button = composeRule.onNodeWithText(action)
    if (scroll) button.performScrollTo()
    button.performClick()
    composeRule.runOnIdle {
      val request = checkNotNull(shadowOf(activity).nextStartedActivityForResult)
      assertEquals(Intent.ACTION_GET_CONTENT, request.intent.action)
      assertTrue(
        activity.activityResultRegistry.dispatchResult(
          request.requestCode,
          Activity.RESULT_OK,
          Intent().setData(Uri.parse("content://ai.openclaw.fixture/setup-qr")),
        ),
      )
      result.setResult(rawValues.map(::barcode))
    }
    composeRule.waitForIdle()
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_QR_PROOF_DIR") ?: return
    if (name.startsWith("gallery-")) composeRule.onNodeWithText("Add Gateway").performScrollTo()
    val target = File(directory, "$name.png")
    requireNotNull(target.parentFile).mkdirs()
    target.outputStream().use { output ->
      val targetNode =
        if (composeRule.onAllNodes(isDialog()).fetchSemanticsNodes().isNotEmpty()) {
          composeRule.onNode(isDialog())
        } else {
          composeRule.onNodeWithTag("onboarding-qr-proof")
        }
      targetNode.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, output)
    }
  }

  private fun setupCode(url: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"url":"$url"}""".toByteArray())

  private fun barcode(raw: String?): Barcode =
    Barcode(
      object : BarcodeSource by ReflectionHelpers.createNullProxy(BarcodeSource::class.java) {
        override fun getRawValue(): String? = raw
      },
    )
}

@Implements(value = BarcodeScanning::class, isInAndroidSdk = false)
class SetupQrScannerFactory {
  companion object {
    lateinit var scanner: BarcodeScanner

    @JvmStatic
    @Implementation
    fun getClient(
      @Suppress("UNUSED_PARAMETER") options: BarcodeScannerOptions,
    ): BarcodeScanner = scanner
  }
}

/** Do not load native ML Kit or read an actual gallery provider in a callback regression. */
@Implements(value = InputImage::class, isInAndroidSdk = false)
class SetupQrInputImage {
  companion object {
    @JvmStatic
    @Implementation
    @Suppress("UNUSED_PARAMETER")
    fun fromFilePath(
      context: Context,
      uri: Uri,
    ): InputImage = placeholder()

    @JvmStatic
    @Implementation
    @Suppress("UNUSED_PARAMETER")
    fun fromMediaImage(
      image: Image,
      rotationDegrees: Int,
    ): InputImage = placeholder()

    private fun placeholder(): InputImage = InputImage.fromBitmap(Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888), 0)
  }
}
