package ai.openclaw.app.gateway

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import kotlin.concurrent.thread

class GatewayTlsTest {
  @Test
  fun probeGatewayTlsFingerprint_reportsHandshakeTimeoutAfterTcpConnect() =
    runBlocking {
      TcpTestServer { socket ->
        socket.soTimeout = 1_000
        runCatching { socket.getInputStream().read(ByteArray(512)) }
        Thread.sleep(700)
      }.use { server ->
        val result =
          probeGatewayTlsFingerprint(
            host = LOOPBACK_HOST,
            port = server.port,
            connectTimeoutMs = 250,
            handshakeTimeoutMs = 250,
          )

        assertEquals(GatewayTlsProbeFailure.TLS_HANDSHAKE_TIMEOUT, result.failure)
      }
    }

  @Test
  fun probeGatewayTlsFingerprint_reportsTlsUnavailableForPlainHttpEndpoint() =
    runBlocking {
      TcpTestServer { socket ->
        socket.soTimeout = 1_000
        runCatching { socket.getInputStream().read(ByteArray(512)) }
        socket.getOutputStream().write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n".toByteArray())
        socket.getOutputStream().flush()
      }.use { server ->
        val result =
          probeGatewayTlsFingerprint(
            host = LOOPBACK_HOST,
            port = server.port,
            connectTimeoutMs = 250,
            handshakeTimeoutMs = 1_000,
          )

        assertEquals(GatewayTlsProbeFailure.TLS_UNAVAILABLE, result.failure)
      }
    }

  @Test
  fun probeGatewayTlsFingerprint_reportsTlsUnavailableForConnectedReset() =
    runBlocking {
      TcpTestServer { socket ->
        socket.close()
      }.use { server ->
        val result =
          probeGatewayTlsFingerprint(
            host = LOOPBACK_HOST,
            port = server.port,
            connectTimeoutMs = 250,
            handshakeTimeoutMs = 1_000,
          )

        assertEquals(GatewayTlsProbeFailure.TLS_UNAVAILABLE, result.failure)
      }
    }

  @Test
  fun probeGatewayTlsFingerprint_reportsUnreachableWhenTcpConnectFails() =
    runBlocking {
      val result =
        probeGatewayTlsFingerprint(
          host = LOOPBACK_HOST,
          port = unusedLoopbackPort(),
          connectTimeoutMs = 250,
          handshakeTimeoutMs = 250,
        )

      assertEquals(GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE, result.failure)
    }

  private class TcpTestServer(
    private val handler: (Socket) -> Unit,
  ) : AutoCloseable {
    private val serverSocket = ServerSocket(0, 50, LOOPBACK_ADDRESS)
    private var acceptedSocket: Socket? = null
    private val worker =
      thread(start = true, isDaemon = true, name = "openclaw-tls-probe-test-server") {
        try {
          serverSocket.accept().use { socket ->
            acceptedSocket = socket
            handler(socket)
          }
        } catch (_: SocketException) {
          // Closing the server during test cleanup interrupts accept/read.
        }
      }

    val port: Int = serverSocket.localPort

    override fun close() {
      runCatching { acceptedSocket?.close() }
      runCatching { serverSocket.close() }
      worker.join(1_000)
    }
  }

  private companion object {
    const val LOOPBACK_HOST = "127.0.0.1"
    val LOOPBACK_ADDRESS: InetAddress = InetAddress.getByName(LOOPBACK_HOST)

    fun unusedLoopbackPort(): Int =
      ServerSocket(0, 50, LOOPBACK_ADDRESS).use { server ->
        server.localPort
      }
  }
}
