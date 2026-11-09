package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.GatewayDevicePairingCapabilities
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPairedDeviceSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class DevicePairingConfirmationIdentityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun removalNamesTheSelectedDeviceAndCancelRetiresItsIdentity() {
    val named = pairedDevice("device-alpha", "Office computer")
    val unnamed = pairedDevice("device-beta", null)
    withScreen(GatewayNodesDevicesSummary(emptyList(), emptyList(), listOf(named, unnamed))) {
      val firstRemove = composeRule.onAllNodesWithText("Remove").onFirst()
      firstRemove.performScrollTo()
      firstRemove.performClick()
      composeRule.waitForIdle()
      dialogText("Remove paired device?").assertIsDisplayed()
      dialogText("Name: Office computer").assertIsDisplayed()
      dialogText("Device ID: device-alpha").assertIsDisplayed()
      dialogText("Device ID: device-beta").assertDoesNotExist()
      dialogText("This device will lose its trusted Gateway access.").assertIsDisplayed()
      cancelDialog()

      val lastRemove = composeRule.onAllNodesWithText("Remove").onLast()
      lastRemove.performScrollTo()
      lastRemove.performClick()
      composeRule.waitForIdle()
      dialogText("Device ID: device-beta").assertIsDisplayed()
      dialogText("Device ID: device-alpha").assertDoesNotExist()
      dialogText("Name: Office computer").assertDoesNotExist()
      cancelDialog()
      dialogText("Remove paired device?").assertDoesNotExist()
    }
  }

  @Test
  fun rejectionIdentifiesTheRequestWhileApprovalKeepsItsFullDisclosure() {
    val pending =
      GatewayPendingDeviceSummary(
        requestId = "request-alpha",
        deviceId = "device-pending",
        displayName = "Pocket phone",
        remoteIp = "192.0.2.10",
        roles = listOf("operator"),
        scopes = listOf("operator.read"),
        requestedAtMs = null,
        repair = false,
      )
    withScreen(GatewayNodesDevicesSummary(emptyList(), listOf(pending), emptyList())) {
      val reject = composeRule.onAllNodesWithText("Reject").onFirst()
      reject.performScrollTo()
      reject.performClick()
      composeRule.waitForIdle()
      dialogText("Reject pairing request?").assertIsDisplayed()
      dialogText("Name: Pocket phone").assertIsDisplayed()
      dialogText("Device ID: device-pending").assertIsDisplayed()
      dialogText("Reject the pairing request from this device?").assertIsDisplayed()
      cancelDialog()

      val approve = composeRule.onAllNodesWithText("Approve").onFirst()
      approve.performScrollTo()
      approve.performClick()
      composeRule.waitForIdle()
      dialogText("Approve device?").assertIsDisplayed()
      dialogText("Name: Pocket phone").assertIsDisplayed()
      dialogText("Device ID: device-pending").assertIsDisplayed()
      dialogText("Roles: operator").assertIsDisplayed()
      dialogText("Scopes: operator.read").assertIsDisplayed()
      cancelDialog()
    }
  }

  private fun dialogText(text: String): SemanticsNodeInteraction = composeRule.onNode(hasText(text) and hasAnyAncestor(isDialog()))

  private fun cancelDialog() {
    dialogText("Cancel").performClick()
    composeRule.waitForIdle()
  }

  private fun pairedDevice(
    id: String,
    name: String?,
  ): GatewayPairedDeviceSummary =
    GatewayPairedDeviceSummary(
      deviceId = id,
      displayName = name,
      remoteIp = null,
      roles = listOf("operator"),
      scopes = listOf("operator.read"),
      tokens = emptyList(),
      approvedAtMs = null,
    )

  private fun withScreen(
    summary: GatewayNodesDevicesSummary,
    assertions: () -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val storage = app.getSharedPreferences("pairing-identity-" + UUID.randomUUID(), Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
    try {
      bindNodeRuntimeTestFixture(app, runtime)
      val summaryState =
        ReflectionHelpers.getField<MutableStateFlow<GatewayNodesDevicesSummary>>(runtime, "_nodesDevicesSummary")
      val capabilitiesState =
        ReflectionHelpers.getField<MutableStateFlow<GatewayDevicePairingCapabilities>>(
          runtime,
          "_devicePairingCapabilities",
        )
      AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("pairing", model)
      model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme { NodesDevicesSettingsScreen(model, {}) }
        }
      }
      shadowOf(Looper.getMainLooper()).idle()
      composeRule.waitForIdle()
      composeRule.runOnIdle {
        summaryState.value = summary
        capabilitiesState.value =
          GatewayDevicePairingCapabilities(canList = true, canApprove = true, canReject = true, canRemove = true)
      }
      shadowOf(Looper.getMainLooper()).idle()
      composeRule.waitForIdle()
      assertions()
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      composeRule.waitForIdle()
      models.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
      }
    }
  }
}
