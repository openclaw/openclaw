package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Headers
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ProtocolException
import java.security.cert.CertificateException
import java.util.Base64
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException

class CloudflareAccessClientTest {
  private val application = CloudflareAccessTestTokens.application

  private fun reply(
    request: Request,
    code: Int,
    headers: Map<String, String> = emptyMap(),
    body: ByteArray = byteArrayOf(),
  ) = CloudflareAccessClient.Reply(request.url.toString(), code, Headers.Builder().apply { headers.forEach { (key, value) -> add(key, value) } }.build(), body)

  @Test fun nativeHeadersRequireExactHttpsAuthorityAndExpiry() {
    val session = CloudflareAccessTestTokens.session(expires = 2000.0)
    for (url in listOf("https://gateway.example.test:8443/a?x=1", "wss://gateway.example.test:8443")) assertNotNull(session.authorizationHeader(url, 1000.0))
    for (url in listOf("http://gateway.example.test:8443", "https://gateway.example.test", "https://other.example.test:8443", "https://user@gateway.example.test:8443")) assertNull(session.authorizationHeader(url, 1000.0))
    assertNull(session.authorizationHeader(application.origin.uri.toString(), 2000.0))
    assertEquals("CloudflareAccessSession(<redacted>)", session.toString())
    assertEquals(CloudflareAccessOrigin.from("wss://gateway.example.test:443/a"), CloudflareAccessOrigin.from("https://gateway.example.test"))
  }

  @Test fun ipv6OriginsUseTheTransportAuthorityWithoutRelaxingValidation() {
    for ((hosts, canonical) in listOf(
      listOf("0:0:0:0:0:0:0:1", "::1") to "[::1]",
      listOf("2001:0DB8:0:0:0:0:0:00AB", "2001:db8::ab", "2001:DB8::AB") to "[2001:db8::ab]",
      listOf("0:0:0:0:0:ffff:c000:201", "::ffff:192.0.2.1") to "192.0.2.1",
    )) {
      val expected = CloudflareAccessOrigin.from("https://$canonical")
      for (host in hosts) {
        for (url in listOf("https://[$host]", "https://[$host]:443/gateway/socket", "wss://[$host]:443/gateway/socket")) {
          val actual = CloudflareAccessOrigin.from(url)
          assertEquals(expected, actual)
          assertEquals(expected.hashCode(), actual.hashCode())
          assertEquals("https://$canonical", actual.uri.toString())
          assertTrue(
            actual.contains(
              Request
                .Builder()
                .url(url)
                .build()
                .url
                .toString(),
            ),
          )
          assertTrue(actual.contains("$url?query=allowed"))
        }
      }
    }
    for (url in listOf("https://gateway.example.test", "https://127.0.0.1", "https://gateway.example.test:8443", "https://192.0.2.1:8443")) {
      assertEquals(url, CloudflareAccessOrigin.from(url).uri.toString())
    }
    val origin = CloudflareAccessOrigin.from("https://[::1]:8443")
    for (url in listOf("https://[::2]:8443", "https://[::1]", "http://[::1]:8443", "https://user@[::1]:8443", "https://[::1]:8443/#fragment")) {
      assertFalse(origin.contains(url))
    }
    for (url in listOf("http://[::1]", "https://user@[::1]", "https://[::1]/?query", "https://[::1]/#fragment", "https://[::1]:0", "https://[::1]:65536", "https://[::1", "https:///gateway")) {
      assertEquals(CloudflareAccessException.Kind.InvalidGateway, assertThrows(CloudflareAccessException::class.java) { CloudflareAccessOrigin.from(url) }.kind)
    }
  }

