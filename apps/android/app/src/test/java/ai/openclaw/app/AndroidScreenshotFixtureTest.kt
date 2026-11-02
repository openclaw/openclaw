package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidScreenshotFixtureTest {
  private val json = Json { ignoreUnknownKeys = true }
  private val request = AndroidScreenshotFixture.createRequester()

  @Test
  fun providesDeterministicProductionScreenData() {
    val sessions =
      json
        .parseToJsonElement(request("sessions.list", null))
        .jsonObject["sessions"]
        ?.jsonArray
        .orEmpty()
    val metadata =
      json
        .parseToJsonElement(request("chat.metadata", null))
        .jsonObject
    val cronJobs =
      json
        .parseToJsonElement(request("cron.list", null))
        .jsonObject["jobs"]
        ?.jsonArray
        .orEmpty()
    val cronDetail =
      json
        .parseToJsonElement(request("cron.get", null))
        .jsonObject
    val cronRunEntries =
      json
        .parseToJsonElement(request("cron.runs", null))
        .jsonObject["entries"]
        ?.jsonArray
    val parsedCronRuns = parseGatewayCronRunHistory(cronRunEntries)

    assertEquals(3, sessions.size)
    assertEquals(
      AndroidScreenshotFixture.primarySessionTitle,
      sessions
        .first()
        .jsonObject["displayName"]
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(
      1,
      json
        .parseToJsonElement(request("models.list", null))
        .jsonObject
        .getValue("models")
        .jsonArray.size,
    )
    assertEquals(6, metadata["commands"]?.jsonArray?.size)
    assertEquals(
      AndroidScreenshotFixture.cronJobName,
      cronJobs
        .single()
        .jsonObject["name"]
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(AndroidScreenshotFixture.cronJobId, cronDetail["id"]?.jsonPrimitive?.content)
    assertEquals(2, parsedCronRuns.size)
    assertEquals("android-release-digest-run-2", parsedCronRuns.first().runId)
    assertEquals("Release checklist ready", parsedCronRuns.first().summary)
    assertEquals("android-release-digest-run-1", parsedCronRuns.last().runId)
    assertEquals("Play publish blocked", parsedCronRuns.last().error)
  }

  @Test
  fun providesSwarmChildRosterForSwarmScene() {
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Swarm)
    try {
      val params = "{\"spawnedBy\":\"${AndroidScreenshotFixture.mainSessionKey}\"}"
      val sessions =
        json
          .parseToJsonElement(request("sessions.list", params))
          .jsonObject["sessions"]
          ?.jsonArray
          .orEmpty()
      val metadata =
        json
          .parseToJsonElement(request("chat.metadata", null))
          .jsonObject
      assertEquals("true", metadata["swarmEnabled"]?.jsonPrimitive?.content)
      assertEquals(5, sessions.size)
      assertEquals(
        "swarm:${AndroidScreenshotFixture.mainSessionKey}:research",
        sessions
          .first()
          .jsonObject["swarmGroupId"]
          ?.jsonPrimitive
          ?.content,
      )
    } finally {
      AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    }
  }

  @Test
  fun recentChatHistoryKeepsNoticeMarkersAndActiveRun() {
    val history =
      json
        .parseToJsonElement(request("chat.history", null))
        .jsonObject
    val messages = history["messages"]?.jsonArray.orEmpty().takeLast(10)

    assertEquals(
      listOf("user", "assistant", "user", "user", "user", "assistant", "system", "system", "user", "assistant"),
      messages.map { it.jsonObject["role"]?.jsonPrimitive?.content },
    )

    val restartRecovery = messages[2].jsonObject["provenance"]?.jsonObject
    assertEquals("internal_system", restartRecovery?.get("kind")?.jsonPrimitive?.content)
    assertEquals("main_session_restart_recovery", restartRecovery?.get("sourceTool")?.jsonPrimitive?.content)
    val gatewayRestarted = messages[3].jsonObject["provenance"]?.jsonObject
    assertEquals("restart-sentinel", gatewayRestarted?.get("sourceTool")?.jsonPrimitive?.content)
    val compaction = messages[6].jsonObject["__openclaw"]?.jsonObject
    assertEquals("compaction", compaction?.get("kind")?.jsonPrimitive?.content)
    assertEquals("android-screenshot-compaction", compaction?.get("id")?.jsonPrimitive?.content)
    assertEquals("900000", compaction?.get("tokensBefore")?.jsonPrimitive?.content)
    assertEquals("24700", compaction?.get("tokensAfter")?.jsonPrimitive?.content)
    val reset = messages[7].jsonObject["__openclaw"]?.jsonObject
    assertEquals("reset", reset?.get("kind")?.jsonPrimitive?.content)
    assertEquals("android-screenshot-reset", reset?.get("id")?.jsonPrimitive?.content)
    val inFlightRun = history["inFlightRun"]?.jsonObject
    assertEquals("android-screenshot-active-run", inFlightRun?.get("runId")?.jsonPrimitive?.content)
    assertEquals("", inFlightRun?.get("text")?.jsonPrimitive?.content)
  }

  @Test
  fun providesDeterministicSystemAgentConversation() {
    val greeting =
      json
        .parseToJsonElement(
          request(
            "openclaw.chat",
            """{"sessionId":"android-settings-openclaw-test"}""",
          ),
        ).jsonObject
    val response =
      json
        .parseToJsonElement(
          request(
            "openclaw.chat",
            """{"sessionId":"android-settings-openclaw-test","message":"Check status"}""",
          ),
        ).jsonObject

    assertEquals("android-screenshot-openclaw", greeting["sessionId"]?.jsonPrimitive?.content)
    assertEquals(
      "What should we look at first?",
      greeting["question"]
        ?.jsonObject
        ?.get("question")
        ?.jsonPrimitive
        ?.content,
    )
    assertEquals(
      "I’ll keep this conversation separate from ordinary agent chat.",
      response["reply"]?.jsonPrimitive?.content,
    )
  }

  @Test
  fun rejectsUnexpectedGatewayCalls() {
    val error =
      assertThrows(IllegalStateException::class.java) {
        request("gateway.unexpected", null)
      }

    assertEquals(
      "Screenshot fixture does not implement gateway method gateway.unexpected with params null",
      error.message,
    )
  }
}
