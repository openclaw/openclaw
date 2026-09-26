package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CloudflareAccessSessionStoreTest {
  private val application = CloudflareAccessTestTokens.application

  private class Storage {
    val values = mutableMapOf<CloudflareAccessOrigin, String>()
    val events = mutableListOf<String>()
    var saveSucceeds = true
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
          values.remove(it)
          true
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
      val second = store.signIn(application.copy()) {}
      assertSame(first, second)
      runCurrent()
      assertEquals(1, attempts)
      assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.states.value[application.origin])
      grant.complete(CloudflareAccessTestTokens.session())
      val snapshot = first.await()
      assertEquals(listOf("retire", "delete", "save"), storage.events)
      assertSame(snapshot, store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.states.value[application.origin])
    }

  @Test fun differentApplicationsReplaceTheAttemptWithoutAcceptingItsLateGrant() =
    runTest {
      for (unconfined in listOf(false, true)) {
        for (differentIssuer in listOf(false, true)) {
          val replacement =
            if (differentIssuer) {
              application.copy(issuer = CloudflareAccessJWT.issuer("other.cloudflareaccess.com"))
            } else {
              application.copy(audience = "other-audience")
            }
          val storage = Storage()
          val firstGrant = CompletableDeferred<CloudflareAccessSession>()
          val secondGrant = CompletableDeferred<CloudflareAccessSession>()
          val owner = SupervisorJob()
          val scope = CoroutineScope(owner + if (unconfined) Dispatchers.Unconfined else StandardTestDispatcher(testScheduler))
          val applications = mutableListOf<CloudflareAccessApplication>()
          val firstSession = CloudflareAccessTestTokens.session()
          val secondSession = sessionFor(replacement)
          val store =
            CloudflareAccessSessionStore(scope, storage.persistence, authenticate = { selected, _ ->
              applications += selected
              if (selected == application) {
                withContext(NonCancellable) { firstGrant.await() }
              } else {
                assertEquals(replacement, selected)
                secondGrant.await()
              }
            }, retireTransports = { storage.events += "retire" })
          try {
            val first = store.signIn(application) {}
            runCurrent()
            assertEquals(listOf(application), applications)
            val second = store.signIn(replacement) {}
            assertNotSame(first, second)
            assertTrue(first.isCancelled)
            assertSame(second, store.signIn(replacement.copy()) {})
            runCurrent()
            assertEquals(listOf(application, replacement), applications)
            secondGrant.complete(secondSession)
            val snapshot = second.await()
            assertEquals(replacement, snapshot.session.application)

            // A ignores cancellation until after B commits. Its exact attempt ID
            // must fence both persistence and terminal cleanup when it returns.
            firstGrant.complete(firstSession)
            assertTrue(runCatching { first.await() }.exceptionOrNull() is CancellationException)
            assertSame(snapshot, store.snapshot(application.origin))
            assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.states.value[application.origin])
            assertEquals(listOf("retire", "delete", "save"), storage.events)
            val persisted = CloudflareAccessSession.decode(checkNotNull(storage.values[application.origin]))
            assertEquals(replacement, persisted.application)
            assertEquals(secondSession.subject, persisted.subject)
          } finally {
            firstGrant.complete(firstSession)
            secondGrant.complete(secondSession)
            owner.cancelAndJoin()
          }
        }
      }
    }

  @Test fun queuedApplicationReplacementRetiresTheOriginalTransferWithoutClearingItsSuccessor() =
    runTest {
      val replacement = application.copy(audience = "other-audience")
      val firstSession = CloudflareAccessTestTokens.session()
      val secondSession = sessionFor(replacement)
      val firstGrant = CompletableDeferred<CloudflareAccessSession>()
      val secondGrant = CompletableDeferred<CloudflareAccessSession>()
      val firstEntered = CompletableDeferred<Unit>()
      val secondEntered = CompletableDeferred<Unit>()
      val applications = mutableListOf<CloudflareAccessApplication>()
      val storage = Storage()
      val owner = SupervisorJob()
      val scope = CoroutineScope(owner + StandardTestDispatcher(testScheduler))
      val store =
        CloudflareAccessSessionStore(scope, storage.persistence, authenticate = { selected, _ ->
          applications += selected
          if (selected == application) {
            firstEntered.complete(Unit)
            withContext(NonCancellable) { firstGrant.await() }
          } else {
            assertEquals(replacement, selected)
            secondEntered.complete(Unit)
            secondGrant.await()
          }
        }, retireTransports = { storage.events += "retire" })
      val first = store.signIn(application) {}
      // The original task already queues for the Mutex. A suspending replacement
      // call must wait behind it, so record that queue before allowing either to run.
      val acquisition = async(start = CoroutineStart.UNDISPATCHED) { store.signIn(replacement) {} }
      try {
        assertFalse(acquisition.isCompleted)
        assertFalse(firstEntered.isCompleted)
        assertFalse(secondEntered.isCompleted)
        assertTrue(applications.isEmpty())
        firstEntered.await()
        val second = acquisition.await()
        secondEntered.await()
        assertNotSame(first, second)
        assertTrue(first.isCancelled)
        assertEquals(listOf(application, replacement), applications)
        assertSame(second, store.signIn(replacement.copy()) {})
        secondGrant.complete(secondSession)
        val snapshot = second.await()
        assertEquals(replacement, snapshot.session.application)
        firstGrant.complete(firstSession)
        assertTrue(runCatching { first.await() }.exceptionOrNull() is CancellationException)
        assertSame(snapshot, store.snapshot(application.origin))
        assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.states.value[application.origin])
        assertEquals(listOf("retire", "delete", "save"), storage.events)
        assertEquals(secondSession.encode(), storage.values[application.origin])
      } finally {
        firstGrant.complete(firstSession)
        secondGrant.complete(secondSession)
        acquisition.cancelAndJoin()
        owner.cancelAndJoin()
      }
    }

  private fun sessionFor(application: CloudflareAccessApplication): CloudflareAccessSession {
    val subject = "replacement-subject"
    val expires = System.currentTimeMillis() / 1000.0 + 3600
    val claims =
      JsonObject(
        CloudflareAccessTestTokens.claims(subject, expires) +
          mapOf(
            "iss" to JsonPrimitive(application.issuer.toString()),
            "aud" to JsonArray(listOf(JsonPrimitive(application.audience))),
          ),
      )
    return CloudflareAccessSession(application, subject, expires, CloudflareAccessTestTokens.token(claims))
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
      assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.states.value[application.origin])
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
      assertEquals(CloudflareAccessSessionStore.State.ReauthenticationRequired, store.states.value[application.origin])

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
      assertEquals(CloudflareAccessSessionStore.State.Authenticated, store.states.value[application.origin])
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
      assertEquals(0, transfers)
      cancelled.cancel()
      store.cancelSignIn(application.origin)
      val fresh = store.signIn(application) {}
      assertNotSame(cancelled, fresh)
      assertEquals(0, transfers)
      runCurrent()
      cancelled.join()
      assertTrue(cancelled.isCancelled)
      assertEquals(1, transfers)
      assertEquals(CloudflareAccessSessionStore.State.SigningIn, store.states.value[application.origin])
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
      attempt.cancel()
      store.forget(application.origin)
      attempt.join()
      assertTrue(attempt.isCancelled)
      assertEquals(0, transfers)
      assertEquals(listOf("retire", "delete"), storage.events)
      assertTrue(storage.values.isEmpty())
      assertNull(store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.SignedOut, store.states.value[application.origin])
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
        assertEquals(CloudflareAccessSessionStore.State.ReauthenticationRequired, store.states.value[application.origin])
      }
    }

  @Test fun forgetCannotBeUndoneByLateTransferCompletion() =
    runTest {
      val storage = Storage()
      val grant = CompletableDeferred<CloudflareAccessSession>()
      val store = CloudflareAccessSessionStore(backgroundScope, storage.persistence, authenticate = { _, _ -> withContext(NonCancellable) { grant.await() } }, retireTransports = {})
      val attempt = store.signIn(application) {}
      runCurrent()
      store.forget(application.origin)
      grant.complete(CloudflareAccessTestTokens.session())
      assertTrue(runCatching { attempt.await() }.isFailure)
      assertNull(store.snapshot(application.origin))
      assertEquals(CloudflareAccessSessionStore.State.SignedOut, store.states.value[application.origin])
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
      store.requireReauthentication(application.origin, first.revision)
      assertEquals("second-subject", store.snapshot(application.origin)?.session?.subject)
      assertTrue(second.revision > first.revision)
      store.requireReauthentication(application.origin, second.revision)
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
}
