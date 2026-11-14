package ai.openclaw.app.gateway

import ai.openclaw.iroh.BiStream
import ai.openclaw.iroh.CancelToken
import ai.openclaw.iroh.CloseInfo
import ai.openclaw.iroh.CloseKind
import ai.openclaw.iroh.Connection
import ai.openclaw.iroh.IrohException
import ai.openclaw.iroh.NoHandle
import ai.openclaw.iroh.RecvStream
import ai.openclaw.iroh.SendStream
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenClawIdNativeTransportTest {
  @Test
  fun generatedCloseCodeSurvivesCancelledAdmissionObserverWithoutReasonParsing() =
    runTest {
      val terminal = CompletableDeferred<CloseInfo>()
      var outgoing = -1L
      val native =
        object : Connection(NoHandle) {
          override suspend fun closed(): CloseInfo = terminal.await()

          override fun close(
            code: Long,
            reason: ByteArray,
          ) {
            outgoing = code
          }
        }
      val connection = OpenClawIdNativeConnection(native)
      val firstWait = async { connection.closed() }
      firstWait.cancelAndJoin()
      val code = (1L shl 62) - 1
      terminal.complete(CloseInfo(CloseKind.APPLICATION, code, "revoked"))
      assertEquals(OpenClawIdClose.Application(code), connection.closed())
      connection.close(code)
      assertEquals(code, outgoing)
    }

  @Test
  fun generatedStreamResetIsNotEofAndCleanupKeepsNumericCodes() =
    runTest {
      val code = (1L shl 40) + 2
      var writes = byteArrayOf()
      var stopped = -1L
      var reset = -1L
      var sendReleased = false
      var receiveReleased = false
      val send =
        object : SendStream(NoHandle) {
          override suspend fun write(data: ByteArray) {
            writes = data
          }

          override suspend fun reset(code: Long) {
            reset = code
          }

          override fun destroy() {
            sendReleased = true
          }
        }
      val recv =
        object : RecvStream(NoHandle) {
          override suspend fun read(max: UInt): ByteArray? = throw IrohException.StreamReset(code)

          override suspend fun stop(code: Long) {
            stopped = code
          }

          override fun destroy() {
            receiveReleased = true
          }
        }
      val native =
        object : Connection(NoHandle) {
          override suspend fun openBi(cancel: CancelToken?): BiStream = BiStream(send, recv)
        }
      val stream = OpenClawIdNativeConnection(native).openBi()
      stream.send.writeAll(byteArrayOf(1, 2, 3))
      assertArrayEquals(byteArrayOf(1, 2, 3), writes)
      val failure = runCatching { stream.receive.read(1024) }.exceptionOrNull()
      assertTrue(failure is IrohException.StreamReset)
      assertEquals(code, (failure as IrohException.StreamReset).code)
      stream.send.reset(code)
      stream.receive.stop(code)
      assertEquals(code, reset)
      assertEquals(code, stopped)
      assertTrue(sendReleased && receiveReleased)
    }

  @Test
  fun cancellationBeforePublishingAStreamReleasesBothNativeHalves() =
    runTest {
      var releases = 0
      lateinit var caller: Job
      val native =
        object : Connection(NoHandle) {
          override fun close(
            code: Long,
            reason: ByteArray,
          ) = Unit

          override suspend fun openBi(cancel: CancelToken?): BiStream {
            caller.cancel()
            return BiStream(
              object : SendStream(NoHandle) {
                override fun destroy() {
                  releases++
                }
              },
              object : RecvStream(NoHandle) {
                override fun destroy() {
                  releases++
                }
              },
            )
          }
        }
      launch {
        caller = currentCoroutineContext()[Job]!!
        OpenClawIdNativeConnection(native).openBi()
      }.join()
      assertEquals(2, releases)
    }

  @Test
  fun cancellationSignalsNativeThenDrainsAndDiscardsItsReturnedResource() =
    runTest {
      val started = CompletableDeferred<Unit>()
      val nativeResult = CompletableDeferred<String>()
      val events = mutableListOf<String>()
      val call =
        launch {
          awaitOpenClawIdNative<String>(
            cancel = {
              events += "cancel-native"
              nativeResult.complete("handle")
            },
            discard = { events += "discard-$it" },
          ) {
            started.complete(Unit)
            nativeResult.await().also { events += "delivered" }
          }
        }
      started.await()
      call.cancelAndJoin()
      assertEquals(listOf("cancel-native", "delivered", "discard-handle"), events)
    }

  @Test
  fun successfulFinishReleasesHandleWithoutResetAndOnlyNullIsEof() =
    runTest {
      val operations = mutableListOf<String>()
      val send =
        object : SendStream(NoHandle) {
          override suspend fun finish() {
            operations += "finish"
          }

          override suspend fun reset(code: Long) {
            operations += "reset"
          }

          override fun destroy() {
            operations += "release"
          }
        }
      val recv =
        object : RecvStream(NoHandle) {
          override suspend fun read(max: UInt): ByteArray? = null
        }
      val native =
        object : Connection(NoHandle) {
          override suspend fun openBi(cancel: CancelToken?): BiStream = BiStream(send, recv)
        }
      val stream = OpenClawIdNativeConnection(native).openBi()
      stream.send.finish()
      assertEquals(listOf("finish", "release"), operations)
      assertNull(stream.receive.read(1))
    }
}
