package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.coroutineContext

/** One endpoint/connection per selected node target. GatewaySession owns WS reconnect, not this class. */
internal class OpenClawIdTunnel(
  parentScope: CoroutineScope,
  private val endpoint: OpenClawIdEndpoint,
  /** Refresh and persist pin/freshness before each dial, including watchdog probes. */
  private val verifiedServerKey: suspend () -> String,
  private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) {
  private val job = SupervisorJob(parentScope.coroutineContext[Job])
  private val scope = CoroutineScope(parentScope.coroutineContext + job)
  private val mutex = Mutex()
  private var current: OpenClawIdConnection? = null
  private val mutableRemoved = MutableStateFlow(false)
  val removed = mutableRemoved.asStateFlow()

  @Volatile private var lastReceived = nowMillis()
  private var lastProbe = Long.MIN_VALUE / 2
  private var nextDial = 0L
  private var denialBackoff = 10_000L

  init {
    scope.launch {
      while (true) {
        delay(3_000)
        probeIfSilent()
      }
    }
  }

  fun received() {
    lastReceived = nowMillis()
  }

  suspend fun connection(): OpenClawIdConnection =
    mutex.withLock {
      checkActive()
      current?.let { return@withLock it }
      dial().also { connection ->
        current = connection
        received()
        scope.launch {
          val close = connection.closed()
          observeClose(close)
          mutex.withLock { if (current === connection) current = null }
        }
      }
    }

  private fun checkActive() {
    job.ensureActive()
    if (mutableRemoved.value) throw OpenClawIdRemovedException()
  }

  private fun observeClose(close: OpenClawIdClose) {
    if (close is OpenClawIdClose.Application && (close.code == 1L || close.code == 2L)) {
      mutableRemoved.value = true
    }
  }

  private suspend fun dial(): OpenClawIdConnection {
    checkActive()
    delay((nextDial - nowMillis()).coerceAtLeast(0))
    checkActive()
    var connected: OpenClawIdConnection? = null
    try {
      val key = verifiedServerKey()
      checkActive()
      // The binding adapter must close late results after coroutine cancellation.
      // Retain ownership inside the timeout too: cancellation can win its return handoff.
      val result = withTimeout(5_000) { endpoint.connect(key).also { connected = it } }
      checkActive()
      coroutineScope {
        val closed = async { result.closed() }
        try {
          val earlyClose = withTimeoutOrNull(500) { closed.await() }
          if (earlyClose != null) {
            observeClose(earlyClose)
            checkActive()
            throw OpenClawIdTunnelException()
          }
        } finally {
          closed.cancelAndJoin()
        }
      }
      coroutineContext.ensureActive()
      checkActive()
      denialBackoff = 10_000
      nextDial = 0
      return result
    } catch (error: Exception) {
      if (error is OpenClawIdRemovedException) mutableRemoved.value = true
      connected?.close(0)
      if (endpoint.relayStatus().admissionDenied) {
        nextDial = nowMillis() + denialBackoff
        denialBackoff = (denialBackoff * 2).coerceAtMost(120_000)
      }
      throw error
    }
  }

  private suspend fun probeIfSilent() {
    if (mutableRemoved.value || nowMillis() - lastReceived < 3_000 || nowMillis() - lastProbe < 5_000) return
    // Serialized with initial/reconnect dials. A probe is never a replacement app connection.
    mutex.withLock {
      val connection = current ?: return
      if (mutableRemoved.value || nowMillis() - lastReceived < 3_000) return
      lastProbe = nowMillis()
      try {
        val probe = dial()
        received()
        probe.close(0)
      } catch (_: TimeoutCancellationException) {
        connection.close(10)
        if (current === connection) current = null
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        connection.close(10)
        if (current === connection) current = null
      }
    }
  }

  suspend fun shutdown() {
    job.cancel()
    // Native shutdown unblocks connects and stream I/O before awaiting coroutine teardown.
    withContext(NonCancellable) {
      try {
        endpoint.shutdown()
      } finally {
        job.join()
      }
    }
  }
}
