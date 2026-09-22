package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.AndroidClientDatabases
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ErrorCollector
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  qualifiers = "en-rUS-w360dp-h800dp-420dpi",
  instrumentedPackages = ["ai.openclaw.app.AndroidScreenshotFixture"],
)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatCompletedWorkLayoutTest {
  private val composeRule = createComposeRule()
  private val assertions = ErrorCollector()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var controller: ChatController
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null

  @Volatile private var historyResponse = HISTORY

  // Dispose Compose consumers before joining runtime cleanup, even on the negative baseline.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(assertions)
      .around(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
            } finally {
              try {
                if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
              } finally {
                try {
                  if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
                } finally {
                  AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
                  restoreAnimatorScale?.invoke()
                }
              }
            }
          }
        },
      ).around(composeRule)

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    val resolver = app.contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    restoreAnimatorScale = {
      Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val prefs = SecurePrefs(app, app.getSharedPreferences("completed-work-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    drainWithMainLooper {
      ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases").clientStateDatabase()
    }
    controller = ReflectionHelpers.getField(runtime, "chat")
    val requestField = ChatController::class.java.getDeclaredField("requestGatewayForGateway").apply { isAccessible = true }

    @Suppress("UNCHECKED_CAST")
    val originalRequest = requestField.get(controller) as suspend (String, String, String?) -> String
    val request: suspend (String, String, String?) -> String = { gatewayId, method, params ->
      when {
        method == "chat.history" &&
          Json
            .parseToJsonElement(checkNotNull(params))
            .jsonObject["sessionKey"]
            ?.jsonPrimitive
            ?.content == SESSION -> historyResponse

        method == "chat.history" &&
          Json
            .parseToJsonElement(checkNotNull(params))
            .jsonObject["sessionKey"]
            ?.jsonPrimitive
            ?.content == OTHER_SESSION -> OTHER_HISTORY

        method == "question.list" -> """{"questions":[]}"""

        else -> originalRequest(gatewayId, method, params)
      }
    }
    requestField.set(controller, request)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("chat", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    // Select through the real owner rather than changing the shared screenshot session constant.
    model.switchChatSession(SESSION, "main")
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.size(width = 360.dp, height = 800.dp).background(ClawTheme.colors.canvas).clipToBounds()) {
          ChatScreen(
            viewModel = model,
            talkActive = false,
            showSidebarButton = true,
            onOpenSidebar = {},
            onToggleTalk = {},
            onOpenDashboard = {},
            onOpenGatewaySettings = {},
          )
        }
      }
    }
    composeRule.waitUntil {
      // IO publications reach the ViewModel bridges through Android Main.
      composeRule.runOnIdle {
        model.chatSessionKey.value == SESSION && !model.chatHistoryLoading.value &&
          model.chatHealthOk.value && model.chatMessages.value.size == 5 && runtime.pendingRunCount.value == 0
      }
    }
  }

  @Test
  fun completedDashboardWorkHidesMixedCommentaryUntilExpanded() {
    composeRule.runOnIdle {
      val messages = model.chatMessages.value
      assertEquals(listOf("user", "assistant", "assistant", "toolresult", "assistant"), messages.map { it.role })
      assertEquals(listOf("text", "toolCall"), messages[2].content.map { it.type })
      assertEquals(
        "check-dashboard",
        messages[2]
          .content
          .last()
          .toolActivity
          ?.toolCallId,
      )
      assertEquals(
        "check-dashboard",
        messages[3]
          .content
          .single()
          .toolActivity
          ?.toolCallId,
      )
      assertEquals(
        OUTPUT,
        messages[3]
          .content
          .single()
          .toolActivity
          ?.result,
      )
    }
    val worked = composeRule.onNode(hasText(nativeString("Worked for \$duration", "4s")) and hasClickAction())
    val command = composeRule.onNode(hasText(COMMAND) and hasClickAction())

    // Collect assertion failures so the original defect still produces both disclosure captures.
    capture("collapsed")
    assertions.checkSucceeds {
      composeRule.onNodeWithText(FINAL).assertIsDisplayed()
      worked.assertIsDisplayed().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
      composeRule.onNodeWithText(MIXED, useUnmergedTree = true).assertDoesNotExist()
      composeRule.onNodeWithText(EARLIER, useUnmergedTree = true).assertDoesNotExist()
      composeRule.onNodeWithText(COMMAND, useUnmergedTree = true).assertDoesNotExist()
    }

    worked.performClick()
    capture("expanded")
    assertions.checkSucceeds {
      worked.assertIsDisplayed().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
      composeRule.onNodeWithText(EARLIER).assertIsDisplayed()
      composeRule.onNodeWithText(MIXED).assertIsDisplayed()
      command.assertIsDisplayed()
      composeRule.onNodeWithText(FINAL).assertIsDisplayed()
    }
    command.performClick()
    capture("command-output")
    assertions.checkSucceeds { composeRule.onNodeWithText(OUTPUT).assertIsDisplayed() }
    command.performClick()

    worked.performClick()
    capture("collapsed-again")
    assertions.checkSucceeds {
      composeRule.onNodeWithText(FINAL).assertIsDisplayed()
      worked.assertIsDisplayed().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
      composeRule.onNodeWithText(MIXED, useUnmergedTree = true).assertDoesNotExist()
      composeRule.onNodeWithText(EARLIER, useUnmergedTree = true).assertDoesNotExist()
      composeRule.onNodeWithText(COMMAND, useUnmergedTree = true).assertDoesNotExist()
      composeRule.onNodeWithText(OUTPUT, useUnmergedTree = true).assertDoesNotExist()
    }
  }

  @Test
  fun hiddenInputTurnsKeepTheirOwnFinalReplies() {
    historyResponse = HIDDEN_TURNS_HISTORY
    composeRule.runOnIdle { model.refreshChat() }
    composeRule.waitUntil {
      composeRule.runOnIdle {
        !model.chatHistoryLoading.value && model.chatMessages.value.size == 4 &&
          model.chatMessages.value
            .last()
            .content
            .singleOrNull()
            ?.text == SECOND_FINAL
      }
    }
    capture("hidden-turns")
    assertions.checkSucceeds {
      composeRule.onNodeWithText(FIRST_FINAL).assertIsDisplayed()
      composeRule.onNodeWithText(SECOND_FINAL).assertIsDisplayed()
      composeRule.onNode(hasText(nativeString("Worked for \$duration", "2s")) and hasClickAction()).assertIsDisplayed()
      composeRule.onNode(hasText(nativeString("Worked for \$duration", "5s")) and hasClickAction()).assertIsDisplayed()
    }
  }

  @Test
  fun earlierTextAndToolResultReplacementRefreshesAnUnchangedTail() {
    val original = composeRule.runOnIdle { model.chatMessages.value }
    val worked = composeRule.onNode(hasText(nativeString("Worked for \$duration", "4s")) and hasClickAction())
    val command = composeRule.onNode(hasText(COMMAND) and hasClickAction())
    worked.performClick()
    command.performClick()
    composeRule.onNodeWithText(OUTPUT).assertIsDisplayed()
    capture("replacement-before")

    val response = Json.parseToJsonElement(HISTORY).jsonObject
    val revised =
      response.getValue("messages").jsonArray.mapIndexed { index, message ->
        when (index) {
          1 -> JsonObject(message.jsonObject + ("content" to JsonPrimitive(REVISED_EARLIER)))
          3 -> JsonObject(message.jsonObject + ("content" to JsonPrimitive(REVISED_OUTPUT)))
          else -> message
        }
      }
    historyResponse = JsonObject(response + ("messages" to JsonArray(revised))).toString()
    composeRule.runOnIdle { model.refreshChat() }
    composeRule.waitUntil {
      composeRule.runOnIdle {
        !model.chatHistoryLoading.value &&
          model.chatMessages.value
            .getOrNull(1)
            ?.content
            ?.singleOrNull()
            ?.text == REVISED_EARLIER &&
          model.chatMessages.value
            .getOrNull(3)
            ?.content
            ?.singleOrNull()
            ?.toolActivity
            ?.result == REVISED_OUTPUT
      }
    }
    composeRule.runOnIdle {
      val replacement = model.chatMessages.value
      assertEquals(original.map { it.id }, replacement.map { it.id })
      assertEquals(original.map { it.entryId }, replacement.map { it.entryId })
      assertEquals(original.size, replacement.size)
      assertEquals(original.last(), replacement.last())
    }
    capture("replacement-after")
    worked.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
    composeRule.onNodeWithText(REVISED_EARLIER).assertIsDisplayed()
    composeRule.onNodeWithText(REVISED_OUTPUT).assertIsDisplayed()
    composeRule.onNodeWithText(EARLIER, useUnmergedTree = true).assertDoesNotExist()
    composeRule.onNodeWithText(OUTPUT, useUnmergedTree = true).assertDoesNotExist()
    composeRule.onNodeWithText(FINAL).assertIsDisplayed()
  }

  @Test
  fun earlierCompletedDisclosureSurvivesLaterLiveUpdates() {
    val response = Json.parseToJsonElement(HISTORY).jsonObject
    val nextUser =
      Json.parseToJsonElement(
        """{"role":"user","content":"Check the next item.","timestamp":1783555005000,"__openclaw":{"id":"next-user"}}""",
      )
    historyResponse =
      JsonObject(response + ("messages" to JsonArray(response.getValue("messages").jsonArray + nextUser))).toString()
    composeRule.runOnIdle { model.refreshChat() }
    composeRule.waitUntil {
      composeRule.runOnIdle { !model.chatHistoryLoading.value && model.chatMessages.value.size == 6 }
    }
    val workedMatcher = hasText(nativeString("Worked for \$duration", "4s")) and hasClickAction()
    composeRule.onNode(workedMatcher).performClick()
    for (text in listOf("Checking next.", "Checking the next result.")) {
      composeRule.runOnIdle {
        controller.handleGatewayEvent("agent", """{"sessionKey":"$SESSION","stream":"assistant","data":{"text":"$text"}}""")
        controller.handleGatewayEvent(
          "agent",
          """{"sessionKey":"$SESSION","stream":"tool","data":{"phase":"start","name":"read","toolCallId":"next-tool"}}""",
        )
      }
      composeRule.waitUntil {
        composeRule.runOnIdle { model.chatStreamingAssistantText.value == text && model.chatPendingToolCalls.value.size == 1 }
      }
      composeRule.onNode(hasScrollToIndexAction()).performScrollToNode(workedMatcher)
      composeRule.onNode(workedMatcher).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
      composeRule.onNodeWithText(EARLIER).assertIsDisplayed()
    }
    capture("earlier-expanded-during-stream")
    composeRule.onNode(workedMatcher).performClick()
    composeRule.onNode(workedMatcher).assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
    composeRule.onNodeWithText(EARLIER, useUnmergedTree = true).assertDoesNotExist()
  }

  @Test
  fun sessionSwitchResetsDisclosureEvenWhenHistoryKeysMatch() {
    val worked = composeRule.onNode(hasText(nativeString("Worked for \$duration", "4s")) and hasClickAction())
    worked.performClick()
    worked.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Expanded")))
    for (session in listOf(OTHER_SESSION, SESSION)) {
      composeRule.runOnIdle { model.switchChatSession(session, "main") }
      composeRule.waitUntil {
        composeRule.runOnIdle {
          model.chatSessionKey.value == session && !model.chatHistoryLoading.value &&
            model.chatMessages.value.size == 5 && model.chatMessages.value
              .last()
              .entryId == "work-final"
        }
      }
      worked.assertIsDisplayed().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, nativeString("Collapsed")))
      composeRule.onNodeWithText(FINAL).assertIsDisplayed()
      composeRule.onNodeWithText(EARLIER, useUnmergedTree = true).assertDoesNotExist()
    }
    capture("session-disclosure-reset")
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_CHAT_WORK_PROOF_DIR") ?: return
    val folder = File(directory)
    check(folder.isDirectory || folder.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture the whole ChatScreen, not an empty node", image.width > 0 && image.height > 0)
    File(folder, "$name.png").outputStream().use {
      assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it))
    }
  }

  private companion object {
    const val SESSION = "agent:main:dashboard:completed-work-proof"
    const val OTHER_SESSION = "agent:main:dashboard:completed-work-other"
    const val EARLIER = "I will check the dashboard."
    const val MIXED = "I am checking the build status."
    const val COMMAND = "printf dashboard-ready"
    const val OUTPUT = "dashboard-ready"
    const val REVISED_EARLIER = "I checked the dashboard configuration."
    const val REVISED_OUTPUT = "dashboard-rechecked"
    const val FINAL = "The dashboard is ready."
    const val FIRST_FINAL = "The first check is complete."
    const val SECOND_FINAL = "The second check is complete."
    val HIDDEN_TURNS_HISTORY =
      """
      {
        "sessionId":"completed-work-proof",
        "messages":[
          {"role":"toolResult","toolCallId":"hidden-1","toolName":"read","content":"First report","timestamp":1783555000000,"__openclaw":{"id":"hidden-work-1","turnBoundary":true}},
          {"role":"assistant","content":"$FIRST_FINAL","timestamp":1783555002000,"__openclaw":{"id":"hidden-final-1"}},
          {"role":"toolResult","toolCallId":"hidden-2","toolName":"read","content":"Second report","timestamp":1783555003000,"__openclaw":{"id":"hidden-work-2","turnBoundary":true}},
          {"role":"assistant","content":"$SECOND_FINAL","timestamp":1783555008000,"__openclaw":{"id":"hidden-final-2"}}
        ]
      }
      """.trimIndent()
    val HISTORY =
      """
      {
        "sessionId":"completed-work-proof",
        "sessionInfo":{"key":"$SESSION","sessionId":"completed-work-proof","displayName":"Dashboard check","ownerAgentId":"main","archived":false},
        "messages":[
          {"role":"user","content":"Check the dashboard status.","timestamp":1783555000000,"__openclaw":{"id":"work-user"}},
          {"role":"assistant","content":"$EARLIER","timestamp":1783555001000,"idempotencyKey":"work-earlier:assistant","__openclaw":{"id":"work-earlier"}},
          {
            "role":"assistant","timestamp":1783555002000,"__openclaw":{"id":"work-mixed"},
            "content":[
              {"type":"text","text":"$MIXED"},
              {"type":"toolCall","id":"check-dashboard","name":"exec","arguments":{"command":"$COMMAND"}}
            ]
          },
          {"role":"toolResult","toolCallId":"check-dashboard","toolName":"exec","content":"$OUTPUT","timestamp":1783555002500,"__openclaw":{"id":"work-result"}},
          {"role":"assistant","content":"$FINAL","timestamp":1783555004000,"__openclaw":{"id":"work-final"}}
        ]
      }
      """.trimIndent()
    val OTHER_HISTORY =
      Json.parseToJsonElement(HISTORY).jsonObject.let { history ->
        JsonObject(
          history +
            mapOf(
              "sessionId" to JsonPrimitive("completed-work-other"),
              "sessionInfo" to
                JsonObject(
                  history.getValue("sessionInfo").jsonObject +
                    mapOf("key" to JsonPrimitive(OTHER_SESSION), "sessionId" to JsonPrimitive("completed-work-other")),
                ),
            ),
        ).toString()
      }
  }
}
