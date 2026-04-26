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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.lang.reflect.Field

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

  @Test
  fun buildWearProxyGatewayConfig_usesStoredOperatorTokenWhenNoSharedTokenExists() {
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    prefs.saveGatewayTlsFingerprint("_openclaw-gw._tcp.|local.|test", "0123abcd")
    val identityStore = DeviceIdentityStore(context)
    val identity = identityStore.loadOrCreate()
    DeviceAuthStore(prefs).saveToken(
      identity.deviceId,
      role = "operator",
      token = "stored-operator-token",
      scopes = listOf("operator.read"),
    )
    val coordinator = newCoordinator(prefs, identityStore)
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
    assertEquals("stored-operator-token", payload.token)
    assertNull(payload.bootstrapToken)
    assertNull(payload.password)
  }

  @Test
  fun refreshOperatorPlanAfterNodeBootstrap_promotesStoredOperatorSessionAuth() {
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    val identityStore = DeviceIdentityStore(context)
    val coordinator = newCoordinator(prefs, identityStore)
    val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
    val bootstrapAuth = GatewayConnectAuth(token = null, bootstrapToken = "bootstrap-1", password = null)

    writeField(coordinator, "connectedEndpoint", endpoint)
    writeField(coordinator, "desiredNodeConnectAuth", bootstrapAuth)
    writeField(coordinator, "shouldConnectOperator", false)

    val identity = identityStore.loadOrCreate()
    DeviceAuthStore(prefs).saveToken(
      identity.deviceId,
      role = "operator",
      token = "operator-device-token",
      scopes = listOf("operator.read"),
    )

    coordinator.refreshOperatorPlanAfterNodeBootstrap()

    assertTrue(readField(coordinator, "shouldConnectOperator"))
    assertEquals("Connecting…", coordinator.operatorStatusText.value)
    assertEquals(
      GatewayConnectAuth(token = null, bootstrapToken = null, password = null),
      readField<GatewayConnectAuth?>(coordinator, "desiredOperatorConnectAuth"),
    )

    val desired = readField<Any?>(coordinator.operatorSession, "desired")
    assertNotNull(desired)
    assertEquals(endpoint, readField(desired!!, "endpoint"))
    assertNull(readField<String?>(desired, "token"))
    assertNull(readField<String?>(desired, "bootstrapToken"))
    assertNull(readField<String?>(desired, "password"))
  }

  @Test
  fun refreshConnection_recomputesDesiredAuthFromCurrentPrefs() {
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)
    val coordinator = newCoordinator(prefs)
    val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)

    prefs.saveGatewayToken("fresh-shared-token")
    prefs.saveGatewayBootstrapToken("")
    prefs.saveGatewayPassword("")
    writeField(coordinator, "connectedEndpoint", endpoint)
    writeField(
      coordinator,
      "desiredNodeConnectAuth",
      GatewayConnectAuth(token = "stale-token", bootstrapToken = "stale-bootstrap", password = "stale-password"),
    )
    writeField(
      coordinator,
      "desiredOperatorConnectAuth",
      GatewayConnectAuth(token = "stale-token", bootstrapToken = null, password = null),
    )
    writeField(coordinator, "shouldConnectOperator", false)

    coordinator.refreshConnection()

    assertEquals(
      GatewayConnectAuth(token = "fresh-shared-token", bootstrapToken = null, password = null),
      readField<GatewayConnectAuth?>(coordinator, "desiredNodeConnectAuth"),
    )
    assertEquals(
      GatewayConnectAuth(token = "fresh-shared-token", bootstrapToken = null, password = null),
      readField<GatewayConnectAuth?>(coordinator, "desiredOperatorConnectAuth"),
    )
    assertTrue(readField(coordinator, "shouldConnectOperator"))

    val desired = readField<Any?>(coordinator.nodeSession, "desired")
    assertNotNull(desired)
    assertEquals(endpoint, readField(desired!!, "endpoint"))
    assertEquals("fresh-shared-token", readField<String?>(desired, "token"))
    assertNull(readField<String?>(desired, "bootstrapToken"))
    assertNull(readField<String?>(desired, "password"))
  }

  private fun newCoordinator(
    prefs: SecurePrefs,
    identityStore: DeviceIdentityStore = DeviceIdentityStore(context),
  ): NodeGatewayCoordinator {
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
        smsSearchPossible = { false },
        callLogAvailable = { false },
        hasRecordAudioPermission = { false },
        manualTls = { true },
      )
    return NodeGatewayCoordinator(
      context = context,
      scope = scope,
      prefs = prefs,
      connectionManager = connectionManager,
      identityStore = identityStore,
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

  private fun writeField(target: Any, name: String, value: Any?) {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        field.set(target, value)
        return
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }

  private fun <T> readField(target: Any, name: String): T {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(target) as T
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }
}
