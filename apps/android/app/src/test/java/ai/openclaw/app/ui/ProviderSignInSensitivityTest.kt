package ai.openclaw.app.ui

import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.provider.Settings
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextLayoutResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class ProviderSignInSensitivityTest {
  private val compose = createComposeRule()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
  private var controller: ProviderAuthController? = null

  // Dispose the dialog (and its controller) before cancelling the request scope.
  @get:Rule
  val rules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun before() {
            Settings.Global.putFloat(
              RuntimeEnvironment.getApplication().contentResolver,
              Settings.Global.ANIMATOR_DURATION_SCALE,
              0f,
            )
          }

          override fun after() {
            controller?.close()
            scope.cancel()
          }
        },
      ).around(compose)

  @Test
  fun passwordSemanticsFollowPlainSecretPlainWizardSteps() {
    assertSensitivityTransitions(listOf(false, true, false))
  }

  @Test
  fun passwordSemanticsFollowSecretPlainSecretWizardSteps() {
    assertSensitivityTransitions(listOf(true, false, true))
  }

  private fun assertSensitivityTransitions(sensitivities: List<Boolean>) {
    val answers = mutableListOf<JsonObject>()
    val values = listOf("  synthetic first  ", "  synthetic café 🔑  ", "synthetic last")
    var authChanged = false
    val lease =
      GatewaySession.RequestLease(
        endpointStableId = "synthetic-gateway",
        requestImpl = { method, paramsJson, _, enqueue ->
          enqueue {}
          val params = Json.parseToJsonElement(requireNotNull(paramsJson)).jsonObject
          when (method) {
            "models.authStatus" -> {
              AUTH_STATUS
            }

            "models.authLogin" -> {
              assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
              assertEquals("fixture/login", params.getValue("authChoice").jsonPrimitive.content)
              wizardStep(0, sensitivities[0])
            }

            "wizard.next" -> {
              answers += params.getValue("answer").jsonObject
              if (answers.size < sensitivities.size) {
                wizardStep(answers.size, sensitivities[answers.size])
              } else {
                """{"done":true,"status":"done"}"""
              }
            }

            "wizard.cancel" -> {
              """{"done":true,"status":"cancelled"}"""
            }

            else -> {
              error("Unexpected request: $method")
            }
          }
        },
      )
    val owner = ProviderAuthController(scope, lease, "writer", Json) { authChanged = true }
    controller = owner
    compose.setContent {
      ClawDesignTheme { ProviderSignInDialog(owner) {} }
    }
    compose.onNodeWithText("Fixture login").performScrollTo().performClick()

    sensitivities.forEachIndexed { index, sensitive ->
      compose.onNodeWithText("Step $index").assertIsDisplayed()
      val input =
        compose.onNode(
          SemanticsMatcher.keyIsDefined(SemanticsProperties.EditableText),
          useUnmergedTree = true,
        )
      input.assert(
        if (sensitive) {
          SemanticsMatcher.keyIsDefined(SemanticsProperties.Password)
        } else {
          SemanticsMatcher.keyNotDefined(SemanticsProperties.Password)
        },
      )
      // The new step starts empty, not with the previous step's answer.
      input.assertTextEquals("")
      input.performTextReplacement(values[index])
      val layouts = mutableListOf<TextLayoutResult>()
      input.performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
        assertTrue(it(layouts))
      }
      assertEquals(
        if (sensitive) "\u2022".repeat(values[index].length) else values[index],
        layouts
          .single()
          .layoutInput.text.text,
      )
      assertEquals(index, answers.size)
      assertFalse(authChanged)
      compose.onNodeWithText("Continue").performScrollTo().performClick()
      assertEquals("step-$index", answers[index].getValue("stepId").jsonPrimitive.content)
      assertEquals(values[index], answers[index].getValue("value").jsonPrimitive.content)
    }
    compose.onNodeWithText("Sign-in complete").assertIsDisplayed()
    assertTrue(authChanged)
    assertFalse(owner.state.value.signInActive)
  }

  private fun wizardStep(
    index: Int,
    sensitive: Boolean,
  ): String =
    buildJsonObject {
      put("done", false)
      put("status", "running")
      put(
        "step",
        buildJsonObject {
          put("id", "step-$index")
          put("type", "text")
          put("executor", "client")
          put("title", "Step $index")
          put("sensitive", sensitive)
          put("initialValue", "")
        },
      )
    }.toString()

  private companion object {
    const val AUTH_STATUS =
      """
      {
        "providers":[],
        "providerCapabilities":[{
          "provider":"fixture",
          "loginOptions":[{"id":"fixture/login","label":"Fixture login"}]
        }]
      }
      """
  }
}
