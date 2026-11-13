package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatControllerSessionPatchScopeTest {
  @Test
  fun retiredRenameFailurePreservesCurrentGatewayError() {
    runTest {
      for (replacementGatewayId in listOf("gateway-b", "gateway-a")) {
        var gatewayScope = ChatCacheScope("gateway-a", 1L)
        val gateway = ScriptedGateway(chatControllerTestJson)
        val patchEntered = CompletableDeferred<Unit>()
        val patchResponse = CompletableDeferred<String>()
        gateway.respond("sessions.patch") {
          patchEntered.complete(Unit)
          patchResponse.await()
        }
        val controller =
          backgroundScope.createChatController(
            cacheScope = { gatewayScope },
            requestGateway = gateway::request,
          )
        controller.outboxPresentationRestored.first { it }
        val rename =
          async {
            controller.patchSession(ChatSessionPatch(key = "custom", ownerAgentId = "main", label = "Renamed"))
          }
        patchEntered.await()

        gatewayScope = ChatCacheScope(replacementGatewayId, 2L)
        controller.onGatewayScopeChanging()
        controller.handleGatewayEvent("agent", """{"stream":"error"}""")
        val currentError = controller.errorText.value
        assertFalse(currentError.isNullOrBlank())

        patchResponse.completeExceptionally(IllegalStateException("Retired gateway rename failed"))
        assertFalse(rename.await())
        assertEquals("Retired rename must not replace the current error", currentError, controller.errorText.value)
        assertEquals(1, gateway.callCount("sessions.patch"))
        assertEquals(0, gateway.callCount("sessions.list"))
      }
    }
  }

  @Test
  fun currentRenameFailureRemainsVisibleAndSuccessfulRetryRefreshesSessions() {
    runTest {
      val gateway = ScriptedGateway(chatControllerTestJson)
      gateway.respond("sessions.patch") { throw IllegalStateException("Rename denied") }
      val controller = backgroundScope.createChatController(requestGateway = gateway::request)
      controller.outboxPresentationRestored.first { it }
      val patch = ChatSessionPatch(key = "custom", ownerAgentId = "main", label = "Renamed")

      assertFalse(controller.patchSession(patch))
      assertEquals("Rename denied", controller.errorText.value)
      assertEquals(0, gateway.callCount("sessions.list"))

      gateway.respondWith("sessions.patch", "{}")
      gateway.respondWith("sessions.list", """{"sessions":[{"key":"custom","label":"Renamed"}]}""")
      assertTrue(controller.patchSession(patch))
      val session = controller.sessions.value.single()
      assertEquals("Renamed", session.label)
      assertEquals(1, gateway.callCount("sessions.list"))
      val patchCalls = gateway.calls.filter { it.method == "sessions.patch" }
      assertEquals(2, patchCalls.size)
      for (call in patchCalls) {
        val params = chatControllerTestJson.parseToJsonElement(requireNotNull(call.paramsJson)).jsonObject
        assertEquals(JsonPrimitive("custom"), params["key"])
        assertEquals(JsonPrimitive("main"), params["agentId"])
        assertEquals(JsonPrimitive("Renamed"), params["label"])
      }
    }
  }
}
