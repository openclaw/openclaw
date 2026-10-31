package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ChatControllerSidebarCreationTest {
  @Test
  fun sidebarCreationKeepsRootsIndependentAndChildrenLinkedForTheSelectedAgent() =
    runTest {
      val parent = "agent:ops:main"
      for (creation in listOf(ChatSessionCreation.Default, ChatSessionCreation.Child(parent))) {
        val (controller, requests) =
          chatControllerTestSetup {
            respond("sessions.create", """{"key":"agent:ops:dashboard:new"}""")
            respond("chat.history", """{"sessionId":"loaded","messages":[]}""")
            respond("sessions.list", """{"sessions":[]}""")
          }
        controller.load(parent)
        advanceUntilIdle()
        assertTrue(controller.startNewChatAwait(creation = creation))
        val params = chatControllerTestJson.parseToJsonElement(requests.single { it.first == "sessions.create" }.second!!).jsonObject
        assertEquals(JsonPrimitive("ops"), params["agentId"])
        if (creation !is ChatSessionCreation.Child) {
          assertEquals(setOf("agentId", "independent"), params.keys)
          assertEquals(JsonPrimitive(true), params["independent"])
        } else {
          val key = params["key"]?.jsonPrimitive?.content.orEmpty()
          assertTrue(key.startsWith("agent:ops:dashboard:"))
          UUID.fromString(key.removePrefix("agent:ops:dashboard:"))
          assertEquals(JsonPrimitive(parent), params["parentSessionKey"])
          assertEquals(JsonPrimitive(true), params["explicitChild"])
          assertEquals(JsonPrimitive(false), params["succeedsParent"])
          assertEquals(JsonPrimitive(true), params["emitCommandHooks"])
        }
        assertEquals("agent:ops:dashboard:new", controller.sessionKey.value)
      }
    }

  @Test
  fun ordinaryNewIsParentlessAfterOpeningAChildOrGrandchild() =
    runTest {
      for (source in listOf("child", "grandchild")) {
        val key = "agent:ops:dashboard:$source"
        val parent = "agent:ops:dashboard:${if (source == "child") "project" else "child"}"
        // Project metadata is deliberately not modeled by Android; it must not leak into New.
        val entry = """{"key":"$key","sessionId":"loaded","parentSessionKey":"$parent","explicitChild":true,"projectId":"project-a","worktree":{"id":"worktree-a"}}"""
        val (controller, requests) =
          chatControllerTestSetup {
            respond("sessions.create", """{"key":"agent:ops:dashboard:new"}""")
            respond("chat.history", """{"sessionId":"loaded","messages":[],"sessionInfo":$entry}""")
            respond("sessions.list", """{"sessions":[$entry]}""")
          }
        controller.load(key)
        advanceUntilIdle()
        controller.refreshSessions()
        advanceUntilIdle()
        val selected = controller.sessions.value.single { it.key == key }
        assertEquals(parent, selected.parentSessionKey)
        assertEquals(true, selected.explicitChild)
        assertEquals("worktree-a", selected.worktreeId)
        assertEquals(key, controller.sessionKey.value)
        assertTrue(controller.startNewChatAwait())
        val params = chatControllerTestJson.parseToJsonElement(requests.single { it.first == "sessions.create" }.second!!).jsonObject
        assertEquals(setOf("agentId", "independent"), params.keys)
        assertEquals(JsonPrimitive(true), params["independent"])
        assertEquals(JsonPrimitive("ops"), params["agentId"])
      }
    }

  @Test
  fun explicitChildNeverFallsBackToAnUnlinkedSessionOnOlderGateways() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history", """{"sessionId":"loaded","messages":[]}""")
          respond("sessions.list", """{"sessions":[]}""")
          respond("sessions.create") {
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "invalid sessions.create params: unexpected property 'explicitChild'",
              ),
            )
          }
        }
      controller.load("main")
      advanceUntilIdle()
      assertFalse(controller.startNewChatAwait(creation = ChatSessionCreation.Child("main")))
      assertEquals(1, requests.count { it.first == "sessions.create" })
      assertEquals("main", controller.sessionKey.value)
      assertEquals("Update your Gateway to create child sessions.", controller.errorText.value)
    }

  @Test
  fun ordinaryNewExplainsOlderGatewayRejectionWithoutRetryingOrNavigating() =
    runTest {
      val (controller, requests) =
        chatControllerTestSetup {
          respond("chat.history", """{"sessionId":"loaded","messages":[]}""")
          respond("sessions.list", """{"sessions":[]}""")
          respond("sessions.create") {
            throw GatewayRequestRejected(
              GatewaySession.ErrorShape(
                code = "INVALID_REQUEST",
                message = "invalid sessions.create params: unexpected property 'independent'",
              ),
            )
          }
        }
      controller.load("main")
      advanceUntilIdle()
      assertFalse(controller.startNewChatAwait())
      assertEquals(1, requests.count { it.first == "sessions.create" })
      assertEquals("main", controller.sessionKey.value)
      assertEquals("Update your Gateway to create independent sessions.", controller.errorText.value)
      assertFalse(controller.isCreatingSession.value)
    }

  @Test
  fun explicitChildRejectsChangedMissingAndLockedParents() =
    runTest {
      for (scenario in listOf("changed", "missing", "locked")) {
        val (controller, requests) =
          chatControllerTestSetup {
            respond(
              "chat.history",
              when (scenario) {
                "missing" -> """{"messages":[]}"""
                "locked" -> """{"sessionId":"loaded","messages":[],"sessionInfo":{"key":"main","agentId":"main","sessionId":"loaded","modelSelectionLocked":true}}"""
                else -> """{"sessionId":"loaded","messages":[]}"""
              },
            )
            respond("sessions.list", """{"sessions":[]}""")
          }
        controller.load("main")
        advanceUntilIdle()
        assertFalse(scenario, controller.startNewChatAwait(creation = ChatSessionCreation.Child(if (scenario == "changed") "old" else "main")))
        assertFalse(requests.any { it.first == "sessions.create" })
        assertTrue(controller.errorText.value != null)
      }
    }
}
