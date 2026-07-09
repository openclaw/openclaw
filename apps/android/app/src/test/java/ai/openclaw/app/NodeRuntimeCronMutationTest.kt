package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.CopyOnWriteArrayList

private const val CRON_CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-cron-test-nonce"}}"""

@RunWith(RobolectricTestRunner::class)
class NodeRuntimeCronMutationTest {
  private val servers = mutableListOf<MockWebServer>()

  @After
  fun tearDown() {
    servers.forEach { server ->
      runCatching { server.shutdown() }
    }
  }

  @Test
  fun adminOperatorSessionSendsCronMutationRequestsToGateway() =
    runBlocking(Dispatchers.Default) {
      val gateway = startCronGateway(operatorScopes = listOf("operator.admin", "operator.read", "operator.write"))
      val runtime = createRuntime()
      try {
        runtime.connect(
          endpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = gateway.server.port),
          auth = NodeRuntime.GatewayConnectAuth(token = "shared-token", bootstrapToken = null, password = null),
        )

        waitUntil { runtime.isConnected.value && runtime.cronMutationAvailable.value }
        runtime.refreshCronJobs()
        waitUntil { runtime.cronJobs.value.any { it.id == "job-1" } }

        runtime.runCronJob("job-1")
        val run = gateway.awaitMethod("cron.run")
        assertEquals("job-1", run.stringParam("id"))
        assertEquals("force", run.stringParam("mode"))

        runtime.setCronJobEnabled(id = "job-1", enabled = false)
        val toggle = gateway.awaitMethod("cron.update")
        assertEquals("job-1", toggle.stringParam("id"))
        assertEquals(
          false,
          toggle.params.jsonObject["patch"]
            ?.jsonObject
            ?.get("enabled")
            ?.jsonPrimitive
            ?.content
            ?.toBooleanStrict(),
        )

        runtime.updateCronJob(
          GatewayCronJobUpdate(
            id = "job-1",
            name = "Updated cron",
            description = "Updated from Android",
            enabled = true,
            deleteAfterRun = false,
            scheduleKind = "cron",
            scheduleAt = "",
            scheduleEveryMs = null,
            scheduleCronExpr = "*/5 * * * *",
            scheduleTimezone = "UTC",
            scheduleStaggerMs = 0,
            scheduleCommand = "",
            scheduleCwd = "",
            sessionTarget = "isolated",
            wakeMode = "next-heartbeat",
            payloadKind = "agentTurn",
            payloadText = "Run Android cron proof",
            payloadModel = "",
            payloadThinking = "",
            payloadCommandArgvJson = "",
            payloadCommandCwd = "",
          ),
        )
        val update = gateway.awaitMethod("cron.update")
        val patch = update.params.jsonObject["patch"]!!.jsonObject
        assertEquals("Updated cron", patch["name"]?.jsonPrimitive?.content)
        assertEquals(
          "*/5 * * * *",
          patch["schedule"]
            ?.jsonObject
            ?.get("expr")
            ?.jsonPrimitive
            ?.content,
        )
        assertEquals(
          "Run Android cron proof",
          patch["payload"]
            ?.jsonObject
            ?.get("message")
            ?.jsonPrimitive
            ?.content,
        )

        runtime.deleteCronJob("job-1")
        val remove = gateway.awaitMethod("cron.remove")
        assertEquals("job-1", remove.stringParam("id"))
      } finally {
        runtime.disconnect()
      }
    }

  @Test
  fun nonAdminOperatorSessionBlocksCronMutationRequests() =
    runBlocking(Dispatchers.Default) {
      val gateway = startCronGateway(operatorScopes = listOf("operator.read", "operator.write"))
      val runtime = createRuntime()
      try {
        runtime.connect(
          endpoint = GatewayEndpoint.manual(host = "127.0.0.1", port = gateway.server.port),
          auth = NodeRuntime.GatewayConnectAuth(token = "bounded-token", bootstrapToken = null, password = null),
        )

        waitUntil { runtime.isConnected.value }
        assertFalse(runtime.cronMutationAvailable.value)

        runtime.runCronJob("job-1")

        val errorText = runtime.cronErrorText.value.orEmpty()
        assertTrue(errorText.contains("admin operator access"))
        assertFalse(gateway.requests.any { it.method == "cron.run" })
      } finally {
        runtime.disconnect()
      }
    }

  private fun createRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.cron.mutation.test.${System.nanoTime()}",
        Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setManualTls(false)
    return NodeRuntime(app, prefs)
  }

  private fun startCronGateway(operatorScopes: List<String>): CronGatewayHarness {
    val json = Json { ignoreUnknownKeys = true }
    val requests = CopyOnWriteArrayList<CronGatewayRequest>()
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    webSocket.send(CRON_CONNECT_CHALLENGE_FRAME)
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val frame = json.parseToJsonElement(text).jsonObject
                    if (frame["type"]?.jsonPrimitive?.content != "req") return
                    val id = frame["id"]?.jsonPrimitive?.content ?: return
                    val method = frame["method"]?.jsonPrimitive?.content ?: return
                    val params = frame["params"] as? JsonObject ?: buildJsonObject { }
                    requests += CronGatewayRequest(method = method, params = params)
                    webSocket.send(responseFor(id = id, method = method, params = params, operatorScopes = operatorScopes))
                  }
                },
              )
          }
        start()
      }
    servers += server
    return CronGatewayHarness(server = server, requests = requests)
  }

  private fun responseFor(
    id: String,
    method: String,
    params: JsonObject,
    operatorScopes: List<String>,
  ): String =
    when (method) {
      "connect" -> connectResponse(id = id, role = params["role"]?.jsonPrimitive?.content ?: "node", operatorScopes = operatorScopes)
      "cron.status" -> """{"type":"res","id":"$id","ok":true,"payload":{"enabled":true,"jobs":1,"nextWakeAtMs":4102444800000}}"""
      "cron.list" -> """{"type":"res","id":"$id","ok":true,"payload":{"jobs":[${cronJobJson()}]}}"""
      "cron.get" -> """{"type":"res","id":"$id","ok":true,"payload":{"job":${cronJobJson()}}}"""
      "cron.runs" ->
        """
        {
          "type":"res",
          "id":"$id",
          "ok":true,
          "payload":{
            "entries":[{
              "ts":4102444800000,
              "runId":"run-1",
              "status":"ok",
              "summary":"proof run",
              "durationMs":128
            }]
          }
        }
        """.trimIndent()
      else -> """{"type":"res","id":"$id","ok":true,"payload":{"ok":true}}"""
    }

  private fun connectResponse(
    id: String,
    role: String,
    operatorScopes: List<String>,
  ): String {
    val scopes = if (role == "operator") operatorScopes else emptyList()
    val scopeJson = scopes.joinToString(",") { "\"$it\"" }
    return """
      {
        "type":"res",
        "id":"$id",
        "ok":true,
        "payload":{
          "server":{"host":"cron-proof","version":"test"},
          "auth":{"deviceToken":"$role-token","role":"$role","scopes":[$scopeJson]},
          "snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}
        }
      }
      """.trimIndent()
  }

  private fun cronJobJson(): String =
    """
    {
      "id":"job-1",
      "name":"Android Cron Proof",
      "description":"Proof job",
      "enabled":true,
      "deleteAfterRun":false,
      "schedule":{"kind":"cron","expr":"0 9 * * *","tz":"UTC"},
      "sessionTarget":"isolated",
      "wakeMode":"next-heartbeat",
      "payload":{"kind":"agentTurn","message":"proof"},
      "delivery":{"mode":"none"},
      "failureAlert":false,
      "createdAt":4102440000000,
      "updatedAt":4102440000000,
      "state":{
        "nextRunAtMs":4102444800000,
        "lastStatus":"ok",
        "lastRunAtMs":4102441200000,
        "lastDurationMs":128,
        "consecutiveErrors":0
      }
    }
    """.trimIndent()

  private suspend fun CronGatewayHarness.awaitMethod(method: String): CronGatewayRequest =
    withTimeout(10_000) {
      while (true) {
        requests.firstOrNull { it.method == method }?.let { request ->
          requests.remove(request)
          return@withTimeout request
        }
        delay(25)
      }
      error("unreachable")
    }

  private suspend fun waitUntil(predicate: () -> Boolean) {
    withTimeout(10_000) {
      while (!predicate()) delay(25)
    }
  }

  private fun CronGatewayRequest.stringParam(key: String): String? = params.jsonObject[key]?.jsonPrimitive?.content

  private data class CronGatewayHarness(
    val server: MockWebServer,
    val requests: CopyOnWriteArrayList<CronGatewayRequest>,
  )

  private data class CronGatewayRequest(
    val method: String,
    val params: JsonObject,
  )
}
