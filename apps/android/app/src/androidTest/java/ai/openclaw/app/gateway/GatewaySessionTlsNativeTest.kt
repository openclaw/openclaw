package ai.openclaw.app.gateway

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.security.cert.CertificateException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException

@RunWith(AndroidJUnit4::class)
class GatewaySessionTlsNativeTest {
  @Before
  fun requireAndroidConscrypt() {
    val provider = SSLContext.getInstance("TLS").provider
    assertTrue("Native Android Conscrypt required: $provider", provider.javaClass.name.contains("conscrypt"))
    println("Android TLS provider=${provider.javaClass.name}")
  }

  @Test
  fun platformRootReachesReadyWithMatchingHostname() = runBlocking { assertPinnedConnection(TlsCase.SYSTEM_MATCHING) }

  @Test
  fun platformRootRejectsWrongHostnameBeforeWebSocketUpgrade() = runBlocking { assertPinnedConnection(TlsCase.SYSTEM_WRONG_HOST) }

  @Test
  fun platformRootCannotBypassBlocklistedRawIntermediate() = runBlocking { assertPinnedConnection(TlsCase.SYSTEM_BLOCKLISTED) }

  @Test
  fun matchingLeafPinReachesReadyDespiteDiscoveredIpHostnameMismatch() = runBlocking { assertPinnedConnection(TlsCase.MATCHING) }

  @Test
  fun wrongLeafPinRejectsBeforeWebSocketUpgrade() = runBlocking { assertPinnedConnection(TlsCase.WRONG) }

  @Test
  fun matchingLeafPinCannotBypassBlocklistedRawIntermediate() = runBlocking { assertPinnedConnection(TlsCase.BLOCKLISTED) }

  private suspend fun assertPinnedConnection(case: TlsCase) {
    val fixture = gatewayTlsTestFixture(blocklisted = case.blocklisted, platformTrusted = case.platformTrusted)
    val observation = GatewayTlsTestObservation()
    val connected = CompletableDeferred<Unit>()
    val clients = ConcurrentLinkedQueue<OkHttpClient>()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val server = MockWebServer()
    val session =
      GatewaySession(
        scope = scope,
        identityStore = DeviceIdentityStore(InstrumentationRegistry.getInstrumentation().targetContext),
        deviceAuthStore = NoopTlsDeviceAuthStore(),
        onConnected = { connected.complete(Unit) },
        onDisconnected = {},
        onEvent = { _, _ -> },
        webSocketFactory = { client, request, listener ->
          // Keep the production factory's socket/trust/hostname policy; only observe it.
          observation.observe(client).also { clients.add(it) }.newWebSocket(request, observation.observeWebSocket(listener))
        },
      )
    try {
      server.useHttps(fixture.socketFactory, false)
      server.enqueue(
        MockResponse().withWebSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"tls-test-nonce","ts":1700000000123}}""")
            }

            override fun onMessage(
              webSocket: WebSocket,
              text: String,
            ) {
              val frame = Json.parseToJsonElement(text).jsonObject
              if (frame["method"]?.jsonPrimitive?.content != "connect") return
              val id = frame.getValue("id").jsonPrimitive.content
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{}}""")
            }
          },
        ),
      )
      server.start(InetAddress.getByName("127.0.0.1"), 0)
      session.connect(
        endpoint = GatewayEndpoint.manual(if (case.platformTrusted && case != TlsCase.SYSTEM_WRONG_HOST) "localhost" else "127.0.0.1", server.port, tlsEnabled = true),
        token = null,
        bootstrapToken = null,
        password = null,
        tls =
          GatewayTlsParams(
            if (case.platformTrusted) {
              null
            } else if (case == TlsCase.WRONG) {
              fixture.wrongFingerprint
            } else {
              fixture.fingerprint
            },
          ),
        options =
          GatewayConnectOptions(
            role = "operator",
            scopes = emptyList(),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client = GatewayClientInfo("openclaw-android-test", "Android Test", "test", "android", "ui", "tls-test", "android", "test"),
          ),
      )
      if (case == TlsCase.MATCHING || case == TlsCase.SYSTEM_MATCHING) {
        withTimeout(8_000) { connected.await() }
        assertTrue(session.isReady())
        assertTrue(observation.hostnameAccepted.get())
        assertEquals("/", server.takeRequest(5, TimeUnit.SECONDS)?.path)
        assertEquals(1, server.requestCount)
      } else {
        val failure = withTimeout(8_000) { observation.failure.await() }
        withTimeout(5_000) { session.disconnectAndJoin() }
        assertFalse(connected.isCompleted)
        assertFalse(session.isReady())
        if (case == TlsCase.SYSTEM_BLOCKLISTED) {
          observation.assertPlatformBlocklisted(failure, fixture)
        } else if (case.blocklisted) {
          observation.assertBlocklisted(failure, fixture)
        } else if (case == TlsCase.SYSTEM_WRONG_HOST) {
          assertTrue("TLS must reach hostname validation", observation.peerCertificates.get().isNotEmpty())
          assertTrue(failure.tlsTestCauses().any { it is SSLPeerUnverifiedException && it.message.orEmpty().contains("Hostname 127.0.0.1 not verified") })
          assertFalse(observation.hostnameAccepted.get())
        } else {
          assertTrue(failure.tlsTestCauses().any { it is CertificateException && it.message.orEmpty().contains("fingerprint mismatch") })
          assertFalse(observation.hostnameAccepted.get())
        }
        // TCP/TLS may occur; no origin HTTP or WebSocket upgrade may reach the server.
        assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
        assertEquals(0, server.requestCount)
      }
    } finally {
      try {
        withTimeout(5_000) { session.disconnectAndJoin() }
      } finally {
        scope.cancel()
        try {
          closeGatewayTlsTestClients(*clients.toTypedArray())
        } finally {
          server.shutdown()
        }
      }
    }
  }

  private enum class TlsCase(
    val platformTrusted: Boolean = false,
    val blocklisted: Boolean = false,
  ) {
    MATCHING,
    WRONG,
    BLOCKLISTED(blocklisted = true),
    SYSTEM_MATCHING(platformTrusted = true),
    SYSTEM_WRONG_HOST(platformTrusted = true),
    SYSTEM_BLOCKLISTED(platformTrusted = true, blocklisted = true),
  }

  private class NoopTlsDeviceAuthStore : DeviceAuthTokenStore {
    override fun loadEntry(
      gatewayId: String,
      deviceId: String,
      role: String,
    ): DeviceAuthEntry? = null

    override fun saveToken(
      gatewayId: String,
      deviceId: String,
      role: String,
      token: String,
      scopes: List<String>,
      replacesStoredToken: String?,
    ) = true

    override fun clearToken(
      gatewayId: String,
      deviceId: String,
      role: String,
      onlyIfToken: String?,
    ) = Unit
  }
}
