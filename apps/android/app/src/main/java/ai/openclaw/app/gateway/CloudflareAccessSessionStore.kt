package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.UUID

/** One browser attempt and revisioned ingress grant per authority; Gateway pairing is separately owned. */
internal class CloudflareAccessSessionStore(
  private val scope: CoroutineScope,
  private val persistence: Persistence,
  private val authenticate: suspend (CloudflareAccessApplication, suspend (String) -> Unit) -> CloudflareAccessSession = { application, browser -> CloudflareAccessTransfer().signIn(application, browser) },
  private val now: () -> Double = { System.currentTimeMillis() / 1000.0 },
  private val retireTransports: suspend (CloudflareAccessOrigin) -> Unit,
) {
  class Snapshot(
    val session: CloudflareAccessSession,
    val revision: Long,
  )

  enum class State { SignedOut, SigningIn, Authenticated, ReauthenticationRequired }

  class Persistence(
    val load: (CloudflareAccessOrigin) -> String?,
    val save: (CloudflareAccessOrigin, String) -> Boolean,
    val delete: (CloudflareAccessOrigin) -> Boolean,
  ) {
    companion object {
      fun securePrefs(prefs: SecurePrefs): Persistence {
        fun key(origin: CloudflareAccessOrigin) = "cloudflare.access.${origin.uri}"
        return Persistence(
          load = { prefs.getString(key(it)) },
          save = { origin, value -> prefs.commitSecureStrings(mapOf(key(origin) to value)) },
          delete = { prefs.commitSecureStrings(mapOf(key(it) to null)) },
        )
      }
    }
  }

  private class Attempt(
    val id: UUID,
    val task: Deferred<Snapshot>,
  )

  private class Retirement(
    val id: UUID,
    val task: Deferred<Unit>,
  )

  private val mutex = Mutex()
  private val sessions = mutableMapOf<CloudflareAccessOrigin, Snapshot>()
  private val attempts = mutableMapOf<CloudflareAccessOrigin, Attempt>()
  private val retirements = mutableMapOf<CloudflareAccessOrigin, Retirement>()
  private val mutableStates = MutableStateFlow<Map<CloudflareAccessOrigin, State>>(emptyMap())
  val states = mutableStates.asStateFlow()
  private var revision = 0L

  suspend fun snapshot(origin: CloudflareAccessOrigin): Snapshot? =
    mutex.withLock {
      if (origin !in mutableStates.value) {
        val session =
          runCatching {
            persistence.load(origin)?.let(CloudflareAccessSession::decode)?.also {
              if (it.application.origin != origin) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
              it.validate(now())
            }
          }.getOrNull()
        if (session != null) sessions[origin] = Snapshot(session, ++revision)
        setState(origin, if (session == null) State.SignedOut else State.Authenticated)
      }
      val snapshot = sessions[origin] ?: return@withLock null
      if (snapshot.session.authorizationHeader(origin.uri.toString(), now()) == null) {
        sessions.remove(origin)
        setState(origin, State.ReauthenticationRequired)
        ++revision
        queueRetirement(origin)
        return@withLock null
      }
      snapshot
    }

  suspend fun signIn(
    application: CloudflareAccessApplication,
    openBrowser: suspend (String) -> Unit,
  ): Deferred<Snapshot> =
    mutex.withLock {
      val origin = application.origin
      attempts[origin]?.let { return@withLock it.task }
      val id = UUID.randomUUID()
      val task =
        scope.async(start = CoroutineStart.LAZY) {
          try {
            val session = authenticate(application, openBrowser)
            val retirement =
              mutex.withLock {
                checkAttempt(origin, id)
                if (session.application != application) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
                session.validate(now())
                sessions.remove(origin)
                ++revision
                queueRetirement(origin)
              }
            // Cookies, caches and old sockets retire before any new Access account can publish.
            // The callback never owns or deletes Gateway pairing credentials.
            retirement.await()
            mutex.withLock {
              checkAttempt(origin, id)
              session.validate(now())
              if (!persistence.save(origin, session.encode())) throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
              val snapshot = Snapshot(session, ++revision)
              sessions[origin] = snapshot
              setState(origin, State.Authenticated)
              attempts.remove(origin)
              snapshot
            }
          } catch (error: Exception) {
            withContext(NonCancellable) {
              mutex.withLock {
                if (attempts[origin]?.id == id) {
                  attempts.remove(origin)
                  setState(origin, State.ReauthenticationRequired)
                  ++revision
                }
              }
            }
            throw error
          }
        }
      attempts[origin] = Attempt(id, task)
      setState(origin, State.SigningIn)
      ++revision
      task.start()
      task
    }

  suspend fun cancelSignIn(origin: CloudflareAccessOrigin) =
    mutex.withLock {
      cancelAttempt(origin)
    }

  suspend fun requireReauthentication(
    origin: CloudflareAccessOrigin,
    expectedRevision: Long,
  ) {
    val retirement =
      mutex.withLock {
        // Late failures from old node/operator sockets cannot retire a newer browser grant.
        if (sessions[origin]?.revision != expectedRevision) return
        sessions.remove(origin)
        setState(origin, State.ReauthenticationRequired)
        ++revision
        queueRetirement(origin)
      }
    retirement.await()
  }

  suspend fun forget(origin: CloudflareAccessOrigin) {
    val retirement =
      mutex.withLock {
        cancelAttempt(origin)
        sessions.remove(origin)
        setState(origin, State.SignedOut)
        ++revision
        queueRetirement(origin)
      }
    retirement.await()
  }

  private fun cancelAttempt(origin: CloudflareAccessOrigin) {
    val attempt = attempts.remove(origin) ?: return
    attempt.task.cancel()
    setState(origin, State.ReauthenticationRequired)
    ++revision
  }

  private fun queueRetirement(origin: CloudflareAccessOrigin): Deferred<Unit> {
    val previous = retirements[origin]?.task
    val id = UUID.randomUUID()
    val task =
      scope.async(start = CoroutineStart.LAZY) {
        try {
          previous?.join()
          retireTransports(origin)
          if (!persistence.delete(origin)) throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
        } finally {
          withContext(NonCancellable) {
            mutex.withLock { if (retirements[origin]?.id == id) retirements.remove(origin) }
          }
        }
      }
    retirements[origin] = Retirement(id, task)
    task.start()
    return task
  }

  private suspend fun checkAttempt(
    origin: CloudflareAccessOrigin,
    id: UUID,
  ) {
    kotlin.coroutines.coroutineContext.ensureActive()
    if (attempts[origin]?.id != id) throw CancellationException()
  }

  private fun setState(
    origin: CloudflareAccessOrigin,
    state: State,
  ) {
    mutableStates.value += origin to state
  }
}