  @Test fun ipv6SessionAndChallengeRoundTripsShareTheCanonicalAuthority() {
    val expanded = "https://[0:0:0:0:0:0:0:1]:8443"
    val origin = CloudflareAccessOrigin.from(expanded)
    val descriptor = application.copy(origin = origin)
    val token = CloudflareAccessTestTokens.token(CloudflareAccessTestTokens.claims(expires = 2000.0))
    val session = CloudflareAccessSession(descriptor, "test-subject", 2000.0, token)
    val encoded = session.encode()
    val restored = CloudflareAccessSession.decode(encoded)
    restored.validate(1000.0)
    assertEquals(descriptor, restored.application)
    assertEquals(encoded, restored.encode())
    // Old unreleased serialized IPv6 spellings decode to the same canonical owner.
    assertEquals(encoded, CloudflareAccessSession.decode(encoded.replace("https://[::1]:8443", expanded)).encode())
    for (url in listOf("$expanded/gateway/socket", "https://[::1]:8443/media?range=1", "wss://[::1]:8443/gateway/socket")) {
      val request = Request.Builder().url(url).build()
      assertEquals(token, restored.authorizationHeader(request.url.toString(), 1000.0))
      for (metadataOrigin in listOf(expanded, "https://[::1]:8443")) {
        assertTrue(
          CloudflareAccessClient.isChallenge(
            reply(request, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"$metadataOrigin/.well-known/cloudflare-access-protected-resource/gateway/socket\"")),
            origin,
          ),
        )
      }
      assertTrue(CloudflareAccessClient.isChallenge(reply(request, 302, mapOf("Location" to "/cdn-cgi/access/login")), origin))
    }
    for (url in listOf("https://[::2]:8443", "https://[::1]:8444", "http://[::1]:8443", "https://user@[::1]:8443", "https://[::1]:8443/#fragment")) {
      assertNull(restored.authorizationHeader(url, 1000.0))
    }
    val request = Request.Builder().url("https://[::1]:8443").build()
    assertFalse(
      CloudflareAccessClient.isChallenge(
        reply(request, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"https://[::2]:8443/.well-known/cloudflare-access-protected-resource/\"")),
        origin,
      ),
    )
  }

  @Test fun warpOrExistingIngressHeadersDoNotLaunchBrowserDiscovery() =
    runBlocking {
      var requests = 0
      val client =
        CloudflareAccessClient { request, _, _ ->
          requests++
          assertEquals("existing-edge-session", request.header("Cf-Access-Token"))
          reply(request, 200, mapOf("Server" to "cloudflare"))
        }
      assertNull(client.discover(application.origin.uri.toString(), customHeaders = mapOf("Cf-Access-Token" to "existing-edge-session")))
      assertEquals(1, requests)
    }

  @Test fun onlyExplicitSameOriginAccessChallengeAdmitsSignedDiscovery() =
    runBlocking {
      val requests = mutableListOf<Request>()
      val client =
        CloudflareAccessClient { request, _, _ ->
          requests += request
          when (requests.size) {
            1 -> {
              reply(request, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/\""))
            }

            2 -> {
              assertEquals("HEAD", request.method)
              assertEquals("true", request.header("Cf-Access-Metadata-Request"))
              reply(request, 200, mapOf("Cf-Access-Metadata" to CloudflareAccessTestTokens.metadata()))
            }

            else -> {
              assertEquals("${application.issuer}/cdn-cgi/access/certs", request.url.toString())
              assertNull(request.header("Cookie"))
              reply(request, 200, body = CloudflareAccessTestTokens.jwks)
            }
          }
        }
      assertEquals(application, client.discover(application.origin.uri.toString()))
      assertEquals(3, requests.size)
      val ordinary = Request.Builder().url(application.origin.uri.toString()).build()
      assertFalse(CloudflareAccessClient.isChallenge(reply(ordinary, 403, mapOf("Server" to "cloudflare")), application.origin))
      assertFalse(CloudflareAccessClient.isChallenge(reply(ordinary, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"https://other.example.test/.well-known/cloudflare-access-protected-resource/\"")), application.origin))
    }

  @Test fun loginRedirectsVerifyMetadataAtTheOriginalGatewayUrl() =
    runBlocking {
      for (location in listOf(
        "https://login.example.test/cdn-cgi/access/login/gateway.example.test?opaque=ignored",
        "/cdn-cgi/access/login?opaque=ignored",
        "../cdn-cgi/access/login",
        "/cdn-cgi/access/login-extra",
        "/%63dn-cgi/access/login",
        "/other/../cdn-cgi/access/login",
        "https://login.example.test/other/../cdn-cgi/access/login",
        "//login.example.test/other/../cdn-cgi/access/login",
        "/cdn-cgi/access/login/%2e%2e/ordinary",
        "/cdn-cgi/access/login%2Fchild",
        "/cdn-cgi/access/login//child",
        "../../../cdn-cgi/access/login",
        "///../../cdn-cgi/access/login",
      )) {
        for (unusableChallenge in listOf(false, true)) {
          val gatewayUrl = "${application.origin.uri}/gateway%20space/%2Fsocket"
          val keysUrl = "${application.issuer}/cdn-cgi/access/certs"
          val requests = mutableListOf<Request>()
          val client =
            CloudflareAccessClient { request, _, _ ->
              requests += request
              when (requests.size) {
                1 -> {
                  reply(
                    request,
                    302,
                    buildMap {
                      put("Location", location)
                      if (unusableChallenge) put("WWW-Authenticate", "Basic realm=\"unrelated\"")
                    },
                  )
                }

                2 -> {
                  reply(request, 200, mapOf("Cf-Access-Metadata" to CloudflareAccessTestTokens.metadata()))
                }

                3 -> {
                  reply(request, 200, body = CloudflareAccessTestTokens.jwks)
                }

                else -> {
                  error("Unexpected discovery request")
                }
              }
            }
          assertEquals(application, client.discover(gatewayUrl.replaceFirst("https:", "wss:")))
          assertEquals(listOf("GET", "HEAD", "GET"), requests.map { it.method })
          assertEquals(listOf(gatewayUrl, gatewayUrl, keysUrl), requests.map { it.url.toString() })
          assertEquals("true", requests[1].header("Cf-Access-Metadata-Request"))
          assertEquals(CloudflareAccessClient.userAgent, requests[1].header("User-Agent"))
          requests.forEach {
            assertNull(it.header("Cookie"))
            assertNull(it.header("Authorization"))
            assertNull(it.header("Cf-Access-Token"))
          }
        }
      }
    }

  @Test fun nonAccessAndMalformedRedirectsRemainOrdinary() =
    runBlocking {
      val original = Request.Builder().url("${application.origin.uri}/gateway/socket").build()
      for ((status, location) in listOf(
        200 to "/cdn-cgi/access/login",
        301 to "/cdn-cgi/access/login",
        303 to "/cdn-cgi/access/login",
        307 to "/cdn-cgi/access/login",
        308 to "/cdn-cgi/access/login",
        302 to "",
        302 to "/login",
        302 to "/cdn-cgi/access/login%ZZ",
        302 to "?next=/cdn-cgi/access/login",
        401 to "/cdn-cgi/access/login",
        302 to "/cdn-cgi/access/login/../ordinary",
        302 to "https://login.example.test/cdn-cgi/access/login/../ordinary",
        302 to "//login.example.test/cdn-cgi/access/login/../ordinary",
        302 to "/cdn-cgi//access/login",
        302 to "///cdn-cgi/access/login",
        302 to "///cdn-cgi/access/login?next=ignored",
        302 to "/other/%2e%2e/cdn-cgi/access/login",
        302 to "../../../../ordinary",
        302 to "/other//../cdn-cgi/access/login",
        302 to "/other/..//cdn-cgi/access/login",
      )) {
        var requests = 0
        val client =
          CloudflareAccessClient { request, _, _ ->
            requests++
            reply(request, status, mapOf("Location" to location))
          }
        assertNull(client.discover(original.url.toString()))
        assertEquals(1, requests)
      }
      assertFalse(CloudflareAccessClient.isChallenge(reply(original, 302), application.origin))
      val malformedHeaders = Headers.Builder().addUnsafeNonAscii("Location", "/cdn-cgi/access/login\nignored").build()
      assertFalse(
        CloudflareAccessClient.isChallenge(
          CloudflareAccessClient.Reply(original.url.toString(), 302, malformedHeaders, byteArrayOf()),
          application.origin,
        ),
      )
      val foreign = Request.Builder().url("https://other.example.test:8443/").build()
      assertFalse(CloudflareAccessClient.isChallenge(reply(foreign, 302, mapOf("Location" to "/cdn-cgi/access/login")), application.origin))
      val login = Request.Builder().url("${application.origin.uri}/cdn-cgi/access/login").build()
      assertTrue(CloudflareAccessClient.isChallenge(reply(login, 302, mapOf("Location" to "?next=ignored")), application.origin))
    }

  @Test fun loginHintStillRejectsMissingOrUnverifiedMetadata() =
    runBlocking {
      val good = CloudflareAccessTestTokens.metadata()
      val parts = good.split('.').toMutableList()
      val signature = Base64.getUrlDecoder().decode(parts[2]).also { it[0] = (it[0].toInt() xor 1).toByte() }
      parts[2] = Base64.getUrlEncoder().withoutPadding().encodeToString(signature)
      for ((token, expectedRequests) in listOf(
        null to 2,
        "not-a-jwt" to 2,
        CloudflareAccessTestTokens.metadata("other.example.test") to 2,
        parts.joinToString(".") to 3,
      )) {
        var requests = 0
        val client =
          CloudflareAccessClient { request, _, _ ->
            requests++
            when (requests) {
              1 -> reply(request, 302, mapOf("Location" to "/cdn-cgi/access/login"))
              2 -> reply(request, 200, token?.let { mapOf("Cf-Access-Metadata" to it) }.orEmpty())
              3 -> reply(request, 200, body = CloudflareAccessTestTokens.jwks)
              else -> error("Unexpected discovery request")
            }
          }
        val failure = runCatching { client.discover(application.origin.uri.toString()) }.exceptionOrNull()
        assertEquals(CloudflareAccessException.Kind.InvalidApplication, (failure as? CloudflareAccessException)?.kind)
        assertEquals(expectedRequests, requests)
      }
    }

  @Test fun probeMetadataAndKeysPreserveTransportFailuresAndCancellation() =
    runBlocking {
      for (failedRequest in 1..3) {
        val certificateFailure = CertificateException("test certificate rejected")
        val failures =
          listOf(
            SSLHandshakeException("test TLS handshake failed").apply { initCause(certificateFailure) },
            SSLPeerUnverifiedException("test hostname rejected"),
            IOException("test transport interrupted"),
            CancellationException("test caller canceled"),
          )
        for (failure in failures) {
          var requests = 0
          val client =
            CloudflareAccessClient { request, _, _ ->
              requests++
              if (requests == failedRequest) throw failure
              when (requests) {
                1 -> reply(request, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/\""))
                2 -> reply(request, 200, mapOf("Cf-Access-Metadata" to CloudflareAccessTestTokens.metadata()))
                else -> error("Discovery must stop at the failed request")
              }
            }
          val observed = runCatching { client.discover(application.origin.uri.toString()) }.exceptionOrNull()
          assertSame(failure, observed)
          assertEquals(failedRequest, requests)
          if (failure is SSLHandshakeException) assertSame(certificateFailure, observed?.cause)
        }
      }
    }

  @Test fun invalidMetadataStillReportsInvalidApplication() =
    runBlocking {
      for (metadata in listOf<String?>(null, "not-a-signed-token")) {
        var requests = 0
        val client =
          CloudflareAccessClient { request, _, _ ->
            requests++
            if (requests == 1) {
              reply(request, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource/\""))
            } else {
              reply(request, 200, metadata?.let { mapOf("Cf-Access-Metadata" to it) }.orEmpty())
            }
          }
        val failure = runCatching { client.discover(application.origin.uri.toString()) }.exceptionOrNull()
        assertEquals(CloudflareAccessException.Kind.InvalidApplication, (failure as? CloudflareAccessException)?.kind)
        assertEquals(2, requests)
      }
    }

  @Test fun defaultTransportPreservesNativeTlsHandshakeFailure() {
    MockWebServer().use { server ->
      // No server certificate is installed: the real HTTPS handshake must fail before HTTP.
      val tls = SSLContext.getInstance("TLS").apply { init(emptyArray(), null, null) }
      server.useHttps(tls.socketFactory, false)
      val address = InetAddress.getLoopbackAddress()
      server.start(address, 0)
      // Hostname lookup may try an unbound address family before reaching this TLS listener.
      val url =
        server
          .url("/")
          .newBuilder()
          .host(checkNotNull(address.hostAddress))
          .build()
      assertThrows(SSLException::class.java) {
        runBlocking { CloudflareAccessClient.send(Request.Builder().url(url).build(), 0, 5) }
      }
      assertEquals(0, server.requestCount)
    }
  }

  @Test fun defaultTransportPreservesInterruptedResponseBodyFailure() =
    runBlocking {
      MockWebServer().use { server ->
        server.start()
        server.enqueue(MockResponse().setBody("response body").setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        val failure = runCatching { CloudflareAccessClient.send(Request.Builder().url(server.url("/")).build(), 64, 5) }.exceptionOrNull()
        assertTrue(failure is ProtocolException)
        assertEquals(1, server.requestCount)
      }
    }

  @Test fun signatureClaimsAndMetadataMustMatchRequestedApplication() {
    val token = CloudflareAccessTestTokens.token(CloudflareAccessTestTokens.claims())
    CloudflareAccessJWT.verify(token, CloudflareAccessTestTokens.jwks)
    assertEquals("test-subject", CloudflareAccessJWT.appClaims(token, application).subject)
    val parts = token.split('.').toMutableList()
    val altered = Base64.getUrlDecoder().decode(parts[2]).also { it[0] = (it[0].toInt() xor 1).toByte() }
    parts[2] = Base64.getUrlEncoder().withoutPadding().encodeToString(altered)
    assertThrows(CloudflareAccessException::class.java) { CloudflareAccessJWT.verify(parts.joinToString("."), CloudflareAccessTestTokens.jwks) }
    for ((key, value) in mapOf("iss" to JsonPrimitive("https://other.cloudflareaccess.com"), "aud" to JsonPrimitive("other"), "type" to JsonPrimitive("org"), "sub" to JsonPrimitive(""), "exp" to JsonPrimitive(1), "nbf" to JsonPrimitive(9e12))) {
      val claims = JsonObject(CloudflareAccessTestTokens.claims() + (key to value))
      assertThrows(CloudflareAccessException::class.java) { CloudflareAccessJWT.appClaims(CloudflareAccessTestTokens.token(claims), application) }
    }
    assertThrows(CloudflareAccessException::class.java) { CloudflareAccessJWT.verify(CloudflareAccessTestTokens.token(CloudflareAccessTestTokens.claims(), "HS256"), CloudflareAccessTestTokens.jwks) }
    assertThrows(CloudflareAccessException::class.java) { CloudflareAccessJWT.application(CloudflareAccessTestTokens.metadata("other.example.test"), application.origin) }
    for (host in listOf("evil.test", "example.cloudflareaccess.com.evil.test", "a.b.cloudflareaccess.com", "example.cloudflareaccess.com:443", "example.cloudflareaccess.com/path")) {
      assertThrows(CloudflareAccessException::class.java) { CloudflareAccessJWT.issuer(host) }
    }
  }

  @Test fun resourceSpecificChallengeStillVerifiesMetadataAtTheOriginalUrl() =
    runBlocking {
      for (path in listOf("/mcp", "/gateway/socket")) {
        val gatewayUrl = "${application.origin.uri}$path"
        val requests = mutableListOf<Request>()
        val client =
          CloudflareAccessClient { request, _, _ ->
            requests += request
            when (requests.size) {
              1 -> {
                reply(request, 302, mapOf("WWW-Authenticate" to "Cloudflare-Access resource_metadata=\"${application.origin.uri}/.well-known/cloudflare-access-protected-resource$path\""))
              }

              2 -> {
                assertEquals(gatewayUrl, request.url.toString())
                assertEquals("HEAD", request.method)
                assertEquals("true", request.header("Cf-Access-Metadata-Request"))
                reply(request, 200, mapOf("Cf-Access-Metadata" to CloudflareAccessTestTokens.metadata()))
              }

              else -> {
                reply(request, 200, body = CloudflareAccessTestTokens.jwks)
              }
            }
          }
        assertEquals(application, client.discover(gatewayUrl))
        assertEquals(3, requests.size)
      }
    }

  @Test fun metadataNamespaceLookalikesAndUrlDecorationsAreRejected() {
    val request = Request.Builder().url(application.origin.uri.toString()).build()
    for (path in listOf(
      "/other/mcp",
      "/.well-known/cloudflare-access-protected-resource-spoof/mcp",
      "/.well-known/cloudflare-access-protected-resource/mcp?redirect=other",
      "/.well-known/cloudflare-access-protected-resource/mcp#fragment",
    )) {
      val header = "Bearer resource_metadata=\"${application.origin.uri}$path\""
      assertFalse(CloudflareAccessClient.isChallenge(reply(request, 401, mapOf("WWW-Authenticate" to header)), application.origin))
    }
  }

  @Test fun identityUsesOneScopedCookieAndMustMatchVerifiedSubject() =
    runBlocking {
      val token = CloudflareAccessTestTokens.token(CloudflareAccessTestTokens.claims())
      for (subject in listOf("test-subject", "other-subject")) {
        val client =
          CloudflareAccessClient { request, _, _ ->
            if (request.url.encodedPath.endsWith("certs")) {
              reply(request, 200, body = CloudflareAccessTestTokens.jwks)
            } else {
              assertEquals("${application.origin.uri}/cdn-cgi/access/get-identity", request.url.toString())
              assertEquals("CF_Authorization=$token", request.header("Cookie"))
              assertNull(request.header("Authorization"))
              assertNull(request.header("Cf-Access-Token"))
              reply(request, 200, body = "{\"user_uuid\":\"$subject\"}".toByteArray())
            }
          }
        val result = runCatching { client.verifiedSession(token, application) }
        assertEquals(subject == "test-subject", result.isSuccess)
      }
    }

  @Test fun defaultTransportDoesNotFollowCredentialRedirectsAndBoundsBodies() =
    runBlocking {
      MockWebServer().use { server ->
        server.start()
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/other")))
        val response =
          CloudflareAccessClient.send(
            Request
              .Builder()
              .url(server.url("/"))
              .header("Cookie", "CF_Authorization=test-only")
              .build(),
            0,
            5,
          )
        assertEquals(302, response.code)
        assertEquals(1, server.requestCount)
        server.enqueue(MockResponse().setBody("12345"))
        val failure = runCatching { CloudflareAccessClient.send(Request.Builder().url(server.url("/")).build(), 4, 5) }.exceptionOrNull()
        assertTrue(failure is CloudflareAccessException)
      }
    }
}
