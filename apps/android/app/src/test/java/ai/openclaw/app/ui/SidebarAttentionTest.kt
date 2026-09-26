package ai.openclaw.app.ui

import ai.openclaw.app.chat.ChatQuestionDraft
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.gateway.Question
import ai.openclaw.app.gateway.QuestionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SidebarAttentionTest {
  @Test
  fun oldestRequestSelectsKindAndCountsOnlyDistinctRequestsOfThatKind() {
    val question = request("question", SidebarAttentionKind.Question, 10, count = 2)
    val approval = request("approval", SidebarAttentionKind.Approval, 5)
    val later = request("later", SidebarAttentionKind.Question, 20)
    val mixed = summarizeSidebarAttention(listOf(question, later, approval, question), "gateway-a")!!
    assertEquals(SidebarAttentionKind.Approval, mixed.first.kind)
    assertEquals(1, mixed.count)
    val questions = summarizeSidebarAttention(mixed.requests.filter { it.kind == SidebarAttentionKind.Question }, "gateway-a")!!
    assertEquals("question", questions.first.id)
    assertEquals(3, questions.count)
    assertEquals("+2 more", questions.more)
  }

  @Test
  fun disclosureIdentityKeepsSummaryUpdatesButRetiresReplacedRequestsAndGatewayScopes() {
    val first = request("question", SidebarAttentionKind.Question, 10, count = 2)
    val initial = summarizeSidebarAttention(listOf(first), "gateway-a")!!
    val background = request("approval", SidebarAttentionKind.Approval, 20)
    val updated = summarizeSidebarAttention(listOf(background, first.copy(preview = "Updated question", count = 3)), "gateway-a")!!
    assertEquals(initial.disclosureIdentity, updated.disclosureIdentity)
    assertEquals(3, updated.count)
    assertNotEquals(initial.disclosureIdentity, initial.copy(gatewayStableId = "gateway-b").disclosureIdentity)
    listOf(
      first.copy(id = "replacement"),
      first.copy(kind = SidebarAttentionKind.Approval),
      first.copy(sessionKey = "agent:main:another"),
      first.copy(createdAtMs = 30),
    ).forEach { replacement ->
      assertNotEquals(initial.disclosureIdentity, summarizeSidebarAttention(listOf(replacement), "gateway-a")!!.disclosureIdentity)
    }
  }

  @Test
  fun inactiveSessionPreviewUsesOnlyPendingQuestionCopyAndRetiresOnTerminalOrExpiry() {
    val record = QuestionRecord(id = "ask", sessionKey = "background", agentId = "work", createdAtMs = 10, expiresAtMs = 100, status = "pending", questions = listOf(Question(questionId = "q", header = "Header", question = "Which\n platform?", options = emptyList())))
    val prompt = ChatQuestionPrompt(record, draft = ChatQuestionDraft(otherText = mapOf("q" to "SECRET DRAFT")))
    val pending = sidebarAttentionRequests(listOf(prompt), emptyList(), "main", 50).single()
    assertEquals("agent:work:background", pending.sessionKey)
    assertEquals("Which platform?", pending.preview)
    assertFalse(pending.preview.contains("SECRET"))
    assertTrue(sidebarAttentionRequests(listOf(prompt), emptyList(), "main", 100).isEmpty())
    listOf("answered", "cancelled", "expired").forEach { terminal ->
      assertTrue(sidebarAttentionRequests(listOf(prompt.copy(record = record.copy(status = terminal))), emptyList(), "main", 50).isEmpty())
    }
    assertTrue(sidebarAttentionRequests(listOf(prompt.copy(record = record.copy(sessionKey = null))), emptyList(), "main", 50).isEmpty())
  }

  private fun request(
    id: String,
    kind: SidebarAttentionKind,
    createdAtMs: Long,
    count: Int = 1,
  ) = SidebarAttentionRequest(kind, id, "agent:main:background", "Preview question", count, createdAtMs)
}
