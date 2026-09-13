package ai.openclaw.app.gateway

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Headers
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

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
