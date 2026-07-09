package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CronJobManagementTest {
  @Test
  fun parsesEveryClosedCronRunOutcome() {
    val started = parseGatewayCronRunOutcome(objectJson("""{"ok":true,"ran":true}"""))
    val queued =
      parseGatewayCronRunOutcome(
        objectJson("""{"ok":true,"enqueued":true,"runId":"run-1"}"""),
      )

    assertEquals(GatewayCronRunOutcome.Started(runId = null), started)
    assertEquals(GatewayCronRunOutcome.Started(runId = "run-1"), queued)
    mapOf(
      "not-due" to GatewayCronRunSkipReason.NotDue,
      "already-running" to GatewayCronRunSkipReason.AlreadyRunning,
      "restart-recovery-pending" to GatewayCronRunSkipReason.RestartRecoveryPending,
      "invalid-spec" to GatewayCronRunSkipReason.InvalidSpec,
      "stopped" to GatewayCronRunSkipReason.Stopped,
    ).forEach { (raw, reason) ->
      assertEquals(
        GatewayCronRunOutcome.Skipped(reason),
        parseGatewayCronRunOutcome(
          objectJson("""{"ok":true,"ran":false,"reason":"$raw"}"""),
        ),
      )
    }
    assertEquals(
      GatewayCronRunOutcome.Rejected,
      parseGatewayCronRunOutcome(objectJson("""{"ok":false}""")),
    )
    assertEquals(null, parseGatewayCronRunOutcome(objectJson("""{"ok":true,"ran":false,"reason":"future"}""")))
    assertEquals(null, parseGatewayCronRunOutcome(objectJson("""{"ok":true,"enqueued":true}""")))
  }

  @Test
  fun updatePatchIsMinimalAndClearsAgentOverridesWithNull() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    val initial = original.toCronJobEdit()
    val payload = initial.payload as GatewayCronPayloadEdit.AgentTurn
    val edit = initial.copy(payload = payload.copy(model = "", thinking = ""))

    val root = objectJson(buildCronUpdateParams(original = original, edit = edit))
    val patch = root.getValue("patch").jsonObject
    val payloadPatch = patch.getValue("payload").jsonObject

    assertEquals(setOf("payload"), patch.keys)
    assertEquals("agentTurn", payloadPatch.getValue("kind").jsonPrimitive.content)
    assertEquals(JsonNull, payloadPatch["model"])
    assertEquals(JsonNull, payloadPatch["thinking"])
    assertFalse(payloadPatch.containsKey("message"))
  }

  @Test
  fun intervalPatchPreservesAnchorAndOmitsUnchangedPayload() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(schedule = """{"kind":"every","everyMs":60000,"anchorMs":1000}"""),
        ),
      )
    val initial = original.toCronJobEdit()
    val schedule = initial.schedule as GatewayCronScheduleEdit.Every
    val edit = initial.copy(schedule = schedule.copy(everyMs = "120000"))

    val patch =
      objectJson(buildCronUpdateParams(original = original, edit = edit))
        .getValue("patch")
        .jsonObject
    val schedulePatch = patch.getValue("schedule").jsonObject

    assertEquals(setOf("schedule"), patch.keys)
    assertEquals("120000", schedulePatch.getValue("everyMs").jsonPrimitive.content)
    assertEquals("1000", schedulePatch.getValue("anchorMs").jsonPrimitive.content)
  }

  @Test
  fun commandArgvRejectsNonStringJsonPrimitives() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(payload = """{"kind":"command","argv":["echo"],"cwd":"/tmp"}"""),
        ),
      )
    val initial = original.toCronJobEdit()
    val payload = initial.payload as GatewayCronPayloadEdit.Command
    val edit = initial.copy(payload = payload.copy(argvJson = """["echo",1,true,null]"""))

    val error = runCatching { buildCronUpdateParams(original = original, edit = edit) }.exceptionOrNull()

    assertEquals("Command argv entries must be non-empty strings.", error?.message)
  }

  @Test
  fun historyParserRequiresTimestampAndKeepsUsefulFields() {
    val entries =
      Json
        .parseToJsonElement(
          """
          [
            {"ts":1000,"runId":"run-1","status":"ok","summary":"done","durationMs":42},
            {"runId":"missing-ts"}
          ]
          """.trimIndent(),
        ).jsonArray

    val runs = parseGatewayCronRunHistory(entries)

    assertEquals(1, runs.size)
    assertEquals("run-1", runs.single().runId)
    assertEquals(42L, runs.single().durationMs)
  }

  @Test
  fun detailAndHistoryGenerationsAdvanceIndependently() {
    val detailGuard = CronJobDetailRequestGuard()
    val historyGuard = CronJobDetailRequestGuard()
    val detailA = requireNotNull(detailGuard.begin("job-a"))
    val historyA = requireNotNull(historyGuard.begin("job-a"))
    val historyB = requireNotNull(historyGuard.begin("job-b"))
    var detailPublished = false
    var historyPublished = "none"

    assertTrue(detailGuard.publishIfCurrent(detailA) { detailPublished = true })
    assertFalse(historyGuard.publishIfCurrent(historyA) { historyPublished = "a" })
    assertTrue(historyGuard.publishIfCurrent(historyB) { historyPublished = "b" })
    assertTrue(detailPublished)
    assertEquals("b", historyPublished)
  }

  private fun objectJson(raw: String) = Json.parseToJsonElement(raw).jsonObject

  private fun jobJson(
    schedule: String = """{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}""",
    payload: String =
      """{"kind":"agentTurn","message":"Summarize the day","model":"openai/gpt-5.5","thinking":"high"}""",
  ) = objectJson(
    """
    {
      "id":"job-1",
      "name":"Daily report",
      "description":"Daily digest",
      "enabled":true,
      "deleteAfterRun":false,
      "createdAtMs":1000,
      "updatedAtMs":2000,
      "schedule":$schedule,
      "sessionTarget":"isolated",
      "wakeMode":"next-heartbeat",
      "payload":$payload,
      "state":{}
    }
    """.trimIndent(),
  )
}
