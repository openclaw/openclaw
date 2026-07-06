package ai.openclaw.app.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceUntilIdle
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

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun healthEventRefreshesCommandsAfterReconnect() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "commands.list" ->
                """
                {
                  "commands": [
                    {
                      "name": "model",
                      "description": "Switch models",
                      "textAliases": ["/model"],
                      "acceptsArgs": true
                    }
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("/model"), controller.commands.value.single().textAliases)

      controller.onDisconnected("gateway closed")
      assertEquals(emptyList<ChatCommandEntry>(), controller.commands.value)

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("/model"), controller.commands.value.single().textAliases)
      assertEquals(2, requests.count { it.first == "commands.list" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun commandListScopesToActiveAgentAndRefreshesAfterAgentSwitch() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "commands.list" ->
                if (paramsJson.orEmpty().contains("\"agentId\":\"ops\"")) {
                  """
                  {
                    "commands": [
                      {
                        "name": "ops",
                        "description": "Ops command",
                        "textAliases": ["/ops"],
                        "acceptsArgs": false
                      }
                    ]
                  }
                  """.trimIndent()
                } else {
                  """
                  {
                    "commands": [
                      {
                        "name": "main",
                        "description": "Main command",
                        "textAliases": ["/main"],
                        "acceptsArgs": false
                      }
                    ]
                  }
                  """.trimIndent()
                }
              "chat.history" -> """{"sessionId":"loaded-session","messages":[]}"""
              "health" -> "{}"
              else -> "{}"
            }
          },
        )

      controller.handleGatewayEvent("health", null)
      advanceUntilIdle()
      assertEquals(listOf("/main"), controller.commands.value.single().textAliases)

      controller.switchSession("agent:ops:dashboard:parent")
      advanceUntilIdle()
      assertEquals(listOf("/ops"), controller.commands.value.single().textAliases)

      val commandRequests = requests.filter { it.first == "commands.list" }
      assertTrue(commandRequests.any { it.second.orEmpty().contains("\"agentId\":\"main\"") })
      assertTrue(commandRequests.any { it.second.orEmpty().contains("\"agentId\":\"ops\"") })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatCreatesWriteScopedSessionAndReloadsHistory() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
              "chat.history" -> """{"sessionId":"fresh-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"main\""))
      assertTrue(create.second.orEmpty().contains("\"parentSessionKey\":\"main\""))
      assertTrue(create.second.orEmpty().contains("\"emitCommandHooks\":true"))
      assertTrue(create.second.orEmpty().contains("\"label\":\"New chat\""))
      assertEquals("agent:main:dashboard:fresh", controller.sessionKey.value)
      assertEquals("fresh-session", controller.sessionId.value)
      assertTrue(requests.any { it.first == "chat.history" })
      assertTrue(requests.any { it.first == "sessions.list" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatInWorktreeIncludesWorktreeFlag() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:worktree"}"""
              "chat.history" -> """{"sessionId":"worktree-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)
      controller.load("main")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait(worktree = true))

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"worktree\":true"))
    }

  @Test
  fun startNewChatWithoutLoadedParentCreatesFirstSession() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:first"}"""
              "chat.history" -> """{"sessionId":"first-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"main\""))
      assertEquals(false, create.second.orEmpty().contains("\"parentSessionKey\""))
      assertEquals(false, create.second.orEmpty().contains("\"emitCommandHooks\""))
      assertEquals("agent:main:dashboard:first", controller.sessionKey.value)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatUsesNextAvailableNewChatLabel() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:main:dashboard:fresh-3"}"""
              "chat.history" -> """{"sessionId":"fresh-session-3","messages":[]}"""
              "health" -> "{}"
              "sessions.list" ->
                """
                {
                  "sessions": [
                    {"key":"agent:main:dashboard:fresh","displayName":"New chat"},
                    {"key":"agent:main:dashboard:fresh-2","displayName":"New chat 2"}
                  ]
                }
                """.trimIndent()
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)
      controller.refreshSessions()
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"label\":\"New chat 3\""))
      assertEquals("agent:main:dashboard:fresh-3", controller.sessionKey.value)
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatScopesCreateToActiveAgentSession() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> """{"ok":true,"key":"agent:ops:dashboard:fresh"}"""
              "chat.history" -> """{"sessionId":"ops-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )

      controller.switchSession("agent:ops:dashboard:parent")
      advanceUntilIdle()

      assertTrue(controller.startNewChatAwait())

      val create = requests.first { it.first == "sessions.create" }
      assertTrue(create.second.orEmpty().contains("\"agentId\":\"ops\""))
      assertTrue(create.second.orEmpty().contains("\"parentSessionKey\":\"agent:ops:dashboard:parent\""))
      assertEquals("agent:ops:dashboard:fresh", controller.sessionKey.value)
    }

  @Test
  fun bareNewSlashCommandUsesGatewayChatCommandPath() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.send" -> """{"runId":"run-new"}"""
              "health" -> "{}"
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("/new", "off", emptyList()))

      val send = requests.single { it.first == "chat.send" }
      assertTrue(send.second.orEmpty().contains("\"message\":\"/new\""))
      assertTrue(requests.none { it.first == "sessions.create" })
    }

  @Test
  fun startNewChatRejectsWhileRunPending() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "chat.send" -> """{"runId":"run-1"}"""
              "health" -> "{}"
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertTrue(controller.sendMessageAwaitAcceptance("hello", "off", emptyList()))
      assertEquals(1, controller.pendingRunCount.value)
      assertEquals(false, controller.startNewChatAwait())
      assertTrue(requests.none { it.first == "sessions.create" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatRejectsDuplicateCreateWhileFirstRequestIsPending() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      val createEntered = CompletableDeferred<Unit>()
      val releaseCreate = CompletableDeferred<Unit>()
      var createCount = 0
      val controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> {
                createCount += 1
                createEntered.complete(Unit)
                releaseCreate.await()
                """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
              }
              "chat.history" -> """{"sessionId":"fresh-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      val first = async { controller.startNewChatAwait() }
      createEntered.await()

      val second = async { controller.startNewChatAwait() }
      advanceUntilIdle()
      releaseCreate.complete(Unit)

      assertTrue(first.await())
      assertEquals(false, second.await())
      assertEquals(1, createCount)
      assertEquals(1, requests.count { it.first == "sessions.create" })
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun startNewChatIgnoresStaleCreateResponseAfterSessionSwitch() =
    runTest {
      val requests = mutableListOf<Pair<String, String?>>()
      lateinit var controller: ChatController
      controller =
        ChatController(
          scope = this,
          json = json,
          requestGateway = { method, paramsJson ->
            requests += method to paramsJson
            when (method) {
              "sessions.create" -> {
                controller.switchSession("agent:main:dashboard:other")
                """{"ok":true,"key":"agent:main:dashboard:fresh"}"""
              }
              "chat.history" -> """{"sessionId":"other-session","messages":[]}"""
              "health" -> "{}"
              "sessions.list" -> """{"sessions":[]}"""
              else -> "{}"
            }
          },
        )
      controller.handleGatewayEvent("health", null)

      assertEquals(false, controller.startNewChatAwait())
      advanceUntilIdle()
      assertEquals("agent:main:dashboard:other", controller.sessionKey.value)
      assertEquals("other-session", controller.sessionId.value)
      assertTrue(requests.any { it.first == "sessions.create" })
    }
}
