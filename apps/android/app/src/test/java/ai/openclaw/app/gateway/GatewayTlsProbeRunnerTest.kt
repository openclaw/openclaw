package ai.openclaw.app.gateway

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class GatewayTlsProbeRunnerTest {
  @Test
  fun deadlineReturnsWhileNativeDnsIsBlockedAndRetryCannotAccumulateWorkers() =
    runBlocking {
      val owner = SupervisorJob()
      val started = CountDownLatch(1)
      val release = CountDownLatch(1)
      val calls = AtomicInteger()
      val expected = GatewayTlsProbeResult(fingerprintSha256 = "ab".repeat(32))
      val runner =
        GatewayTlsProbeRunner(
          scope = CoroutineScope(owner + Dispatchers.IO),
          timeoutMs = 100,
          probe = { _, _ ->
            if (calls.incrementAndGet() == 1) {
              started.countDown()
              check(release.await(5, TimeUnit.SECONDS))
            }
            expected
          },
        )
      try {
        val attempt = async(Dispatchers.Default) { runner.probe("gateway.example", 443) }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        assertEquals(
          GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE,
          withTimeout(2_000) { attempt.await() }.failure,
        )
        val replacement = async(start = CoroutineStart.UNDISPATCHED) { runner.probe("replacement.example", 443) }
        delay(150)
        assertFalse("An unattempted endpoint must wait, not report unreachable", replacement.isCompleted)
        assertEquals(1, calls.get())
        release.countDown()
        assertEquals(expected, withTimeout(2_000) { replacement.await() })
        assertEquals(2, calls.get())
      } finally {
        release.countDown()
        owner.cancelAndJoin()
      }
    }

  @Test
  fun supersessionCancelsTheNativeOwnerButOnlyTheLatestWaiterCanStartAfterItExits() =
    runBlocking {
      val owner = SupervisorJob()
      val started = CountDownLatch(1)
      val release = CountDownLatch(1)
      val nativeWorker = AtomicReference<Job>()
      val hosts = java.util.concurrent.ConcurrentLinkedQueue<String>()
      val expected = GatewayTlsProbeResult(fingerprintSha256 = "ab".repeat(32))
      val runner =
        GatewayTlsProbeRunner(
          scope = CoroutineScope(owner + Dispatchers.IO),
          probe = { host, _ ->
            hosts.add(host)
            if (host == "first.example") {
              nativeWorker.set(currentCoroutineContext()[Job])
              started.countDown()
              check(release.await(5, TimeUnit.SECONDS))
            }
            expected
          },
        )
      try {
        val first = async(Dispatchers.Default) { runner.probe("first.example", 443) }
        assertTrue(started.await(2, TimeUnit.SECONDS))
        runner.cancel()
        first.cancelAndJoin()
        assertTrue("Supersession must cancel the held worker promptly", nativeWorker.get().isCancelled)
        assertFalse("Native DNS still owns its one physical slot", nativeWorker.get().isCompleted)
        val second = async(start = CoroutineStart.UNDISPATCHED) { runner.probe("second.example", 443) }
        assertFalse(second.isCompleted)
        runner.cancel()
        second.cancelAndJoin()
        val third = async(start = CoroutineStart.UNDISPATCHED) { runner.probe("third.example", 443) }
        assertFalse(third.isCompleted)
        assertEquals(listOf("first.example"), hosts.toList())
        release.countDown()
        assertEquals(expected, withTimeout(2_000) { third.await() })
        assertEquals(listOf("first.example", "third.example"), hosts.toList())
      } finally {
        release.countDown()
        owner.cancelAndJoin()
      }
    }
}
