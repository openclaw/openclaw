package ai.openclaw.app.ui

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class GatewayTrustIdentityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun capturedCertificateShowsItsDestinationAndReplacesItWithTheNextPrompt() {
    val first = prompt(GatewayEndpoint.manual("gateway.example.test", 443, true, "/one"))
    val current = mutableStateOf(first)
    val accepted = mutableListOf<NodeRuntime.GatewayTrustPrompt>()
    composeRule.setContent {
      val shown = current.value
      ClawDesignTheme {
        GatewayTrustDialog(
          prompt = shown,
          confirmLabel = "Trust",
          cancelLabel = "Cancel",
          onAccept = { accepted.add(shown) },
          onUseSystemTrust = {},
          onDecline = {},
        )
      }
    }

    composeRule.onNodeWithText("gateway.example.test:443/one").assertIsDisplayed()
    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
    composeRule.onNodeWithText("Trust").assertIsEnabled()
    composeRule.onNodeWithText("Trust").performClick()
    composeRule.waitForIdle()
    assertEquals(listOf(first), accepted)

    val replacement =
      prompt(GatewayEndpoint.manual("2001:db8::1", 8443, true, "/two"))
        .copy(previousFingerprintSha256 = "cd".repeat(32))
    composeRule.runOnIdle { current.value = replacement }
    composeRule.onNodeWithText("[2001:db8::1]:8443/two").assertIsDisplayed()
    composeRule.onNodeWithText("gateway.example.test:443/one").assertDoesNotExist()
    composeRule.onNodeWithText("Old SHA-256:", substring = true).assertIsDisplayed()
    composeRule.onNodeWithText("Trust").performClick()
    composeRule.waitForIdle()
    assertEquals(listOf(first, replacement), accepted)
  }

  @Test
  fun manualFingerprintShowsTheDestinationWithoutRelaxingPinValidation() {
    val manual =
      prompt(GatewayEndpoint.manual("manual.example.test", 9443, true, "/gateway"))
        .copy(fingerprintSha256 = null, probeFailure = GatewayTlsProbeFailure.TLS_UNAVAILABLE)
    val accepted = mutableListOf<String?>()
    composeRule.setContent {
      ClawDesignTheme {
        GatewayTrustDialog(
          prompt = manual,
          confirmLabel = "Trust",
          cancelLabel = "Cancel",
          onAccept = { accepted.add(it) },
          onUseSystemTrust = {},
          onDecline = {},
        )
      }
    }

    composeRule.onNodeWithText("manual.example.test:9443/gateway").assertIsDisplayed()
    val trust = composeRule.onNodeWithText("Trust")
    trust.assertIsNotEnabled()
    val input = composeRule.onNode(hasSetTextAction())
    input.performScrollTo()
    input.performTextReplacement("not-a-fingerprint")
    trust.assertIsNotEnabled()
    assertTrue(accepted.isEmpty())
    input.performTextReplacement("ab".repeat(32))
    trust.performScrollTo()
    trust.assertIsEnabled()
    trust.performClick()
    composeRule.waitForIdle()
    assertEquals(listOf("ab".repeat(32)), accepted)
  }

  private fun prompt(endpoint: GatewayEndpoint): NodeRuntime.GatewayTrustPrompt =
    NodeRuntime.GatewayTrustPrompt(
      endpoint = endpoint,
      fingerprintSha256 = "ab".repeat(32),
      auth = NodeRuntime.GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
    )
}
