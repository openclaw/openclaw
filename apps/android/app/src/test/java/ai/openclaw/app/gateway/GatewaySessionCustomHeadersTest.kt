package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import okio.ByteString
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.DERBitString
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.Certificate
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Time
import org.bouncycastle.asn1.x509.V3TBSCertificateGenerator
import org.bouncycastle.asn1.x509.Validity
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.util.Date
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory

private const val TEST_TIMEOUT_MS = 8_000L
private const val CONNECT_CHALLENGE_FRAME =
  """{"type":"event","event":"connect.challenge","payload":{"nonce":"android-test-nonce","ts":1700000000123}}"""

private class NoopDeviceAuthStore : DeviceAuthTokenStore {
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewaySessionCustomHeadersTest {
  @Test
  fun sourceFaviconsUseReadAuthContextPathBoundsAndCurrentConnection() =
    runBlocking {
      assertSourceFavicons(contextPath = "/socket", basePath = "/ui")
    }

  @Test
  fun sourceFaviconsPreserveNativeProxyMountsWithoutDuplicatingExplicitUiPaths() =
    runBlocking {
      for ((contextPath, basePath, encodedPath) in listOf(
        Triple("/openclaw", "", "/openclaw"),
        Triple("/tenant%20mount", "", "/tenant%20mount"),
        Triple("/openclaw", "/openclaw", "/openclaw"),
        Triple("/socket", "/team space", "/team%20space"),
        Triple("/socket", "/知识", "/%E7%9F%A5%E8%AF%86"),
        Triple("/socket", "/team%20space", "/team%20space"),
      )) {
        assertSourceFavicons(contextPath, basePath, expectedBasePath = encodedPath)
      }
    }

  @Test
  fun sourceFaviconsPreserveTlsProxyAuthorizationAndCanFallBackToGatewayCredentials() =
    runBlocking {
      for (proxyAcceptsRead in listOf(true, false)) {
        assertSourceFavicons(contextPath = "/socket", basePath = "/ui", proxyAcceptsRead = proxyAcceptsRead)
      }
    }

  private suspend fun assertSourceFavicons(
    contextPath: String,
    basePath: String,
    proxyAcceptsRead: Boolean? = null,
    expectedBasePath: String = basePath.ifEmpty { contextPath },
  ) = coroutineScope {
    val connected = CompletableDeferred<Unit>()
    val slowStarted = CompletableDeferred<Unit>()
    val releaseSlow = java.util.concurrent.CountDownLatch(1)
    val iconRequests = ConcurrentLinkedQueue<RecordedRequest>()
    val imageBytes = byteArrayOf(1, 2, 3, 4)
    val tls = if (proxyAcceptsRead != null) sourceFaviconTls() else null
    val proxyAuthorization = "Basic c3ludGhldGljOnByb3h5"
    val expectedAuthorization = if (proxyAcceptsRead == true) listOf(proxyAuthorization) else listOfNotNull(proxyAuthorization.takeIf { tls != null }) + listOf("Bearer issued-device-token", "Bearer shared-token")
    val trap = MockWebServer().apply { start() }
    val server =
      MockWebServer().apply {
        tls?.let { useHttps(it.first, false) }
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              if (request.path == contextPath) {
                if (tls != null && request.getHeader("Authorization") != proxyAuthorization) return MockResponse().setResponseCode(401)
                return MockResponse().withWebSocketUpgrade(
                  object : WebSocketListener() {
                    override fun onOpen(
                      webSocket: WebSocket,
                      response: Response,
                    ) {
                      webSocket.send(CONNECT_CHALLENGE_FRAME)
                    }

                    override fun onMessage(
                      webSocket: WebSocket,
                      text: String,
                    ) {
                      val frame = Json.parseToJsonElement(text).jsonObject
                      if (frame["method"]?.jsonPrimitive?.content == "connect") {
                        val id = frame.getValue("id").jsonPrimitive.content
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"auth":{"deviceToken":"issued-device-token","role":"operator","scopes":["operator.read"]}}}""")
                      }
                    }
                  },
                )
              }
              iconRequests.add(request)
              if (request.path?.startsWith("$expectedBasePath/__openclaw__/link-favicon/") != true) return MockResponse().setResponseCode(404)
              val authorization = request.getHeader("Authorization")
              if (proxyAcceptsRead == true && authorization != proxyAuthorization) return MockResponse().setResponseCode(401)
              if (proxyAcceptsRead != true && authorization != "Bearer shared-token") return MockResponse().setResponseCode(401)
              return when {
                request.path?.endsWith("redirect.example") == true -> {
                  MockResponse().setResponseCode(302).setHeader("Location", trap.url("/must-not-load"))
                }

                request.path?.endsWith("large.example") == true -> {
                  MockResponse().setHeader("Content-Type", "image/png").setChunkedBody(Buffer().write(ByteArray(65_537)), 4_096)
                }

                else -> {
                  if (request.path?.endsWith("slow.example") == true) {
                    slowStarted.complete(Unit)
                    releaseSlow.await(8, java.util.concurrent.TimeUnit.SECONDS)
                  }
                  MockResponse().setHeader("Content-Type", "image/x-icon").setBody(Buffer().write(imageBytes))
                }
              }
            }
          }
        start()
      }
    val sessionScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, tlsEnabled = tls != null, contextPath = contextPath)
    val session =
      GatewaySession(
        scope = sessionScope,
        identityStore = testDeviceIdentityStore(RuntimeEnvironment.getApplication()),
        deviceAuthStore = NoopDeviceAuthStore(),
        onConnected = { connected.complete(Unit) },
        onDisconnected = {},
        onEvent = { _, _ -> },
        customHeadersProvider = {
          check(tls != null) { "Cleartext favicon reads must not access proxy credentials" }
          mapOf("authorization" to proxyAuthorization, "X-Proxy-Route" to "source-proof")
        },
      )
    val config =
      resolveGatewaySourcePreviewConfig(
        Json.parseToJsonElement("""{"gateway":{"controlUi":{"basePath":"$basePath","automaticallyFetchFavicons":true}}}""").jsonObject,
        server.url(contextPath).toString(),
        1L,
      )!!
    try {
      session.connect(
        endpoint = endpoint,
        token = "shared-token",
        bootstrapToken = "never-http-bootstrap",
        password = null,
        tls = tls?.let { GatewayTlsParams(required = true, expectedFingerprint = it.second, allowTOFU = false, stableId = endpoint.stableId) },
        options =
          GatewayConnectOptions(
            role = "operator",
            scopes = listOf("operator.read"),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client = GatewayClientInfo("openclaw-android-test", "Android Test", "1.0.0-test", "android", "ui", "source-test", "android", "test"),
          ),
      )
      withTimeout(TEST_TIMEOUT_MS) { connected.await() }

      suspend fun load(
        host: String,
        current: GatewaySourcePreviewConfig = config,
      ) = session.loadSourceFavicon(endpoint.stableId, current, host) { it() }
      assertNull(load("disabled.example", config.copy(automaticallyFetchFavicons = false)))
      assertTrue(iconRequests.isEmpty())
      assertArrayEquals(imageBytes, load("example.com")?.bytes)
      assertEquals(expectedAuthorization, iconRequests.map { it.getHeader("Authorization") })
      assertTrue(iconRequests.all { it.path == "$expectedBasePath/__openclaw__/link-favicon/example.com" })
      if (tls != null) assertTrue(iconRequests.all { it.getHeader("X-Proxy-Route") == "source-proof" })
      assertArrayEquals(imageBytes, load("example.com")?.bytes)
      assertEquals(expectedAuthorization.size, iconRequests.size)
      assertNull(load("redirect.example"))
      assertEquals(0, trap.requestCount)
      assertNull(load("large.example"))
      val stale = async { load("slow.example") }
      withTimeout(TEST_TIMEOUT_MS) { slowStarted.await() }
      session.disconnect()
      releaseSlow.countDown()
      assertNull(withTimeout(TEST_TIMEOUT_MS) { stale.await() })
      assertNull(load("example.com"))
    } finally {
      releaseSlow.countDown()
      session.disconnect()
      sessionScope.cancel()
      server.shutdown()
      trap.shutdown()
    }
  }

  @Test
  fun managedMediaDownload_usesArtifactTicketWithoutGatewayBearer() = runBlocking { assertManagedMediaDownload(contextPath = "") }

  @Test
  fun managedMediaDownload_preservesGatewayContextPathForEveryMediaType() =
    runBlocking {
      for (contextPath in listOf("/tenant/gw", "/tenant%2Fgw", "/tenant%20gw", "//tenant/gw")) {
        assertManagedMediaDownload(contextPath)
      }
    }

  private suspend fun assertManagedMediaDownload(contextPath: String) =
    coroutineScope {
      val app = RuntimeEnvironment.getApplication()
      val json = Json { ignoreUnknownKeys = true }
      val connected = CompletableDeferred<Unit>()
      val imageRequest = CompletableDeferred<RecordedRequest>()
      val imageBytes = byteArrayOf(1, 2, 3, 4)
      val attachmentId = "11111111-1111-4111-8111-111111111111"
      val artifactId = "artifact_managed_image_$attachmentId"
      val imagePath = "/api/chat/media/outgoing/main/$attachmentId/full?mediaTicket=ticket"
      val videoAttachmentId = "22222222-2222-4222-8222-222222222222"
      val videoArtifactId = "artifact_managed_media_$videoAttachmentId"
      val videoPath = "/api/chat/media/outgoing/main/$videoAttachmentId/full?mediaTicket=video-ticket"
      val videoBytes = byteArrayOf(9, 10, 11, 12)
      val audioAttachmentId = "33333333-3333-4333-8333-333333333333"
      val audioArtifactId = "artifact_managed_media_$audioAttachmentId"
      val audioPath = "/api/chat/media/outgoing/main/$audioAttachmentId/full?mediaTicket=audio-ticket"
      val audioPlaybackPath = "$audioPath&playback=1"
      val audioBytes = byteArrayOf(5, 6, 7, 8)
      val audioRequestCount = AtomicInteger()
      val mediaRequests = ConcurrentLinkedQueue<RecordedRequest>()
      val invalidMediaPaths =
        mapOf(
          "invalid-absolute" to "https://attacker.invalid$imagePath",
          "invalid-authority" to "//attacker.invalid$imagePath",
          "invalid-fragment" to "$imagePath#fragment",
          "invalid-missing-ticket" to imagePath.substringBefore('?'),
          "invalid-empty-ticket" to "${imagePath.substringBefore('?')}?mediaTicket=",
          "invalid-prefix" to "/other/path?mediaTicket=ticket",
        )
      val server =
        MockWebServer().apply {
          dispatcher =
            object : Dispatcher() {
              override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "$contextPath$imagePath") {
                  mediaRequests.add(request)
                  imageRequest.complete(request)
                  return MockResponse()
                    .setHeader("Content-Type", "image/png")
                    .setBody(Buffer().write(imageBytes))
                }
                if (request.path == "$contextPath$videoPath") {
                  mediaRequests.add(request)
                  return MockResponse()
                    .setHeader("Content-Type", "video/mp4")
                    .setBody(Buffer().write(videoBytes))
                }
                if (request.path == "$contextPath$audioPlaybackPath") {
                  mediaRequests.add(request)
                  if (audioRequestCount.incrementAndGet() == 1) {
                    return MockResponse().setResponseCode(202).setBody("""{"status":"preparing"}""")
                  }
                  return MockResponse()
                    .setHeader("Content-Type", "audio/mp4")
                    .setBody(Buffer().write(audioBytes))
                }
                if (request.path != contextPath.ifEmpty { "/" }) {
                  return MockResponse().setResponseCode(404)
                }
                return MockResponse().withWebSocketUpgrade(
                  object : WebSocketListener() {
                    override fun onOpen(
                      webSocket: WebSocket,
                      response: Response,
                    ) {
                      webSocket.send(CONNECT_CHALLENGE_FRAME)
                    }

                    override fun onMessage(
                      webSocket: WebSocket,
                      text: String,
                    ) {
                      val frame = json.parseToJsonElement(text).jsonObject
                      if (frame["type"]?.jsonPrimitive?.content != "req") return
                      val id = frame["id"]?.jsonPrimitive?.content ?: return
                      when (frame["method"]?.jsonPrimitive?.content) {
                        "connect" -> {
                          webSocket.send(
                            """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                          )
                        }

                        "artifacts.download" -> {
                          val requestedArtifactId =
                            frame["params"]
                              ?.jsonObject
                              ?.get("artifactId")
                              ?.jsonPrimitive
                              ?.content
                          val invalidMediaPath = invalidMediaPaths[requestedArtifactId]
                          if (invalidMediaPath != null) {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"artifact":{"id":"$requestedArtifactId","type":"video","mimeType":"video/mp4","download":{"mode":"url"}},"url":"$invalidMediaPath"}}""",
                            )
                          } else if (requestedArtifactId == videoArtifactId) {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"artifact":{"id":"$videoArtifactId","type":"video","mimeType":"video/mp4","download":{"mode":"url"}},"url":"$videoPath"}}""",
                            )
                          } else if (requestedArtifactId == audioArtifactId) {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"artifact":{"id":"$audioArtifactId","type":"audio","mimeType":"audio/mp4","download":{"mode":"url"}},"url":"$audioPath"}}""",
                            )
                          } else {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"url":"$imagePath"}}""",
                            )
                          }
                        }
                      }
                    }
                  },
                )
              }
            }
          start()
        }
      val stableId = "manual|127.0.0.1|${server.port}"
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = NoopDeviceAuthStore(),
          onConnected = { if (!connected.isCompleted) connected.complete(Unit) },
          onDisconnected = {},
          onEvent = { _, _ -> },
          customHeadersProvider = { error("Cleartext transport must not read custom headers") },
        )

      try {
        session.connect(
          endpoint = GatewayEndpoint(stableId, "test", "127.0.0.1", server.port, tlsEnabled = false, contextPath = contextPath),
          token = "bootstrap-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "operator",
              scopes = listOf("operator.read"),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client =
                GatewayClientInfo(
                  id = "openclaw-android-test",
                  displayName = "Android Test",
                  version = "1.0.0-test",
                  platform = "android",
                  mode = "ui",
                  instanceId = "android-test-instance",
                  deviceFamily = "android",
                  modelIdentifier = "test",
                ),
            ),
          tls = null,
        )
        withTimeout(TEST_TIMEOUT_MS) { connected.await() }

        val loaded = session.loadImageArtifact(stableId, "main", "main", artifactId)
        assertArrayEquals(imageBytes, loaded?.bytes)
        assertEquals("image/png", loaded?.mimeType)
        val request = withTimeout(TEST_TIMEOUT_MS) { imageRequest.await() }
        assertNull(request.getHeader("Authorization"))
        assertEquals("image/*", request.getHeader("Accept"))

        val streamed =
          session.loadMediaArtifact(stableId, "main", "main", videoArtifactId, GatewayMediaKind.Video) as GatewayLoadedMedia.Streaming
        assertEquals("http://127.0.0.1:${server.port}$contextPath$videoPath", streamed.url)
        assertEquals("video/*", streamed.headers["Accept"])
        assertEquals("video/mp4", streamed.mimeType)
        assertEquals(false, streamed.retryPreparingPlayback)
        val videoRequest =
          Request
            .Builder()
            .url(streamed.url)
            .apply {
              for ((name, value) in streamed.headers) header(name, value)
            }.build()
        streamed.client.newCall(videoRequest).execute().use { response ->
          assertEquals(200, response.code)
          assertArrayEquals(videoBytes, response.body.bytes())
        }

        val transcodedVideo =
          session.loadMediaArtifact(stableId, "main", "main", videoArtifactId, GatewayMediaKind.Video, true) as GatewayLoadedMedia.Streaming
        assertEquals("http://127.0.0.1:${server.port}$contextPath$videoPath&playback=1", transcodedVideo.url)
        assertTrue(transcodedVideo.retryPreparingPlayback)

        val audio =
          session.loadMediaArtifact(stableId, "main", "main", audioArtifactId, GatewayMediaKind.Audio, true) as GatewayLoadedMedia.Buffered
        assertArrayEquals(audioBytes, audio.bytes)
        assertEquals(2, audioRequestCount.get())

        val validMediaRequestCount = mediaRequests.size
        for (artifactId in invalidMediaPaths.keys) {
          assertNull(session.loadMediaArtifact(stableId, "main", "main", artifactId, GatewayMediaKind.Video))
        }
        assertEquals(validMediaRequestCount, mediaRequests.size)
        assertTrue(mediaRequests.all { it.getHeader("Authorization") == null })
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
      }
    }

  @Test
  fun preparingPlaybackInterceptorRetries202WithoutSurfacingLoadError() {
    val server = MockWebServer()
    server.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"preparing"}"""))
    server.enqueue(MockResponse().setResponseCode(200).setBody("ready"))
    server.start()
    var nowMs = 0L
    val client =
      OkHttpClient
        .Builder()
        .addInterceptor(
          GatewayPreparingPlaybackInterceptor(
            policy = GatewayPlaybackRetryPolicy(maxElapsedMs = 100L, initialDelayMs = 0L, maxDelayMs = 0L),
            nowMs = { nowMs++ },
            sleepMs = {},
          ),
        ).build()

    try {
      client.newCall(Request.Builder().url(server.url("/video?playback=1")).build()).execute().use { response ->
        assertEquals(200, response.code)
        assertEquals("ready", response.body.string())
      }
      assertEquals(2, server.requestCount)
    } finally {
      server.shutdown()
    }
  }

  @Test
  fun preparingPlaybackRetryStopsAtTwoMinuteCap() {
    val retry = GatewayPlaybackRetryState(startedAtMs = 1_000L)

    assertTrue(retry.canAttempt(nowMs = 1_000L))
    assertEquals(500L, retry.nextDelayMs(nowMs = 1_000L))
    assertEquals(false, retry.canAttempt(nowMs = 121_000L))
    assertNull(retry.nextDelayMs(nowMs = 121_001L))
  }

  @Test
  fun preparingPlaybackInterceptorDoesNotStartRequestAfterOvershootingDeadline() {
    val server = MockWebServer()
    server.enqueue(MockResponse().setResponseCode(202).setBody("""{"status":"preparing"}"""))
    server.start()
    var nowMs = 0L
    val client =
      OkHttpClient
        .Builder()
        .addInterceptor(
          GatewayPreparingPlaybackInterceptor(
            policy = GatewayPlaybackRetryPolicy(maxElapsedMs = 2L, initialDelayMs = 1L, maxDelayMs = 1L),
            nowMs = { nowMs },
            sleepMs = { delayMs -> nowMs += delayMs + 1L },
          ),
        ).build()

    try {
      val failure =
        runCatching {
          client.newCall(Request.Builder().url(server.url("/video?playback=1")).build()).execute().use { }
        }.exceptionOrNull()
      assertTrue(failure is java.io.IOException)
      assertEquals(1, server.requestCount)
    } finally {
      server.shutdown()
    }
  }

  @Test
  fun tlsUpgradeRequest_carriesLatestSanitizedHeadersForOnlyThisGateway() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefsBacking =
      app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefsBacking)
    val stableId = "manual|gateway.example|443"
    val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 443)
    val tls = GatewayTlsParams(required = true, expectedFingerprint = "aa".repeat(32), allowTOFU = false, stableId = stableId)

    prefs.saveGatewayCustomHeaders(stableId, mapOf("CF-Access-Client-Id" to "client-id"))
    securePrefsBacking
      .edit()
      .putString(
        "gateway.customHeaders.$stableId",
        """{"CF-Access-Client-Id":"client-id","Host":"smuggled.example"}""",
      ).commit()
    prefs.saveGatewayCustomHeaders("manual|other.example|443", mapOf("X-Other-Gateway" to "leak"))

    val first = buildGatewayWebSocketUpgradeRequest(endpoint, tls, prefs::loadGatewayCustomHeaders)
    assertTrue(first.url.isHttps)
    assertEquals("client-id", first.header("CF-Access-Client-Id"))
    assertNull(first.header("Host"))
    assertNull(first.header("X-Other-Gateway"))

    prefs.saveGatewayCustomHeaders(stableId, mapOf("CF-Access-Client-Id" to "updated-id"))
    val reconnected = buildGatewayWebSocketUpgradeRequest(endpoint, tls, prefs::loadGatewayCustomHeaders)
    assertEquals("updated-id", reconnected.header("CF-Access-Client-Id"))
  }

  @Test
  fun cleartextUpgrade_neverReadsOrSendsStoredCustomHeaders() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefsBacking =
        app.getSharedPreferences("openclaw.node.secure.test.${UUID.randomUUID()}", Context.MODE_PRIVATE)
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefsBacking)

      val handshake = AtomicReference<RecordedRequest?>(null)
      val server = startCapturingGatewayServer { request -> handshake.compareAndSet(null, request) }
      val stableId = "manual|127.0.0.1|${server.port}"
      prefs.saveGatewayCustomHeaders(
        stableId,
        mapOf("CF-Access-Client-Id" to "client-id", "CF-Access-Client-Secret" to "client-secret"),
      )
      val providerRead = AtomicBoolean(false)

      val sessionJob = SupervisorJob()
      val scope = CoroutineScope(sessionJob + Dispatchers.Default)
      val connected = CompletableDeferred<Unit>()
      val session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = NoopDeviceAuthStore(),
          onConnected = { if (!connected.isCompleted) connected.complete(Unit) },
          onDisconnected = {},
          onEvent = { _, _ -> },
          customHeadersProvider = { id ->
            providerRead.set(true)
            prefs.loadGatewayCustomHeaders(id)
          },
          ingressAuthorizationProvider = { error("Cleartext must not read an ingress grant") },
        )

      try {
        session.connect(
          endpoint =
            GatewayEndpoint(
              stableId = stableId,
              name = "test",
              host = "127.0.0.1",
              port = server.port,
              tlsEnabled = false,
            ),
          token = "test-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "node",
              scopes = emptyList(),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client =
                GatewayClientInfo(
                  id = "openclaw-android-test",
                  displayName = "Android Test",
                  version = "1.0.0-test",
                  platform = "android",
                  mode = "node",
                  instanceId = "android-test-instance",
                  deviceFamily = "android",
                  modelIdentifier = "test",
                ),
            ),
          tls = null,
        )
        withTimeout(TEST_TIMEOUT_MS) { connected.await() }

        val request = requireNotNull(handshake.get()) { "no websocket upgrade recorded" }
        assertEquals(false, providerRead.get())
        assertNull(request.getHeader("CF-Access-Client-Id"))
        assertNull(request.getHeader("CF-Access-Client-Secret"))
        assertEquals("127.0.0.1:${server.port}", request.getHeader("Host"))
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
      }
    }

  private fun sourceFaviconTls(): Pair<SSLSocketFactory, String> {
    val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    val algorithm = AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE)
    val subject = X500Name("CN=source-favicon-test")
    val now = System.currentTimeMillis()
    val tbs =
      V3TBSCertificateGenerator()
        .apply {
          setSerialNumber(ASN1Integer.ONE)
          setSignature(algorithm)
          setIssuer(subject)
          setSubject(subject)
          setValidity(Validity(Time(Date(now - 60_000)), Time(Date(now + 86_400_000))))
          setSubjectPublicKeyInfo(SubjectPublicKeyInfo.getInstance(keyPair.public.encoded))
        }.generateTBSCertificate()
    val signature =
      Signature.getInstance("SHA256withRSA").apply {
        initSign(keyPair.private)
        update(tbs.encoded)
      }
    val encoded = Certificate(tbs, algorithm, DERBitString(signature.sign())).encoded
    val certificate = CertificateFactory.getInstance("X.509").generateCertificate(encoded.inputStream())
    val password = charArrayOf()
    val keyStore =
      KeyStore.getInstance("PKCS12").apply {
        load(null, null)
        setKeyEntry("server", keyPair.private, password, arrayOf(certificate))
      }
    val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, password) }
    val factory = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) }.socketFactory
    val fingerprint = MessageDigest.getInstance("SHA-256").digest(encoded).joinToString("") { "%02x".format(it) }
    return factory to fingerprint
  }

  @Test
  fun suspendedIngressCannotCreateSocketAfterDisconnect() =
    runBlocking {
      val started = CompletableDeferred<Unit>()
      val release = CompletableDeferred<Unit>()
      val socketCount = AtomicInteger()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val authorization =
        object : GatewayIngressAuthorization {
          override suspend fun authorizeUpgrade(request: Request): Request {
            started.complete(Unit)
            withContext(NonCancellable) { release.await() }
            return request.newBuilder().header("CF-Access-Token", "test-grant").build()
          }

          override fun requireCurrent(request: Request) = Unit

          override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
        }
      val session =
        ingressSession(scope, authorization, socketFactory = { _, _, _ ->
          socketCount.incrementAndGet()
          throw IOException("unexpected socket creation")
        })
      try {
        connectIngressSession(session)
        withTimeout(TEST_TIMEOUT_MS) { started.await() }
        session.disconnect()
        val drained = async { session.disconnectAndJoin() }
        release.complete(Unit)
        withTimeout(TEST_TIMEOUT_MS) { drained.await() }
        assertEquals(0, socketCount.get())
      } finally {
        release.complete(Unit)
        session.disconnectAndJoin()
        scope.cancel()
      }
    }

  @Test
  fun ingressDenialPausesReconnectUntilExplicitRetry() =
    runBlocking {
      val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val secondAuthorization = CompletableDeferred<Unit>()
      val socketCreated = CompletableDeferred<Unit>()
      val attempts = AtomicInteger()
      val allowed = AtomicBoolean(false)
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val authorization =
        object : GatewayIngressAuthorization {
          override suspend fun authorizeUpgrade(request: Request): Request {
            if (attempts.incrementAndGet() > 1) secondAuthorization.complete(Unit)
            if (!allowed.get()) throw GatewayExternalAuthorizationException("Sign in again")
            return request.newBuilder().header("CF-Access-Token", "test-grant").build()
          }

          override fun requireCurrent(request: Request) = Unit

          override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
        }
      val session =
        ingressSession(
          scope,
          authorization,
          onFailure = { error, pause -> failure.complete(error to pause) },
          socketFactory = { client, request, _ ->
            assertEquals("test-grant", request.header("CF-Access-Token"))
            assertTrue(!client.followRedirects && !client.followSslRedirects)
            socketCreated.complete(Unit)
            throw IOException("test ends before a real socket")
          },
        )
      try {
        connectIngressSession(session)
        val observed = withTimeout(TEST_TIMEOUT_MS) { failure.await() }
        assertEquals("EXTERNAL_AUTH_REQUIRED", observed.first.code)
        assertTrue(observed.second)
        assertNull(withTimeoutOrNull(1000) { secondAuthorization.await() })
        allowed.set(true)
        connectIngressSession(session)
        withTimeout(TEST_TIMEOUT_MS) { socketCreated.await() }
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
      }
    }

  @Test
  fun upgradeFollowUpRetainsItsGrantAndCannotOutliveOwnerRetirement() =
    runBlocking {
      for (mode in listOf("valid", "retire", "expired")) {
        val retire = mode == "retire"
        val valid = AtomicBoolean(true)
        val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
        val server = MockWebServer()
        val firstRequest = CompletableDeferred<Unit>()
        val releaseResponse = CountDownLatch(if (retire) 1 else 0)
        val opened = CompletableDeferred<Unit>()
        val admissions = AtomicInteger()
        val requests = AtomicInteger()
        server.dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              if (requests.incrementAndGet() == 1) {
                firstRequest.complete(Unit)
                check(releaseResponse.await(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
                return MockResponse().setResponseCode(503).setHeader("Retry-After", "0")
              }
              return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {})
            }
          }
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val authorization =
          object : GatewayIngressAuthorization {
            override suspend fun authorizeUpgrade(request: Request): Request {
              admissions.incrementAndGet()
              return request.newBuilder().header("CF-Access-Token", "test-grant").build()
            }

            override fun requireCurrent(request: Request) {
              if (!valid.get()) throw GatewayExternalAuthorizationException()
            }

            override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
          }
        val session =
          ingressSession(scope, authorization, onFailure = { error, pause -> failure.complete(error to pause) }, socketFactory = { client, request, listener ->
            // Use a real loopback upgrade to exercise OkHttp's internal 503 follow-up;
            // endpoint/TLS admission remains covered separately from this transaction test.
            client.newWebSocket(
              request.newBuilder().url(server.url("/upgrade")).build(),
              object : WebSocketListener() {
                override fun onOpen(
                  webSocket: WebSocket,
                  response: Response,
                ) {
                  opened.complete(Unit)
                  if (mode == "expired") valid.set(false)
                  listener.onOpen(webSocket, response)
                }

                override fun onFailure(
                  webSocket: WebSocket,
                  t: Throwable,
                  response: Response?,
                ) = listener.onFailure(webSocket, t, response)

                override fun onClosing(
                  webSocket: WebSocket,
                  code: Int,
                  reason: String,
                ) = listener.onClosing(webSocket, code, reason)

                override fun onClosed(
                  webSocket: WebSocket,
                  code: Int,
                  reason: String,
                ) = listener.onClosed(webSocket, code, reason)
              },
            )
          })
        try {
          connectIngressSession(session)
          withTimeout(TEST_TIMEOUT_MS) { firstRequest.await() }
          val first = requireNotNull(server.takeRequest(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
          assertEquals("test-grant", first.getHeader("CF-Access-Token"))
          if (retire) {
            withTimeout(TEST_TIMEOUT_MS) { session.disconnectAndJoin() }
            releaseResponse.countDown()
            assertNull(server.takeRequest(250, TimeUnit.MILLISECONDS))
            assertTrue(!opened.isCompleted)
          } else {
            withTimeout(TEST_TIMEOUT_MS) { opened.await() }
            val repeated = requireNotNull(server.takeRequest(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
            assertEquals(first.path, repeated.path)
            assertEquals(first.getHeader("Host"), repeated.getHeader("Host"))
            assertEquals("test-grant", repeated.getHeader("CF-Access-Token"))
            if (mode == "expired") {
              val denied = withTimeout(TEST_TIMEOUT_MS) { failure.await() }
              assertEquals("EXTERNAL_AUTH_REQUIRED", denied.first.code)
              assertTrue(denied.second)
            }
          }
          assertEquals(1, admissions.get())
        } finally {
          releaseResponse.countDown()
          session.disconnectAndJoin()
          scope.cancel()
          server.shutdown()
        }
      }
    }

  @Test
  fun rejectedUpgradeClosesPeerBeforeFailureTeardown() =
    runBlocking {
      val valid = AtomicBoolean(true)
      val peerOpened = CompletableDeferred<Unit>()
      val peerClosed = CompletableDeferred<Unit>()
      val responseHeld = CompletableDeferred<Unit>()
      val rawFailure = CompletableDeferred<Throwable>()
      val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val releaseResponse = CountDownLatch(1)
      val releaseFailure = CountDownLatch(1)
      val opened = AtomicInteger()
      val connected = AtomicInteger()
      val server = MockWebServer()
      server.enqueue(
        MockResponse().withWebSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              peerOpened.complete(Unit)
            }

            override fun onFailure(
              webSocket: WebSocket,
              t: Throwable,
              response: Response?,
            ) {
              peerClosed.complete(Unit)
            }
          },
        ),
      )
      server.start()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val authorization =
        object : GatewayIngressAuthorization {
          override suspend fun authorizeUpgrade(request: Request) = request.newBuilder().header("CF-Access-Token", "test-grant").build()

          override fun requireCurrent(request: Request) {
            if (!valid.get()) throw GatewayExternalAuthorizationException()
          }

          override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
        }
      val session =
        ingressSession(
          scope,
          authorization,
          onFailure = { error, pause -> failure.complete(error to pause) },
          onConnected = { connected.incrementAndGet() },
          socketFactory = { client, request, listener ->
            client
              .newBuilder()
              .addInterceptor { chain ->
                val response = chain.proceed(chain.request())
                check(response.code == 101 && response.socket != null)
                responseHeld.complete(Unit)
                check(releaseResponse.await(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
                response
              }.build()
              .newWebSocket(
                request.newBuilder().url(server.url("/upgrade")).build(),
                object : WebSocketListener() {
                  override fun onOpen(
                    webSocket: WebSocket,
                    response: Response,
                  ) {
                    opened.incrementAndGet()
                    listener.onOpen(webSocket, response)
                  }

                  override fun onFailure(
                    webSocket: WebSocket,
                    t: Throwable,
                    response: Response?,
                  ) {
                    rawFailure.complete(t)
                    // Hold application teardown so it cannot mask leaked upgrade streams.
                    check(releaseFailure.await(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
                    listener.onFailure(webSocket, t, response)
                  }
                },
              )
          },
        )
      try {
        connectIngressSession(session)
        withTimeout(TEST_TIMEOUT_MS) {
          peerOpened.await()
          responseHeld.await()
        }
        valid.set(false)
        releaseResponse.countDown()
        assertTrue(withTimeout(TEST_TIMEOUT_MS) { rawFailure.await() } is GatewayExternalAuthorizationException)
        withTimeout(TEST_TIMEOUT_MS) { peerClosed.await() }
        assertEquals(0, opened.get())
        assertEquals(0, connected.get())
        releaseFailure.countDown()
        val denied = withTimeout(TEST_TIMEOUT_MS) { failure.await() }
        assertEquals("EXTERNAL_AUTH_REQUIRED", denied.first.code)
        assertTrue(denied.second)
        assertEquals(1, server.requestCount)
        val request = requireNotNull(server.takeRequest(TEST_TIMEOUT_MS, TimeUnit.MILLISECONDS))
        assertEquals("test-grant", request.getHeader("CF-Access-Token"))
        assertNull(server.takeRequest(250, TimeUnit.MILLISECONDS))
      } finally {
        releaseResponse.countDown()
        releaseFailure.countDown()
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
      }
    }

  @Test
  fun onlyAnExplicitUpgradeChallengePausesForExternalAuthorization() =
    runBlocking {
      for (protected in listOf(false, true)) {
        val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
        val disconnected = CompletableDeferred<Unit>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val authorization =
          object : GatewayIngressAuthorization {
            override suspend fun authorizeUpgrade(request: Request) = request

            override fun requireCurrent(request: Request) = Unit

            override fun rejection(response: Response): GatewayExternalAuthorizationException? =
              if (response.code == 302 && response.header("WWW-Authenticate") == "Cloudflare-Access") {
                GatewayExternalAuthorizationException("Sign in again")
              } else {
                null
              }
          }
        val session =
          ingressSession(
            scope,
            authorization,
            onFailure = { error, pause -> failure.complete(error to pause) },
            socketFactory = { _, request, listener ->
              val socket =
                object : WebSocket {
                  override fun request() = request

                  override fun queueSize() = 0L

                  override fun send(text: String) = false

                  override fun send(bytes: ByteString) = false

                  override fun close(
                    code: Int,
                    reason: String?,
                  ) = true

                  override fun cancel() = Unit
                }
              val response =
                Response
                  .Builder()
                  .request(request)
                  .protocol(Protocol.HTTP_1_1)
                  .code(if (protected) 302 else 403)
                  .message("Denied")
                  .apply { if (protected) header("WWW-Authenticate", "Cloudflare-Access") }
                  .build()
              listener.onFailure(socket, IOException("Upgrade rejected"), response)
              disconnected.complete(Unit)
              socket
            },
          )
        try {
          connectIngressSession(session)
          withTimeout(TEST_TIMEOUT_MS) { disconnected.await() }
          if (protected) {
            val observed = withTimeout(TEST_TIMEOUT_MS) { failure.await() }
            assertEquals("EXTERNAL_AUTH_REQUIRED", observed.first.code)
            assertTrue(observed.second)
          } else {
            // A normal HTTP denial follows the existing generic connection path.
            assertNull(withTimeoutOrNull(200) { failure.await() })
          }
        } finally {
          session.disconnectAndJoin()
          scope.cancel()
        }
      }
    }

  @Test
  fun admittedHttpTransportDoesNotRedirectOrReuseRetiredMediaCapability() =
    runBlocking {
      val source = MockWebServer()
      val foreign = MockWebServer()
      source.start()
      foreign.start()
      source.enqueue(MockResponse().setResponseCode(302).setHeader("Location", foreign.url("/leak")))
      val captured = CompletableDeferred<OkHttpClient>()
      val valid = AtomicBoolean(true)
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val authorization =
        object : GatewayIngressAuthorization {
          override suspend fun authorizeUpgrade(request: Request) = request.newBuilder().header("CF-Access-Token", "test-grant").build()

          override fun requireCurrent(request: Request) {
            if (!valid.get()) throw GatewayExternalAuthorizationException()
            // The loopback HTTP endpoint isolates the shared client lifecycle; the
            // app grant owner separately enforces its exact HTTPS authority.
            check(request.url.host == "gateway.example.test" || request.url == source.url("/media"))
          }

          override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
        }
      val session =
        ingressSession(scope, authorization, socketFactory = { client, request, listener ->
          captured.complete(client)
          object : WebSocket {
            override fun request() = request

            override fun queueSize() = 0L

            override fun send(text: String) = false

            override fun send(bytes: ByteString) = false

            override fun close(
              code: Int,
              reason: String?,
            ) = true

            override fun cancel() {
              listener.onFailure(this, IOException("fixture closed"), null)
            }
          }
        })
      try {
        connectIngressSession(session)
        val client = withTimeout(TEST_TIMEOUT_MS) { captured.await() }
        val request =
          Request
            .Builder()
            .url(source.url("/media"))
            .header("CF-Access-Token", "test-grant")
            .build()
        client.newCall(request).execute().use { assertEquals(302, it.code) }
        assertEquals("test-grant", source.takeRequest().getHeader("CF-Access-Token"))
        assertEquals(0, foreign.requestCount)

        source.enqueue(MockResponse().setResponseCode(202).setBody("preparing"))
        val retrying =
          client
            .newBuilder()
            .addInterceptor(
              GatewayPreparingPlaybackInterceptor(
                policy = GatewayPlaybackRetryPolicy(initialDelayMs = 1),
                sleepMs = { valid.set(false) },
              ),
            ).build()
        val retryFailure = runCatching { retrying.newCall(request).execute().close() }
        assertTrue(retryFailure.exceptionOrNull() is GatewayExternalAuthorizationException)
        assertEquals(2, source.requestCount)
        valid.set(true)

        source.enqueue(MockResponse().setBody("ab").throttleBody(1, 1, TimeUnit.DAYS))
        client.newCall(request).execute().use { response ->
          assertEquals(
            97,
            response.body
              .source()
              .readByte()
              .toInt(),
          )
          val reading = CompletableDeferred<Unit>()
          val pending =
            async(Dispatchers.IO) {
              reading.complete(Unit)
              runCatching { response.body.source().readByte() }
            }
          withTimeout(TEST_TIMEOUT_MS) { reading.await() }
          session.disconnectAndJoin()
          assertTrue(withTimeout(TEST_TIMEOUT_MS) { pending.await() }.exceptionOrNull() is IOException)
        }
        val late = runCatching { client.newCall(request.newBuilder().header("Range", "bytes=10-").build()).execute().close() }
        assertTrue(late.exceptionOrNull() is GatewayExternalAuthorizationException)
        assertEquals(3, source.requestCount)
        assertEquals(0, foreign.requestCount)
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        source.shutdown()
        foreign.shutdown()
      }
    }

  private fun ingressSession(
    scope: CoroutineScope,
    authorization: GatewayIngressAuthorization,
    onFailure: (GatewaySession.ErrorShape, Boolean) -> Unit = { _, _ -> },
    onConnected: (GatewayHelloSummary) -> Unit = {},
    socketFactory: (OkHttpClient, Request, WebSocketListener) -> WebSocket,
  ) = GatewaySession(
    scope = scope,
    identityStore = testDeviceIdentityStore(RuntimeEnvironment.getApplication()),
    deviceAuthStore = NoopDeviceAuthStore(),
    onConnected = onConnected,
    onDisconnected = {},
    onEvent = { _, _ -> },
    onConnectFailure = onFailure,
    ingressAuthorizationProvider = { authorization },
    webSocketFactory = socketFactory,
  )

  private fun connectIngressSession(session: GatewaySession) {
    val endpoint = GatewayEndpoint.manual("gateway.example.test", 443)
    session.connect(
      endpoint = endpoint,
      token = "gateway-token",
      bootstrapToken = null,
      password = null,
      options =
        GatewayConnectOptions(
          role = "node",
          scopes = emptyList(),
          caps = emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client = GatewayClientInfo("openclaw-android-test", "Android Test", "test", "android", "node", "test", "android", "test"),
        ),
      tls = GatewayTlsParams(required = true, expectedFingerprint = "aa".repeat(32), allowTOFU = false, stableId = endpoint.stableId),
    )
  }

  private fun startCapturingGatewayServer(onHandshake: (RecordedRequest) -> Unit): MockWebServer {
    val json = Json { ignoreUnknownKeys = true }
    return MockWebServer().apply {
      dispatcher =
        object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            onHandshake(request)
            return MockResponse().withWebSocketUpgrade(
              object : WebSocketListener() {
                override fun onOpen(
                  webSocket: WebSocket,
                  response: Response,
                ) {
                  webSocket.send(CONNECT_CHALLENGE_FRAME)
                }

                override fun onMessage(
                  webSocket: WebSocket,
                  text: String,
                ) {
                  val frame = json.parseToJsonElement(text).jsonObject
                  if (frame["type"]?.jsonPrimitive?.content != "req") return
                  val id = frame["id"]?.jsonPrimitive?.content ?: return
                  if (frame["method"]?.jsonPrimitive?.content != "connect") return
                  webSocket.send(
                    """{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""",
                  )
                }
              },
            )
          }
        }
      start()
    }
  }
}
