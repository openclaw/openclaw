package ai.openclaw.app.gateway

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class BrowserSessionAuthorizationTest {
  private val origin = "https://gateway.example.test:8443/".toHttpUrl()

  @Test
  fun cookiesAreResolvedForEachExactRequestAndNeverExportedAsMediaHeaders() =
    runBlocking {
      val lookedUp = mutableListOf<String>()
      val grant =
        BrowserSessionAuthorization(origin, { url ->
          lookedUp.add(url.toString())
          if (url.encodedPath.startsWith("/media/")) "media=session" else "login=session"
        }, { true })
      val upgrade = grant.authorizeUpgrade(Request.Builder().url("wss://gateway.example.test:8443/gateway/").build())
      val media =
        grant.authorizeHttp(
          Request
            .Builder()
            .url("https://gateway.example.test:8443/media/item")
            .header("Cookie", "login=stale")
            .build(),
        )
      assertEquals("login=session", upgrade.header("Cookie"))
      assertEquals("media=session", media.header("Cookie"))
      assertEquals(listOf("https://gateway.example.test:8443/gateway/", "https://gateway.example.test:8443/media/item"), lookedUp)
      assertEquals(mapOf("X-Proxy" to "value"), grant.mediaHeaders(mapOf("cOoKiE" to "secret", "X-Proxy" to "value")))
    }

  @Test
  fun foreignOriginsExpiredCookiesAndRetiredAccountsFailBeforeCookieAccess() {
    var current = true
    var reads = 0
    var cookie: String? = "session=current"
    val grant =
      BrowserSessionAuthorization(origin, {
        reads++
        cookie
      }, { current })
    for (url in listOf("http://gateway.example.test:8443/", "https://gateway.example.test/", "https://other.example.test:8443/")) {
      assertThrows(GatewayExternalAuthorizationException::class.java) { grant.authorizeHttp(Request.Builder().url(url).build()) }
    }
    assertEquals(0, reads)
    current = false
    assertThrows(GatewayExternalAuthorizationException::class.java) { grant.authorizeHttp(Request.Builder().url(origin).build()) }
    assertEquals(0, reads)
    current = true
    cookie = null
    assertThrows(GatewayExternalAuthorizationException::class.java) { grant.authorizeHttp(Request.Builder().url(origin).build()) }
    assertEquals(1, reads)
  }

  @Test
  fun rotationStaysInTheLiveStoreAndProxyChallengesRemainSeparateFromGatewayErrors() {
    var current = true
    val saved = mutableListOf<Pair<String, List<String>>>()
    val grant = BrowserSessionAuthorization(origin, { "session=current" }, { current }, { url, values -> saved.add(url.toString() to values) })

    fun response(
      code: Int,
      vararg headers: Pair<String, String>,
    ): Response {
      val builder =
        Response
          .Builder()
          .request(Request.Builder().url(origin).build())
          .protocol(Protocol.HTTP_1_1)
          .code(code)
          .message("fixture")
      headers.forEach { (name, value) -> builder.addHeader(name, value) }
      return builder.build()
    }
    grant.receiveResponse(response(200, "Set-Cookie" to "session=rotated; Path=/; Secure; HttpOnly"))
    assertEquals(listOf(origin.toString() to listOf("session=rotated; Path=/; Secure; HttpOnly")), saved)
    assertNotNull(grant.rejection(response(302, "Location" to "https://login.example.test/?rd=fixture")))
    assertNotNull(grant.rejection(response(403, "Content-Type" to "text/html; charset=utf-8")))
    assertNull(grant.rejection(response(403, "Content-Type" to "application/json")))
    assertNull(grant.rejection(response(301, "Location" to "/gateway/")))
    current = false
    assertThrows(GatewayExternalAuthorizationException::class.java) { grant.receiveResponse(response(200, "Set-Cookie" to "session=late")) }
    assertEquals(1, saved.size)
    assertFalse(grant.mediaHeaders(mapOf("Cookie" to "secret")).containsKey("Cookie"))
  }
}
