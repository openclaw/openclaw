package ai.openclaw.app

import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GatewayModelSettingsControllerTest {
  @Test
  fun defaultsUseFreshSourceRevisionAndPreserveFallbackTailsWithoutPatchingAgentOverrides() =
    runTest {
      val fixture = Fixture(this)
      fixture.controller.refresh()
      runCurrent()
      assertEquals(
        "provider/primary",
        fixture.controller.state.value.defaults
          ?.primary,
      )
      assertEquals(
        "",
        fixture.controller.state.value.defaults
          ?.utilityModel,
      )
      assertEquals(
        "high",
        fixture.controller.state.value.defaults
          ?.thinkingLevel,
      )
      assertEquals(
        ChatFastMode.Automatic,
        fixture.controller.state.value.defaults
          ?.fastMode,
      )
      fixture.hash = "changed-elsewhere"
      val committed = objectJson("""{"agents":{"defaults":{"model":{"primary":"provider/fallback","fallbacks":["provider/tail"]}},"entries":{"writer":{"model":"other/override"}}},"unrelated":true}""")
      fixture.reply = { method, params ->
        when (method) {
          "config.get" -> {
            fixture.snapshot()
          }

          "config.patch" -> {
            assertEquals("changed-elsewhere", params.getValue("baseHash").jsonPrimitive.content)
            assertEquals(objectJson("""{"agents":{"defaults":{"model":{"primary":"provider/fallback","fallbacks":["provider/tail"]}}}}"""), rawPatch(params))
            assertEquals(JsonArray(listOf(JsonPrimitive("agents.defaults.model.fallbacks"))), params["replacePaths"])
            fixture.config = committed
            fixture.hash = "committed"
            acknowledgement(committed, fixture.hash)
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }
      fixture.controller.setPrimaryModel("provider/fallback")
      runCurrent()
      assertEquals(
        "provider/fallback",
        fixture.controller.state.value.defaults
          ?.primary,
      )
      assertEquals(
        listOf("provider/tail"),
        fixture.controller.state.value.defaults
          ?.fallbacks,
      )
      assertEquals(1, fixture.changed)
      assertEquals(listOf("config.get", "config.get", "config.patch", "config.get"), fixture.calls.map { it.first })
    }

  @Test
  fun fallbackReplacementKeepsOtherFallbacksAndClearingConfirmsArrayRemoval() =
    runTest {
      for ((replacement, expected) in listOf("provider/new" to """{"primary":"provider/primary","fallbacks":["provider/new","provider/tail"]}""", null to "\"provider/primary\"")) {
        val fixture = Fixture(this)
        fixture.controller.setFallbackModel(replacement)
        runCurrent()
        val patch = fixture.calls.single { it.first == "config.patch" }.second
        assertEquals(
          Json.parseToJsonElement(expected),
          rawPatch(patch)["agents"]
            ?.jsonObject
            ?.get("defaults")
            ?.jsonObject
            ?.get("model"),
        )
        assertEquals(JsonArray(listOf(JsonPrimitive("agents.defaults.model.fallbacks"))), patch["replacePaths"])
      }
    }

  @Test
  fun nullableSelectionsAndFastModeUseOnlyTheirOwnedGlobalField() =
    runTest {
      val cases: List<Triple<String, kotlinx.serialization.json.JsonElement, (GatewayModelSettingsController) -> Unit>> =
        listOf(
          Triple("utilityModel", JsonNull) { it.setUtilityModel(null) },
          Triple("utilityModel", JsonPrimitive("")) { it.setUtilityModel("") },
          Triple("decisionModel", JsonNull) { it.setDecisionModel(null) },
          Triple("thinkingDefault", JsonNull) { it.setThinkingLevel(null) },
          Triple("fastModeDefault", JsonNull) { it.setFastMode(null) },
          Triple("fastModeDefault", JsonPrimitive(false)) { it.setFastMode(ChatFastMode.Off) },
          Triple("fastModeDefault", JsonPrimitive("auto")) { it.setFastMode(ChatFastMode.Automatic) },
        )
      for ((field, expected, mutate) in cases) {
        val fixture = Fixture(this)
        mutate(fixture.controller)
        runCurrent()
        val patch = fixture.calls.single { it.first == "config.patch" }.second
        assertEquals(buildJsonObject { put("agents", buildJsonObject { put("defaults", buildJsonObject { put(field, expected) }) }) }, rawPatch(patch))
        assertFalse(patch.containsKey("replacePaths"))
      }
    }

  @Test
  fun installedAgentAcknowledgementPrecedesReadbackAndSurvivesReadbackFailure() =
    runTest {
      val fixture = Fixture(this)
      val finishWrite = CompletableDeferred<Unit>()
      val finishRead = CompletableDeferred<Unit>()
      val committed = objectJson("""{"agents":{"defaults":{"model":"provider/primary"}},"plugins":{"entries":{"acpx":{"config":{"nativeAgents":{"installed":false,"other":true}}}}}}""")
      fixture.reply = { method, params ->
        when (method) {
          "config.get" -> {
            if (fixture.changed > 0) {
              finishRead.await()
              error("Readback unavailable")
            }
            fixture.snapshot()
          }

          "config.patch" -> {
            assertEquals(objectJson("""{"plugins":{"entries":{"acpx":{"config":{"nativeAgents":{"installed":false}}}}}}"""), rawPatch(params))
            finishWrite.await()
            acknowledgement(committed, "saved")
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }
      fixture.controller.setInstalledAgentEnabled("installed", false)
      runCurrent()
      fixture.controller.setUtilityModel("provider/ignored")
      fixture.controller.refresh()
      runCurrent()
      assertEquals(1, fixture.calls.count { it.first == "config.patch" })
      finishWrite.complete(Unit)
      runCurrent()
      assertEquals(mapOf("installed" to false, "other" to true), fixture.controller.state.value.nativeAgentFlags)
      assertEquals(nativeText("Model settings saved."), fixture.controller.state.value.noticeText)
      assertEquals(1, fixture.changed)
      finishRead.complete(Unit)
      runCurrent()
      assertFalse(fixture.controller.state.value.saving)
      assertNull(fixture.controller.state.value.errorText)
      assertNotNull(fixture.controller.state.value.warningText)
      assertEquals(mapOf("installed" to false, "other" to true), fixture.controller.state.value.nativeAgentFlags)
      assertEquals(nativeText("Model settings saved."), fixture.controller.state.value.noticeText)
    }

  @Test
  fun unknownWriteIsReadBackWithoutClaimingAcknowledgementOrRetryingIt() =
    runTest {
      val fixture = Fixture(this)
      val observed = objectJson("""{"agents":{"defaults":{"utilityModel":""}}}""")
      fixture.reply = { method, _ ->
        if (method == "config.patch") {
          fixture.config = observed
          fixture.hash = "observed"
          throw GatewayRequestOutcomeUnknown("response lost")
        }
        fixture.snapshot()
      }
      fixture.controller.setUtilityModel("")
      runCurrent()
      assertEquals(
        "",
        fixture.controller.state.value.defaults
          ?.utilityModel,
      )
      assertNotNull(fixture.controller.state.value.errorText)
      assertNull(fixture.controller.state.value.noticeText)
      assertEquals(0, fixture.changed)
      assertEquals(listOf("config.get", "config.patch", "config.get"), fixture.calls.map { it.first })
    }

  @Test
  fun configConflictKeepsGatewayErrorAndReconcilesWithoutOverwritingTheWinner() =
    runTest {
      val fixture = Fixture(this)
      fixture.reply = { method, _ ->
        if (method == "config.patch") {
          fixture.config = objectJson("""{"agents":{"defaults":{"model":"provider/concurrent"}}}""")
          fixture.hash = "concurrent"
          throw GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "Configuration changed; refresh before retrying."))
        }
        fixture.snapshot()
      }
      fixture.controller.setPrimaryModel("provider/chosen")
      runCurrent()
      assertEquals(
        "provider/concurrent",
        fixture.controller.state.value.defaults
          ?.primary,
      )
      assertEquals(verbatimText("Configuration changed; refresh before retrying."), fixture.controller.state.value.errorText)
      assertEquals(0, fixture.changed)
      assertEquals(1, fixture.calls.count { it.first == "config.patch" })
    }

  @Test
  fun adminOrConnectionLossWhileWaitingForTransportPreventsTheWrite() =
    runTest {
      for (retireConnection in listOf(false, true)) {
        val fixture = Fixture(this)
        val release = CompletableDeferred<Unit>()
        fixture.beforeEnqueue = { method -> if (method == "config.patch") release.await() }
        fixture.controller.setThinkingLevel("high")
        runCurrent()
        if (retireConnection) fixture.current = false else fixture.admin = false
        release.complete(Unit)
        runCurrent()
        assertEquals(listOf("config.get"), fixture.calls.map { it.first })
        assertEquals(0, fixture.changed)
        assertNull(fixture.controller.state.value.noticeText)
        if (!retireConnection) assertNotNull(fixture.controller.state.value.errorText)
      }
    }

  @Test
  fun lateConfigReadCannotPublishAfterItsConnectionCloses() =
    runTest {
      val fixture = Fixture(this)
      val release = CompletableDeferred<Unit>()
      fixture.reply = { _, _ ->
        release.await()
        fixture.snapshot()
      }
      fixture.controller.refresh()
      runCurrent()
      val before = fixture.controller.state.value
      fixture.controller.close()
      release.complete(Unit)
      runCurrent()
      assertEquals(before, fixture.controller.state.value)
      assertNull(fixture.controller.state.value.defaults)
    }

  private class Fixture(
    scope: CoroutineScope,
  ) {
    var current = true
    var admin = true
    var changed = 0
    var hash = "original"
    var config = objectJson("""{"agents":{"defaults":{"model":{"primary":"provider/primary","fallbacks":["provider/fallback","provider/tail"]},"thinkingDefault":"high","fastModeDefault":"auto","utilityModel":""},"entries":{"writer":{"model":"other/override"}}},"unrelated":true}""")
    val calls = mutableListOf<Pair<String, JsonObject>>()
    var beforeEnqueue: suspend (String) -> Unit = {}
    var reply: suspend (String, JsonObject) -> String = { method, _ ->
      if (method == "config.get") snapshot() else """{"ok":true,"noop":true}"""
    }
    private val lease =
      GatewaySession.RequestLease("gateway", { current }, null) { method, params, _, enqueue ->
        beforeEnqueue(method)
        val input = Json.parseToJsonElement(requireNotNull(params)).jsonObject
        enqueue { calls += method to input }
        reply(method, input)
      }
    val controller = GatewayModelSettingsController(scope, lease, Json, { current }, { admin }) { changed += 1 }

    fun snapshot(): String =
      buildJsonObject {
        put("valid", true)
        put("hash", hash)
        put("sourceConfig", config)
        put("resolved", objectJson("""{"agents":{"defaults":{"model":"wrong/resolved"}}}"""))
      }.toString()
  }

  companion object {
    private fun objectJson(value: String): JsonObject = Json.parseToJsonElement(value).jsonObject

    private fun rawPatch(params: JsonObject): JsonObject = objectJson(params.getValue("raw").jsonPrimitive.content)

    private fun acknowledgement(
      config: JsonObject,
      hash: String,
    ): String =
      buildJsonObject {
        put("ok", true)
        put("config", config)
        put("hash", hash)
      }.toString()
  }
}
