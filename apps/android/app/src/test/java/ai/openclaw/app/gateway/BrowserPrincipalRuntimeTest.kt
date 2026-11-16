package ai.openclaw.app.gateway

import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
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
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrowserPrincipalRuntimeTest {
  @Test fun oldNodeResponseBeforeNewOperatorCannotSaveOrReconnectWithOldAuthority() = scenario(false)

  @Test fun oldNodeResponseAfterNewOperatorCannotSaveOrReconnectWithOldAuthority() = scenario(true)

  @Test fun alreadyIssuedNodeGrantCannotConsumeFreshEventsAfterAccountReplacement() = scenario(true, nodeAlreadyAdmitted = true)

  private fun scenario(
    releaseAfterOperator: Boolean,
    nodeAlreadyAdmitted: Boolean = false,
  ) {
    var cleanupRuntime: NodeRuntime? = null
    var cleanupGateway: Gateway? = null
    try {
      drainWithMainLooper {
        val app = RuntimeEnvironment.getApplication() as NodeApp
        app
          .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
          .edit()
          .clear()
          .commit()
        val prefs = SecurePrefs(app, app.getSharedPreferences("principal-runtime-" + UUID.randomUUID(), Context.MODE_PRIVATE))
        val profiles = BrowserSessionLifecycleTest.Profiles()
        val owner = withContext(Dispatchers.Main.immediate) { ReverseProxyBrowserSessions(prefs, profiles) }
        val gateway = Gateway().also { cleanupGateway = it }
        val target =
          gateway.server
            .url("/")
            .toString()
            .replace("http:", "https:")
            .toHttpUrl()
        val endpoint = GatewayEndpoint.manual(target.host, target.port, tlsEnabled = true)
        prefs.saveGatewayTlsFingerprint(endpoint.stableId, gateway.fingerprint)
        val login = withContext(Dispatchers.Main.immediate) { owner.begin(target) }
        login.cookies.setCookie(target.toString(), "principal=account-a")
        val runtime = NodeRuntime(app, prefs, browserAuthorizationProvider = owner::authorization, initialReconnectSuppressed = true).also { cleanupRuntime = it }
        val startup =
          ReflectionHelpers
            .getField<CoroutineScope>(runtime, "scope")
            .coroutineContext.job.children
            .toList()
        startup.forEach { it.cancel() }
        startup.joinAll()
        try {
          val operation = checkNotNull(runtime.beginGatewayConnectionOperation { true })
          assertTrue(runtime.configureGatewayAndConnect(endpoint, NodeRuntime.GatewayConnectAuth("synthetic-shared", null, null), operation, false, clearComposer = {}) {})
          val oldNode = withTimeout(10_000) { gateway.nodeA.await() }
          val oldOperator = withTimeout(10_000) { gateway.operatorA.await() }
          val device =
            oldNode.params["device"]!!
              .jsonObject["id"]!!
              .jsonPrimitive.content
          if (nodeAlreadyAdmitted) {
            oldNode.success("node-account-a")
            withTimeout(10_000) { runtime.nodeConnected.first { it } }
          }
          login.cookies.setCookie(target.toString(), "principal=account-b")
          if (!releaseAfterOperator) oldNode.success("node-account-a")
          oldOperator.socket.close(1001, "synthetic operator reconnect")
          val newOperator = withTimeout(10_000) { gateway.operatorB.await() }
          newOperator.success("operator-account-b")
          withTimeout(10_000) {
            login.admission.await()
            runtime.gatewayConnectionDisplay.first { it.isConnected }
          }
          assertTrue(owner.isAdmitted(login))
          if (nodeAlreadyAdmitted) {
            oldNode.socket.send("""{"type":"event","event":"tick","payload":{}}""")
          } else if (releaseAfterOperator) {
            oldNode.success("node-account-a")
          }
          // The old physical node response must be rejected; its replacement authenticates B
          // without ever loading an A token from the same browser profile's role slot.
          val oldOutcome =
            if (nodeAlreadyAdmitted) {
              withTimeout(10_000) { gateway.nodeAClosed.await() }
              "closed"
            } else {
              coroutineScope {
                val ready =
                  async {
                    runtime.nodeConnected.first { it }
                    "accepted"
                  }
                val outcome =
                  withTimeout(10_000) {
                    select<String> {
                      ready.onAwait { it }
                      gateway.nodeAClosed.onAwait { "closed" }
                    }
                  }
                ready.cancelAndJoin()
                outcome
              }
            }
          assertEquals("An old-account node response must retire, never gain the new operator authority", "closed", oldOutcome)
          runtime.refreshGatewayConnection()
          val newNode = withTimeout(10_000) { gateway.nodeB.await() }
          assertEquals(
            device,
            newNode.params["device"]!!
              .jsonObject["id"]!!
              .jsonPrimitive.content,
          )
          assertNull(newNode.params["auth"]?.jsonObject?.get("deviceToken"))
          assertFalse(newNode.params["auth"].toString().contains("node-account-a"))
          val scope = checkNotNull(owner.authorization(endpoint)).deviceCredentialScope(endpoint.stableId)
          assertNull(DeviceAuthStore(prefs).loadToken(scope, device, "node"))
          newNode.success("node-account-b")
          withTimeout(10_000) { runtime.nodeConnected.first { it } }
          assertEquals("node-account-b", DeviceAuthStore(prefs).loadToken(scope, device, "node"))
        } finally {
          withContext(Dispatchers.Main.immediate) { owner.cancel(login) }
        }
      }
    } finally {
      cleanupRuntime?.let(::closeNodeRuntimeTestFixture)
      cleanupGateway?.server?.shutdown()
    }
  }

  private data class Connect(
    val socket: WebSocket,
    val id: String,
    val params: JsonObject,
  ) {
    fun success(token: String) {
      val role = params["role"]!!.jsonPrimitive.content
      val scopes = params["scopes"]?.toString() ?: "[]"
      socket.send("""{"type":"res","id":"$id","ok":true,"payload":{"auth":{"role":"$role","deviceToken":"$token","scopes":$scopes},"features":{"methods":["agents.list"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""")
    }
  }

  private class Gateway {
    val operatorA = CompletableDeferred<Connect>()
    val operatorB = CompletableDeferred<Connect>()
    val nodeA = CompletableDeferred<Connect>()
    val nodeB = CompletableDeferred<Connect>()
    val nodeAClosed = CompletableDeferred<Unit>()
    private val tls = GatewaySessionCustomHeadersTest().sourceFaviconTls()
    val fingerprint = tls.second
    val server =
      MockWebServer().apply {
        useHttps(tls.first, false)
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  private var isNode = false

                  override fun onOpen(
                    webSocket: WebSocket,
                    response: okhttp3.Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"synthetic-principal","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val m = Json.parseToJsonElement(text).jsonObject
                    val id = m["id"]?.jsonPrimitive?.content ?: return
                    if (m["method"]?.jsonPrimitive?.content == "connect") {
                      val params = m["params"]!!.jsonObject
                      val c = Connect(webSocket, id, params)
                      val a = request.getHeader("Cookie") == "principal=account-a"
                      val node = params["role"]!!.jsonPrimitive.content == "node"
                      isNode = node
                      if (!node && !a && operatorB.isCompleted) {
                        c.success("operator-account-b")
                      } else {
                        (
                          if (node) {
                            if (a) nodeA else nodeB
                          } else {
                            if (a) operatorA else operatorB
                          }
                        ).complete(c)
                      }
                    } else {
                      val payload = if (m["method"]?.jsonPrimitive?.content == "agents.list") """{"agents":[{"id":"main","name":"Synthetic"}],"defaultId":"main"}""" else "{}"
                      webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":$payload}""")
                    }
                  }

                  override fun onClosed(
                    webSocket: WebSocket,
                    code: Int,
                    reason: String,
                  ) {
                    if (isNode && request.getHeader("Cookie") == "principal=account-a") nodeAClosed.complete(Unit)
                  }

                  override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: okhttp3.Response?,
                  ) {
                    if (isNode && request.getHeader("Cookie") == "principal=account-a") nodeAClosed.complete(Unit)
                  }
                },
              )
          }
        start()
      }
  }
}
