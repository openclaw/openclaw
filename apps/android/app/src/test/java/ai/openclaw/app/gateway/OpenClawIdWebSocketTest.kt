package ai.openclaw.app.gateway

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class OpenClawIdWebSocketTest {
  private class Stream :
    OpenClawIdSendStream,
    OpenClawIdReceiveStream {
    val incoming = Channel<ByteArray>(Channel.UNLIMITED)
    val writes = mutableListOf<ByteArray>()
    val retired = mutableListOf<String>()
    var remaining = byteArrayOf()

    override suspend fun read(maxBytes: Int): ByteArray? {
      if (remaining.isEmpty()) remaining = incoming.receiveCatching().getOrNull() ?: return null
      val result = remaining.copyOfRange(0, minOf(remaining.size, maxBytes))
      remaining = remaining.copyOfRange(result.size, remaining.size)
      return result
    }

    override suspend fun writeAll(bytes: ByteArray) {
      writes += bytes
    }

    override suspend fun finish() {
      retired += "FIN"
    }

    override suspend fun reset(code: Long) {
      retired += "reset"
    }

    override suspend fun stop(code: Long) {
      retired += "stop"
      incoming.close()
    }
  }

  private class Endpoint(
    val stream: Stream,
  ) : OpenClawIdEndpoint {
    private val ended = CompletableDeferred<OpenClawIdClose>()

    override suspend fun connect(serverKey: String) =
      object : OpenClawIdConnection {
        override suspend fun openBi() = OpenClawIdBiStream(stream, stream)

        override suspend fun closed() = ended.await()

        override fun close(code: Long) {
          ended.complete(OpenClawIdClose.Local)
        }
      }

    override fun relayStatus() = OpenClawIdRelayStatus(true, false)

    override suspend fun shutdown() {
      ended.complete(OpenClawIdClose.Local)
    }
  }

  @Test fun nodeWebSocketUsesProtocolHeadAndMessagesWithoutCopyingHttpCredentials() =
    runTest {
      val stream = Stream()
      val tunnel = OpenClawIdTunnel(backgroundScope, Endpoint(stream), { "verified" }, { testScheduler.currentTime })
      val events = mutableListOf<String>()
      val socket =
        OpenClawIdWebSocket(
          backgroundScope,
          tunnel,
          Request
            .Builder()
            .url("https://logical.example.test/")
            .header("Authorization", "never-forward")
            .build(),
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              events += "open"
              assertTrue(webSocket.send("hello"))
            }

            override fun onMessage(
              webSocket: WebSocket,
              text: String,
            ) {
              events += text
            }

            override fun onClosing(
              webSocket: WebSocket,
              code: Int,
              reason: String,
            ) {
              events += "closing"
              webSocket.close(code, reason)
            }

            override fun onClosed(
              webSocket: WebSocket,
              code: Int,
              reason: String,
            ) {
              assertTrue("stop" in stream.retired)
              events += "closed"
            }

            override fun onFailure(
              webSocket: WebSocket,
              t: Throwable,
              response: Response?,
            ) {
              events += "failure"
            }
          },
        )
      stream.incoming.send(OpenClawIdFrames.encode("{\"status\":101,\"protocol\":null}".toByteArray()))
      advanceTimeBy(500)
      runCurrent()
      assertEquals(listOf("open"), events)
      assertArrayEquals(OpenClawIdFrames.encode("{\"kind\":\"ws\",\"path\":\"/\",\"headers\":[],\"protocols\":[]}".toByteArray()), stream.writes.first())
      assertArrayEquals(byteArrayOf(0, 0, 0, 6, 1, 104, 101, 108, 108, 111), stream.writes[1])
      stream.incoming.send(OpenClawIdFrames.encode(byteArrayOf(1, 104, 105)))
      stream.incoming.send(OpenClawIdFrames.encode(byteArrayOf(8, 3, -24)))
      runCurrent()
      assertEquals(listOf("open", "hi", "closing", "closed"), events)
      assertFalse(socket.send("after close"))
      tunnel.shutdown()
    }

  @Test fun cancelBlockedReadRetiresBothHalvesBeforeOneTerminalCallback() =
    runTest {
      val stream = Stream()
      val tunnel = OpenClawIdTunnel(backgroundScope, Endpoint(stream), { "verified" }, { testScheduler.currentTime })
      var failures = 0
      val socket =
        OpenClawIdWebSocket(
          backgroundScope,
          tunnel,
          Request.Builder().url("https://logical.example.test/").build(),
          object : WebSocketListener() {
            override fun onFailure(
              webSocket: WebSocket,
              t: Throwable,
              response: Response?,
            ) {
              failures++
              assertTrue("reset" in stream.retired && "stop" in stream.retired)
            }
          },
        )
      stream.incoming.send(OpenClawIdFrames.encode("{\"status\":101}".toByteArray()))
      advanceTimeBy(500)
      runCurrent()
      socket.cancel()
      socket.cancel()
      runCurrent()
      assertEquals(1, failures)
      tunnel.shutdown()
    }

  @Test fun emptyPeerCloseIsEchoedWithoutReservedCodeOrResettingFinishedSend() =
    runTest {
      val stream = Stream()
      val tunnel = OpenClawIdTunnel(backgroundScope, Endpoint(stream), { "verified" }, { testScheduler.currentTime })
      var closedCode: Int? = null
      var failures = 0
      OpenClawIdWebSocket(
        backgroundScope,
        tunnel,
        Request.Builder().url("https://logical.example.test/").build(),
        object : WebSocketListener() {
          override fun onClosing(
            webSocket: WebSocket,
            code: Int,
            reason: String,
          ) {
            webSocket.close(code, reason)
          }

          override fun onClosed(
            webSocket: WebSocket,
            code: Int,
            reason: String,
          ) {
            closedCode = code
          }

          override fun onFailure(
            webSocket: WebSocket,
            t: Throwable,
            response: Response?,
          ) {
            failures++
          }
        },
      )
      stream.incoming.send(OpenClawIdFrames.encode("{\"status\":101}".toByteArray()))
      stream.incoming.send(byteArrayOf(0, 0, 0, 1, 8))
      advanceTimeBy(500)
      runCurrent()
      assertEquals(1005, closedCode)
      assertEquals(0, failures)
      assertArrayEquals(byteArrayOf(0, 0, 0, 1, 8), stream.writes.last())
      assertTrue("FIN" in stream.retired)
      assertFalse("reset" in stream.retired)
      tunnel.shutdown()
    }
}
