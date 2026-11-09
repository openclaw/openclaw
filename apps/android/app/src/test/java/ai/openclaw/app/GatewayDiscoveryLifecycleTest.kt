package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayHelloSummary
import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import android.net.nsd.NsdManager
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayDiscoveryLifecycleTest {
  @Test
  fun discoveryRunsOnlyWhileForegroundAndDisconnected() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, securePrefsOverride = app.getSharedPreferences("discovery-lifecycle", Context.MODE_PRIVATE))
    val nsd = shadowOf(app.getSystemService(NsdManager::class.java))
    val runtime = NodeRuntime(app, prefs, initialForeground = false)
    fun listeners() = nsd.getDiscoveryListeners("_openclaw-gw._tcp.").orEmpty().size
    try {
      assertEquals(0, listeners())
      runtime.setForeground(true)
      assertEquals(1, listeners())
      runtime.setForeground(true)
      assertEquals(1, listeners())
      runtime.setForeground(false)
      assertEquals(0, listeners())
      runtime.setForeground(true)
      assertEquals(1, listeners())
      val session = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
      ReflectionHelpers.getField<(GatewayHelloSummary) -> Unit>(session, "onConnected")(
        GatewayHelloSummary(null, null, null, null, null),
      )
      assertEquals(0, listeners())
      ReflectionHelpers.getField<(String) -> Unit>(session, "onDisconnected")("Connection closed")
      assertEquals(1, listeners())
    } finally {
      runtime.setForeground(false)
      closeNodeRuntimeTestFixture(runtime)
    }
  }
}
