package ai.openclaw.app.ui.chat

import ai.openclaw.app.gateway.GatewayTlsTestObservation
import ai.openclaw.app.gateway.closeGatewayTlsTestClients
import ai.openclaw.app.gateway.gatewayTlsTestFixture
import ai.openclaw.app.gateway.tlsTestCauses
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.InetAddress
import java.security.cert.CertificateException
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatInlineWidgetTlsTest {
  @Test
  fun matchingLeafPinFetchesDocumentDespiteDiscoveredIpHostnameMismatch() = runBlocking { assertWidgetFetch(TlsCase.MATCHING) }

  @Test
  fun wrongLeafPinReturnsUnavailableWithoutOriginRequest() = runBlocking { assertWidgetFetch(TlsCase.WRONG) }

  @Test
  fun matchingLeafPinCannotFetchThroughBlocklistedRawIntermediate() = runBlocking { assertWidgetFetch(TlsCase.BLOCKLISTED) }

  private suspend fun assertWidgetFetch(case: TlsCase) {
    val fixture = gatewayTlsTestFixture(blocklisted = case == TlsCase.BLOCKLISTED)
    val observation = GatewayTlsTestObservation()
    val productionClient = requireNotNull(buildWidgetClient(if (case == TlsCase.WRONG) fixture.wrongFingerprint else fixture.fingerprint))
    val client = observation.observe(productionClient)
    MockWebServer().use { server ->
      try {
        server.useHttps(fixture.socketFactory, false)
        server.enqueue(MockResponse().setHeader("Content-Type", "text/html; charset=utf-8").setBody("<p>owned localhost widget</p>"))
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        val response = fetchWidgetDocument(client, "https://127.0.0.1:${server.port}/widget")
        requireNotNull(response.data).use { body ->
          if (case == TlsCase.MATCHING) {
            assertEquals(200, response.statusCode)
            assertEquals("text/html", response.mimeType)
            assertEquals("<p>owned localhost widget</p>", body.bufferedReader().readText())
            assertTrue(observation.hostnameAccepted.get())
            assertEquals("/widget", server.takeRequest(5, TimeUnit.SECONDS)?.path)
            assertEquals(1, server.requestCount)
          } else {
            assertEquals(502, response.statusCode)
            val failure = withTimeout(8_000) { observation.failure.await() }
            if (case == TlsCase.BLOCKLISTED) {
              observation.assertBlocklisted(failure, fixture)
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

  private enum class TlsCase {
    MATCHING,
    WRONG,
    BLOCKLISTED,
  }
}
