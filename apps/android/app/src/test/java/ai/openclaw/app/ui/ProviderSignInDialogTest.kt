package ai.openclaw.app.ui

import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ProviderSignInDialogTest {
  @get:Rule val composeRule = createComposeRule()

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
  private var controller: ProviderAuthController? = null

  @After
  fun closeController() {
    controller?.close()
    controller = null
  }

  @Test
  fun openSignInPageOpensHttps() {
    assertEquals(listOf("https://example.com/login"), openedUrls("https://example.com/login"))
  }

  @Test
  fun openSignInPageOpensLoopbackHttp() {
    assertEquals(listOf("http://127.0.0.1:18789/login"), openedUrls("http://127.0.0.1:18789/login"))
  }

  @Test
  fun openSignInPageOpensUppercaseHttps() {
    assertEquals(listOf("HTTPS://example.com/login"), openedUrls("HTTPS://example.com/login"))
  }

  @Test
  fun openSignInPageDoesNotOpenIntentScheme() {
    assertEquals(emptyList<String>(), openedUrls("intent://scan/#Intent;scheme=https;end"))
  }

  @Test
  fun openSignInPageDoesNotOpenFileScheme() {
    assertEquals(emptyList<String>(), openedUrls("file:///sdcard/secret.txt"))
  }

  @Test
  fun openSignInPageDoesNotOpenJavascriptScheme() {
    assertEquals(emptyList<String>(), openedUrls("javascript:alert(1)"))
  }

  private fun openedUrls(externalUrl: String): List<String> {
    val opened = mutableListOf<String>()
    controller?.close()
    val next =
      ProviderAuthController(
        scope,
        GatewaySession.RequestLease("gateway", { true }, null) { method, params, _, enqueue ->
          enqueue {}
          Json.parseToJsonElement(requireNotNull(params)).jsonObject
          when (method) {
            "models.authStatus" -> AUTH_STATUS
            "models.authLogin" -> wizard(externalUrl)
            else -> error("Unexpected method: $method")
          }
        },
        "writer",
        Json,
        { true },
      ) {}
    controller = next
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    composeRule.runOnUiThread {
      activity.get().setContent {
        CompositionLocalProvider(LocalUriHandler provides RecordingUriHandler(opened)) {
          ClawDesignTheme {
            ProviderSignInDialog(next) {}
          }
        }
      }
    }
    composeRule.waitForIdle()
    composeRule.onNodeWithText("Device code").performClick()
    composeRule.waitForIdle()
    assertTrue(composeRule.onAllNodesWithText("ABCD").fetchSemanticsNodes().isNotEmpty())
    val openButton = composeRule.onAllNodesWithText(nativeString("Open sign-in page"))
    if (openButton.fetchSemanticsNodes().isNotEmpty()) {
      openButton[0].performClick()
      composeRule.waitForIdle()
    }
    activity.get().finish()
    return opened.toList()
  }

  private class RecordingUriHandler(
    private val opened: MutableList<String>,
  ) : UriHandler {
    override fun openUri(uri: String) {
      opened += uri
    }
  }

  private companion object {
    private const val AUTH_STATUS =
      """{"ts":1,"providers":[],"providerCapabilities":[{"provider":"fixture","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/device","brandId":"fixture","label":"Device code","kind":"device-code","featured":true}]}]}"""

    private fun wizard(externalUrl: String): String {
      val encoded = JsonPrimitive(externalUrl).toString()
      return """{"done":false,"status":"running","step":{"id":"device","type":"action","executor":"client","externalUrl":$encoded,"deviceCode":{"code":"ABCD"}}}"""
    }
  }
}
