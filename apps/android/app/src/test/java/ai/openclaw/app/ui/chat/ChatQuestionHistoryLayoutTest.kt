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
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionAnswers
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionOption
import ai.openclaw.app.gateway.QuestionRecord
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
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
class ChatQuestionHistoryLayoutTest {
  private val composeRule = createComposeRule()
  private val assertions = ErrorCollector()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null

  @Volatile private var questionRecords = emptyList<QuestionRecord>()
  private lateinit var controller: ChatController

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
    val prefs = SecurePrefs(app, app.getSharedPreferences("question-history-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    drainWithMainLooper {
      ReflectionHelpers.getField<AndroidClientDatabases>(runtime, "clientDatabases").clientStateDatabase()
    }
    controller = ReflectionHelpers.getField<ChatController>(runtime, "chat")
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
            ?.content == SESSION -> HISTORY

        method == "question.list" -> Json.encodeToString(QuestionListResult(questionRecords))

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
          model.chatHealthOk.value && model.chatMessages.value.size == 3 && runtime.pendingRunCount.value == 0
      }
    }
  }

  // Protect the rendered history ordering, not only the timeline projection. The old
  // reverse-layout prefix leaves the answer below both newer bubbles; unit ordering
  // tests alone cannot prove the real screen actually displays the corrected order.
  @Test
  fun answeredQuestionStaysAboveLaterMessages() {
    val pending = question()
    publishQuestion(pending, "question.requested")
    publishQuestion(pending.copy(status = "answered", answers = QuestionAnswers(mapOf("visibility" to listOf(ANSWER)))), "question.resolved")
    scrollToLatest()
    capture("answered-history")
    assertions.checkSucceeds {
      val answer =
        composeRule
          .onNodeWithText(ANSWER)
          .assertIsDisplayed()
          .fetchSemanticsNode()
          .boundsInRoot
      val laterUser =
        composeRule
          .onNodeWithText(LATER_USER)
          .assertIsDisplayed()
          .fetchSemanticsNode()
          .boundsInRoot
      val laterAssistant =
        composeRule
          .onNodeWithText(LATER_ASSISTANT)
          .assertIsDisplayed()
          .fetchSemanticsNode()
          .boundsInRoot
      assertTrue("The answered card belongs before the later user message", answer.bottom <= laterUser.top)
      assertTrue("The newer assistant reply follows the user message", laterUser.bottom <= laterAssistant.top)
      composeRule.onNodeWithText("Submit").assertDoesNotExist()
    }
  }

  @Test
  fun pendingQuestionRemainsActionableAtLatestEdge() {
    publishQuestion(question(), "question.requested")
    scrollToLatest()
    composeRule.onNodeWithText(ANSWER).assertIsDisplayed().performClick()
    composeRule.onNode(hasText("Submit") and hasClickAction()).assertIsDisplayed().assertIsEnabled()
    capture("pending-question")
    composeRule.runOnIdle {
      assertEquals(
        "pending",
        controller.questions.value
          .single()
          .record.status,
      )
      assertTrue(
        controller.questions.value
          .single()
          .draft.selectedOptions
          .isNotEmpty(),
      )
    }
  }

  private fun question() =
    QuestionRecord(
      id = "history-question",
      questions = listOf(Question("visibility", "Button test", "Can you select this button?", listOf(QuestionOption(ANSWER)), isOther = false)),
      agentId = "main",
      sessionKey = SESSION,
      createdAtMs = 1783555001000,
      expiresAtMs = System.currentTimeMillis() + 600_000,
      status = "pending",
    )

  private fun publishQuestion(
    record: QuestionRecord,
    event: String,
  ) {
    questionRecords = listOf(record)
    composeRule.runOnIdle { controller.handleGatewayEvent(event, Json.encodeToString(record)) }
    composeRule.waitUntil {
      composeRule.runOnIdle {
        model.chatQuestions.value
          .singleOrNull()
          ?.record == record
      }
    }
  }

  private fun scrollToLatest() {
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToIndex(0)
    composeRule.waitForIdle()
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_CHAT_QUESTION_PROOF_DIR") ?: return
    val folder = File(directory)
    check(folder.isDirectory || folder.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture the whole ChatScreen, not an empty node", image.width > 0 && image.height > 0)
    File(folder, "$name.png").outputStream().use {
      assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it))
    }
  }

  private companion object {
    const val SESSION = "agent:main:dashboard:question-history-proof"
    const val ANSWER = "Yes, this button works"
    const val LATER_USER = "Continue the conversation."
    const val LATER_ASSISTANT = "The conversation has continued."
    val HISTORY =
      """
      {
        "sessionId":"question-history-proof",
        "sessionInfo":{"key":"$SESSION","sessionId":"question-history-proof","displayName":"Question history","ownerAgentId":"main","archived":false},
        "messages":[
          {"role":"user","content":"Show a practice question.","timestamp":1783555000000,"__openclaw":{"id":"question-user"}},
          {"role":"user","content":"$LATER_USER","timestamp":1783555003000,"__openclaw":{"id":"later-user"}},
          {"role":"assistant","content":"$LATER_ASSISTANT","timestamp":1783555004000,"__openclaw":{"id":"later-assistant"}}
        ]
      }
      """.trimIndent()
  }
}
