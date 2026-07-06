package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControllerModelSelectionTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun successfulSelectionRecordsRecentAndUpdatesSelectedModel() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            "{}"
          },
          recordModelRecent = recents::add,
        )

      assertTrue(controller.setSessionModelAwait("main", " anthropic/claude-opus-4 "))

      assertEquals(listOf("anthropic/claude-opus-4"), recents)
      assertEquals("anthropic/claude-opus-4", controller.selectedModelRef.value)
      assertEquals(
        "sessions.patch" to "{\"key\":\"main\",\"model\":\"anthropic/claude-opus-4\"}",
        requests.single(),
      )
    }

  @Test
  fun failedSelectionDoesNotRecordRecentOrUpdateSelectedModel() =
    runTest {
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, _ -> error("patch failed") },
          recordModelRecent = recents::add,
        )

      assertFalse(controller.setSessionModelAwait("main", "openai/gpt-5"))

      assertEquals(emptyList<String>(), recents)
      assertNull(controller.selectedModelRef.value)
      assertEquals("patch failed", controller.errorText.value)
    }

  @Test
  fun successfulDefaultSelectionDoesNotRecordRecent() =
    runTest {
      val requests = mutableListOf<String?>()
      val recents = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { _, paramsJson ->
            requests += paramsJson
            "{}"
          },
          recordModelRecent = recents::add,
        )

      assertTrue(controller.setSessionModelAwait("main", null))

      assertEquals(emptyList<String>(), recents)
      assertEquals("{\"key\":\"main\",\"model\":null}", requests.single())
    }

  @Test
  fun immediateSendWaitsForPendingModelSelection() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requests += method
            when (method) {
              "sessions.patch" -> {
                patchStarted.complete(Unit)
                releasePatch.await()
                "{}"
              }
              "chat.send" -> """{"runId":"run-ok","status":"ok"}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      controller.setSessionModel("main", "openai/gpt-5")
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = "off",
            attachments = emptyList(),
          )
        }
      yield()

      assertEquals(listOf("sessions.patch"), requests.filter { it == "sessions.patch" || it == "chat.send" })

      releasePatch.complete(Unit)
      assertTrue(send.await())
      assertEquals(
        listOf("sessions.patch", "chat.send"),
        requests.filter { it == "sessions.patch" || it == "chat.send" },
      )
    }

  @Test
  fun immediateSendStopsWhenPendingModelSelectionFails() =
    runTest {
      val patchStarted = CompletableDeferred<Unit>()
      val releasePatch = CompletableDeferred<Unit>()
      val requests = mutableListOf<String>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, _ ->
            requests += method
            when (method) {
              "sessions.patch" -> {
                patchStarted.complete(Unit)
                releasePatch.await()
                error("patch failed")
              }
              "chat.send" -> """{"runId":"run-unexpected","status":"ok"}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      controller.setSessionModel("main", "openai/gpt-5")
      patchStarted.await()
      val send =
        async {
          controller.sendMessageAwaitAcceptance(
            message = "hello",
            thinkingLevel = "off",
            attachments = emptyList(),
          )
        }
      yield()

      releasePatch.complete(Unit)
      assertFalse(send.await())
      assertEquals("patch failed", controller.errorText.value)
      assertFalse("chat.send" in requests)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun historyHydratesSelectedModelAndAgentScopedCatalog() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.history" ->
                """
                {
                  "sessionId": "session-ops",
                  "messages": [],
                  "sessionInfo": {
                    "key": "agent:ops:main",
                    "modelProvider": "anthropic",
                    "model": "claude-opus-4"
                  }
                }
                """.trimIndent()
              "chat.metadata" ->
                """
                {
                  "commands": [],
                  "models": [
                    {
                      "id": "claude-opus-4",
                      "name": "Claude Opus 4",
                      "provider": "anthropic",
                      "available": true,
                      "input": ["text"]
                    }
                  ]
                }
                """.trimIndent()
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )

      controller.load("agent:ops:main")
      advanceUntilIdle()

      assertEquals("anthropic/claude-opus-4", controller.selectedModelRef.value)
      assertEquals(
        "claude-opus-4",
        controller.modelCatalog.value
          .single()
          .id,
      )
      val metadataRequest = requests.single { it.first == "chat.metadata" }
      assertTrue(metadataRequest.second.orEmpty().contains("\"agentId\":\"ops\""))
    }
}
