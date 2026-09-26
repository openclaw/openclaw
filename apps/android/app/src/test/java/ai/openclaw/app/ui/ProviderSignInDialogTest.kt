package ai.openclaw.app.ui

import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-mdpi")
class ProviderSignInDialogTest {
  @get:Rule val composeRule = createComposeRule()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var connected: String? = null
  private var dismissed by mutableStateOf(false)
  private var readyProvider: String? = null
  private var openedUrl: String? = null
  private var savedKey: String? = null
  private var authStatus = AUTH
  private var loginChoice: String? = null
  private val lease =
    GatewaySession.RequestLease("gateway", { true }, null) { method, params, _, enqueue ->
      enqueue {}
      val input = Json.parseToJsonElement(requireNotNull(params)).jsonObject
      when (method) {
        "models.authStatus" -> {
          if (readyProvider == null) authStatus else """{"providers":[{"provider":"$readyProvider","status":"ok"}]}"""
        }

        "models.authLogin" -> {
          loginChoice = input.getValue("authChoice").jsonPrimitive.content
          when (val choice = input.getValue("authChoice").jsonPrimitive.content) {
            "plugin/example" -> """{"done":false,"status":"running","step":{"id":"device","type":"action","executor":"client","externalUrl":"https://example.com/login","deviceCode":{"code":"ABCD"}}}"""
            "plugin/other" -> """{"done":false,"status":"running","step":{"id":"callback","type":"text","executor":"client","externalUrl":"https://example.com/oauth","placeholder":"Callback URL"}}"""
            "anthropic/setup-token" -> """{"done":false,"status":"running","step":{"id":"subscription","type":"text","executor":"client","sensitive":true,"placeholder":"Setup token"}}"""
            "minimax/minimax-cn-oauth" -> """{"done":false,"status":"running","step":{"id":"portal","type":"action","executor":"client","externalUrl":"https://example.com/minimax","deviceCode":{"code":"DEMO"}}}"""
            else -> error("Unexpected login choice: $choice")
          }
        }

        "wizard.next" -> {
          val answer = input.getValue("answer").jsonObject
          when (val step = answer.getValue("stepId").jsonPrimitive.content) {
            "device" -> {
              readyProvider = "example"
            }

            "callback" -> {
              assertEquals("https://example.com/return?code=synthetic", answer.getValue("value").jsonPrimitive.content)
              readyProvider = "other"
            }

            "subscription" -> {
              assertEquals("synthetic-subscription-token", answer.getValue("value").jsonPrimitive.content)
              readyProvider = "anthropic"
            }

            "portal" -> {
              readyProvider = "minimax-portal"
            }

            else -> {
              error("Unexpected step: $step")
            }
          }
          """{"done":true,"status":"done"}"""
        }

        "models.authSetApiKey" -> {
          assertEquals("key", input.getValue("provider").jsonPrimitive.content)
          savedKey = input.getValue("apiKey").jsonPrimitive.content
          readyProvider = "key"
          """{"provider":"key","profileId":"key:default"}"""
        }

        else -> {
          error("Unexpected method: $method")
        }
      }
    }
  private val controller = ProviderAuthController(scope, lease, "writer", Json) {}

  @After
  fun tearDown() {
    controller.close()
    scope.cancel()
  }

  @Test
  fun providerFamilyOffersApiAndOAuthWithoutChangingTheCredentialOwner() {
    authStatus = FAMILY_AUTH
    show("minimax")
    composeRule.onNodeWithText("MiniMax API key (Global)").assertIsDisplayed()
    composeRule.onNodeWithText("MiniMax API key (CN)").assertIsDisplayed()
    composeRule.onNodeWithText("MiniMax OAuth (Global)").assertIsDisplayed()
    composeRule.onNodeWithText("MiniMax OAuth (CN)").performScrollTo().performClick()
    composeRule.onNodeWithText("DEMO").assertIsDisplayed()
    composeRule.onNodeWithText("Continue").performClick()
    composeRule.runOnIdle {
      assertEquals("minimax/minimax-cn-oauth", loginChoice)
      assertEquals("minimax-portal", connected)
      assertNull(savedKey)
    }
  }

  @Test
  fun providerPickerKeepsSubscriptionTokenAndGatewaySetupDistinct() {
    authStatus = FAMILY_AUTH
    show()
    composeRule.onNode(hasText("Anthropic") and !hasSetTextAction()).performClick()
    composeRule.onNodeWithText("Anthropic API key").assertIsDisplayed()
    composeRule.onNodeWithText("Claude subscription (setup-token)").assertIsDisplayed()
    composeRule.onNodeWithText("Anthropic Claude CLI").performScrollTo().performClick()
    composeRule.onNodeWithText("openclaw configure --section model").assertIsDisplayed()
    composeRule.runOnIdle { assertNull(loginChoice) }
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNodeWithText("Claude subscription (setup-token)").performClick()
    val token = composeRule.onNode(hasSetTextAction() and hasText("Setup token"))
    token.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
    token.performTextReplacement("synthetic-subscription-token")
    composeRule.onNodeWithText("Continue").performClick()
    composeRule.runOnIdle {
      assertEquals("anthropic/setup-token", loginChoice)
      assertEquals("anthropic", connected)
      assertNull(savedKey)
    }
  }

