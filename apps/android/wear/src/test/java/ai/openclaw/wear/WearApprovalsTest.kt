package ai.openclaw.wear

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WearApprovalsTest {
  @Test
  fun canonicalReplayIncludesExecPluginAndSystemAgentWithoutLegacyPayloads() {
    val feed = WearApprovalFeed()
    feed.begin()
    assertTrue(feed.replay(replay("session", listOf("exec", "plugin", "system-agent").map { approval(it) })))
    assertEquals(setOf("exec", "plugin", "system-agent"), feed.approvals.map { it.kind }.toSet())
    assertTrue(feed.approvals.all { it.canResolve("allow-once", 1) })
    assertTrue(
      feed.approvals
        .first { it.kind == "exec" }
        .details
        .any { it.value == "printf approved" },
    )
    assertTrue(
      feed.approvals
        .first { it.kind == "plugin" }
        .details
        .any { it.value == "Approve publication" },
    )
    assertTrue(
      feed.approvals
        .first { it.kind == "system-agent" }
        .details
        .any { it.value == "a".repeat(64) },
    )
  }

  @Test
  fun liveTerminalWinsOverPendingReplayEvenWithEqualTimestamps() {
    val feed = WearApprovalFeed()
    feed.begin()
    feed.accept(WearApprovalTransition("session", 10, parseWearApproval(approval("exec", "denied"))!!))
    assertTrue(feed.replay(replay("session", listOf(approval("exec")))))
    assertEquals("denied", feed.approvals.single().status)
    feed.accept(WearApprovalTransition("session", 9, parseWearApproval(approval("exec"))!!))
    assertEquals("denied", feed.approvals.single().status)
  }

  @Test
  fun replayFiltersOtherAudiencesAndDoesNotInventCompleteInboxWhenTruncated() {
    val feed = WearApprovalFeed()
    feed.begin()
    feed.accept(WearApprovalTransition("other-session", 11, parseWearApproval(approval("plugin"))!!))
    assertTrue(feed.replay(replay("session", listOf(approval("exec")), truncated = true)))
    assertEquals(listOf("exec"), feed.approvals.map { it.kind })
    assertTrue(feed.incomplete)
  }

  @Test
  fun livePendingOverflowIsVisibleAfterCompleteReplayAndResetsWithNewSnapshot() {
    val feed = WearApprovalFeed()
    feed.begin()
    assertTrue(feed.replay(replay("session", emptyList())))
    repeat(51) { index ->
      feed.accept(WearApprovalTransition("session", 11L + index, parseWearApproval(approval("exec", id = "pending-$index"))!!))
      assertEquals(index >= 50, feed.incomplete)
    }
    assertEquals(50, feed.approvals.size)
    assertTrue(feed.ready)
    feed.begin()
    assertTrue(feed.replay(replay("session", listOf(approval("exec")))))
    assertFalse(feed.incomplete)
  }

  @Test
  fun retainedTerminalTransitionsCannotCrowdOutPendingApprovalsOrRevive() {
    val feed = WearApprovalFeed()
    feed.begin()
    assertTrue(feed.replay(replay("session", emptyList())))
    repeat(50) { index ->
      feed.accept(WearApprovalTransition("session", 11, parseWearApproval(approval("exec", "denied", "terminal-$index"))!!))
    }
    feed.accept(WearApprovalTransition("session", 12, parseWearApproval(approval("plugin", id = "pending"))!!))
    assertEquals("pending", feed.approvals.first().id)
    assertTrue(feed.incomplete)
    feed.accept(WearApprovalTransition("session", 13, parseWearApproval(approval("exec", id = "terminal-0"))!!))
    assertEquals(listOf("pending"), feed.approvals.filter { it.status == "pending" }.map { it.id })
  }

  @Test
  fun oversizedReviewIsNotSilentlyTruncatedIntoActionableApproval() {
    val oversized = approval("exec").toMutableMap()
    oversized["presentation"] =
      buildJsonObject {
        put("kind", "exec")
        put("commandText", "x".repeat(20_001))
        put("allowedDecisions", Json.parseToJsonElement("""["allow-once","deny"]"""))
      }
    val parsed = parseWearApproval(JsonObject(oversized))!!
    assertFalse(parsed.canResolve("allow-once", 1))
    assertTrue(parsed.canResolve("deny", 1))
    assertNull(parseWearApproval(Json.parseToJsonElement("""{"id":"legacy","request":{"command":"printf hidden"}}""")))
  }

  @Test
  fun malformedOwnerOrDecisionsCannotBecomeAnApprovalAction() {
    val unknown = approval("exec").toMutableMap()
    unknown["presentation"] = Json.parseToJsonElement("""{"kind":"future","allowedDecisions":["allow-once","deny"]}""")
    assertNull(parseWearApproval(JsonObject(unknown)))
    unknown["presentation"] = Json.parseToJsonElement("""{"kind":"exec","commandText":"printf nope","allowedDecisions":["unknown","deny"]}""")
    assertNull(parseWearApproval(JsonObject(unknown)))
  }

  @Test
  fun canonicalScopeTermsRemainVisibleWithoutRawJson() {
    val scopes =
      listOf(
        """{"kind":"message-send","target":"mail","recipientCount":2,"recipients":["a@example.com","b@example.com"],"audience":"external"}""" to
          listOf("mail", "2", "a@example.com", "b@example.com"),
        """{"kind":"payment","amount":"12.50","currency":"USD","target":"Example vendor"}""" to
          listOf("12.50", "USD", "Example vendor"),
        """{"kind":"external-post","target":"Public announcement","visibility":"public"}""" to
          listOf("Public announcement"),
        """{"kind":"standing-grant","automation":"Scheduled report","command":"printf report","expiresInDays":7}""" to
          listOf("Scheduled report", "printf report", "7"),
      )
    for ((scope, terms) in scopes) {
      val parsed = withContext("scope", scope)
      assertTrue(parsed.canResolve("allow-once", 1))
      assertTrue(parsed.details.map { it.value }.containsAll(terms))
      assertFalse(parsed.details.any { it.value.startsWith("{") })
    }
    val standing = withContext("scope", """{"kind":"standing-grant","automation":"Report","command":"printf report"}""")
    assertTrue(standing.details.any { it.label == R.string.watch_scope_expiry_until_revoked })
  }

  @Test
  fun malformedOptionalContextBlocksAllowButPreservesOfferedDeny() {
    val contexts =
      listOf(
        "scope" to "null",
        "scope" to """{"kind":"unknown","target":"hidden"}""",
        "scope" to """{"kind":"payment","amount":12.50,"currency":"USD","target":"vendor"}""",
        "scope" to """{"kind":"message-send","target":"mail","recipientCount":"2"}""",
        "scope" to """{"kind":"message-send","target":"mail","recipientCount":2,"recipients":[false]}""",
        "scope" to """{"kind":"message-send","target":"mail","recipientCount":2,"audience":"unknown"}""",
        "scope" to """{"kind":"external-post","target":"message","visibility":"public","newDecisionContext":true}""",
        "scope" to """{"kind":"standing-grant","automation":"job","command":"printf job","expiresInDays":null}""",
        "externalResolution" to "null",
        "externalResolution" to """{"label":"Verified","decisions":["deny"]}""",
        "agentId" to "42",
        "detail" to "false",
        "newDecisionContext" to """{"permission":"unknown"}""",
      )
    for ((key, raw) in contexts) {
      val parsed = withContext(key, raw)
      assertFalse("$key=$raw", parsed.canResolve("allow-once", 1))
      assertTrue("$key=$raw", parsed.canResolve("deny", 1))
      assertEquals(R.string.watch_approval_context_invalid, parsed.reviewIssue)
    }
    assertTrue(withContext("agentId", "null").canResolve("allow-once", 1))
  }

  @Test
  fun allowOnlyExternalVerificationAndOfferedDecisionsAreNotRewritten() {
    val parsed = withContext("externalResolution", """{"label":"I verified publication","decisions":["allow-once"]}""")
    assertTrue(parsed.canResolve("allow-once", 1))
    assertEquals(listOf("allow-once"), parsed.externalResolution?.decisions)
    assertEquals("I verified publication", parsed.externalResolution?.label)

    val allowOnly = withContext("allowedDecisions", """["allow-once"]""")
    assertTrue(allowOnly.canResolve("allow-once", 1))
    assertFalse(allowOnly.canResolve("deny", 1))
    assertEquals(listOf("allow-once"), allowOnly.decisions)
  }

  @Test
  fun externalResolutionChoicesAreIndependentOfOrdinaryDecisions() {
    for (decisions in listOf(listOf("allow-once", "deny"), listOf("deny"))) {
      val parsed =
        withPresentation(
          "allowedDecisions" to JsonArray(decisions.map(::JsonPrimitive)),
          "externalResolution" to
            Json.parseToJsonElement(
              """{"label":"Verify in the publication service","decisions":["allow-once","allow-always"]}""",
            ),
        )
      assertNull(parsed.reviewIssue)
      assertEquals(decisions, parsed.decisions)
      assertEquals("Verify in the publication service", parsed.externalResolution?.label)
      assertEquals(listOf("allow-once", "allow-always"), parsed.externalResolution?.decisions)
      assertEquals("allow-once" in decisions, parsed.canResolve("allow-once", 1))
      assertFalse(parsed.canResolve("allow-always", 1))
      assertTrue(parsed.canResolve("deny", 1))
    }
  }

  @Test
  fun presentationAndScopeFieldLimitsCountCodePointsWithoutTruncating() {
    val astral = String(Character.toChars(0x1F680))
    val cases: List<Pair<Int, (String) -> Pair<String, JsonElement>>> =
      listOf(
        80 to { text -> "title" to JsonPrimitive(text) },
        512 to { text -> "description" to JsonPrimitive(text) },
        1024 to { text -> "agentId" to JsonPrimitive(text) },
        128 to { text ->
          "scope" to
            buildJsonObject {
              put("kind", "external-post")
              put("target", text)
              put("visibility", "public")
            }
        },
        128 to { text ->
          "scope" to
            buildJsonObject {
              put("kind", "message-send")
              put("target", "mail")
              put("recipientCount", 1)
              put("recipients", JsonArray(listOf(JsonPrimitive(text))))
            }
        },
      )
    for ((limit, field) in cases) {
      val text = astral.repeat(limit)
      val accepted = withPresentation(field(text))
      assertNull(accepted.reviewIssue)
      assertTrue(accepted.canResolve("allow-once", 1))
      assertTrue(accepted.title == text || accepted.details.any { it.value == text })
      val rejected = withPresentation(field(text + astral))
      assertEquals(R.string.watch_approval_context_invalid, rejected.reviewIssue)
      assertFalse(rejected.canResolve("allow-once", 1))
      assertTrue(rejected.canResolve("deny", 1))
    }
  }

  @Test
  fun externalLabelAcceptsEightyAstralCodePointsButNotEightyOne() {
    val astral = String(Character.toChars(0x1F680))
    for (length in listOf(80, 81)) {
      val label = astral.repeat(length)
      val parsed =
        withPresentation(
          "externalResolution" to
            buildJsonObject {
              put("label", label)
              put("decisions", JsonArray(listOf(JsonPrimitive("allow-once"))))
            },
        )
      assertEquals(length == 80, parsed.canResolve("allow-once", 1))
      assertTrue(parsed.canResolve("deny", 1))
      if (length == 80) {
        assertEquals(label, parsed.externalResolution?.label)
      } else {
        assertEquals(R.string.watch_approval_context_invalid, parsed.reviewIssue)
      }
    }
  }

  @Test
  fun aggregateReviewBudgetStillCountsUtf16AndNeverEnablesTruncatedAllow() {
    val astral = String(Character.toChars(0x1F680))
    for (commandLength in listOf(4000, 6000)) {
      val value = approval("exec").toMutableMap()
      value["presentation"] =
        buildJsonObject {
          put("kind", "exec")
          put("commandText", astral.repeat(commandLength))
          put("warningText", astral.repeat(5000))
          put("allowedDecisions", Json.parseToJsonElement("""["allow-once","deny"]"""))
        }
      val parsed = parseWearApproval(JsonObject(value))!!
      assertEquals(commandLength == 4000, parsed.canResolve("allow-once", 1))
      assertTrue(parsed.canResolve("deny", 1))
      if (commandLength == 6000) {
        assertEquals(R.string.watch_approval_too_large, parsed.reviewIssue)
        assertTrue(parsed.details.isEmpty())
      }
    }
  }

  @Test
  fun canonicalReadbackCanMatchReviewWithoutSessionDeliveryAttribution() {
    val live = approval("plugin").toMutableMap()
    live["sourceSessionKey"] = kotlinx.serialization.json.JsonPrimitive("child-session")
    val reviewed = parseWearApproval(JsonObject(live))!!
    assertTrue(reviewed.sameReview(parseWearApproval(approval("plugin"))!!))
    assertFalse(reviewed.sameReview(withContext("description", "\"Changed publication\"")))
  }

  private fun withContext(
    key: String,
    raw: String,
  ): WearApproval = withPresentation(key to Json.parseToJsonElement(raw))

  private fun withPresentation(vararg fields: Pair<String, JsonElement>): WearApproval {
    val value = approval("plugin").toMutableMap()
    val presentation = value.getValue("presentation").jsonObject.toMutableMap()
    presentation.putAll(fields)
    value["presentation"] = JsonObject(presentation)
    return parseWearApproval(JsonObject(value))!!
  }

  private fun replay(
    session: String,
    entries: List<JsonObject>,
    truncated: Boolean = false,
  ): JsonObject =
    buildJsonObject {
      put("sessionKey", session)
      put("updatedAtMs", 10)
      put("approvals", JsonArray(entries))
      put("truncated", truncated)
    }

  private fun approval(
    kind: String,
    status: String = "pending",
    id: String = kind,
  ): JsonObject {
    val presentation =
      when (kind) {
        "exec" -> """{"kind":"exec","commandText":"printf approved","warningText":"Check the command","allowedDecisions":["allow-once","deny"]}"""
        "plugin" -> """{"kind":"plugin","title":"Publish","description":"Approve publication","severity":"warning","detail":"Visible text","allowedDecisions":["allow-once","deny"]}"""
        else -> """{"kind":"system-agent","title":"Update","description":"Approve system change","proposalHash":"${"a".repeat(64)}","allowedDecisions":["allow-once","deny"]}"""
      }
    return buildJsonObject {
      put("id", id)
      put("status", status)
      put("createdAtMs", 1)
      put("expiresAtMs", 100_000)
      put("urlPath", "/approvals/$kind")
      put("presentation", Json.parseToJsonElement(presentation))
      if (status == "denied") {
        put("decision", "deny")
        put("resolvedAtMs", 10)
        put("reason", "operator")
      }
    }
  }
}
