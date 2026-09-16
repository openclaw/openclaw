package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.coroutines.CoroutineContext

@OptIn(ExperimentalCoroutinesApi::class)
class CloudflareAccessSessionStoreTest {
  private val application = CloudflareAccessTestTokens.application

  private class Storage {
    val values = mutableMapOf<CloudflareAccessOrigin, String>()
    val events = mutableListOf<String>()
    var saveSucceeds = true
    var deleteSucceeds = true
    val persistence =
      CloudflareAccessSessionStore.Persistence(
        load = { values[it] },
        save = { origin, value ->
          events += "save"
          if (saveSucceeds) values[origin] = value
          saveSucceeds
        },
        delete = {
          events += "delete"
          if (deleteSucceeds) values.remove(it)
          deleteSucceeds
        },
      )
  }

  @Test fun concurrentRolesShareOneAttemptAndRetireBeforePublish() =
    runTest {
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      var attempts = 0
      val store =
        CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ ->
          attempts++
          grant.await()
        }, retireTransports = { storage.events += "retire" })
      val first = store.signIn(application) {}
      val second = store.signIn(application) {}
      assertSame(first, second)
      runCurrent()
      assertEquals(1, attempts)
      assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.state(application.origin))
      grant.complete(CloudflareAccessTestTokens.session())
      val snapshot = first.await()
      assertEquals(listOf("retire", "delete", "save"), storage.events)
      assertSame(snapshot, store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.state(application.origin))
    }

  @Test fun cancelledDeferredBeforeDispatchAllowsFreshCoalescedSignIn() =
    runTest {
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      var transfers = 0
      var browsers = 0
      val store =
        CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, openBrowser ->
          transfers++
          openBrowser("https://gateway.example.test/cdn-cgi/access/cli")
          grant.await()
        }, retireTransports = { storage.events += "retire" })
      val cancelled = store.signIn(application) { browsers++ }
      assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.state(application.origin))
      assertEquals(0, transfers)
      assertEquals(0, browsers)
      cancelled.cancel()
      runCurrent()
      cancelled.join()
      assertTrue(cancelled.isCancelled)
      assertTrue(runCatching { cancelled.await() }.exceptionOrNull() is CancellationException)
      assertEquals(0, transfers)
      assertEquals(0, browsers)
      assertTrue(storage.events.isEmpty())
      assertTrue(storage.values.isEmpty())
      assertNull(store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.ReauthenticationRequired, store.state(application.origin))

      val fresh = store.signIn(application) { browsers++ }
      assertNotSame(cancelled, fresh)
      assertTrue(fresh.isActive)
      assertSame(fresh, store.signIn(application) { browsers++ })
      runCurrent()
      assertEquals(1, transfers)
      assertEquals(1, browsers)
      grant.complete(CloudflareAccessTestTokens.session())
      val snapshot = fresh.await()
      assertEquals(listOf("retire", "delete", "save"), storage.events)
      assertEquals(snapshot.session.encode(), storage.values[application.origin])
      assertSame(snapshot, store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.state(application.origin))
    }

  @Test fun cancelledAttemptBeforeDispatchCannotClearReplacement() =
    runTest {
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      var transfers = 0
      val store =
        CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ ->
          transfers++
          grant.await()
        }, retireTransports = { storage.events += "retire" })
      val cancelled = store.signIn(application) {}
      store.cancelSignIn(application.origin)
      val fresh = store.signIn(application) {}
      assertNotSame(cancelled, fresh)
      assertEquals(0, transfers)
      runCurrent()
      cancelled.join()
      assertTrue(cancelled.isCancelled)
      assertEquals(1, transfers)
      assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.state(application.origin))
      assertSame(fresh, store.signIn(application) {})
      grant.complete(CloudflareAccessTestTokens.session())
      assertSame(fresh.await(), store.snapshot(application.origin))
      assertEquals(listOf("retire", "delete", "save"), storage.events)
    }

  @Test fun forgetBeforeDispatchStaysSignedOutWhenCancelledAttemptCompletes() =
    runTest {
      val storage = Storage()
      var transfers = 0
      val store =
        CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ ->
          transfers++
          CloudflareAccessTestTokens.session()
        }, retireTransports = { storage.events += "retire" })
      val attempt = store.signIn(application) {}
      assertEquals(0, transfers)
      store.forget(application.origin).task.await()
      attempt.join()
      assertTrue(attempt.isCancelled)
      assertEquals(0, transfers)
      assertEquals(listOf("retire", "delete"), storage.events)
      assertTrue(storage.values.isEmpty())
      assertNull(store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.SignedOut, store.state(application.origin))
    }

  @Test fun alreadyCancelledStoreScopeCannotLeavePublishedAttemptSigningIn() =
    runTest {
      val ownedScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      ownedScope.cancel()
      val storage = Storage()
      var transfers = 0
      val store =
        CloudflareAccessSessionStore(ownedScope, storage.persistence, authenticate = { _, _ ->
          transfers++
          CloudflareAccessTestTokens.session()
        }, retireTransports = { storage.events += "retire" })
      val attempt = store.signIn(application) {}
      assertTrue(attempt.isCancelled)
      assertEquals(0, transfers)
      assertTrue(storage.events.isEmpty())
      assertNull(store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.ReauthenticationRequired, store.state(application.origin))
    }

  @Test fun completedCancellationAllowsRetryWhileItsCompletionHandlerWaitsForPublication() =
    runTest {
      val dispatches = LinkedBlockingQueue<Runnable>()
      val dispatcher =
        object : CoroutineDispatcher() {
          override fun dispatch(
            context: CoroutineContext,
            block: Runnable,
          ) {
            dispatches.add(block)
          }
        }
      val ownedScope = CoroutineScope(SupervisorJob() + dispatcher)
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session().encode()
      var transfers = 0
      val store =
        CloudflareAccessSessionStore(ownedScope, storage.persistence, authenticate = { _, _ ->
          transfers++
          CloudflareAccessTestTokens.session("fresh")
        }, retireTransports = { storage.events += "retire" })
      val previous = checkNotNull(store.snapshot(application.origin))
      val checkpoint = store.admissionCheckpoint()
      val cancelled = store.signIn(application) {}
      val cancelledDispatch = checkNotNull(dispatches.poll(1, TimeUnit.SECONDS))
      val completion =
        Thread {
          cancelled.cancel()
          cancelledDispatch.run()
        }
      try {
        val fresh =
          store.withCurrentSnapshot(application.origin, previous.revision, checkpoint) {
            // The real synchronous publication boundary holds the monitor while the
            // canceled dispatch completes on another thread, before cleanup can enter.
            completion.start()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
            while (!cancelled.isCompleted && System.nanoTime() < deadline) Thread.yield()
            assertTrue("canceled dispatch must publish its terminal state", cancelled.isCompleted)
            assertTrue(runCatching { runBlocking { cancelled.await() } }.exceptionOrNull() is CancellationException)
            val retry = store.signIn(application) {}
            assertNotSame(cancelled, retry)
            assertSame(retry, store.signIn(application) {})
            assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.state(application.origin))
            retry
          }
        completion.join(1000)
        assertFalse("canceled completion must drain after publication", completion.isAlive)
        assertEquals(0, transfers)
        while (true) {
          val dispatch = dispatches.poll() ?: break
          dispatch.run()
        }
        assertTrue(fresh.isCompleted)
        assertEquals(1, transfers)
        assertSame(fresh.await(), store.snapshot(application.origin))
        assertEquals("fresh", store.snapshot(application.origin)?.session?.subject)
        assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.state(application.origin))
        assertEquals(listOf("retire", "delete", "save"), storage.events)
      } finally {
        ownedScope.cancel()
        while (true) {
          val dispatch = dispatches.poll() ?: break
          dispatch.run()
        }
        completion.join(1000)
        assertFalse("test completion thread must be joined", completion.isAlive)
      }
    }

  @Test fun grantExpiringDuringRetirementIsNeverPersistedOrPublished() =
    runTest {
      val storage = Storage()
      val retirement = CompletableDeferred<Unit>()
      var now = 1000.0
      supervisorScope {
        val store = CloudflareAccessSessionStore(this, storage.persistence, authenticate = { _, _ -> CloudflareAccessTestTokens.session(expires = 1001.0) }, now = { now }, retireTransports = { retirement.await() })
        val attempt = store.signIn(application) {}
        runCurrent()
        now = 1001.0
        retirement.complete(Unit)
        assertTrue(runCatching { attempt.await() }.exceptionOrNull() is CloudflareAccessException)
        assertFalse("save" in storage.events)
        assertNull(store.snapshot(application.origin))
        assertEquals(CloudflareAccessSessionStore.State.ReauthenticationRequired, store.state(application.origin))
      }
    }

  @Test fun forgetCannotBeUndoneByLateTransferCompletion() =
    runTest {
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val store = CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ -> withContext(NonCancellable) { grant.await() } }, retireTransports = {})
      val attempt = store.signIn(application) {}
      runCurrent()
      store.forget(application.origin).task.await()
      grant.complete(CloudflareAccessTestTokens.session())
      assertTrue(runCatching { attempt.await() }.isFailure)
      assertNull(store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.SignedOut, store.state(application.origin))
      assertFalse("save" in storage.events)
    }

  @Test fun oldSocketFailureCannotInvalidateDifferentAccountRenewal() =
    runTest {
      val storage = Storage()
      var subject = "first-subject"
      val store = CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ -> CloudflareAccessTestTokens.session(subject) }, retireTransports = {})
      val first = store.signIn(application) {}.await()
      subject = "second-subject"
      val second = store.signIn(application) {}.await()
      store.requireReauthentication(application.origin, first.revision)?.task?.await()
      assertEquals("second-subject", store.snapshot(application.origin)?.session?.subject)
      assertTrue(second.revision > first.revision)
      store.requireReauthentication(application.origin, second.revision)?.task?.await()
      assertNull(store.snapshot(application.origin))
      assertFalse(storage.values.containsKey(application.origin))
    }

  @Test fun restartRestoresOnlyUnexpiredExactAuthorityAndStorageFailureIsVisible() =
    runTest {
      val storage = Storage()
      storage.values[application.origin] = CloudflareAccessTestTokens.session(expires = 1001.0).encode()
      var now = 1000.0
      val store = CloudflareAccessSessionStore(backgroundScope, storage.persistence, now = { now }, retireTransports = {})
      assertNotNull(store.snapshot(application.origin))
      assertNull(store.snapshot(CloudflareAccessOrigin.from("https://gateway.example.test")))
      now = 1001.0
      assertNull(store.snapshot(application.origin))
      runCurrent()
      assertFalse(storage.values.containsKey(application.origin))
      storage.saveSucceeds = false
      supervisorScope {
        val failing = CloudflareAccessSessionStore(this, storage.persistence, authenticate = { _, _ -> CloudflareAccessTestTokens.session() }, retireTransports = {})
        assertTrue(runCatching { failing.signIn(application) {}.await() }.isFailure)
        assertNull(failing.snapshot(application.origin))
      }
    }

  @Test fun cancelledAttemptDoesNotPublishWhileRetirementFinishes() =
    runTest {
      val storage = Storage()
      val retirement = CompletableDeferred<Unit>()
      val store = CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ -> CloudflareAccessTestTokens.session() }, retireTransports = { retirement.await() })
      val attempt = store.signIn(application) {}
      runCurrent()
      store.cancelSignIn(application.origin)
      retirement.complete(Unit)
      assertTrue(runCatching { attempt.await() }.isFailure)
      assertFalse("save" in storage.events)
      assertNull(store.snapshot(application.origin))
    }

  @Test fun failedTransportRetirementCannotDeleteOrPublishAReplacementGrant() =
    runTest {
      val storage = Storage()
      val encoded = CloudflareAccessTestTokens.session().encode()
      storage.values[application.origin] = encoded
      supervisorScope {
        val failure = java.io.IOException("test-only retirement failure")
        val store = CloudflareAccessSessionStore(this, storage.persistence, authenticate = { _, _ -> CloudflareAccessTestTokens.session("replacement") }, retireTransports = { throw failure })
        assertNotNull(store.snapshot(application.origin))
        val thrown = checkNotNull(runCatching { store.signIn(application) {}.await() }.exceptionOrNull())
        assertEquals(failure.javaClass, thrown.javaClass)
        assertEquals(failure.message, thrown.message)
        assertSame(failure, generateSequence(thrown) { it.cause }.last())
        assertNull(store.snapshot(application.origin))
        assertEquals(encoded, storage.values[application.origin])
        assertTrue(storage.events.isEmpty())
        assertEquals(CloudflareAccessSessionStore.State.ReauthenticationRequired, store.state(application.origin))
      }
    }

  @Test fun failedDeletionRetiresAdmissionAndReportsFailureWithoutRewritingPersistence() =
    runTest {
      val storage = Storage()
      val encoded = CloudflareAccessTestTokens.session().encode()
      storage.values[application.origin] = encoded
      storage.deleteSucceeds = false
      supervisorScope {
        val store = CloudflareAccessSessionStore(this, storage.persistence, retireTransports = { storage.events += "retire" })
        assertNotNull(store.snapshot(application.origin))
        val checkpoint = store.admissionCheckpoint()
        val deletion = store.forget(application.origin)
        assertTrue(runCatching { store.requireAdmission(application.origin, checkpoint) }.exceptionOrNull() is CancellationException)
        assertTrue(runCatching { deletion.task.await() }.exceptionOrNull() is CloudflareAccessException)
        assertTrue(runCatching { store.requireAdmission(application.origin, checkpoint) }.exceptionOrNull() is CancellationException)
        assertNull(store.snapshot(application.origin))
        assertEquals(CloudflareAccessSessionStore.State.SignedOut, store.state(application.origin))
        assertEquals(encoded, storage.values[application.origin])
        assertEquals(listOf("retire", "delete"), storage.events)
      }
    }

  @Test fun queuedAdmissionRemainsRevokedAfterRenewalAndDoesNotBlockAnotherOrigin() =
    runTest {
      val storage = Storage()
      val gate = CompletableDeferred<Unit>()
      val store =
        CloudflareAccessSessionStore(
          backgroundScope,
          storage.persistence,
          authenticate = { _, _ -> CloudflareAccessTestTokens.session() },
          retireTransports = { gate.await() },
        )
      val old = store.admissionCheckpoint()
      val retirement = store.forget(application.origin)
      assertTrue(runCatching { store.requireAdmission(application.origin, old) }.exceptionOrNull() is CancellationException)
      store.requireAdmission(CloudflareAccessOrigin.from("https://other.example.test"), old)
      assertNull(store.snapshot(application.origin))
      gate.complete(Unit)
      retirement.task.await()
      val fresh = store.admissionCheckpoint()
      val grant = store.signIn(application, fresh) {}.await()
      assertTrue(runCatching { store.signIn(application, old) {} }.exceptionOrNull() is CancellationException)
      assertTrue(runCatching { store.withCurrentSnapshot(application.origin, grant.revision, old) { it } }.exceptionOrNull() is CancellationException)
      assertSame(grant, store.withCurrentSnapshot(application.origin, grant.revision, fresh) { it })
    }

  @Test fun unconfinedStartCancellationAndRetirementRunOutsideStoreMonitor() =
    runTest {
      val effects = mutableListOf<Boolean>()
      val ownedScope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
      val gate = CompletableDeferred<CloudflareAccessSession>()
      lateinit var store: CloudflareAccessSessionStore

      fun recordMonitorAvailability() {
        val read = java.util.concurrent.FutureTask { store.admissionCheckpoint() }
        val thread = Thread(read)
        thread.start()
        effects += runCatching { read.get(1, java.util.concurrent.TimeUnit.SECONDS) }.isSuccess
      }
      store =
        CloudflareAccessSessionStore(
          ownedScope,
          Storage().persistence,
          authenticate = { _, _ ->
            recordMonitorAvailability()
            gate.await()
          },
          retireTransports = { recordMonitorAvailability() },
        )
      try {
        val attempt = store.signIn(application) {}
        attempt.invokeOnCompletion { recordMonitorAvailability() }
        store.cancelSignIn(application.origin)
        store.forget(application.origin).task.await()
        assertEquals(listOf(true, true, true), effects)
      } finally {
        gate.complete(CloudflareAccessTestTokens.session())
        ownedScope.cancel()
      }
    }
}
