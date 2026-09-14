package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.ensureActive
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

  class Retirement(
    val id: UUID,
    val origin: CloudflareAccessOrigin,
    val transitionRevision: Long,
    val task: Deferred<Unit>,
    private val supersededAttempt: Deferred<Snapshot>? = null,
  ) {
    fun start() {
      supersededAttempt?.cancel()
      task.start()
    }
  }

  private class Lifecycle(
    var state: State,
    var lastRevokedRevision: Long = 0,
    var transitionRevision: Long = 0,
  )

  private val lock = Any()
  private val sessions = mutableMapOf<CloudflareAccessOrigin, Snapshot>()
  private val attempts = mutableMapOf<CloudflareAccessOrigin, Attempt>()
  private val retirements = mutableMapOf<CloudflareAccessOrigin, Retirement>()
  private val lifecycle = mutableMapOf<CloudflareAccessOrigin, Lifecycle>()
  private var revision = 0L

  fun admissionCheckpoint(): Long = synchronized(lock) { revision }

  fun state(origin: CloudflareAccessOrigin): State? = synchronized(lock) { lifecycle[origin]?.state }

  fun isCurrent(retirement: Retirement): Boolean = synchronized(lock) { lifecycle[retirement.origin]?.transitionRevision == retirement.transitionRevision }

  fun requireAdmission(
    origin: CloudflareAccessOrigin,
    checkpoint: Long,
  ) {
    synchronized(lock) {
      if ((lifecycle[origin]?.lastRevokedRevision ?: 0) > checkpoint) throw CancellationException("Access admission revoked")
    }
  }

  fun snapshot(origin: CloudflareAccessOrigin): Snapshot? {
    var retirement: Retirement? = null
    val result =
      synchronized(lock) {
        if (origin !in lifecycle) {
          val session =
            runCatching {
              persistence.load(origin)?.let(CloudflareAccessSession::decode)?.also {
                if (it.application.origin != origin) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
                it.validate(now())
              }
            }.getOrNull()
          val restoredRevision = setState(origin, if (session == null) State.SignedOut else State.Authenticated)
          if (session != null) sessions[origin] = Snapshot(session, restoredRevision)
        }
        val snapshot = sessions[origin] ?: return@synchronized null
        if (snapshot.session.authorizationHeader(origin.uri.toString(), now()) == null) {
          sessions.remove(origin)
          setState(origin, State.ReauthenticationRequired)
          retirement = queueRetirement(origin)
          null
        } else {
          snapshot
        }
      }
    retirement?.task?.start()
    return result
  }

  fun signIn(
    application: CloudflareAccessApplication,
    admissionCheckpoint: Long = this.admissionCheckpoint(),
    openBrowser: suspend (String) -> Unit,
  ): Deferred<Snapshot> {
    val task =
      synchronized(lock) {
        val origin = application.origin
        requireAdmission(origin, admissionCheckpoint)
        attempts[origin]?.let { return@synchronized it.task }
        val id = UUID.randomUUID()
        val task =
          scope.async(start = CoroutineStart.LAZY) {
            try {
              val session = authenticate(application, openBrowser)
              kotlin.coroutines.coroutineContext.ensureActive()
              val retirement =
                synchronized(lock) {
                  checkAttempt(origin, id)
                  requireAdmission(origin, admissionCheckpoint)
                  if (session.application != application) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
                  session.validate(now())
                  sessions.remove(origin)
                  setState(origin, State.SigningIn)
                  queueRetirement(origin)
                }
              // Retirement owns sockets and cookies, never Gateway pairing credentials.
              retirement.task.await()
              kotlin.coroutines.coroutineContext.ensureActive()
              synchronized(lock) {
                checkAttempt(origin, id)
                requireAdmission(origin, admissionCheckpoint)
                session.validate(now())
                if (!persistence.save(origin, session.encode())) throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
                val snapshot = Snapshot(session, setState(origin, State.Authenticated))
                sessions[origin] = snapshot
                attempts.remove(origin)
                snapshot
              }
            } catch (error: Exception) {
              synchronized(lock) {
                if (attempts[origin]?.id == id) {
                  attempts.remove(origin)
                  setState(origin, State.ReauthenticationRequired)
                }
              }
              throw error
            }
          }
        attempts[origin] = Attempt(id, task)
        setState(origin, State.SigningIn)
        task
      }
    // Unconfined starts and cancellation handlers can run inline. Never execute
    // them while holding the state monitor or a consumer publication lock.
    task.start()
    return task
  }

  fun cancelSignIn(origin: CloudflareAccessOrigin) {
    val attempt =
      synchronized(lock) {
        attempts.remove(origin)?.also {
          setState(origin, State.ReauthenticationRequired)
        }
      }
    attempt?.task?.cancel()
  }

  suspend fun waitForRetirement(origin: CloudflareAccessOrigin) {
    synchronized(lock) { retirements[origin]?.task }?.await()
  }

  fun <T> withCurrentSnapshot(
    origin: CloudflareAccessOrigin,
    expectedRevision: Long,
    admissionCheckpoint: Long,
    publish: (Snapshot) -> T,
  ): T =
    synchronized(lock) {
      requireAdmission(origin, admissionCheckpoint)
      val snapshot =
        sessions[origin]?.takeIf { it.revision == expectedRevision }
          ?: throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
      snapshot.session.validate(now())
      // Ingress holds its own lock first; this synchronous field commit cannot
      // race explicit revocation. Consumer effects run after both locks release.
      publish(snapshot)
    }

  fun requireReauthentication(
    origin: CloudflareAccessOrigin,
    expectedRevision: Long,
  ): Retirement? {
    val retirement =
      synchronized(lock) {
        if (sessions[origin]?.revision != expectedRevision) return null
        sessions.remove(origin)
        setState(origin, State.ReauthenticationRequired)
        queueRetirement(origin)
      }
    retirement.task.start()
    return retirement
  }

  fun forget(origin: CloudflareAccessOrigin): Retirement = reserveForget(origin).also { it.start() }

  // Ingress may reserve while committing a last-owner decision. Cancellation and
  // coroutine starts belong to the returned handle, after all owner locks release.
  fun reserveForget(origin: CloudflareAccessOrigin): Retirement =
    synchronized(lock) {
      val attempt = attempts.remove(origin)
      sessions.remove(origin)
      setState(origin, State.SignedOut)
      lifecycle.getValue(origin).lastRevokedRevision = revision
      queueRetirement(origin, attempt?.task)
    }

  private fun queueRetirement(
    origin: CloudflareAccessOrigin,
    supersededAttempt: Deferred<Snapshot>? = null,
  ): Retirement {
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
            synchronized(lock) { if (retirements[origin]?.id == id) retirements.remove(origin) }
          }
        }
      }
    val retirement = Retirement(id, origin, lifecycle.getValue(origin).transitionRevision, task, supersededAttempt)
    retirements[origin] = retirement
    return retirement
  }

  private fun checkAttempt(
    origin: CloudflareAccessOrigin,
    id: UUID,
  ) {
    val attempt = attempts[origin]
    if (attempt == null || attempt.id != id || !attempt.task.isActive) throw CancellationException()
  }

  private fun setState(
    origin: CloudflareAccessOrigin,
    state: State,
  ): Long {
    // Completion belongs to this origin transition, including repeated same-state
    // actions; another origin's activity must not hide its retirement failure.
    val current = lifecycle.getOrPut(origin) { Lifecycle(state) }
    current.state = state
    current.transitionRevision = ++revision
    return revision
  }
}
