package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
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
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.Certificate
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.ExtensionsGenerator
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
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
import java.util.Base64
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
  fun sourceFaviconsUseAuthenticatedRpcBehindBasicProxy() =
    runBlocking {
      for (authField in listOf("token", "password")) {
        assertSourceFavicons(authField)
      }
    }

  @Test
  fun sourceFaviconsWithoutAdvertisedRpcDoNotFetch() = runBlocking { assertSourceFavicons("token", advertisePreview = false) }

  private suspend fun assertSourceFavicons(
    authField: String,
    advertisePreview: Boolean = true,
  ) = coroutineScope {
    val connected = CompletableDeferred<Unit>()
    val connectParams = CompletableDeferred<JsonObject>()
    val slowResponse = CompletableDeferred<() -> Unit>()
    val previewParams = ConcurrentLinkedQueue<JsonObject>()
    val response = AtomicReference(""""ok":true,"payload":{"faviconDataUrl":"data:image/png;base64,AQIDBA=="}""")
    val imageBytes = byteArrayOf(1, 2, 3, 4)
    val remoteImage =
      MockWebServer().apply {
        enqueue(MockResponse().setHeader("Content-Type", "image/png").setBody(Buffer().write(imageBytes)))
        start()
      }
    val tls = sourceFaviconTls()
    val proxyAuthorization = "Basic c3ludGhldGljOnByb3h5"
    val server =
      MockWebServer().apply {
        useHttps(tls.socketFactory, false)
        dispatcher =
          object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
              // The proxy requires Basic on every HTTP request; only the WebSocket
              // connect payload can independently authenticate the Gateway.
              if (request.getHeader("Authorization") != proxyAuthorization || request.path != "/tenant%20mount") {
                return MockResponse().setResponseCode(401)
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
                    val frame = Json.parseToJsonElement(text).jsonObject
                    val id = frame.getValue("id").jsonPrimitive.content
                    val params = frame.getValue("params").jsonObject
                    when (frame.getValue("method").jsonPrimitive.content) {
                      "connect" -> {
                        connectParams.complete(params)
                        val auth = params.getValue("auth").jsonObject
                        if (auth[authField]?.jsonPrimitive?.content != "gateway-secret" || params["role"]?.jsonPrimitive?.content != "operator") {
                          webSocket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"Gateway authentication rejected"}}""")
                          return
                        }
                        val methods = if (advertisePreview) """["controlUi.linkPreview"]""" else "[]"
                        webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"features":{"methods":$methods},"auth":{"deviceToken":"issued-device-token","role":"operator","scopes":["operator.read"]}}}""")
                      }

                      "controlUi.linkPreview" -> {
                        previewParams.add(params)
                        val result = response.get()
                        val send = {
                          webSocket.send("""{"type":"res","id":"$id",$result}""")
                          Unit
                        }
                        if (params["url"]?.jsonPrimitive?.content == "https://slow.example/") {
                          slowResponse.complete(send)
                        } else {
                          send()
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
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, tlsEnabled = true, contextPath = "/tenant%20mount")
    val grant = GatewayBasicProxyAuthorization(endpoint, GatewayProxyCredentials("synthetic", "proxy"), isCurrent = { true })
    val session =
      GatewaySession(
        scope = scope,
        identityStore = testDeviceIdentityStore(RuntimeEnvironment.getApplication()),
        deviceAuthStore = NoopDeviceAuthStore(),
        onConnected = { connected.complete(Unit) },
        onDisconnected = {},
        onEvent = { _, _ -> },
        ingressAuthorizationProvider = { grant },
      )
    val config = requireNotNull(resolveGatewaySourcePreviewConfig(Json.parseToJsonElement("{}").jsonObject, server.url("/tenant%20mount").toString(), 1L))
    try {
      gatewayPlatformTrustOverrideForTests = syntheticPlatformTrust(tls.certificate)
      session.connect(
        endpoint = endpoint,
        token = "gateway-secret".takeIf { authField == "token" },
        bootstrapToken = null,
        password = "gateway-secret".takeIf { authField == "password" },
        tls = GatewayTlsParams(expectedFingerprint = tls.fingerprint.takeIf { authField == "password" }, requireSystemTrust = true),
        options =
          GatewayConnectOptions(
            role = "operator",
            scopes = listOf("operator.read"),
            caps = emptyList(),
            commands = emptyList(),
            permissions = emptyMap(),
            client = GatewayClientInfo("openclaw-android-test", "Android Test", "test", "android", "ui", "source-test", "android", "test"),
          ),
      )
      withTimeout(TEST_TIMEOUT_MS) { connected.await() }
      val auth = connectParams.await().getValue("auth").jsonObject
      assertEquals("gateway-secret", auth.getValue(authField).jsonPrimitive.content)
      assertNull(auth[if (authField == "token") "password" else "token"])
      assertEquals(proxyAuthorization, server.takeRequest().getHeader("Authorization"))

      suspend fun load(
        host: String,
        current: GatewaySourcePreviewConfig = config,
      ) = session.loadSourceFavicon(endpoint.stableId, current, host) { it() }

      assertNull(load("disabled.example", config.copy(automaticallyFetchFavicons = false)))
      if (!advertisePreview) {
        assertNull(load("example.com"))
        assertTrue(previewParams.isEmpty())
        assertEquals(1, server.requestCount)
        return@coroutineScope
      }
      assertTrue(previewParams.isEmpty())
      assertArrayEquals(imageBytes, load("example.com")?.bytes)
      assertEquals("image/png", load("example.com")?.mimeType)
      assertEquals(1, previewParams.size)
      assertEquals("https://example.com/", previewParams.single()["url"]?.jsonPrimitive?.content)
      assertEquals(1, server.requestCount)

      for (host in listOf("example.com/path", "user@example.com", "example.com:443", "example.com?token=secret", "example.com#fragment", "a".repeat(254))) {
        assertNull(load(host))
      }
      assertEquals(1, previewParams.size)
      assertNull(session.loadSourceFavicon(endpoint.stableId, config, "retired.example") { throw GatewayRequestNotEnqueued("config retired") })
      assertEquals(1, previewParams.size)

      val maximumBytes = ByteArray(65_536) { 1 }
      val cases =
        listOf(
          "ico" to "data:image/x-icon;base64,AQIDBA==",
          "limit" to ("data:image/png;base64," + Base64.getEncoder().encodeToString(maximumBytes)),
          "encoded-large" to ("data:image/png;base64," + "A".repeat(87_385)),
          "decoded-large" to ("data:image/png;base64," + Base64.getEncoder().encodeToString(ByteArray(65_537))),
          "malformed" to "data:image/png;base64,%%%%",
          "empty" to "data:image/png;base64,",
          "svg" to "data:image/svg+xml;base64,AQIDBA==",
          "remote" to remoteImage.url("/favicon.ico").toString(),
          "missing" to null,
        )
      for ((name, dataUrl) in cases) {
        val payload =
          buildJsonObject {
            if (dataUrl != null) put("faviconDataUrl", JsonPrimitive(dataUrl))
            put("imageDataUrl", JsonPrimitive("data:image/png;base64,AQIDBA=="))
          }
        response.set(""""ok":true,"payload":$payload""")
        val image = load("$name.example")
        when (name) {
          "ico" -> {
            assertArrayEquals(imageBytes, image?.bytes)
            assertEquals("image/x-icon", image?.mimeType)
          }

          "limit" -> {
            assertArrayEquals(maximumBytes, image?.bytes)
          }

          else -> {
            assertNull(name, image)
          }
        }
        val count = previewParams.size
        load("$name.example")
        assertEquals(count, previewParams.size)
      }
      for ((host, code) in listOf("unsupported-rpc.example" to "INVALID_REQUEST", "denied.example" to "FORBIDDEN")) {
        response.set(""""ok":false,"error":{"code":"$code","message":"Preview unavailable"}""")
        val count = previewParams.size
        assertNull(load(host))
        assertEquals(count + 1, previewParams.size)
      }
      response.set(""""ok":true,"payload":{"faviconDataUrl":"data:image/png;base64,AQIDBA=="}""")
      repeat(32) { assertArrayEquals(imageBytes, load("cache$it.example")?.bytes) }
      assertArrayEquals(imageBytes, load("example.com")?.bytes)
      assertEquals(2, previewParams.count { it["url"]?.jsonPrimitive?.content == "https://example.com/" })
      assertTrue(previewParams.all { it.keys == setOf("url") })
      assertEquals(1, server.requestCount)
      assertEquals(0, remoteImage.requestCount)

      val stale = async { load("slow.example") }
      val sendStale = withTimeout(TEST_TIMEOUT_MS) { slowResponse.await() }
      session.disconnect()
      sendStale()
      assertNull(withTimeout(TEST_TIMEOUT_MS) { stale.await() })
      assertNull(load("example.com"))
    } finally {
      session.disconnectAndJoin()
      scope.cancel()
      server.shutdown()
      remoteImage.shutdown()
      gatewayPlatformTrustOverrideForTests = null
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
      val fileArtifactId = "artifact_managed_media_44444444-4444-4444-8444-444444444444"
      val filePath = "/api/chat/media/outgoing/main/44444444-4444-4444-8444-444444444444/full?mediaTicket=file-ticket"
      val fileBytes = "%PDF-1.7\nsynthetic document\n%%EOF".toByteArray()
      val csvBytes = "name,value\nexample,42\n".toByteArray()
      val csvData =
        java.util.Base64
          .getEncoder()
          .encodeToString(csvBytes)
      val artifactRequests = ConcurrentLinkedQueue<kotlinx.serialization.json.JsonObject>()
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
      val redirectTrap =
        MockWebServer().apply {
          enqueue(MockResponse().setHeader("Content-Type", "application/pdf").setBody("unexpected redirect"))
          start()
        }
      val server =
        MockWebServer().apply {
          dispatcher =
            object : Dispatcher() {
              override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path?.startsWith("$contextPath$filePath") == true) {
                  mediaRequests.add(request)
                  return when (request.requestUrl?.queryParameter("test")) {
                    "redirect" -> MockResponse().setResponseCode(302).setHeader("Location", redirectTrap.url("/must-not-load"))
                    "oversized" -> MockResponse().setHeader("Content-Type", "application/pdf").setHeader("Content-Length", 100L * 1024L * 1024L + 1L)
                    "missing-mime" -> MockResponse().setBody(Buffer().write(fileBytes))
                    else -> MockResponse().setHeader("Content-Type", "application/pdf").setChunkedBody(Buffer().write(fileBytes), 8)
                  }
                }
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
                          artifactRequests.add(frame.getValue("params").jsonObject)
                          val requestedArtifactId =
                            frame["params"]
                              ?.jsonObject
                              ?.get("artifactId")
                              ?.jsonPrimitive
                              ?.content
                          val invalidFilePath = requestedArtifactId?.removePrefix("file-")?.let(invalidMediaPaths::get)
                          val invalidMediaPath = invalidMediaPaths[requestedArtifactId]
                          if (requestedArtifactId == "inline-csv") {
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"artifact":{"id":"inline-csv","type":"file","mimeType":"text/csv","download":{"mode":"bytes"}},"encoding":"base64","data":"$csvData"}}""",
                            )
                          } else if (requestedArtifactId == fileArtifactId || requestedArtifactId?.startsWith("file-") == true) {
                            val path =
                              invalidFilePath ?: when (requestedArtifactId) {
                                "file-redirect" -> "$filePath&test=redirect"
                                "file-oversized" -> "$filePath&test=oversized"
                                "file-missing-mime" -> "$filePath&test=missing-mime"
                                else -> filePath
                              }
                            webSocket.send(
                              """{"type":"res","id":"$id","ok":true,"payload":{"artifact":{"id":"$requestedArtifactId","type":"file","mimeType":"application/pdf","download":{"mode":"url"}},"url":"$path"}}""",
                            )
                          } else if (invalidMediaPath != null) {
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

        val file =
          session.loadMediaArtifact(stableId, "main", "main", fileArtifactId, GatewayMediaKind.File) as? GatewayLoadedMedia.Buffered
        assertArrayEquals(fileBytes, file?.bytes)
        assertEquals("application/pdf", file?.mimeType)
        val fileRequest = mediaRequests.last()
        assertEquals("$contextPath$filePath", fileRequest.path)
        assertEquals("*/*", fileRequest.getHeader("Accept"))

        val validMediaRequestCount = mediaRequests.size
        val csv =
          session.loadMediaArtifact(stableId, "main", "main", "inline-csv", GatewayMediaKind.File) as? GatewayLoadedMedia.Buffered
        assertArrayEquals(csvBytes, csv?.bytes)
        assertEquals("text/csv", csv?.mimeType)
        for (artifactId in invalidMediaPaths.keys) {
          assertNull(session.loadMediaArtifact(stableId, "main", "main", artifactId, GatewayMediaKind.Video))
          assertNull(session.loadMediaArtifact(stableId, "main", "main", "file-$artifactId", GatewayMediaKind.File))
        }
        // A file load must not inherit the old untyped image fallback or accept a different media kind.
        assertNull(session.loadMediaArtifact(stableId, "main", "main", artifactId, GatewayMediaKind.File))
        assertNull(session.loadMediaArtifact(stableId, "main", "main", videoArtifactId, GatewayMediaKind.File))
        for (kind in listOf(GatewayMediaKind.Image, GatewayMediaKind.Audio, GatewayMediaKind.Video)) {
          assertNull(session.loadMediaArtifact(stableId, "main", "main", fileArtifactId, kind))
        }
        assertEquals(validMediaRequestCount, mediaRequests.size)
        if (contextPath.isEmpty()) {
          for (id in listOf("file-redirect", "file-oversized", "file-missing-mime")) {
            assertNull(session.loadMediaArtifact(stableId, "main", "main", id, GatewayMediaKind.File))
          }
          assertEquals(0, redirectTrap.requestCount)
        }
        assertTrue(
          artifactRequests.all {
            it["sessionKey"]?.jsonPrimitive?.content == "main" && it["agentId"]?.jsonPrimitive?.content == "main"
          },
        )
        assertTrue(mediaRequests.all { it.getHeader("Authorization") == null })
        session.disconnectAndJoin()
        assertNull(session.loadMediaArtifact(stableId, "main", "main", fileArtifactId, GatewayMediaKind.File))
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
        redirectTrap.shutdown()
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
            nowMs = { nowMs },
            sleepMs = { nowMs = 120_001L },
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
    val tls = GatewayTlsParams(expectedFingerprint = "aa".repeat(32))

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

  private class SourceTlsFixture(
    val socketFactory: SSLSocketFactory,
    val fingerprint: String,
    val certificate: java.security.cert.Certificate,
  )

  private fun sourceFaviconTls(sanIp: String = "127.0.0.1"): SourceTlsFixture {
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
          setExtensions(
            ExtensionsGenerator()
              .apply {
                addExtension(Extension.basicConstraints, true, BasicConstraints(true))
                addExtension(Extension.subjectAlternativeName, false, GeneralNames(GeneralName(GeneralName.iPAddress, sanIp)))
              }.generate(),
          )
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
    return SourceTlsFixture(factory, fingerprint, certificate)
  }

  @Test
  fun basicProxyUpgradeUsesVerifiedTlsAndPreservesGatewayRoleEnforcement() =
    runBlocking {
      val trusted = sourceFaviconTls()
      val wrongHostname = sourceFaviconTls("127.0.0.2")
      val untrusted = sourceFaviconTls()
      val foreign = MockWebServer().apply { start() }
      try {
        gatewayPlatformTrustOverrideForTests =
          syntheticPlatformTrust(trusted.certificate, wrongHostname.certificate)
        for (scenario in listOf("wrong-password", "same-redirect", "foreign-redirect", "gateway-role", "wrong-hostname", "untrusted-ca", "pinned-wrong-hostname", "pinned-untrusted-ca", "pin-mismatch")) {
          val server =
            MockWebServer().apply {
              useHttps(
                when (scenario) {
                  "untrusted-ca", "pinned-untrusted-ca" -> untrusted.socketFactory
                  "wrong-hostname", "pinned-wrong-hostname" -> wrongHostname.socketFactory
                  else -> trusted.socketFactory
                },
                false,
              )
              start()
            }
          val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
          val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
          val host = "127.0.0.1"
          val endpoint = GatewayEndpoint.manual(host, server.port, tlsEnabled = true)
          val grant = GatewayBasicProxyAuthorization(endpoint, GatewayProxyCredentials("synthetic", "proxy"), isCurrent = { true })
          val session =
            GatewaySession(
              scope = scope,
              identityStore = testDeviceIdentityStore(RuntimeEnvironment.getApplication()),
              deviceAuthStore = NoopDeviceAuthStore(),
              onConnected = { throw AssertionError("A rejected connection must not become ready") },
              onDisconnected = {},
              onEvent = { _, _ -> },
              onConnectFailure = { error, paused -> failure.complete(error to paused) },
              ingressAuthorizationProvider = { grant },
            )
          try {
            server.enqueue(
              when (scenario) {
                "wrong-password" -> {
                  MockResponse().setResponseCode(401).setHeader("WWW-Authenticate", "Basic realm=\"gateway\"")
                }

                "same-redirect" -> {
                  MockResponse().setResponseCode(302).setHeader("Location", server.url("/redirected"))
                }

                "foreign-redirect" -> {
                  MockResponse().setResponseCode(302).setHeader("Location", foreign.url("/must-not-leak"))
                }

                "gateway-role" -> {
                  MockResponse().withWebSocketUpgrade(
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
                        assertEquals(
                          "node",
                          frame
                            .getValue("params")
                            .jsonObject
                            .getValue("role")
                            .jsonPrimitive.content,
                        )
                        val id = frame.getValue("id").jsonPrimitive.content
                        webSocket.send("""{"type":"res","id":"$id","ok":false,"error":{"code":"INVALID_REQUEST","message":"synthetic-secret","details":{"code":"AUTH_SCOPE_MISMATCH"}}}""")
                      }
                    },
                  )
                }

                else -> {
                  MockResponse().setResponseCode(401)
                }
              },
            )
            session.connect(
              endpoint = endpoint,
              token = "dummy-gateway-token",
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
              tls =
                GatewayTlsParams(
                  expectedFingerprint =
                    when (scenario) {
                      "pinned-wrong-hostname" -> wrongHostname.fingerprint
                      "pinned-untrusted-ca" -> untrusted.fingerprint
                      "pin-mismatch" -> "aa".repeat(32)
                      else -> null
                    },
                  requireSystemTrust = true,
                ),
            )
            val observed = withTimeout(TEST_TIMEOUT_MS) { failure.await() }
            assertTrue("$scenario must pause: ${observed.first.code} ${observed.first.message}", observed.second)
            assertTrue(!observed.first.message.contains("synthetic-secret"))
            when (scenario) {
              "wrong-password" -> assertEquals("PROXY_AUTH_REQUIRED", observed.first.code)
              "same-redirect", "foreign-redirect" -> assertEquals("PROXY_REDIRECT", observed.first.code)
              "gateway-role" -> assertEquals("AUTH_SCOPE_MISMATCH", observed.first.details?.code)
              else -> assertEquals("PROXY_TLS_FAILURE", observed.first.code)
            }
            if (scenario in listOf("wrong-hostname", "untrusted-ca", "pinned-wrong-hostname", "pinned-untrusted-ca", "pin-mismatch")) {
              assertEquals(0, server.requestCount)
            } else {
              assertEquals("Basic c3ludGhldGljOnByb3h5", server.takeRequest().getHeader("Authorization"))
              assertEquals(1, server.requestCount)
            }
            assertEquals(0, foreign.requestCount)
          } finally {
            session.disconnectAndJoin()
            scope.cancel()
            server.shutdown()
          }
        }
      } finally {
        gatewayPlatformTrustOverrideForTests = null
        foreign.shutdown()
      }
    }

  @Test
  fun verifiedTlsBasicChallengeRequestsProxyLoginWithoutSendingPairingSecrets() =
    runBlocking {
      val tls = sourceFaviconTls()
      val server =
        MockWebServer().apply {
          useHttps(tls.socketFactory, false)
          enqueue(MockResponse().setResponseCode(401).setHeader("WWW-Authenticate", "Basic realm=\"gateway\""))
          start()
        }
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val failure = CompletableDeferred<Pair<GatewaySession.ErrorShape, Boolean>>()
      val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, tlsEnabled = true)
      val session =
        GatewaySession(
          scope = scope,
          identityStore = testDeviceIdentityStore(RuntimeEnvironment.getApplication()),
          deviceAuthStore = NoopDeviceAuthStore(),
          onConnected = { error("Proxy rejection must precede Gateway pairing") },
          onDisconnected = {},
          onEvent = { _, _ -> },
          onConnectFailure = { error, paused -> failure.complete(error to paused) },
        )
      try {
        session.connect(
          endpoint = endpoint,
          token = "dummy-gateway-token",
          bootstrapToken = "dummy-pairing-code",
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
          tls = GatewayTlsParams(expectedFingerprint = tls.fingerprint),
        )
        val observed = withTimeout(TEST_TIMEOUT_MS) { failure.await() }
        assertEquals("PROXY_AUTH_REQUIRED", observed.first.code)
        assertTrue(observed.second)
        val request = server.takeRequest()
        assertNull(request.getHeader("Authorization"))
        assertEquals(0L, request.bodySize)
        assertEquals(1, server.requestCount)
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
        server.shutdown()
      }
    }

  @Test
  fun basicNetworkWakeCannotResetRetryBudgetAndExplicitRetryResumes() =
    runBlocking {
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val attempts = AtomicInteger()
      val paused = CompletableDeferred<Unit>()
      val resumed = CompletableDeferred<Unit>()
      val authorization =
        GatewayBasicProxyAuthorization(
          GatewayEndpoint.manual("gateway.example.test", 443, tlsEnabled = true),
          GatewayProxyCredentials("synthetic", "proxy"),
          isCurrent = { true },
        )
      lateinit var session: GatewaySession
      session =
        ingressSession(
          scope,
          authorization,
          onFailure = { error, pause ->
            assertEquals("NETWORK_UNREACHABLE", error.code)
            assertTrue(!error.message.contains("synthetic-secret"))
            when (attempts.get()) {
              1, 2 -> {
                assertTrue(!pause)
                session.retryAfterNetworkRestore()
              }

              3 -> {
                assertTrue(pause)
                paused.complete(Unit)
              }

              4 -> {
                assertTrue(!pause)
                resumed.complete(Unit)
              }

              else -> {
                throw AssertionError("Unexpected automatic retry")
              }
            }
          },
          socketFactory = { _, request, _ ->
            assertEquals("Basic c3ludGhldGljOnByb3h5", request.header("Authorization"))
            attempts.incrementAndGet()
            throw IOException("synthetic-secret")
          },
        )
      try {
        connectIngressSession(session, requireSystemTrust = true)
        withTimeout(TEST_TIMEOUT_MS) { paused.await() }
        assertEquals(3, attempts.get())
        session.reconnect()
        withTimeout(TEST_TIMEOUT_MS) { resumed.await() }
        assertEquals(4, attempts.get())
      } finally {
        session.disconnectAndJoin()
        scope.cancel()
      }
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
  fun replacingGatewayCancelsAndDrainsPendingIngressBeforeConnecting() = runBlocking { assertPendingIngressRetirement("replace") }

  @Test
  fun reconnectingGatewayCancelsAndDrainsPendingIngressBeforeConnecting() = runBlocking { assertPendingIngressRetirement("reconnect") }

  @Test
  fun disconnectingGatewayCancelsAndDrainsPendingIngress() = runBlocking { assertPendingIngressRetirement("disconnect") }

  private suspend fun assertPendingIngressRetirement(mode: String) =
    coroutineScope {
      val started = CompletableDeferred<Unit>()
      val canceled = CompletableDeferred<Unit>()
      val releaseCleanup = CompletableDeferred<Unit>()
      val cleanupFinished = CompletableDeferred<Unit>()
      val socketAttempted = CompletableDeferred<Unit>()
      val authorizations = AtomicInteger()
      val sockets = AtomicInteger()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val authorization =
        object : GatewayIngressAuthorization {
          override suspend fun authorizeUpgrade(request: Request): Request {
            if (authorizations.incrementAndGet() == 1) {
              started.complete(Unit)
              try {
                awaitCancellation()
              } finally {
                withContext(NonCancellable) {
                  canceled.complete(Unit)
                  releaseCleanup.await()
                  cleanupFinished.complete(Unit)
                }
              }
            }
            check(cleanupFinished.isCompleted) { "Successor authorization started before old probe drained" }
            return request.newBuilder().header("CF-Access-Token", "successor-grant").build()
          }

          override fun requireCurrent(request: Request) = Unit

          override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
        }
      val session =
        ingressSession(scope, authorization, socketFactory = { _, request, _ ->
          assertTrue(cleanupFinished.isCompleted)
          assertEquals(if (mode == "replace") "replacement.example.test" else "gateway.example.test", request.url.host)
          assertEquals("successor-grant", request.header("CF-Access-Token"))
          sockets.incrementAndGet()
          socketAttempted.complete(Unit)
          throw GatewayExternalAuthorizationException("Test ends after successor socket admission")
        })
      try {
        connectIngressSession(session)
        withTimeout(TEST_TIMEOUT_MS) { started.await() }
        when (mode) {
          "replace" -> connectIngressSession(session, host = "replacement.example.test")
          "reconnect" -> session.reconnect()
          "disconnect" -> session.disconnect()
          else -> error("Unexpected retirement mode")
        }
        val disconnected = if (mode == "disconnect") async { session.disconnectAndJoin() } else null
        // Cancellation must arrive without releasing the probe or waiting for its connect timeout.
        withTimeout(TEST_TIMEOUT_MS) { canceled.await() }
        assertEquals(1, authorizations.get())
        assertEquals(0, sockets.get())
        assertTrue(disconnected?.isCompleted != true)
        releaseCleanup.complete(Unit)
        if (disconnected != null) {
          withTimeout(TEST_TIMEOUT_MS) { disconnected.await() }
          assertEquals(1, authorizations.get())
          assertEquals(0, sockets.get())
        } else {
          withTimeout(TEST_TIMEOUT_MS) { socketAttempted.await() }
          assertEquals(2, authorizations.get())
          assertEquals(1, sockets.get())
        }
      } finally {
        releaseCleanup.complete(Unit)
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

  private fun connectIngressSession(
    session: GatewaySession,
    host: String = "gateway.example.test",
    requireSystemTrust: Boolean = false,
  ) {
    val endpoint = GatewayEndpoint.manual(host, 443)
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
      tls = GatewayTlsParams(expectedFingerprint = "aa".repeat(32), requireSystemTrust = requireSystemTrust),
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
