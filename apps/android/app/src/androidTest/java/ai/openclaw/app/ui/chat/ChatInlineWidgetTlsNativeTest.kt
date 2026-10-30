package ai.openclaw.app.ui.chat

import ai.openclaw.app.gateway.GatewayTlsTestObservation
import ai.openclaw.app.gateway.closeGatewayTlsTestClients
import ai.openclaw.app.gateway.gatewayTlsTestFixture
import ai.openclaw.app.gateway.tlsTestCauses
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
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
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException

@RunWith(AndroidJUnit4::class)
class ChatInlineWidgetTlsNativeTest {
  @Before
  fun requireAndroidConscrypt() {
    val provider = SSLContext.getInstance("TLS").provider
    assertTrue("Native Android Conscrypt required: $provider", provider.javaClass.name.contains("conscrypt"))
    println("Android TLS provider=${provider.javaClass.name}")
  }

  @Test
  fun platformRootFetchesDocumentWithMatchingHostname() = runBlocking { assertWidgetFetch(TlsCase.SYSTEM_MATCHING) }

  @Test
  fun platformRootRejectsWrongHostnameWithoutOriginRequest() = runBlocking { assertWidgetFetch(TlsCase.SYSTEM_WRONG_HOST) }

  @Test
  fun platformRootCannotFetchThroughBlocklistedRawIntermediate() = runBlocking { assertWidgetFetch(TlsCase.SYSTEM_BLOCKLISTED) }

  @Test
  fun matchingLeafPinFetchesDocumentDespiteDiscoveredIpHostnameMismatch() = runBlocking { assertWidgetFetch(TlsCase.MATCHING) }

  @Test
  fun wrongLeafPinReturnsUnavailableWithoutOriginRequest() = runBlocking { assertWidgetFetch(TlsCase.WRONG) }

  @Test
  fun matchingLeafPinCannotFetchThroughBlocklistedRawIntermediate() = runBlocking { assertWidgetFetch(TlsCase.BLOCKLISTED) }

  private suspend fun assertWidgetFetch(case: TlsCase) {
    val fixture = gatewayTlsTestFixture(blocklisted = case.blocklisted, platformTrusted = case.platformTrusted)
    val observation = GatewayTlsTestObservation()
    val productionClient =
      requireNotNull(
        buildWidgetClient(
          if (case.platformTrusted) {
            null
          } else if (case == TlsCase.WRONG) {
            fixture.wrongFingerprint
          } else {
            fixture.fingerprint
          },
        ),
      )
    val client = observation.observe(productionClient)
    MockWebServer().use { server ->
      try {
        server.useHttps(fixture.socketFactory, false)
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html; charset=utf-8").setBody("<p>owned localhost widget</p>"))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val host = if (case.platformTrusted && case != TlsCase.SYSTEM_WRONG_HOST) "localhost" else "127.0.0.1"
        val response = fetchWidgetDocument(client, "https://$host:${server.port}/widget")
        requireNotNull(response.data).use { body ->
          if (case == TlsCase.MATCHING || case == TlsCase.SYSTEM_MATCHING) {
            assertEquals(200, response.statusCode)
            assertEquals("text/html", response.mimeType)
            assertEquals("<p>owned localhost widget</p>", body.bufferedReader().readText())
            assertTrue(observation.hostnameAccepted.get())
            assertEquals("/widget", server.takeRequest(5, TimeUnit.SECONDS)?.path)
            assertEquals(1, server.requestCount)
          } else {
            assertEquals(502, response.statusCode)
            val failure = withTimeout(8_000) { observation.failure.await() }
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
            assertNull(server.takeRequest(100, TimeUnit.MILLISECONDS))
            assertEquals(0, server.requestCount)
          }
        }
      } finally {
        closeGatewayTlsTestClients(client)
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
}
