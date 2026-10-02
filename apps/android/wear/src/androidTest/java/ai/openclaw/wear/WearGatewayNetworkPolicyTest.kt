package ai.openclaw.wear

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WearGatewayNetworkPolicyTest {
  @Test
  fun acceptedLocalSetupCanReceiveWebSocketFrames() {
    assertThrows(IllegalArgumentException::class.java) { setup("http://gateway.example/gateway") }
    MockWebServer().use { server ->
      server.enqueue(
        MockResponse().withWebSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              webSocket.send("local-gateway-ready")
            }
          },
        ),
      )
      server.start()
      val url = server.url("/gateway")
      assertFalse(setup(url.toString()).endpoint.tlsEnabled)
      val client = OkHttpClient()
      val received = CompletableFuture<String>()
      val socket =
        client.newWebSocket(
          Request.Builder().url(url).build(),
          object : WebSocketListener() {
            override fun onMessage(
              webSocket: WebSocket,
              text: String,
            ) {
              received.complete(text)
            }

            override fun onFailure(
              webSocket: WebSocket,
              t: Throwable,
              response: Response?,
            ) {
              received.completeExceptionally(t)
            }
          },
        )
      try {
        assertEquals("local-gateway-ready", received.get(10, TimeUnit.SECONDS))
      } finally {
        socket.cancel()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
      }
    }
  }

  private fun setup(url: String): WearGatewaySetup =
    parseWearGatewaySetup(
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        buildJsonObject {
          put("url", url)
          put("bootstrapToken", "fixture-bootstrap")
        }.toString().toByteArray(),
      ),
    )
}
