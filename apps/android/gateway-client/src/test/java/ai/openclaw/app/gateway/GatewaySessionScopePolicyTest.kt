package ai.openclaw.app.gateway

import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionScopePolicyTest {
  private val requested = listOf("operator.read", "operator.write", "operator.approvals")
  private val granted = requested + listOf("operator.questions", "operator.talk.secrets")
  private val policy = GatewayOperatorScopePolicy(requested.toSet(), setOf("operator.admin", "operator.pairing"))

  @Test
  fun constrainedReconnectSignsOnlyRequestedScopesWithoutNarrowingStoredGrant() =
    runBlocking {
      verifyReconnect(policy, requested)
    }

  @Test
  fun clientsWithoutPolicyKeepStoredScopeBehavior() =
    runBlocking {
      verifyReconnect(null, granted.sorted())
    }

  private suspend fun verifyReconnect(
    policy: GatewayOperatorScopePolicy?,
    expected: List<String>,
  ) {
    val connects = Channel<JsonObject>(Channel.UNLIMITED)
    val connected = Channel<Unit>(Channel.UNLIMITED)
    val server =
      server { params ->
        connects.trySend(params)
        buildJsonObject {
          put("role", "operator")
          put("deviceToken", "watch-owned-token")
          put("scopes", params["scopes"]!!)
        }
      }
    val prefs = freshPrefs()
    val identity = DeviceIdentityStore.withPrefs(RuntimeEnvironment.getApplication(), prefs)
    val tokens = DeviceAuthStore(prefs)
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
    val deviceId = identity.loadOrCreate().deviceId
    assertTrue(tokens.saveToken(endpoint.stableId, deviceId, "operator", "watch-owned-token", granted))
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val session = GatewaySession(scope, identity, tokens, onConnected = { connected.trySend(Unit) }, onDisconnected = {}, onEvent = { _, _ -> })
    try {
      repeat(2) {
        session.connect(endpoint, null, null, null, options("operator", policy))
        val params = withTimeout(8000) { connects.receive() }
        withTimeout(8000) { connected.receive() }
        assertEquals(expected, (params["scopes"] as JsonArray).map { it.jsonPrimitive.content })
        assertTrue(
          params["device"]
            ?.jsonObject
            ?.get("signature")
            ?.jsonPrimitive
            ?.content
            ?.isNotEmpty() == true,
        )
        assertEquals(granted.sorted(), tokens.loadEntry(endpoint.stableId, deviceId, "operator")?.scopes)
        session.disconnectAndJoin()
      }
    } finally {
      session.disconnectAndJoin()
      scope.cancel()
      server.shutdown()
    }
  }

  @Test
  fun privilegedBootstrapHandoffIsRejectedBeforeEitherRoleIsPersisted() =
    runBlocking {
      for (forbidden in listOf("operator.admin", "operator.pairing")) {
        val server =
          server {
            Json
              .parseToJsonElement(
                """{"role":"node","deviceToken":"new-node","scopes":[],"deviceTokens":[{"role":"operator","deviceToken":"new-operator","scopes":["operator.read","$forbidden"]}]}""",
              ).jsonObject
          }
        val prefs = freshPrefs()
        val identity = DeviceIdentityStore.withPrefs(RuntimeEnvironment.getApplication(), prefs)
        val tokens = DeviceAuthStore(prefs)
        val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val failure = CompletableDeferred<Pair<String?, Boolean>>()
        var ready = false
        val handoff = GatewayBootstrapHandoff { error("Rejected grants must not retire bootstrap") }
        val session =
          GatewaySession(
            scope,
            identity,
            tokens,
            onConnected = { ready = true },
            onDisconnected = {},
            onConnectFailure = { error, paused -> failure.complete(error.details?.code to paused) },
            onEvent = { _, _ -> },
          )
        try {
          session.connect(endpoint, null, "fresh-watch-bootstrap", null, options("node", policy), bootstrapHandoff = handoff)
          assertEquals("CLIENT_SCOPE_POLICY" to true, withTimeout(8000) { failure.await() })
          session.disconnectAndJoin()
          assertFalse(ready)
          assertFalse(handoff.completed)
          val deviceId = identity.loadOrCreate().deviceId
          assertNull(tokens.loadEntry(endpoint.stableId, deviceId, "node"))
          assertNull(tokens.loadEntry(endpoint.stableId, deviceId, "operator"))
        } finally {
          session.disconnectAndJoin()
          scope.cancel()
          server.shutdown()
        }
      }
    }

  private fun options(
    role: String,
    policy: GatewayOperatorScopePolicy?,
  ) = GatewayConnectOptions(
    role,
    if (role == "node") emptyList() else requested,
    emptyList(),
    emptyList(),
    emptyMap(),
    GatewayClientInfo("openclaw-android", "Watch test", "test", "android", if (role == "node") "node" else "ui", null, "android", "test"),
    operatorScopePolicy = policy,
  )

  private fun freshPrefs(): GatewayCredentialStore =
    TestGatewayCredentialStore(
      RuntimeEnvironment.getApplication().getSharedPreferences("scope-policy-${UUID.randomUUID()}", Context.MODE_PRIVATE),
    )

  private fun server(auth: (JsonObject) -> JsonObject): MockWebServer =
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
                  webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"scope-test","ts":1700000000123}}""")
                }

                override fun onMessage(
                  webSocket: WebSocket,
                  text: String,
                ) {
                  val frame = Json.parseToJsonElement(text).jsonObject
                  if (frame["method"]?.jsonPrimitive?.content != "connect") return
                  webSocket.send(
                    buildJsonObject {
                      put("type", "res")
                      put("id", frame["id"]!!)
                      put("ok", true)
                      put("payload", buildJsonObject { put("auth", auth(frame["params"]!!.jsonObject)) })
                    }.toString(),
                  )
                }

                override fun onClosing(
                  webSocket: WebSocket,
                  code: Int,
                  reason: String,
                ) {
                  webSocket.close(code, reason)
                }
              },
            )
        }
      start()
    }
}
