package ai.openclaw.app.gateway

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer

@OptIn(ExperimentalCoroutinesApi::class)
class OpenClawIdTunnelTest {
  private class Connection : OpenClawIdConnection {
    val ended = CompletableDeferred<OpenClawIdClose>()
    val closes = mutableListOf<Long>()

    override suspend fun openBi(): OpenClawIdBiStream = error("not used")

    override suspend fun closed() = ended.await()

    override fun close(code: Long) {
      closes += code
      ended.complete(OpenClawIdClose.Local)
    }
  }

  private class Endpoint(
    val dial: suspend () -> OpenClawIdConnection,
  ) : OpenClawIdEndpoint {
    var calls = 0
    var denied = false
    var shutdown = false

    override suspend fun connect(serverKey: String): OpenClawIdConnection {
      calls++
      return dial()
    }

    override fun relayStatus() = OpenClawIdRelayStatus(!denied, denied)

    override suspend fun shutdown() {
      shutdown = true
    }
  }

  @Test fun admissionWaitAndTerminalCodesNeverDependOnReasonOrNarrowTo32Bits() =
    runTest {
      for (code in listOf(1L, 2L, 0x1_0000_0001L)) {
        val connection = Connection()
        val endpoint = Endpoint { connection }
        val tunnel = OpenClawIdTunnel(backgroundScope, endpoint, { "verified" }, { testScheduler.currentTime })
        val dial = async { runCatching { tunnel.connection() } }
        runCurrent()
        assertFalse(dial.isCompleted)
        connection.ended.complete(OpenClawIdClose.Application(code))
        runCurrent()
        assertTrue(dial.await().isFailure)
        assertEquals(code == 1L || code == 2L, tunnel.removed.value)
        if (tunnel.removed.value) {
          assertTrue(runCatching { tunnel.connection() }.exceptionOrNull() is OpenClawIdRemovedException)
          assertEquals(1, endpoint.calls)
        }
        tunnel.shutdown()
      }
    }

  @Test fun sharedConnectionWaitsForAdmissionAndRevalidatesEveryDial() =
    runTest {
      val connection = Connection()
      val endpoint = Endpoint { connection }
      var verifications = 0
      val tunnel =
        OpenClawIdTunnel(backgroundScope, endpoint, {
          verifications++
          "verified"
        }, { testScheduler.currentTime })
      val first = async { tunnel.connection() }
      val second = async { tunnel.connection() }
      runCurrent()
      advanceTimeBy(499)
      assertFalse(first.isCompleted)
      advanceTimeBy(1)
      runCurrent()
      assertSame(first.await(), second.await())
      assertEquals(1, verifications)
      connection.ended.complete(OpenClawIdClose.Application(2))
      runCurrent()
      assertTrue(tunnel.removed.value)
      tunnel.shutdown()
      assertTrue(endpoint.shutdown)
    }

  @Test fun silentConnectionProbeTimeoutClosesOldConnectionAndReconnects() =
    runTest {
      val initial = Connection()
      var attempts = 0
      val endpoint = Endpoint { if (++attempts == 1) initial else awaitCancellation() }
      val tunnel = OpenClawIdTunnel(backgroundScope, endpoint, { "verified" }, { testScheduler.currentTime })
      val first = async { tunnel.connection() }
      advanceTimeBy(500)
      runCurrent()
      first.await()
      // First timer at 3s sees only 2.5s silence; next timer at 6s starts the 5s probe.
      advanceTimeBy(10_500)
      runCurrent()
      assertEquals(listOf(10L), initial.closes)
      assertFalse(tunnel.removed.value)
      tunnel.shutdown()
    }

  @Test fun relayDenialBackoffPreventsImmediateRedial() =
    runTest {
      val endpoint = Endpoint { throw OpenClawIdTunnelException() }.apply { denied = true }
      val tunnel = OpenClawIdTunnel(backgroundScope, endpoint, { "verified" }, { testScheduler.currentTime })
      assertTrue(runCatching { tunnel.connection() }.isFailure)
      val next = async { runCatching { tunnel.connection() } }
      runCurrent()
      advanceTimeBy(9_999)
      assertEquals(1, endpoint.calls)
      advanceTimeBy(1)
      runCurrent()
      assertTrue(next.await().isFailure)
      assertEquals(2, endpoint.calls)
      tunnel.shutdown()
    }

  @Test fun protocolPackageFrameExamplesSurviveBytewiseReadsAndRejectLengthBeforePayload() =
    runTest {
      // Independent byte expectations from packages/openclaw-id-protocol/src/tunnel/tunnel.test.ts.
      assertArrayEquals(byteArrayOf(0, 0, 0, 3, 1, 104, 105), OpenClawIdFrames.encode(OpenClawIdFrames.text("hi")))
      assertArrayEquals(byteArrayOf(8, 3, -24, 98, 121, 101), OpenClawIdFrames.close(1000, "bye"))
      assertEquals(OpenClawIdFrames.Message.Close(1000, "bye"), OpenClawIdFrames.message(byteArrayOf(8, 3, -24, 98, 121, 101)))
      val bytes = OpenClawIdFrames.encode("hello".toByteArray()) + OpenClawIdFrames.encode(byteArrayOf())
      var position = 0
      val receive =
        object : OpenClawIdReceiveStream {
          override suspend fun read(maxBytes: Int) = if (position < bytes.size) byteArrayOf(bytes[position++]) else null

          override suspend fun stop(code: Long) {}
        }
      val reader = OpenClawIdFrameReader(receive)
      assertArrayEquals("hello".toByteArray(), reader.next())
      assertArrayEquals(byteArrayOf(), reader.next())
      assertNull(reader.next())
      var calls = 0
      val oversized =
        object : OpenClawIdReceiveStream {
          override suspend fun read(maxBytes: Int): ByteArray {
            calls++
            return ByteBuffer.allocate(4).putInt(OpenClawIdFrames.MAX_HEAD_BYTES + 1).array()
          }

          override suspend fun stop(code: Long) {}
        }
      assertTrue(runCatching { OpenClawIdFrameReader(oversized).next(OpenClawIdFrames.MAX_HEAD_BYTES) }.exceptionOrNull() is OpenClawIdProtocolException)
      assertEquals(1, calls)
    }

  @Test fun headAndMessageValidationFailClosed() {
    assertEquals(101, OpenClawIdFrames.responseStatus("{\"status\":101,\"protocol\":null}".toByteArray()))
    assertEquals(403, OpenClawIdFrames.responseStatus("{\"status\":403,\"headers\":[]}".toByteArray()))
    for (bad in listOf("{\"status\":\"101\"}", "{\"status\":101,\"protocol\":\"unrequested\"}", "[]", "{\"status\":403,\"headers\":[1]}")) {
      assertTrue(runCatching { OpenClawIdFrames.responseStatus(bad.toByteArray()) }.exceptionOrNull() is OpenClawIdProtocolException)
    }
    for (bad in listOf(byteArrayOf(9), byteArrayOf(8, 1), byteArrayOf(1, -1))) {
      assertTrue(runCatching { OpenClawIdFrames.message(bad) }.exceptionOrNull() is OpenClawIdProtocolException)
    }
    assertEquals("{\"kind\":\"ws\",\"path\":\"/\",\"headers\":[],\"protocols\":[]}", OpenClawIdFrames.webSocketHead("/").decodeToString())
  }
}
