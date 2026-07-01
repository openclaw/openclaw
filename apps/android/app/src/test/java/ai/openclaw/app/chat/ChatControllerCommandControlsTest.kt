package ai.openclaw.app.chat

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerCommandControlsTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parseChatCommandsKeepsTextAliasesAndArgumentFlag() {
    val commands =
      parseChatCommands(
        json,
        """
        {
          "commands": [
            {
              "name": "new",
              "description": "Start a fresh chat",
              "category": "session",
              "textAliases": ["/new", "/reset"],
              "acceptsArgs": false
            },
            {
              "name": "/model",
              "description": "Switch models",
              "category": "options",
              "textAliases": ["model", "/model"],
              "acceptsArgs": true
            }
          ]
        }
        """.trimIndent(),
      )

    assertEquals(2, commands.size)
    assertEquals("new", commands[0].name)
    assertEquals(listOf("/new", "/reset"), commands[0].textAliases)
    assertEquals(false, commands[0].acceptsArgs)
    assertEquals("model", commands[1].name)
    assertEquals(listOf("/model"), commands[1].textAliases)
    assertEquals(true, commands[1].acceptsArgs)
  }

  @Test
  fun startNewChatUsesSessionsResetWithNewReasonAndReloadsHistory() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.reset" -> """{"ok":true,"key":"main"}"""
              "chat.history" -> """{"sessionId":"fresh-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.startNewChatAwait())

      val reset = requests.first { it.first == "sessions.reset" }
      assertTrue(reset.second.orEmpty().contains("\"key\":\"main\""))
      assertTrue(reset.second.orEmpty().contains("\"reason\":\"new\""))
      assertEquals("fresh-session", controller.sessionId.value)
      assertTrue(requests.any { it.first == "chat.history" })
      assertTrue(requests.any { it.first == "sessions.list" })
    }
}
