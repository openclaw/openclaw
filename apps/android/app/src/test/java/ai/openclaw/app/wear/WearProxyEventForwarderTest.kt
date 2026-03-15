package ai.openclaw.app.wear

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class WearProxyEventForwarderTest {
  @Test
  fun `forwarder keeps sending events to the handshake node`() = runTest {
    val scope = TestScope(StandardTestDispatcher(testScheduler))
    val mainSessionKey = MutableStateFlow("main")
    val events = MutableSharedFlow<Pair<String, String?>>(extraBufferCapacity = 4)
    val sent = mutableListOf<Triple<String, String, String?>>()

    val job =
      WearProxyEventForwarder(
        nodeId = "watch-node-a",
        mainSessionKey = mainSessionKey,
        events = events,
        sendEvent = { nodeId, event, payload ->
          sent += Triple(nodeId, event, payload)
        },
      ).startIn(scope)

    advanceUntilIdle()
    events.emit("chat" to """{"state":"streaming"}""")
    advanceUntilIdle()

    assertEquals(
      listOf(
        Triple("watch-node-a", "mainSessionKey", "main"),
        Triple("watch-node-a", "chat", """{"state":"streaming"}"""),
      ),
      sent,
    )

    job.cancel()
    scope.cancel()
  }
}
