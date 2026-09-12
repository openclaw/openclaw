package ai.openclaw.app

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeText
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ProviderAuthControllerTest {
  @Test
  fun advertisedApiKeyWriteWaitsForAcknowledgementAndReadsPublishedState() =
    runTest {
      var saved = CompletableDeferred<Unit>()
      val fixture = Fixture(this)
      var written = false
      val applied = CompletableDeferred<Unit>()
      var applyRequests = 0
      fixture.reply = { method, params ->
        when (method) {
          "models.authStatus" -> {
            """{"ts":1,"providers":[{"provider":"fixture","displayName":"Fixture","status":"${if (written) "static" else "missing"}","profiles":[]}],"providerCapabilities":[{"provider":"fixture","apiKeySupported":true,"quickApiKeySetup":true}]}"""
          }

          "models.authSetApiKey" -> {
            assertEquals("fixture", params.getValue("provider").jsonPrimitive.content)
            assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
            assertEquals("fixture-secret", params.getValue("apiKey").jsonPrimitive.content)
            saved.await()
            written = true
            """{"provider":"fixture","profileId":"fixture:default","warning":"Saved, but runtime auth refresh failed. Restart the Gateway to apply it."}"""
          }

          "models.authRefresh" -> {
            assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
            assertEquals("update", params.getValue("operation").jsonPrimitive.content)
            applyRequests += 1
            applied.await()
            """{"refreshed":true}"""
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }
      fixture.controller.refresh()
      runCurrent()
      fixture.controller.setApiKey(
        fixture.controller.state.value.apiKeyProviders
          .single(),
        "fixture-secret",
      )
      runCurrent()
      assertNull(fixture.controller.state.value.noticeText)
      assertFalse(fixture.changed)
      saved.complete(Unit)
      runCurrent()
      assertNotNull(fixture.controller.state.value.noticeText)
      assertEquals(
        "static",
        fixture.controller.state.value.authStatus!!
          .getValue("providers")
          .jsonArray
          .single()
          .jsonObject
          .getValue("status")
          .jsonPrimitive.content,
      )
      assertTrue(fixture.changed)
      assertNull(fixture.controller.state.value.errorText)
      val savedNotice = fixture.controller.state.value.noticeText
      val savedRevision = fixture.controller.state.value.apiKeySaveRevision
      fixture.controller.refresh()
      runCurrent()
      assertEquals(savedNotice, fixture.controller.state.value.noticeText)
      assertEquals(savedRevision, fixture.controller.state.value.apiKeySaveRevision)
      assertEquals(nativeText("API key saved. Tap Refresh to apply it."), savedNotice)
      fixture.changed = false
      fixture.controller.refresh(refresh = true)
      runCurrent()
      assertEquals(1, applyRequests)
      assertEquals(savedNotice, fixture.controller.state.value.noticeText)
      assertFalse(fixture.changed)
      applied.complete(Unit)
      runCurrent()
      assertEquals(nativeText("Sign-ins refreshed."), fixture.controller.state.value.noticeText)
      assertEquals(savedRevision, fixture.controller.state.value.apiKeySaveRevision)
      assertTrue(fixture.changed)
      saved = CompletableDeferred()
      fixture.controller.setApiKey("fixture", "fixture-secret")
      runCurrent()
      assertNull(fixture.controller.state.value.noticeText)
      assertEquals(savedRevision, fixture.controller.state.value.apiKeySaveRevision)
      saved.complete(Unit)
      runCurrent()
      assertEquals(savedNotice, fixture.controller.state.value.noticeText)
      assertTrue(fixture.controller.state.value.apiKeySaveRevision > savedRevision)
    }

  @Test
  fun returnedChoiceAndDeviceStepRemainPendingUntilGatewayCompletesLogin() =
    runTest {
      val terminal = CompletableDeferred<String>()
      val fixture = Fixture(this)
      var signedIn = false
      fixture.reply = { method, params ->
        when (method) {
          "models.authStatus" -> {
            assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
            assertFalse(params.containsKey("refresh"))
            if (signedIn) """{"ts":2,"providers":[{"provider":"fixture","displayName":"Fixture","status":"ok","profiles":[]}]}""" else AUTH
          }

          "models.authLogin" -> {
            assertEquals("plugin/returned-choice", params.getValue("authChoice").jsonPrimitive.content)
            assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
            """{"sessionId":"${params.getValue("sessionId").jsonPrimitive.content}","done":false,"status":"running"}"""
          }

          "wizard.next" -> {
            if (params["answer"] == null) {
              STEP
            } else {
              assertEquals(
                "device",
                params
                  .getValue("answer")
                  .jsonObject
                  .getValue("stepId")
                  .jsonPrimitive.content,
              )
              terminal.await().also { signedIn = true }
            }
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }
      fixture.controller.refresh()
      runCurrent()
      fixture.controller.start(
        fixture.controller.state.value.loginOptions
          .single()
          .getValue("id")
          .jsonPrimitive.content,
      )
      runCurrent()
      val step =
        fixture.controller.state.value.wizard!!
          .getValue("step")
          .jsonObject
      assertEquals(
        "ABCD",
        step
          .getValue("deviceCode")
          .jsonObject
          .getValue("code")
          .jsonPrimitive.content,
      )
      assertFalse(fixture.changed)
      fixture.controller.answer(JsonPrimitive(true))
      runCurrent()
      assertFalse(
        fixture.controller.state.value.wizard!!
          .getValue("done")
          .jsonPrimitive.boolean,
      )
      terminal.complete("""{"done":true,"status":"done"}""")
      runCurrent()
      assertEquals(
        "done",
        fixture.controller.state.value.wizard!!
          .getValue("status")
          .jsonPrimitive.content,
      )
      assertTrue(fixture.changed)
      assertEquals(
        "2",
        fixture.controller.state.value.authStatus!!
          .getValue("ts")
          .jsonPrimitive.content,
      )
      assertFalse(fixture.controller.state.value.busy)
      assertNull(fixture.controller.state.value.errorText)
    }

  @Test
  fun retiredLeaseCannotEnqueueOrPublishLateAuthStatus() =
    runTest {
      for ((retireBeforeEnqueue, retireOwner) in listOf(true to false, false to false, true to true, false to true)) {
        val gate = CompletableDeferred<Unit>()
        val fixture = Fixture(this)
        if (retireBeforeEnqueue) fixture.beforeEnqueue = { gate.await() }
        fixture.reply = { _, _ ->
          gate.await()
          AUTH
        }
        fixture.controller.refresh()
        runCurrent()
        val before = fixture.controller.state.value
        if (retireOwner) fixture.ownerCurrent = false else fixture.current = false
        gate.complete(Unit)
        runCurrent()
        assertEquals(before, fixture.controller.state.value)
        assertNull(fixture.controller.state.value.authStatus)
        if (retireBeforeEnqueue) assertFalse(fixture.enqueued)
      }
    }

  @Test
  fun unavailableAuthStatusDoesNotOfferLoginOrClaimReadiness() =
    runTest {
      val fixture = Fixture(this)
      fixture.reply = { method, params ->
        assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
        when (method) {
          "models.authRefresh" -> {
            """{"refreshed":true}"""
          }

          "models.authStatus" -> {
            assertFalse(params.containsKey("refresh"))
            """{"ts":1,"providers":[],"unavailable":{"code":"PREPARED_MODEL_AUTH_UNAVAILABLE","message":"Preparing"}}"""
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }
      fixture.controller.refresh(refresh = true)
      runCurrent()
      val state = fixture.controller.state.value
      assertNotNull(state.authStatus?.get("unavailable"))
      assertTrue(state.loginOptions.isEmpty())
      assertNotNull(state.errorText)
      assertNull(state.wizard)
      assertTrue(fixture.changed)
    }

  @Test
  fun cancellationWaitsForProtectedLoginWorkToSettle() =
    runTest {
      val settled = CompletableDeferred<String>()
      val fixture = Fixture(this)
      fixture.reply = { method, params ->
        when (method) {
          "models.authStatus" -> {
            AUTH
          }

          "models.authLogin" -> {
            """{"sessionId":"${params.getValue("sessionId").jsonPrimitive.content}","done":false,"status":"running"}"""
          }

          "wizard.next" -> {
            STEP
          }

          "wizard.cancel" -> {
            assertTrue(params.getValue("closeInput").jsonPrimitive.boolean)
            settled.await()
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }
      fixture.controller.refresh()
      runCurrent()
      fixture.controller.start("plugin/returned-choice")
      runCurrent()
      fixture.controller.cancel()
      runCurrent()
      assertTrue(fixture.controller.state.value.cancelling)
      assertFalse(fixture.changed)
      settled.complete("""{"status":"cancelled"}""")
      runCurrent()
      assertEquals(
        "cancelled",
        fixture.controller.state.value.wizard!!
          .getValue("status")
          .jsonPrimitive.content,
      )
      assertFalse(fixture.controller.state.value.cancelling)
      assertTrue(fixture.changed)
    }

  private class Fixture(
    scope: CoroutineScope,
  ) {
    var current = true
    var ownerCurrent = true
    var changed = false
    var enqueued = false
    var beforeEnqueue: suspend () -> Unit = {}
    var reply: suspend (String, JsonObject) -> String = { _, _ -> AUTH }
    private val lease =
      GatewaySession.RequestLease("gateway", { current }, null) { method, params, _, enqueue ->
        beforeEnqueue()
        enqueue { enqueued = true }
        reply(method, Json.parseToJsonElement(requireNotNull(params)).jsonObject)
      }
    val controller = ProviderAuthController(scope, lease, "writer", Json, { ownerCurrent }) { changed = true }
  }

  companion object {
    private const val AUTH = """{"ts":1,"providers":[],"providerCapabilities":[{"provider":"fixture","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/returned-choice","brandId":"fixture","label":"Sign in","kind":"device-code","featured":true}]}]}"""
    private const val STEP = """{"done":false,"status":"running","step":{"id":"device","type":"action","executor":"client","externalUrl":"https://example.com/login","deviceCode":{"code":"ABCD"}}}"""
  }
}
