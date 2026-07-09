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
  fun deleteAfterRunStaysAvailableOnlyForOneShotSchedules() {
    val recurring =
      requireNotNull(
        parseGatewayCronJobDetail(jobJson(deleteAfterRun = true)),
      ).toCronJobEdit()
    val oneShot =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(
            deleteAfterRun = true,
            schedule = """{"kind":"at","at":"2026-07-10T09:00:00Z"}""",
          ),
        ),
      ).toCronJobEdit()

    assertFalse(recurring.deleteAfterRun)
    assertTrue(oneShot.deleteAfterRun)
    assertFalse(
      oneShot
        .withSchedule(GatewayCronScheduleEdit.Every(everyMs = "60000", anchorMs = ""))
        .deleteAfterRun,
    )
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
  fun commandArgvPreservesWhitespaceOnlyEntriesAllowedByGateway() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(payload = """{"kind":"command","argv":["printf"," "],"cwd":"/tmp"}"""),
        ),
      )
    val edit = original.toCronJobEdit().copy(name = "Renamed command")

    val patch =
      objectJson(buildCronUpdateParams(original = original, edit = edit))
        .getValue("patch")
        .jsonObject

    assertEquals(setOf("name"), patch.keys)
    assertEquals("Renamed command", patch.getValue("name").jsonPrimitive.content)
  }

  @Test
  fun commandPayloadRejectsClearingAnExistingWorkingDirectory() {
    val original =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(payload = """{"kind":"command","argv":["echo"],"cwd":"/tmp"}"""),
        ),
      )
    val initial = original.toCronJobEdit()
    val payload = initial.payload as GatewayCronPayloadEdit.Command

    val error =
      runCatching {
        buildCronUpdateParams(
          original = original,
          edit = initial.copy(payload = payload.copy(cwd = "")),
        )
      }.exceptionOrNull()

    assertEquals("The gateway does not support clearing a command working directory.", error?.message)
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

  @Test
  fun editorDraftPreservesDirtyFieldsAndMarksIncomingRevisionConflict() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    var draft = CronEditorDraftState.from(original)
    draft = draft.withEdit(draft.edit.copy(name = "Unsaved name"))
    val unrelated =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(name = "Gateway revision"),
        ),
      )

    draft = draft.observeJob(unrelated)

    assertEquals("Unsaved name", draft.edit.name)
    assertTrue(draft.isDirty)
    assertTrue(draft.hasIncomingConflict)
    assertTrue(draft.requiresResolution)
    val returnedToBaseline = draft.withEdit(draft.baseline)
    assertFalse(returnedToBaseline.isDirty)
    assertTrue(returnedToBaseline.requiresResolution)
    val reverted = CronEditorDraftState.from(unrelated)
    assertEquals("Gateway revision", reverted.edit.name)
    assertFalse(reverted.isDirty)
    assertFalse(reverted.hasIncomingConflict)
  }

  @Test
  fun editorDraftIgnoresRuntimeOnlyTimestampUpdates() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    val draft =
      CronEditorDraftState
        .from(original)
        .withEdit(original.toCronJobEdit().copy(name = "Unsaved name"))
    val runtimeUpdate =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(updatedAtMs = 3000),
        ),
      )

    val observed = draft.observeJob(runtimeUpdate)

    assertEquals("Unsaved name", observed.edit.name)
    assertEquals(3000, observed.baselineRevision)
    assertTrue(observed.isDirty)
    assertFalse(observed.hasIncomingConflict)
  }

  @Test
  fun editorDraftAdoptsOnlyTheNewRevisionAfterSuccessfulSave() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    var draft = CronEditorDraftState.from(original)
    draft = draft.withEdit(draft.edit.copy(name = "Saved name"))

    draft = draft.saveStarted().saveAborted()
    assertFalse(draft.savePending)
    assertEquals("Saved name", draft.edit.name)
    draft = draft.saveStarted().observeSaveNotice(GatewayCronNoticeKind.Error)
    assertEquals("Saved name", draft.edit.name)
    draft = draft.saveStarted().observeSaveNotice(GatewayCronNoticeKind.Success)
    assertEquals("Saved name", draft.observeJob(original).edit.name)

    val saved =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(name = "Saved name", updatedAtMs = 4000),
        ),
      )
    draft = draft.observeJob(saved)

    assertEquals("Saved name", draft.baseline.name)
    assertEquals(draft.baseline, draft.edit)
    assertFalse(draft.savePending)
    assertFalse(draft.saveSucceeded)
  }

  @Test
  fun restoredPendingSaveTracksRetainedRuntimeAndRecoversAfterProcessDeath() {
    val original = requireNotNull(parseGatewayCronJobDetail(jobJson()))
    val pending =
      CronEditorDraftState
        .from(original)
        .withEdit(original.toCronJobEdit().copy(name = "Saved name"))
        .saveStarted()
    val running = GatewayCronActionState.Running(id = original.id, action = GatewayCronAction.Save)
    val success =
      GatewayCronActionState.Notice(
        id = original.id,
        message = "Cron job updated.",
        kind = GatewayCronNoticeKind.Success,
      )

    assertEquals(
      pending,
      pending.reconcileRestoredAction(isConnected = true, jobId = original.id, actionState = running),
    )
    assertEquals(
      pending,
      pending.reconcileRestoredAction(isConnected = true, jobId = original.id, actionState = success),
    )
    assertFalse(
      pending
        .reconcileRestoredAction(
          isConnected = true,
          jobId = original.id,
          actionState = GatewayCronActionState.Idle,
        ).savePending,
    )
    assertFalse(
      pending
        .reconcileRestoredAction(
          isConnected = false,
          jobId = original.id,
          actionState = running,
        ).savePending,
    )

    val applied =
      requireNotNull(
        parseGatewayCronJobDetail(
          jobJson(name = "Saved name", updatedAtMs = 4000),
        ),
      )
    val recovered = pending.saveAborted().observeJob(applied)
    assertEquals(recovered.baseline, recovered.edit)
    assertFalse(recovered.requiresResolution)
  }

  @Test
  fun latestRefreshGuardRejectsStaleAndInvalidatedResults() {
    val guard = LatestGatewayRefreshGuard()
    val stale = guard.begin()
    val current = guard.begin()
    var published = "none"

    assertFalse(guard.publishIfCurrent(stale) { published = "stale" })
    assertTrue(guard.publishIfCurrent(current) { published = "current" })
    guard.invalidate()
    assertFalse(guard.publishIfCurrent(current) { published = "invalidated" })
    assertEquals("current", published)
  }

  private fun objectJson(raw: String) = Json.parseToJsonElement(raw).jsonObject

  private fun jobJson(
    name: String = "Daily report",
    updatedAtMs: Long = 2000,
    deleteAfterRun: Boolean = false,
    schedule: String = """{"kind":"cron","expr":"0 9 * * *","tz":"UTC"}""",
    payload: String =
      """{"kind":"agentTurn","message":"Summarize the day","model":"openai/gpt-5.5","thinking":"high"}""",
  ) = objectJson(
    """
    {
      "id":"job-1",
      "name":"$name",
      "description":"Daily digest",
      "enabled":true,
      "deleteAfterRun":$deleteAfterRun,
      "createdAtMs":1000,
      "updatedAtMs":$updatedAtMs,
      "schedule":$schedule,
      "sessionTarget":"isolated",
      "wakeMode":"next-heartbeat",
      "payload":$payload,
      "state":{}
    }
    """.trimIndent(),
  )
}