  @Test
  fun pickerScopesMethodsAndCompletesReturnedDeviceFlow() {
    show()
    composeRule.onNodeWithText("Search 3 providers").performTextReplacement("Example")
    composeRule.onNodeWithText("Key").assertDoesNotExist()
    composeRule.onNode(hasText("Example") and !hasSetTextAction()).performClick()
    composeRule.onNodeWithText("Connect Example").assertIsDisplayed()
    composeRule.onNodeWithText("Pick how you want to connect.").assertIsDisplayed()
    composeRule.onNodeWithText("Example account").assertIsDisplayed()
    composeRule.onNodeWithText("Recommended").assertIsDisplayed()
    composeRule.onNodeWithText("Other account").assertDoesNotExist()
    composeRule.onNodeWithText("Example account").performClick()
    composeRule.onNodeWithText("ABCD").assertIsDisplayed()
    composeRule.onNodeWithText("Open sign-in page").performClick()
    composeRule.onNodeWithText("Continue").performClick()
    composeRule.runOnIdle {
      assertEquals("https://example.com/login", openedUrl)
      assertEquals("example", connected)
      assertTrue(dismissed)
    }
  }

  @Test
  fun directProviderEntryMasksKeyAndDoesNotLeaveAfterEmptyInput() {
    show("key", initialApiKeySelected = true)
    composeRule.onNodeWithText("Search 3 providers").assertDoesNotExist()
    composeRule.onNodeWithText("Other account").assertDoesNotExist()
    val key = composeRule.onNode(hasSetTextAction() and hasText("API key"))
    key.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
    composeRule.onNodeWithText("Save and connect").performClick()
    composeRule.onNodeWithText("Enter an API key.").assertIsDisplayed()
    key.performTextReplacement("synthetic-key")
    composeRule.onNodeWithText("Save and connect").performScrollTo().performClick()
    composeRule.runOnIdle {
      assertEquals("synthetic-key", savedKey)
      assertEquals("key", connected)
      assertTrue(dismissed)
    }
  }

  @Test
  fun oauthBrowserStepPreservesRequiredWizardAnswer() {
    show("other")
    composeRule.onNodeWithText("Other account").performClick()
    composeRule.onNodeWithText("Finish in your browser. Come back here when you’re done.").assertIsDisplayed()
    composeRule.onNodeWithText("Open browser").performClick()
    composeRule.runOnIdle {
      assertEquals("https://example.com/oauth", openedUrl)
      assertNull(connected)
      assertFalse(dismissed)
    }
    composeRule.onNodeWithText("Callback URL").performTextReplacement("https://example.com/return?code=synthetic")
    composeRule.onNodeWithText("Continue").performScrollTo().performClick()
    composeRule.runOnIdle {
      assertEquals("other", connected)
      assertTrue(dismissed)
    }
  }

  private fun show(
    initialProviderId: String? = null,
    initialApiKeySelected: Boolean = false,
  ) {
    composeRule.setContent {
      ClawDesignTheme {
        CompositionLocalProvider(
          LocalUriHandler provides
            object : UriHandler {
              override fun openUri(uri: String) {
                openedUrl = uri
              }
            },
        ) {
          if (!dismissed) {
            ProviderSignInDialog(controller, initialProviderId = initialProviderId, initialApiKeySelected = initialApiKeySelected, onConnected = { connected = it }) {
              dismissed = true
            }
          }
        }
      }
    }
  }

  companion object {
    private const val FAMILY_AUTH = """{"providers":[],"providerCapabilities":[
      {"provider":"anthropic","apiKeySupported":true,"quickApiKeySetup":true,"loginOptions":[
        {"id":"anthropic/apiKey","groupId":"anthropic","groupLabel":"Anthropic","label":"Anthropic API key","kind":"secret"},
        {"id":"anthropic/setup-token","groupId":"anthropic","groupLabel":"Anthropic","label":"Claude subscription (setup-token)","kind":"secret"}
      ],"setupOptions":[{"id":"anthropic/anthropic-cli","groupId":"anthropic","groupLabel":"Anthropic","label":"Anthropic Claude CLI"}]},
      {"provider":"minimax","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[
        {"id":"minimax/minimax-global-api","groupId":"minimax","groupLabel":"MiniMax","label":"MiniMax API key (Global)","kind":"secret"},
        {"id":"minimax/minimax-cn-api","groupId":"minimax","groupLabel":"MiniMax","label":"MiniMax API key (CN)","kind":"secret"}
      ]},
      {"provider":"minimax-portal","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[
        {"id":"minimax/minimax-global-oauth","groupId":"minimax","groupLabel":"MiniMax","label":"MiniMax OAuth (Global)","kind":"device-code"},
        {"id":"minimax/minimax-cn-oauth","groupId":"minimax","groupLabel":"MiniMax","label":"MiniMax OAuth (CN)","kind":"device-code"}
      ]}
    ]}"""
    private const val AUTH = """{"providers":[],"providerCapabilities":[{"provider":"example","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/example","label":"Example account","kind":"device-code","featured":true}]},{"provider":"other","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/other","label":"Other account","kind":"oauth","featured":false}]},{"provider":"key","apiKeySupported":true,"quickApiKeySetup":true}]}"""
  }
}
