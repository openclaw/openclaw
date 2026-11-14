package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.OnboardingStep
import ai.openclaw.app.ui.canFinishOnboarding
import ai.openclaw.app.ui.gatewayPairingContinueDestination
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
class GatewayOnboardingLifecycleTest {
  @Test fun admittedOperatorCanLeavePairingWhileOptionalNodeIsPending() =
    runBlocking {
      withRuntime(operatorReady = true) { runtime, gateway, _ ->
        withTimeout(5_000) { gateway.nodeRequested.await() }
        withTimeout(5_000) { runtime.gatewayConnectionDisplay.first { it.isConnected } }
        assertFalse(runtime.nodeConnected.value)
        val ready = canFinishOnboarding(runtime.gatewayConnectionDisplay.value, runtime.gatewayConnectionDisplay.value.targetStableId)
        assertTrue("An admitted operator must not wait indefinitely for optional node approval", ready)
        assertEquals(OnboardingStep.Permissions, gatewayPairingContinueDestination(ready, runtime.nodeCapabilityApproval.value))
      }
    }

  @Test fun admittedNodeCannotStandInForTheOperator() =
    runBlocking {
      withRuntime(operatorReady = false) { runtime, gateway, _ ->
        withTimeout(5_000) { gateway.operatorRequested.await() }
        withTimeout(5_000) { runtime.nodeConnected.first { it } }
        assertFalse(runtime.gatewayConnectionDisplay.value.isConnected)
        assertFalse(canFinishOnboarding(runtime.gatewayConnectionDisplay.value, runtime.gatewayConnectionDisplay.value.targetStableId))
      }
    }

  @Test fun anotherReadySavedGatewayCannotCompleteTheOriginalTarget() =
    runBlocking {
      withRuntime(operatorReady = true) { runtime, original, prefs ->
        val originalId = GatewayEndpoint.manual("127.0.0.1", original.server.port).stableId
        withTimeout(5_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && it.targetStableId == originalId } }
        val second = SyntheticGateway(true)
        try {
          val endpoint = GatewayEndpoint.manual("127.0.0.1", second.server.port)
          val operation = checkNotNull(runtime.beginGatewayConnectionOperation { true })
          assertTrue(
            runtime.configureGatewayAndConnect(endpoint, NodeRuntime.GatewayConnectAuth("synthetic-second", null, null), operation, false, clearComposer = {}) {
              prefs.saveGatewayCredentials(endpoint.stableId, token = "synthetic-second")
              prefs.gatewayRegistry.upsert(GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, "Second synthetic gateway", endpoint.host, endpoint.port, false))
            },
          )
          val display = withTimeout(5_000) { runtime.gatewayConnectionDisplay.first { it.isConnected && it.targetStableId == endpoint.stableId } }
          assertFalse(canFinishOnboarding(display, originalId))
          assertTrue(canFinishOnboarding(display, endpoint.stableId))
          assertEquals(2, prefs.gatewayRegistry.entries.value.size)
        } finally {
          second.server.shutdown()
        }
      }
    }

  private suspend fun withRuntime(
    operatorReady: Boolean,
    action: suspend (NodeRuntime, SyntheticGateway, SecurePrefs) -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    app
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    val prefs = SecurePrefs(app, app.getSharedPreferences("onboarding-lifecycle-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val gateway = SyntheticGateway(operatorReady)
    val runtime = NodeRuntime.forGatewayAuthReset(app, prefs)
    val startup =
      ReflectionHelpers
        .getField<CoroutineScope>(runtime, "scope")
        .coroutineContext.job.children
        .toList()
    startup.forEach { it.cancel() }
    startup.joinAll()
    try {
      val endpoint = GatewayEndpoint.manual("127.0.0.1", gateway.server.port)
      val operation = checkNotNull(runtime.beginGatewayConnectionOperation { true })
      assertTrue(
        runtime.configureGatewayAndConnect(endpoint, NodeRuntime.GatewayConnectAuth("synthetic-shared", null, null), operation, true, clearComposer = {}) {
          prefs.saveGatewayCredentials(endpoint.stableId, token = "synthetic-shared")
          prefs.gatewayRegistry.upsert(GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, "Synthetic gateway", endpoint.host, endpoint.port, false))
        },
      )
      action(runtime, gateway, prefs)
    } finally {
      closeNodeRuntimeTestFixture(runtime)
      gateway.server.shutdown()
    }
  }

  private class SyntheticGateway(
    private val operatorReady: Boolean,
  ) {
    val nodeRequested = CompletableDeferred<Unit>()
    val operatorRequested = CompletableDeferred<Unit>()
    val server =
      MockWebServer().apply {
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse =
              MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: okhttp3.Response,
                  ) {
                    webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"synthetic-nonce","ts":1700000000123}}""")
                  }

                  override fun onMessage(
                    webSocket: WebSocket,
                    text: String,
                  ) {
                    val message = Json.parseToJsonElement(text).jsonObject
                    val id = message["id"]?.jsonPrimitive?.contentOrNull ?: return
                    when (message["method"]?.jsonPrimitive?.contentOrNull) {
                      "connect" -> {
                        val params = message["params"]!!.jsonObject
                        val role = params["role"]!!.jsonPrimitive.content
                        val scopes = params["scopes"]?.toString() ?: "[]"
                        if (role == "node") nodeRequested.complete(Unit) else operatorRequested.complete(Unit)
                        if ((role == "operator") == operatorReady) {
                          webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"synthetic-$role-token","role":"$role","scopes":$scopes},"features":{"methods":["agents.list"]},"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""")
                        } else {
                          webSocket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"NOT_PAIRED","message":"pairing required","details":{"code":"PAIRING_REQUIRED","requestId":"synthetic-$role-request"}}}""")
                        }
                      }

                      "agents.list" -> {
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"agents":[{"id":"main","name":"Synthetic"}],"defaultId":"main"}}""")
                      }

                      else -> {
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
                      }
                    }
                  }
                },
              )
          }
        start()
      }
  }
}
