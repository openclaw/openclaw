package ai.openclaw.app.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerTerminalAckTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalTimeoutAckRemovesOptimisticUserEchoAndSurfacesFailedAcceptance() =
    runTest {
      var requestedMethod: String? = null
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requestedMethod = method
            """{"runId":"run-timeout","status":"timeout"}"""
          },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that times out before start",
          thinkingLevel = "off",
          attachments = emptyList(),
        )

      assertFalse(accepted)
      assertEquals("chat.send", requestedMethod)
      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("Chat failed before the run started; try again.", controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that times out before start"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun nonTerminalStartedAckRetainsOptimisticUserEchoAndPendingRun() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> """{"runId":"run-started","status":"started"}""" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that started",
          thinkingLevel = "off",
          attachments = emptyList(),
        )

      assertTrue(accepted)
      assertEquals(1, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)
      assertTrue(controller.messages.value.hasUserText("message that started"))
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalOkAckClearsOptimisticUserEchoAndRefreshesHistory() =
    runTest {
      val requestedMethods = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requestedMethods += method
            when (method) {
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              "chat.history" ->
                """
                {
                  "sessionId": "session-1",
                  "messages": [
                    { "role": "assistant", "content": "cached success reply", "timestamp": 1 }
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that already completed",
          thinkingLevel = "off",
          attachments = emptyList(),
        )
      advanceUntilIdle()

      assertTrue(accepted)
      assertEquals(listOf("chat.send", "chat.history"), requestedMethods)
      assertEquals(0, controller.pendingRunCount.value)
      assertNull(controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that already completed"))
      assertTrue(controller.messages.value.any { message -> message.role == "assistant" && message.content.any { part -> part.text == "cached success reply" } })
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalErrorAckRemovesOptimisticUserEchoAndSurfacesErrorText() =
    runTest {
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> """{"runId":"run-error","status":"error"}""" },
        )
      controller.handleGatewayEvent("health", null)

      val accepted =
        controller.sendMessageAwaitAcceptance(
          message = "message that errors before start",
          thinkingLevel = "off",
          attachments = emptyList(),
        )

      assertFalse(accepted)
      assertEquals(0, controller.pendingRunCount.value)
      assertEquals("Chat failed before the run started; try again.", controller.errorText.value)
      assertFalse(controller.messages.value.hasUserText("message that errors before start"))
    }

  private fun List<ChatMessage>.hasUserText(text: String): Boolean =
    any { message ->
      message.role == "user" && message.content.any { part -> part.text == text }
    }
}
