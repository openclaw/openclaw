package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcMethod
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearProxyBridgeTest {
  @Test
  fun validRequestRegistersPeerAndReturnsCorrelatedResponse() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { request ->
            WearMessage.Response(
              requestId = request.requestId,
              ok = true,
              result = buildJsonObject { put("connected", true) },
            )
          },
        )

      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))

      assertEquals(1, bridge.peerCountForTests())
      assertEquals(1, sent.size)
      assertEquals("watch-1", sent.single().nodeId)
      assertEquals(WearProtocol.RESPONSE_PATH, sent.single().path)
      val response = (WearProtocolCodec.decode(sent.single().data) as WearDecodeResult.Success).message as WearMessage.Response
      assertEquals("req-1", response.requestId)
    }

  @Test
  fun malformedMessageDoesNotRegisterPeer() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { error("must not run") },
        )

      bridge.handleMessage("watch-1", "not-json".encodeToByteArray())

      assertEquals(0, bridge.peerCountForTests())
      assertTrue(sent.isEmpty())
    }

  @Test
  fun responseSendPreservesCancellation() =
    runTest {
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { _, _, _ -> throw CancellationException("stopping") },
          handleRequest = { request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )

      var cancelled = false
      try {
        bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))
      } catch (_: CancellationException) {
        cancelled = true
      }

      assertTrue(cancelled)
      assertEquals(1, bridge.peerCountForTests())
    }

  @Test
  fun canceledGoogleTaskResumesAsSendFailure() =
    runTest {
      val failure = runCatching { Tasks.forCanceled<Int>().awaitWearTask() }.exceptionOrNull()

      assertTrue(failure is WearTaskCanceledException)
    }

  @Test
  fun callerCancellationWinsLaterGoogleTaskCompletion() =
    runTest {
      val source = TaskCompletionSource<Int>()
      val awaiting = backgroundScope.async { source.task.awaitWearTask() }
      runCurrent()

      awaiting.cancel()
      runCurrent()
      source.setResult(1)
      runCurrent()

      assertTrue(awaiting.isCancelled)
    }

  @Test
  fun eventQueuePreservesSequenceAndBoundsPeers() =
    runTest {
      val sent = mutableListOf<SentWearMessage>()
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender = WearMessageSender { nodeId, path, data -> sent += SentWearMessage(nodeId, path, data) },
          handleRequest = { request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      repeat(9) { index -> bridge.handleMessage("watch-$index", WearProtocolCodec.encode(request("req-$index"))) }
      sent.clear()

      bridge.publishConnection(connected = true, status = "Connected")
      bridge.publishChat(
        buildJsonObject {
          put("runId", "run-1")
          put("sessionKey", "main")
          put("seq", 1)
          put("state", "delta")
          put("deltaText", "hello")
          put("privateField", "drop me")
        },
      )
      runCurrent()

      assertEquals(8, bridge.peerCountForTests())
      val events =
        sent
          .filter { it.path == WearProtocol.EVENT_PATH }
          .map { (WearProtocolCodec.decode(it.data) as WearDecodeResult.Success).message as WearMessage.Event }
      assertEquals(16, events.size)
      assertEquals(setOf(1L, 2L), events.map { it.sequence }.toSet())
      assertEquals(setOf(WearEventType.Connection, WearEventType.Chat), events.map { it.event }.toSet())
      val chat = events.first { it.event == WearEventType.Chat }
      val payload = checkNotNull(chat.payload).jsonObject
      assertEquals(setOf("runId", "sessionKey", "seq", "state", "deltaText"), payload.keys)
      assertEquals("hello", payload.getValue("deltaText").jsonPrimitive.content)
    }

  @Test
  fun staleEventFailureDoesNotRemoveRefreshedPeer() =
    runTest {
      val eventStarted = CompletableDeferred<Unit>()
      val releaseEvent = CompletableDeferred<Unit>()
      val sent = mutableListOf<SentWearMessage>()
      var failFirstEvent = true
      val bridge =
        WearProxyBridge(
          scope = backgroundScope,
          sender =
            WearMessageSender { nodeId, path, data ->
              if (path == WearProtocol.EVENT_PATH && failFirstEvent) {
                failFirstEvent = false
                eventStarted.complete(Unit)
                releaseEvent.await()
                error("stale send failed")
              }
              sent += SentWearMessage(nodeId, path, data)
            },
          handleRequest = { request -> WearMessage.Response(requestId = request.requestId, ok = true) },
        )
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-1")))

      bridge.publishConnection(connected = true, status = "Connected")
      eventStarted.await()
      bridge.handleMessage("watch-1", WearProtocolCodec.encode(request("req-2")))
      releaseEvent.complete(Unit)
      runCurrent()

      bridge.publishConnection(connected = false, status = "Offline")
      runCurrent()

      assertEquals(1, bridge.peerCountForTests())
      assertEquals(1, sent.count { it.path == WearProtocol.EVENT_PATH })
    }

  private fun request(requestId: String): WearMessage.Request = WearMessage.Request(requestId = requestId, method = WearRpcMethod.ProxyStatus)
}

private data class SentWearMessage(
  val nodeId: String,
  val path: String,
  val data: ByteArray,
)
