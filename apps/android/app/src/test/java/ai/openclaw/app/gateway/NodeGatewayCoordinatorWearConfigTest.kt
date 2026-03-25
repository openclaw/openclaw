package ai.openclaw.app.gateway

import android.content.Context
import ai.openclaw.app.LocationMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.VoiceWakeMode
import ai.openclaw.app.node.ConnectionManager
import java.util.concurrent.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NodeGatewayCoordinatorWearConfigTest {
  private val context: Context = RuntimeEnvironment.getApplication()
  private val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
  private val securePrefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)

  @Before
  fun setUp() {
    plainPrefs.edit().clear().commit()
    securePrefs.edit().clear().commit()
  }

  @Test
  fun buildWearProxyGatewayConfig_returnsNullUntilTlsFingerprintIsTrusted() {
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    val coordinator = newCoordinator(prefs)
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|test",
        name = "Test",
        host = "10.0.0.2",
        port = 18789,
        tlsEnabled = true,
      )

    assertNull(coordinator.buildWearProxyGatewayConfig(endpoint))
  }

  @Test
  fun buildWearProxyGatewayConfig_includesTlsOnlyAfterPinIsStored() {
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    prefs.saveGatewayTlsFingerprint("_openclaw-gw._tcp.|local.|test", "0123abcd")
    prefs.saveGatewayToken("shared-token")
    prefs.saveGatewayBootstrapToken("bootstrap-token")
    prefs.saveGatewayPassword("device-password")
    val coordinator = newCoordinator(prefs)
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|test",
        name = "Test",
        host = "10.0.0.2",
        port = 18789,
        tlsEnabled = true,
      )

    val payload = coordinator.buildWearProxyGatewayConfig(endpoint)

    requireNotNull(payload)
    assertEquals("10.0.0.2", payload.host)
    assertEquals(18789, payload.port)
    assertEquals(true, payload.useTls)
    assertEquals("shared-token", payload.token)
    assertEquals("bootstrap-token", payload.bootstrapToken)
    assertEquals("device-password", payload.password)
    assertEquals("0123abcd", payload.tlsFingerprintSha256)
  }

  private fun newCoordinator(prefs: SecurePrefs): NodeGatewayCoordinator {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    val connectionManager =
      ConnectionManager(
        prefs = prefs,
        cameraEnabled = { true },
        locationMode = { LocationMode.Off },
        voiceWakeMode = { VoiceWakeMode.Off },
        motionActivityAvailable = { false },
        motionPedometerAvailable = { false },
        sendSmsAvailable = { false },
        readSmsAvailable = { false },
        callLogAvailable = { false },
        hasRecordAudioPermission = { false },
        manualTls = { true },
      )
    return NodeGatewayCoordinator(
      context = context,
      scope = scope,
      prefs = prefs,
      connectionManager = connectionManager,
      identityStore = DeviceIdentityStore(context),
      callbacks =
        NodeGatewayCoordinator.Callbacks(
          onOperatorConnected = { _, _, _ -> },
          onOperatorDisconnected = { _ -> },
          onOperatorEvent = { _, _ -> },
          onNodeConnected = { },
          onNodeDisconnected = { _ -> },
          onNodeInvoke = { _ -> throw CancellationException("not used") },
          onStatusChanged = { },
        ),
    )
  }
}
