package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SessionDiffRuntimeTest {
  private val endpoint = GatewayEndpoint.manual("127.0.0.1", 18789)
  private val sessionKey = "agent:coder:review-session"
  private val snapshot = """{"sessionKey":"$sessionKey","files":[],"additions":0,"deletions":0}"""

  private var runtimeForCleanup: NodeRuntime? = null

  @After
  fun tearDown() {
    runtimeForCleanup?.let(::closeNodeRuntimeTestFixture)
  }

  @Test
  fun requestKeepsConversationOwnerAndUncommittedScope() =
    runBlocking {
      val runtime = createRuntime()
      runtime.gatewayDataRequestOverrideForTests = { gatewayId, method, params ->
        assertEquals(endpoint.stableId, gatewayId)
        assertEquals("sessions.diff", method)
        val request = Json.parseToJsonElement(requireNotNull(params)).jsonObject
        assertEquals(sessionKey, request["sessionKey"]?.jsonPrimitive?.content)
        assertEquals("coder", request["agentId"]?.jsonPrimitive?.content)
        assertEquals("uncommitted", request["scope"]?.jsonPrimitive?.content)
        assertFalse(request.containsKey("commit"))
        snapshot
      }
      assertEquals(
        sessionKey,
        runtime.loadSessionDiff(sessionKey, "coder", endpoint.stableId).sessionKey,
      )
    }

  @Test
  fun staleGatewayOwnerDoesNotSendRequest() {
    val runtime = createRuntime()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ -> error("must not request another gateway") }
    assertThrows(CancellationException::class.java) {
      runBlocking { runtime.loadSessionDiff(sessionKey, "coder", expectedGatewayStableId = "other") }
    }
  }

  @Test
  fun gatewayChangeDuringRequestDiscardsSnapshot() {
    val runtime = createRuntime()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ ->
      setField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18790))
      snapshot
    }
    assertThrows(CancellationException::class.java) {
      runBlocking {
        runtime.loadSessionDiff(sessionKey, "coder", expectedGatewayStableId = endpoint.stableId)
      }
    }
  }

  @Test
  fun mismatchedSessionResponseIsRejected() {
    val runtime = createRuntime()
    runtime.gatewayDataRequestOverrideForTests = { _, _, _ -> snapshot.replace(sessionKey, "agent:other:session") }
    assertThrows(IllegalStateException::class.java) {
      runBlocking {
        runtime.loadSessionDiff(sessionKey, "coder", expectedGatewayStableId = endpoint.stableId)
      }
    }
  }

  private fun createRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val prefs = app.getSharedPreferences("openclaw.diff.test.${UUID.randomUUID()}", android.content.Context.MODE_PRIVATE)
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = prefs)).also {
      runtimeForCleanup = it
      setField(it, "connectedEndpoint", endpoint)
    }
  }

  private fun setField(
    runtime: NodeRuntime,
    name: String,
    value: Any?,
  ) {
    NodeRuntime::class.java
      .getDeclaredField(name)
      .apply { isAccessible = true }
      .set(runtime, value)
  }
}
