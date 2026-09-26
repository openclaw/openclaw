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
  fun probePreservesPartialCredentialFailuresWithoutClaimingAnAuthMutation() =
    runTest {
      val completed = CompletableDeferred<Unit>()
      val fixture = Fixture(this)
      fixture.reply = { method, params ->
        assertEquals("models.probe", method)
        assertEquals(Json.parseToJsonElement("""{"provider":"fixture","agentId":"writer"}"""), params)
        completed.await()
        """{"provider":"fixture","status":"ok","latencyMs":12,"results":[{"profileId":"fixture:ok","label":"Working account","status":"ok","latencyMs":12},{"profileId":"fixture:expired","label":"Expired account","status":"auth","error":"This credential has expired."}]}"""
      }

      fixture.controller.probe("fixture")
      runCurrent()
      assertTrue(fixture.controller.state.value.busy)
      assertEquals("fixture", fixture.controller.state.value.actionProviderId)
      assertNull(fixture.controller.state.value.probeResult)
      completed.complete(Unit)
      runCurrent()

      val result = checkNotNull(fixture.controller.state.value.probeResult)
      assertEquals("ok", result.status)
      assertEquals(12L, result.latencyMs)
      assertEquals(listOf("ok", "auth"), result.results.map { it.status })
      assertEquals("This credential has expired.", result.results.last().error)
      assertEquals("fixture:expired", result.results.last().profileId)
      assertFalse(fixture.controller.state.value.busy)
      assertFalse(fixture.changed)
    }

  @Test
  fun removeKeyUsesOnlyApiKeyScopeAndRetainsAcknowledgedRemovalDuringRefreshFailure() =
    runTest {
      val removed = CompletableDeferred<Unit>()
      val fixture = Fixture(this)
      fixture.reply = { method, params ->
        when (method) {
          "models.authLogout" -> {
            assertEquals(Json.parseToJsonElement("""{"provider":"fixture","agentId":"writer","credentialType":"api_key"}"""), params)
            removed.await()
            """{"provider":"fixture","removedProfiles":["fixture:key"],"abortedRunIds":[],"warning":"The environment key remains configured."}"""
          }

          "models.authStatus" -> {
            error("Connection lost after acknowledged removal")
          }

          else -> {
            error("Unexpected method: $method")
          }
        }
      }

      fixture.controller.removeApiKey("fixture")
      runCurrent()
      assertNull(fixture.controller.state.value.noticeText)
      assertFalse(fixture.changed)
      removed.complete(Unit)
      runCurrent()

      assertEquals(nativeText("API key removed."), fixture.controller.state.value.noticeText)
      assertEquals("The environment key remains configured.", fixture.controller.state.value.warningText)
      assertEquals(nativeText("API key removed, but provider status could not refresh. Tap Refresh to check it."), fixture.controller.state.value.errorText)
      assertTrue(fixture.changed)
      assertFalse(fixture.controller.state.value.busy)
    }

  @Test
  fun providerActionsCannotDispatchOrPublishAfterTheirConnectionOrAgentRetires() =
    runTest {
      for (removeKey in listOf(false, true)) {
        for ((retireBeforeEnqueue, retireOwner) in listOf(true to false, false to false, true to true, false to true)) {
          val gate = CompletableDeferred<Unit>()
          val fixture = Fixture(this)
          if (retireBeforeEnqueue) fixture.beforeEnqueue = { gate.await() }
          fixture.reply = { _, _ ->
            gate.await()
            if (removeKey) """{"provider":"fixture","removedProfiles":[],"abortedRunIds":[]}""" else """{"provider":"fixture","status":"ok","results":[]}"""
          }
          if (removeKey) fixture.controller.removeApiKey("fixture") else fixture.controller.probe("fixture")
          runCurrent()
          val before = fixture.controller.state.value
          if (retireOwner) fixture.ownerCurrent = false else fixture.current = false
          gate.complete(Unit)
          runCurrent()

          assertEquals(before, fixture.controller.state.value)
          assertFalse(fixture.changed)
          if (retireBeforeEnqueue) assertFalse(fixture.enqueued)
        }
      }
    }

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
      assertEquals(nativeText("API key saved. Tap Refresh in this dialog to apply it."), savedNotice)
      assertNull(fixture.controller.state.value.connectedProviderId)
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
      assertNull(fixture.controller.state.value.connectedProviderId)
    }

  @Test
  fun returnedChoiceAndDeviceStepRemainPendingUntilGatewayCompletesLogin() =
    runTest {
      val terminal = CompletableDeferred<String>()
      val published = CompletableDeferred<Unit>()
      val fixture = Fixture(this)
      var signedIn = false
      fixture.reply = { method, params ->
        when (method) {
          "models.authStatus" -> {
            assertEquals("writer", params.getValue("agentId").jsonPrimitive.content)
            assertFalse(params.containsKey("refresh"))
            if (signedIn) {
              published.await()
              """{"ts":2,"providers":[{"provider":"fixture","displayName":"Fixture","status":"ok","profiles":[]}]}"""
            } else {
              AUTH
            }
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
        fixture.controller.state.value.providers
          .single()
          .loginOptions
          .single()
          .id,
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
      assertNull(fixture.controller.state.value.connectedProviderId)
      assertFalse(fixture.changed)
      published.complete(Unit)
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
      assertEquals("fixture", fixture.controller.state.value.connectedProviderId)
    }

  @Test
  fun savedKeyOnlyConnectsAfterCurrentReadyStatusAndRejectsEmptyKeys() =
    runTest {
      for (outcome in listOf("ready", "missing", "unavailable", "failed")) {
        val fixture = Fixture(this)
        var written = false
        var writes = 0
        fixture.reply = { method, _ ->
          when (method) {
            "models.authStatus" -> {
              when {
                !written || outcome == "ready" -> API_KEY_AUTH
                outcome == "failed" -> error("Disconnected during refresh")
                outcome == "unavailable" -> """{"providers":[],"unavailable":{"code":"PREPARED_MODEL_AUTH_UNAVAILABLE"}}"""
                else -> API_KEY_AUTH.replace("\"static\"", "\"missing\"")
              }
            }

            "models.authSetApiKey" -> {
              writes += 1
              written = true
              """{"provider":"fixture","profileId":"fixture:default"}"""
            }

            else -> {
              error("Unexpected method: $method")
            }
          }
        }
        fixture.controller.refresh()
        runCurrent()
        fixture.controller.setApiKey("fixture", " ")
        runCurrent()
        assertEquals(0, writes)
        assertEquals(nativeText("Enter an API key."), fixture.controller.state.value.errorText)
        fixture.controller.setApiKey("fixture", "fixture-secret")
        runCurrent()
        assertEquals(1, writes)
        assertEquals(if (outcome == "ready") "fixture" else null, fixture.controller.state.value.connectedProviderId)
      }
    }

  @Test
  fun providerCapabilitiesDoNotOfferUnsafeQuickKeySetupOrOtherProvidersChoices() =
    runTest {
      val fixture = Fixture(this)
      fixture.reply = { method, _ ->
        assertEquals("models.authStatus", method)
        """{"providers":[{"provider":"remote","displayName":"Remote","status":"missing"}],"providerCapabilities":[{"provider":"remote","apiKeySupported":true,"quickApiKeySetup":false},{"provider":"account","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/account","label":"Account sign-in","hint":"Use your account","kind":"oauth","featured":true}]}]}"""
      }
      fixture.controller.refresh()
      runCurrent()
      val providers = fixture.controller.state.value.providers
      val remote = providers.single { it.id == "remote" }
      assertFalse(remote.canSignIn)
      assertTrue(remote.loginOptions.isEmpty())
      assertTrue(providers.single { it.id == "account" }.canSignIn)
      fixture.controller.setApiKey("remote", "fixture-secret")
      fixture.controller.start("plugin/unadvertised")
      runCurrent()
      assertFalse(fixture.controller.state.value.busy)
      assertNull(fixture.controller.state.value.connectedProviderId)
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
      assertTrue(state.providers.isEmpty())
      assertNotNull(state.errorText)
      assertNull(state.wizard)
      assertTrue(fixture.changed)
      assertNull(fixture.controller.state.value.connectedProviderId)
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
      settled.complete("""{"status":"cancelled","error":"cancelled"}""")
      runCurrent()
      assertEquals(
        "cancelled",
        fixture.controller.state.value.wizard!!
          .getValue("status")
          .jsonPrimitive.content,
      )
      assertFalse(fixture.controller.state.value.cancelling)
      assertNull(fixture.controller.state.value.errorText)
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
    private const val API_KEY_AUTH = """{"providers":[{"provider":"fixture","displayName":"Fixture","status":"static"}],"providerCapabilities":[{"provider":"fixture","apiKeySupported":true,"quickApiKeySetup":true}]}"""
    private const val AUTH = """{"ts":1,"providers":[],"providerCapabilities":[{"provider":"fixture","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/returned-choice","brandId":"fixture","label":"Sign in","kind":"device-code","featured":true}]}]}"""
    private const val STEP = """{"done":false,"status":"running","step":{"id":"device","type":"action","executor":"client","externalUrl":"https://example.com/login","deviceCode":{"code":"ABCD"}}}"""
  }
}
