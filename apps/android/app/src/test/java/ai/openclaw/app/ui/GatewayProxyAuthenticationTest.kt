package ai.openclaw.app.ui

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayProxyCredentials
import ai.openclaw.app.gateway.GatewayProxyPrincipal
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** The shared production form owns draft validation and only publishes on explicit actions. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GatewayProxyAuthenticationTest {
  @get:Rule val composeRule = createComposeRule()
  private val endpoint = GatewayEndpoint.manual("gateway.example", 443, true, "/openclaw")

  @Test
  fun savedFormRequiresReplacementPasswordAndRejectsInvalidBasicUsername() {
    var saved: GatewayProxyCredentials? = null
    composeRule.setContent {
      ClawDesignTheme {
        GatewayProxyCredentialDialog(endpoint, "dummy-user", true, {}, { saved = it }, {}, "Save")
      }
    }
    composeRule.onNodeWithTag("proxy-save").assertIsNotEnabled()
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("hello")
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("invalid:username")
    composeRule.onNodeWithTag("proxy-save").assertIsNotEnabled()
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("dummy-user")
    composeRule.onNodeWithTag("proxy-destination").assertExists()
    System.getProperty("openclaw.proxyScreenshotDir")?.let { directory ->
      val image = File(directory, "android-proxy-login.png")
      requireNotNull(image.parentFile).mkdirs()
      image.outputStream().use {
        assertTrue(
          composeRule
            .onNode(isDialog())
            .captureToImage()
            .asAndroidBitmap()
            .compress(Bitmap.CompressFormat.PNG, 100, it),
        )
      }
    }
    composeRule.onNodeWithTag("proxy-save").performClick()
    composeRule.runOnIdle {
      assertEquals("dummy-user", saved?.username)
      assertEquals("hello", saved?.password)
      assertEquals("GatewayProxyCredentials([redacted])", saved.toString())
    }
  }

  @Test
  fun sharedSelectionStagesBasicAndCancelPreservesConfiguredGateway() {
    val action = mutableStateOf<GatewayProxyAuthAction>(GatewayProxyAuthAction.Keep)
    composeRule.setContent {
      ClawDesignTheme {
        FoldAwarePrompt(
          onDismissRequest = {},
          title = "Gateway setup",
          text = {
            Column {
              Text(gatewayProxyDestination(endpoint))
              GatewayProxyAuthentication(endpoint, GatewayProxyPrincipal("dummy-user", locked = false), action.value, { action.value = it }, savedConfigured = true, saveLabel = "Save")
            }
          },
          actions = {},
        )
      }
    }
    val basic = hasText("HTTP Basic") and hasClickAction()
    val none = hasText("None") and hasClickAction()
    composeRule.onNode(basic).assertIsSelected()
    composeRule.onNodeWithText("Edit").performClick()
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("uncommitted-hello")
    composeRule.onNodeWithText("Cancel").performClick()
    composeRule.onNode(basic).assertIsSelected()
    composeRule.runOnIdle { assertEquals(GatewayProxyAuthAction.Keep, action.value) }

    composeRule.onNode(none).performClick()
    composeRule.onNode(none).assertIsSelected()
    composeRule.runOnIdle { assertEquals(GatewayProxyAuthAction.Remove, action.value) }
    composeRule.onNode(basic).performClick()
    composeRule.onNodeWithTag("proxy-save").assertIsNotEnabled()
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("dummy-user")
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("hello")
    composeRule.onNodeWithTag("proxy-save").performClick()
    composeRule.onNode(basic).assertIsSelected()
    composeRule.onNodeWithText("Edit").assertExists()
    composeRule.runOnIdle {
      val staged = action.value as GatewayProxyAuthAction.Save
      assertEquals("dummy-user", staged.credentials.username)
    }
    System.getProperty("openclaw.proxyScreenshotDir")?.let { directory ->
      val image = File(directory, "android-proxy-selection.png")
      requireNotNull(image.parentFile).mkdirs()
      image.outputStream().use {
        assertTrue(
          composeRule
            .onNode(isDialog())
            .captureToImage()
            .asAndroidBitmap()
            .compress(Bitmap.CompressFormat.PNG, 100, it),
        )
      }
    }
  }

  @Test
  fun lockedAccountAllowsPasswordRotationOnlyAndExplainsForget() {
    val action = mutableStateOf<GatewayProxyAuthAction>(GatewayProxyAuthAction.Keep)
    composeRule.setContent {
      ClawDesignTheme {
        GatewayProxyAuthentication(endpoint, GatewayProxyPrincipal("dummy-user", locked = true), action.value, { action.value = it }, savedConfigured = true, saveLabel = "Save")
      }
    }
    composeRule.onNodeWithText("Edit").performClick()
    composeRule.onNodeWithTag("proxy-username").assertIsNotEnabled()
    composeRule.onNodeWithText("To use a different proxy account, forget this Gateway and add it again.").assertExists()
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("rotated")
    composeRule.onNodeWithTag("proxy-save").performClick()
    composeRule.runOnIdle {
      val staged = action.value as GatewayProxyAuthAction.Save
      assertEquals("dummy-user", staged.credentials.username)
      assertEquals("rotated", staged.credentials.password)
    }
  }

  @Test
  fun cancelDoesNotPublishTypedProxyCredentials() {
    var saved: GatewayProxyCredentials? = null
    var cancelled = false
    var removed = false
    composeRule.setContent {
      ClawDesignTheme {
        GatewayProxyCredentialDialog(endpoint, "", false, { cancelled = true }, { saved = it }, { removed = true })
      }
    }
    composeRule.onNodeWithTag("proxy-username").performTextReplacement("dummy-user")
    composeRule.onNodeWithTag("proxy-password").performTextReplacement("hello")
    composeRule.onNodeWithText("Cancel").performClick()
    composeRule.runOnIdle {
      assertTrue(cancelled)
      assertNull(saved)
      assertEquals(false, removed)
    }
  }
}
