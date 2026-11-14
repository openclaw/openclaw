package ai.openclaw.app.chat

import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionListResult
import ai.openclaw.app.gateway.QuestionRecord
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatDesktopHandoffTest {
  private val questionJson =
    """{
        "questionId":"required_action",
        "header":"Manual step",
        "question":"Complete the visible manual step, then return for a fresh check.",
        "desktop":{"source":{"kind":"environment","environmentId":"desktop-proof"}},
        "options":[{"label":"Ready to recheck"},{"label":"Stop this task"}],
        "isOther":false
      }"""
  private val question = Json.decodeFromString<Question>(questionJson)

  private val record =
    QuestionRecord(
      id = "handoff-request",
      questions = listOf(question),
      sessionKey = "agent:main:task",
      agentId = "main",
      runId = "original-run",
      createdAtMs = 1,
      expiresAtMs = Long.MAX_VALUE,
      status = "pending",
    )

  @Test
  fun onlyLiveTaskBoundQuestionsOfferTheExactDesktop() {
    val prompt = ChatQuestionPrompt(record)
    assertEquals(
      "desktop-proof",
      prompt
        .desktopHandoffQuestion()
        ?.desktop
        ?.source
        ?.environmentId,
    )
    assertNotNull(prompt.copy(submitting = true).desktopHandoffQuestion())
    for (status in listOf("answered", "cancelled", "expired")) {
      assertNull(ChatQuestionPrompt(record.copy(status = status)).desktopHandoffQuestion())
    }
    for (unbound in listOf(record.copy(sessionKey = null), record.copy(runId = null), record.copy(expiresAtMs = 0))) {
      assertNull(ChatQuestionPrompt(unbound).desktopHandoffQuestion())
    }
    assertNull(prompt.copy(recoveryUnavailable = true).desktopHandoffQuestion())
    assertNull(ChatQuestionPrompt(record.copy(questions = listOf(question.copy(desktop = null)))).desktopHandoffQuestion())
  }

  @Test
  fun replacingTheDesktopRejectsOldCallbacksAndOnlyExplicitSubmissionResolvesTheRequest() =
    runTest {
      val json = chatControllerTestJson
      var pending = record
      val (controller, requests) =
        chatControllerTestSetup {
          respond("question.list") { json.encodeToString(QuestionListResult(listOf(pending))) }
          respond("question.resolve", """{"status":"answered","answers":{"answers":{"required_action":["Ready to recheck"]}}}""")
        }
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      val oldPresentation = controller.questions.value.single()
      pending = record.copy(questions = listOf(Json.decodeFromString<Question>(questionJson.replace("desktop-proof", "replacement-proof"))))
      controller.handleGatewayEvent("question.requested", json.encodeToString(pending))
      runCurrent()
      controller.resolveQuestion(oldPresentation, mapOf("required_action" to listOf("Ready to recheck")))
      runCurrent()
      assertTrue(requests.none { it.first == "question.resolve" })
      val current = controller.questions.value.single()
      assertEquals(
        "replacement-proof",
        current
          .desktopHandoffQuestion()
          ?.desktop
          ?.source
          ?.environmentId,
      )
      controller.resolveQuestion(current, mapOf("required_action" to listOf("Ready to recheck")))
      runCurrent()
      assertEquals(1, requests.count { it.first == "question.resolve" })
      assertEquals(
        ChatQuestionStatus.Answered,
        controller.questions.value
          .single()
          .status(),
      )
      controller.onGatewayScopeChanging()
    }
}
