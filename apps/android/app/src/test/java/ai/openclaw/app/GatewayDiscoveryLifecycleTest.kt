package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayHelloSummary
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.gateway.ServiceInfoNsdShadow
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [ServiceInfoNsdShadow::class])
class GatewayDiscoveryLifecycleTest {
  @Test
  fun discoveryServesRecoveryAndVisibleConsumersWithoutRevivingStaleEndpoints() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val prefs = SecurePrefs(app, securePrefsOverride = app.getSharedPreferences("discovery-lifecycle", Context.MODE_PRIVATE))
      val primaryId = "_openclaw-gw._tcp.|local.|Primary"
      prefs.gatewayRegistry.upsert(GatewayRegistryEntry(primaryId, GatewayRegistryEntryKind.DISCOVERED, "Primary"))
      prefs.gatewayRegistry.setActive(primaryId)
      prefs.saveGatewayTlsFingerprint(primaryId, "aa".repeat(32))
      prefs.setVoiceMicEnabled(true)
      val nsd = shadowOf(app.getSystemService(NsdManager::class.java)) as ServiceInfoNsdShadow
      val runtime =
        NodeRuntime(
          app,
          prefs,
          initialForeground = false,
          tlsFingerprintProbe = { _, _ -> GatewayTlsProbeResult(fingerprintSha256 = "bb".repeat(32), systemTrusted = true) },
        )
      var browser: Job? = null

      fun listeners() = nsd.getDiscoveryListeners("_openclaw-gw._tcp.").orEmpty()

      fun advertise(
        name: String,
        host: String = "127.0.0.1",
      ) = NsdServiceInfo().apply {
        serviceName = name
        serviceType = "_openclaw-gw._tcp."
        port = 18789
        hostAddresses = listOf(InetAddress.getByName(host))
        setAttribute("gatewayTls", "1")
        listeners().single().onServiceFound(this)
        nsd.registrations.last().deliver { onServiceUpdated(this@apply) }
      }

      try {
        // The sticky service's cold background runtime must resolve the saved route, not enable the mic.
        assertEquals(1, listeners().size)
        assertFalse(runtime.isForeground.value)
        assertFalse(prefs.voiceMicEnabled.value)
        advertise("Primary")
        val recovered = withTimeout(5_000) { runtime.pendingGatewayTrust.first { it != null } }!!
        assertEquals(primaryId, recovered.endpoint.stableId)
        assertEquals("127.0.0.1", recovered.endpoint.host)
        runtime.disconnect()
        assertEquals(0, listeners().size)

        runtime.setForeground(true)
        runtime.setForeground(true)
        assertEquals(1, listeners().size)
        val session = ReflectionHelpers.getField<GatewaySession>(runtime, "nodeSession")
        ReflectionHelpers.getField<(GatewayHelloSummary) -> Unit>(session, "onConnected")(
          GatewayHelloSummary(null, null, null, null, null),
        )
        assertEquals(0, listeners().size)

        // Opening Discovered while connected starts a scoped scan; closing it retires callbacks.
        browser = launch(start = CoroutineStart.UNDISPATCHED) { runtime.discoverGateways() }
        assertEquals(1, listeners().size)
        val old = advertise("Primary")
        val retired = nsd.registrations.last()
        advertise("Gone while paused")
        browser.cancelAndJoin()
        assertEquals(0, listeners().size)
        browser = launch(start = CoroutineStart.UNDISPATCHED) { runtime.discoverGateways() }
        assertTrue(runtime.gateways.value.isEmpty())
        retired.deliver { onServiceUpdated(old) }
        assertTrue(runtime.gateways.value.isEmpty())
        advertise("Primary", "127.0.0.2")
        assertEquals(listOf("127.0.0.2"), runtime.gateways.value.map { it.host })

        // An enabled secondary appearing later still needs discovery after the browser closes.
        val secondaryId = "_openclaw-gw._tcp.|local.|Secondary"
        prefs.gatewayRegistry.upsert(GatewayRegistryEntry(secondaryId, GatewayRegistryEntryKind.DISCOVERED, "Secondary"))
        runtime.setGatewayConnectionEnabled(secondaryId, true)
        browser.cancelAndJoin()
        assertEquals(1, listeners().size)
        advertise("Secondary")
        assertTrue(runtime.gateways.value.any { it.stableId == secondaryId })
        runtime.setForeground(false)
        assertEquals(0, listeners().size)
        runtime.setForeground(true)
        assertEquals(1, listeners().size)
        runtime.setGatewayConnectionEnabled(secondaryId, false)
        runtime.setForeground(true)
        assertEquals(0, listeners().size)
        ReflectionHelpers.getField<(String) -> Unit>(session, "onDisconnected")("Connection closed")
        assertEquals(1, listeners().size)
      } finally {
        browser?.cancelAndJoin()
        runtime.setForeground(false)
        closeNodeRuntimeTestFixture(runtime)
      }
    }
}
