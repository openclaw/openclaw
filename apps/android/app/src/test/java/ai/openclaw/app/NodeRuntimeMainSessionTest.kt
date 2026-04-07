package ai.openclaw.app

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeRuntimeMainSessionTest {
  @Test
  fun applyMainSessionKey_replacesCanonicalNodeSessionWithGatewaySelection() {
    val runtime = newRuntime()

    invokePrivate(runtime, "applyMainSessionKey", "agent:gateway-selected:node-proxy")

    assertEquals("agent:gateway-selected:node-proxy", runtime.mainSessionKey.value)
  }

  @Test
  fun syncMainSessionKey_forwardsUpdatedSessionToWearProxy() =
    runBlocking {
      val runtime = newRuntime()

      invokePrivate(runtime, "syncMainSessionKey", "gateway-selected")

      val forwarded =
        withTimeout(2_000) {
          runtime.wearProxyEvents.first { it.event == "mainSessionKey" }
        }

      assertEquals(runtime.mainSessionKey.value, forwarded.payloadJson)
    }

  private fun newRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun invokePrivate(runtime: NodeRuntime, name: String, arg: String?) {
    val method = runtime.javaClass.getDeclaredMethod(name, String::class.java)
    method.isAccessible = true
    method.invoke(runtime, arg)
  }
}
