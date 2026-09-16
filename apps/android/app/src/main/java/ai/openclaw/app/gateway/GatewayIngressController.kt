package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal data class GatewayAccessAttention(
  val stableId: String,
  val message: String,
  val attemptId: UUID? = null,
)

internal data class GatewayAccessBrowserLaunch(
  val attemptId: UUID,
  val url: String,
)

internal data class GatewayAccessPresentation(
  val attention: GatewayAccessAttention? = null,
  val browserLaunch: GatewayAccessBrowserLaunch? = null,
  val browserRequired: Set<String> = emptySet(),
)

/** Runtime owner of Access admission. Activity owns presentation only; Gateway still owns pairing. */
internal class GatewayIngressController(
  private val scope: CoroutineScope,
  private val registry: GatewayRegistryStore,
  persistence: CloudflareAccessSessionStore.Persistence,
  private val customHeaders: (String) -> Map<String, String>,
  private val retireTransports: suspend (CloudflareAccessOrigin) -> Unit,
  private val now: () -> Double = { System.currentTimeMillis() / 1000.0 },
  private val clientForRoute: (GatewayEndpoint, GatewayTlsParams) -> CloudflareAccessClient = ::routeClient,
  authenticate: suspend (CloudflareAccessApplication, suspend (String) -> Unit) -> CloudflareAccessSession =
    { application, browser -> CloudflareAccessTransfer().signIn(application, browser) },
) {
  private class Registration(
    val endpoint: GatewayEndpoint,
    val tls: GatewayTlsParams,
    val client: CloudflareAccessClient,
  ) {
    val origin = CloudflareAccessOrigin.from(url)
    var ordinaryAdmission = false
    val url: String
      get() = buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath)
  }

  private sealed interface RetryOwner {
    class Captured(
      val action: GatewayAccessAttention,
      val entry: GatewayRegistryEntry,
      val registration: Registration?,
      val acknowledgement: SignOutAcknowledgement?,
    ) : RetryOwner

    class Acquired(
      val registration: Registration,
    ) : RetryOwner
  }

  private class SignOutAcknowledgement(
    val action: GatewayAccessAttention,
    val entry: GatewayRegistryEntry,
    var registration: Registration?,
    val origin: CloudflareAccessOrigin,
  ) {
    var completedAction: GatewayAccessAttention? = null
    val currentAction: GatewayAccessAttention
      get() = completedAction ?: action
  }

  private class BrowserIntent(
    val id: UUID,
    val registration: Registration,
    val isCurrent: () -> Boolean,
  ) {
    val canceled = AtomicBoolean(false)

    @Volatile var task: Deferred<CloudflareAccessSessionStore.Snapshot>? = null
  }

  private val lock = Any()
  private val browserMutex = Mutex()
  private val registrations = mutableMapOf<String, Registration>()
  private val leases = mutableMapOf<String, Lease>()
  private val expiryJobs = mutableMapOf<CloudflareAccessOrigin, Job>()
  private var browserIntent: BrowserIntent? = null
  private var signOutAcknowledgement: SignOutAcknowledgement? = null
  private val mutablePresentation = MutableStateFlow(GatewayAccessPresentation(browserRequired = requiredBrowserProfiles()))
  val presentation = mutablePresentation.asStateFlow()
  private val store =
    CloudflareAccessSessionStore(scope, persistence, authenticate, now) { origin ->
      val expiry =
        synchronized(lock) {
          leases.values.filter { it.origin == origin }.forEach { it.active.set(false) }
          expiryJobs.remove(origin)
        }
      expiry?.cancel()
      // No connect task awaits its own drain. Rejections schedule this store-owned boundary.
      retireTransports(origin)
    }

  init {
    scope.launch {
      registry.entries.collect { synchronized(lock) { publishLocked() } }
    }
  }

  fun admissionCheckpoint(): Long = store.admissionCheckpoint()

  suspend fun prepare(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams?,
    userInitiated: Boolean,
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): GatewayIngressAuthorization? {
    if (tls == null) return null
    return prepareRegistered(register(endpoint, tls, isCurrent), userInitiated, admissionCheckpoint, isCurrent)
  }

  private suspend fun register(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams,
    isCurrent: () -> Boolean,
    bind: (Registration) -> Unit = {},
  ): Registration {
    val (registration, replacedIntent) =
      synchronized(lock) {
        if (!isCurrent() || registry.entries.value.none { it.stableId == endpoint.stableId }) {
          throw CancellationException("Gateway request superseded")
        }
        val previous = registrations[endpoint.stableId]
        val current =
          previous?.takeIf { it.endpoint == endpoint && it.tls == tls }
            ?: Registration(endpoint, tls, clientForRoute(endpoint, tls))
        // A carried Retry validates its captured owner and adopts this registration
        // in the same commit, before retiring any work or resuming UI observers.
        bind(current)
        val acknowledgement =
          signOutAcknowledgement?.takeIf {
            previous == null && it.registration == null && it.action.stableId == endpoint.stableId &&
              it.origin == current.origin && isAcknowledgementRegisteredLocked(it)
          }
        val retired = browserIntent?.takeIf { current !== previous && it.registration === previous }
        if (current !== previous) {
          retired?.canceled?.set(true)
          leases.remove(endpoint.stableId)?.active?.set(false)
          registrations[endpoint.stableId] = current
          // A cold Sign out belongs to the saved entry until its first registration.
          // Bind after Retry validation, and before publication can invalidate that owner.
          acknowledgement?.registration = current
          publishLocked(
            attention = mutablePresentation.value.attention.takeUnless { retired != null && it?.attemptId == retired.id },
            browserLaunch = mutablePresentation.value.browserLaunch.takeUnless { it?.attemptId == retired?.id },
          )
        }
        current to retired
      }
    replacedIntent?.let { finishCancellation(it, it.task).join() }
    checkRegistration(registration, isCurrent)
    return registration
  }

  private suspend fun prepareRegistered(
    registration: Registration,
    userInitiated: Boolean,
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): GatewayIngressAuthorization? {
    val endpoint = registration.endpoint
    val managedIsCurrent = {
      store.requireAdmission(registration.origin, admissionCheckpoint)
      isCurrent()
    }
    checkRegistration(registration, isCurrent)
    val origin = registration.origin
    val previousRetirement =
      synchronized(lock) {
        checkRegistrationLocked(registration, isCurrent)
        val previous =
          registry.entries.value
            .firstOrNull { it.stableId == endpoint.stableId }
            ?.accessOrigin
            ?.takeIf { it != origin.uri.toString() }
        if (previous != null && registry.entries.value.any { it.stableId != endpoint.stableId && it.accessOrigin == previous }) {
          // Release a shared association atomically so the final departing profile
          // still owns retirement. The last owner stays durable until deletion succeeds.
          if (!registry.setAccessOrigin(endpoint.stableId, null)) {
            throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
          }
          publishLocked()
          null
        } else {
          previous?.let { store.reserveForget(CloudflareAccessOrigin.from(it)) }
        }
      }
    if (previousRetirement != null) {
      previousRetirement.start()
      previousRetirement.task.await()
      checkRegistration(registration, isCurrent)
      synchronized(lock) {
        checkRegistrationLocked(registration, isCurrent)
        if (registry.entries.value
            .firstOrNull { it.stableId == endpoint.stableId }
            ?.accessOrigin != previousRetirement.origin.uri.toString()
        ) {
          throw CancellationException("Gateway association superseded")
        }
        if (!registry.setAccessOrigin(endpoint.stableId, null)) {
          throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
        }
        publishLocked()
      }
    }
    // Existing service headers or WARP must remain independent of a cached browser
    // grant. Only a verified Access challenge admits managed credentials for this profile.
    val ordinaryChallenge = registration.client.discover(registration.url, customHeaders = customHeaders(endpoint.stableId))
    checkRegistration(registration, isCurrent)
    if (ordinaryChallenge == null) {
      synchronized(lock) {
        checkRegistrationLocked(registration, isCurrent)
        registration.ordinaryAdmission = true
        leases.remove(endpoint.stableId)?.active?.set(false)
        publishLocked(attention = attentionAfterAdmissionLocked(registration))
      }
      return null
    }
    synchronized(lock) {
      checkRegistrationLocked(registration, managedIsCurrent)
      registration.ordinaryAdmission = false
      publishLocked()
    }
    store.waitForRetirement(origin)
    val previous = store.snapshot(origin)
    store.waitForRetirement(origin)
    checkRegistration(registration, managedIsCurrent)
    val application = if (previous == null) ordinaryChallenge else registration.client.discover(registration.url, previous.session, customHeaders(endpoint.stableId))
    checkRegistration(registration, managedIsCurrent)
    if (previous != null && store.snapshot(origin)?.revision != previous.revision) {
      showRequired(registration, managedIsCurrent)
      throw GatewayExternalAuthorizationException()
    }
    if (application == null) {
      associate(registration, managedIsCurrent)
      return admit(registration, checkNotNull(previous), admissionCheckpoint, managedIsCurrent)
    }
    if (previous != null) {
      store.requireReauthentication(origin, previous.revision)?.task?.await()
      checkRegistration(registration, managedIsCurrent)
    }
    // Signed application discovery (or cached verified grant above) owns this fact, before
    // signIn can persist. Canceling browser return must not leave a grant without a Forget owner.
    associate(registration, managedIsCurrent)
    if (!userInitiated) {
      showRequired(registration, managedIsCurrent)
      throw GatewayExternalAuthorizationException()
    }
    val snapshot = signIn(registration, application, admissionCheckpoint, managedIsCurrent)
    checkRegistration(registration, managedIsCurrent)
    return admit(registration, snapshot, admissionCheckpoint, managedIsCurrent)
  }

  fun authorization(endpoint: GatewayEndpoint): GatewayIngressAuthorization? =
    synchronized(lock) {
      if (registrations[endpoint.stableId]?.takeIf { it.endpoint == endpoint }?.ordinaryAdmission == true) return@synchronized null
      leases[endpoint.stableId]?.takeIf { it.registration.endpoint == endpoint }
        ?: registry.entries.value
          .firstOrNull { it.stableId == endpoint.stableId }
          ?.accessOrigin
          ?.let { unavailable }
    }

  fun managedOrigin(endpoint: GatewayEndpoint): CloudflareAccessOrigin? = (authorization(endpoint) as? Lease)?.origin

  fun blocksAutomaticReconnect(stableId: String): Boolean =
    synchronized(lock) {
      registrations[stableId]?.ordinaryAdmission != true &&
        (
          browserIntent?.registration?.endpoint?.stableId == stableId ||
            mutablePresentation.value.attention?.stableId == stableId ||
            leases[stableId]?.active?.get() == false
        )
    }

  fun needsEmbeddedBrowserSignIn(stableId: String): Boolean =
    synchronized(lock) {
      registrations[stableId]?.ordinaryAdmission != true && registry.entries.value.any { it.stableId == stableId && it.accessOrigin != null }
    }

  private fun requiredBrowserProfiles(): Set<String> =
    registry.entries.value
      .filter { it.accessOrigin != null && registrations[it.stableId]?.ordinaryAdmission != true }
      .map { it.stableId }
      .toSet()

  private fun publishLocked(
    attention: GatewayAccessAttention? = mutablePresentation.value.attention,
    browserLaunch: GatewayAccessBrowserLaunch? = mutablePresentation.value.browserLaunch,
  ) {
    val acknowledgement = signOutAcknowledgement
    // Registration replacement invalidates this action before its raw probe finishes.
    // Keep its completed action on the same owner for Retry captured before acknowledgement.
    val currentAttention = attention.takeUnless { acknowledgement != null && it === acknowledgement.currentAction && !isAcknowledgementRegisteredLocked(acknowledgement) }
    if (currentAttention !== acknowledgement?.currentAction) signOutAcknowledgement = null
    // One emission is the commit boundary for UI observers that can resume inline.
    // Never publish a second field after an observer has canceled or replaced its owner.
    mutablePresentation.value = GatewayAccessPresentation(currentAttention, browserLaunch, requiredBrowserProfiles())
  }

  private fun isAcknowledgementRegisteredLocked(acknowledgement: SignOutAcknowledgement): Boolean =
    registrations[acknowledgement.action.stableId] === acknowledgement.registration && acknowledgement.registration?.ordinaryAdmission != true &&
      registry.entries.value.any {
        it.stableId == acknowledgement.action.stableId && it.accessOrigin == acknowledgement.origin.uri.toString() &&
          (acknowledgement.registration != null || it === acknowledgement.entry)
      }

  fun consumeBrowserLaunch(id: UUID): String? =
    synchronized(lock) {
      val launch = mutablePresentation.value.browserLaunch ?: return@synchronized null
      val intent = browserIntent ?: return@synchronized null
      if (launch.attemptId != id || intent.id != id || !isLiveIntentLocked(intent)) return@synchronized null
      publishLocked(browserLaunch = null)
      launch.url.takeIf { isLiveIntentLocked(intent) }
    }

  fun cancel(
    id: UUID,
    message: String = "Sign-in canceled. Sign in again to reconnect.",
  ): Job? {
    val intent =
      synchronized(lock) {
        browserIntent?.takeIf { it.id == id }?.also {
          // Retire the consumer synchronously, even if the store already committed and
          // its waiter has not resumed. A queued browser launch must retire with it.
          val current = isLiveIntentLocked(it)
          it.canceled.set(true)
          publishLocked(
            attention = if (current) GatewayAccessAttention(it.registration.endpoint.stableId, message) else mutablePresentation.value.attention.takeUnless { attention -> attention?.attemptId == it.id },
            browserLaunch = mutablePresentation.value.browserLaunch.takeUnless { launch -> launch?.attemptId == it.id },
          )
        }
      } ?: return null
    return finishCancellation(intent, intent.task)
  }

  private fun finishCancellation(
    intent: BrowserIntent,
    task: Deferred<CloudflareAccessSessionStore.Snapshot>?,
  ): Job {
    task?.cancel()
    return scope.launch {
      browserMutex.withLock {
        val ownsAttempt =
          synchronized(lock) {
            if (browserIntent !== intent) return@synchronized false
            browserIntent = null
            true
          }
        if (ownsAttempt) store.cancelSignIn(intent.registration.origin)
      }
    }
  }

  fun cancelPending(stableId: String? = null) {
    val id =
      synchronized(lock) {
        browserIntent
          ?.takeIf { stableId == null || it.registration.endpoint.stableId == stableId }
          ?.id
      } ?: return
    cancel(id)
  }

  suspend fun forget(stableId: String) {
    val (origin, intent, task) =
      synchronized(lock) {
        val intent = browserIntent?.takeIf { it.registration.endpoint.stableId == stableId }
        val task = intent?.task
        // A StateFlow publication may resume the committed waiter inline. Retire
        // its identity before removing registration or publishing the cleared UI.
        intent?.canceled?.set(true)
        leases.remove(stableId)?.active?.set(false)
        val registration = registrations.remove(stableId)
        // The saved association was committed before any grant. An interrupted
        // route replacement may already have a different in-flight registration.
        val origin =
          registry.entries.value.firstOrNull { it.stableId == stableId }?.accessOrigin?.let {
            runCatching { CloudflareAccessOrigin.from(it) }.getOrNull()
          } ?: registration?.origin
        publishLocked(
          attention = mutablePresentation.value.attention.takeUnless { it?.stableId == stableId },
          browserLaunch = mutablePresentation.value.browserLaunch.takeUnless { intent != null && it?.attemptId == intent.id },
        )
        Triple(origin, intent, task)
      }
    val cancellation = intent?.let { finishCancellation(it, task) }
    val retirement = if (origin != null && registry.entries.value.none { it.stableId != stableId && it.accessOrigin == origin.uri.toString() }) store.forget(origin) else null
    cancellation?.join()
    retirement?.task?.await()
  }

  fun revalidate() {
    val expired = synchronized(lock) { leases.values.filter { it.active.get() && it.snapshot.session.expiresAt <= now() } }
    expired.forEach(::invalidate)
  }

  fun retry(
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): Retry? =
    synchronized(lock) {
      val action = mutablePresentation.value.attention ?: return@synchronized null
      val entry = registry.entries.value.firstOrNull { it.stableId == action.stableId } ?: return@synchronized null
      Retry(action, entry, admissionCheckpoint, isCurrent)
    }

  inner class Retry internal constructor(
    action: GatewayAccessAttention,
    entry: GatewayRegistryEntry,
    private val admissionCheckpoint: Long,
    private val isCurrent: () -> Boolean,
  ) {
    val stableId: String = action.stableId
    private var owner: RetryOwner =
      RetryOwner.Captured(
        action,
        entry,
        registrations[stableId],
        signOutAcknowledgement?.takeIf { it.currentAction === action && isAcknowledgementRegisteredLocked(it) },
      )

    suspend fun prepare(
      endpoint: GatewayEndpoint,
      tls: GatewayTlsParams?,
    ): GatewayIngressAuthorization? {
      if (tls == null) return null
      require(endpoint.stableId == stableId)
      val prepared =
        register(endpoint, tls, isCurrent) { selected ->
          if (!ownsPresentationLocked() ||
            !callerIsCurrent {
              ownedOrigin()?.let { store.requireAdmission(it, admissionCheckpoint) }
              isCurrent()
            }
          ) {
            throw CancellationException("Gateway retry superseded")
          }
          owner = RetryOwner.Acquired(selected)
        }
      return prepareRegistered(prepared, true, admissionCheckpoint, isCurrent)
    }

    private fun ownsPresentationLocked(): Boolean =
      when (val captured = owner) {
        is RetryOwner.Captured -> {
          // Only this captured Sign out owner may advance the action before Retry acquires it.
          // Its completion still settles the UI when a queued Retry is stopped before running.
          val acknowledgement = captured.acknowledgement
          val action = acknowledgement?.currentAction ?: captured.action
          (acknowledgement == null || signOutAcknowledgement === acknowledgement) &&
            registrations[stableId] === (acknowledgement?.registration ?: captured.registration) &&
            registry.entries.value.any { it === captured.entry } && mutablePresentation.value.attention === action
        }

        is RetryOwner.Acquired -> {
          isRegisteredLocked(captured.registration)
        }
      }

    private fun ownedRegistration(): Registration? =
      when (val captured = owner) {
        is RetryOwner.Captured -> captured.acknowledgement?.registration ?: captured.registration
        is RetryOwner.Acquired -> captured.registration
      }

    // Before acquisition, Sign out owns the saved association even when an
    // interrupted route replacement has already installed another registration.
    private fun ownedOrigin(): CloudflareAccessOrigin? =
      when (val captured = owner) {
        is RetryOwner.Captured -> captured.entry.accessOrigin?.let(CloudflareAccessOrigin::from) ?: captured.registration?.origin
        is RetryOwner.Acquired -> captured.registration.origin
      }

    fun reportFailure(message: String) {
      synchronized(lock) {
        val registration = ownedRegistration()
        val origin = ownedOrigin()
        // An acquired route owns even a failed raw probe. Its new origin need not
        // have a verified grant association yet; that metadata is never admission.
        if (!ownsPresentationLocked() || registration?.ordinaryAdmission == true || browserIntent != null ||
          mutablePresentation.value.attention?.let { it.stableId != stableId } == true ||
          !callerIsCurrent {
            origin?.let { store.requireAdmission(it, admissionCheckpoint) }
            isCurrent()
          }
        ) {
          return
        }
        publishLocked(attention = GatewayAccessAttention(stableId, message))
      }
    }
  }

  private suspend fun associate(
    registration: Registration,
    isCurrent: () -> Boolean,
  ) {
    checkRegistration(registration, isCurrent)
    synchronized(lock) {
      checkRegistrationLocked(registration, isCurrent)
      if (!registry.setAccessOrigin(registration.endpoint.stableId, registration.origin)) {
        throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
      }
      checkRegistrationLocked(registration, isCurrent)
      publishLocked()
    }
  }

  private suspend fun signIn(
    registration: Registration,
    application: CloudflareAccessApplication,
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): CloudflareAccessSessionStore.Snapshot {
    val (intent, task) =
      browserMutex.withLock {
        val old = synchronized(lock) { browserIntent }
        if (old != null && synchronized(lock) { !isLiveIntentLocked(old) || old.registration.origin != registration.origin }) cancelExisting(old)
        checkRegistration(registration, isCurrent)
        val intent =
          synchronized(lock) {
            checkRegistrationLocked(registration, isCurrent)
            browserIntent?.takeIf { it.registration.origin == registration.origin }
              ?: BrowserIntent(UUID.randomUUID(), registration, isCurrent).also { browserIntent = it }
          }
        val task =
          store.signIn(application, admissionCheckpoint) { url ->
            synchronized(lock) {
              checkRegistrationLocked(registration, isCurrent)
              if (!isLiveIntentLocked(intent)) throw CancellationException()
              publishLocked(
                attention =
                  GatewayAccessAttention(
                    intent.registration.endpoint.stableId,
                    "After approving sign-in, close the browser tab to return to OpenClaw.",
                    intent.id,
                  ),
                browserLaunch = GatewayAccessBrowserLaunch(intent.id, url),
              )
            }
          }
        intent.task = task
        if (intent.canceled.get()) task.cancel()
        intent to task
      }
    try {
      val result = task.await()
      synchronized(lock) {
        checkRegistrationLocked(registration, isCurrent)
        if (intent.canceled.get()) throw CancellationException("Gateway sign-in canceled")
        if (isLiveIntentLocked(intent)) {
          browserIntent = null
          publishLocked(attention = null, browserLaunch = null)
        }
      }
      return result
    } catch (error: Exception) {
      val context = kotlin.coroutines.coroutineContext
      synchronized(lock) {
        val callerCurrent =
          try {
            context.ensureActive()
            isCurrent()
          } catch (_: CancellationException) {
            false
          }
        // A shared task's retired waiter cannot clear the surviving browser owner
        // or publish a retry action for a forgotten/replaced profile.
        if (isLiveIntentLocked(intent) && task.isCompleted && callerCurrent &&
          isRegisteredLocked(registration)
        ) {
          browserIntent = null
          publishLocked(
            attention =
              GatewayAccessAttention(
                intent.registration.endpoint.stableId,
                (error as? CloudflareAccessException)?.message ?: "Sign-in canceled. Sign in again to reconnect.",
              ),
            browserLaunch = null,
          )
        }
      }
      throw error
    }
  }

  private suspend fun cancelExisting(intent: BrowserIntent) {
    synchronized(lock) {
      intent.canceled.set(true)
      if (browserIntent === intent) {
        browserIntent = null
        publishLocked(
          attention = mutablePresentation.value.attention.takeUnless { it?.attemptId == intent.id },
          browserLaunch = mutablePresentation.value.browserLaunch.takeUnless { it?.attemptId == intent.id },
        )
      }
    }
    intent.task?.cancel()
    store.cancelSignIn(intent.registration.origin)
  }

  fun signOut(stableId: String): Deferred<Unit>? {
    val entry = registry.entries.value.firstOrNull { it.stableId == stableId } ?: return null
    val origin = entry.accessOrigin?.let(CloudflareAccessOrigin::from) ?: return null
    // Revoke the canonical snapshot before observable effects can re-enter admission.
    // Store cancellation and retirement starts must execute outside the ingress lock.
    val retirement = store.forget(origin)
    val (acknowledgement, task, expiry) =
      synchronized(lock) {
        val registration = registrations[stableId]
        // Admission can run before or after revocation. Recapture here, retiring
        // only stale work and preserving a fresh browser intent or grant.
        val intent = browserIntent?.takeIf { it.registration.origin == origin && !isLiveIntentLocked(it) }
        val task = intent?.task
        intent?.canceled?.set(true)
        if (intent != null) browserIntent = null
        leases.values.filter { it.origin == origin && !it.hasCurrentSnapshot() }.forEach { it.active.set(false) }
        val expiry = if (store.isCurrent(retirement)) expiryJobs.remove(origin) else null
        val survivingAttention = mutablePresentation.value.attention.takeUnless { intent != null && it?.attemptId == intent.id }
        val carried =
          signOutAcknowledgement?.takeIf {
            it.action === survivingAttention && it.origin == origin &&
              ownsRetirementPresentationLocked(retirement, it.action.stableId, it.registration, survivingAttention)
          }
        val acknowledgement =
          if (ownsRetirementPresentationLocked(retirement, stableId, registration, survivingAttention.takeUnless { carried != null })) {
            val pending = GatewayAccessAttention(stableId, "Signing out…")
            // StateFlow retains equal values. Capture this action before publication
            // can synchronously re-enter and replace it with a newer Retry outcome.
            SignOutAcknowledgement(survivingAttention?.takeIf { it == pending } ?: pending, entry, registration, origin)
          } else {
            // An ordinary sibling can finish the original profile's pending Sign out,
            // but cannot acquire its presentation or adopt a replacement registration.
            carried
          }
        if (acknowledgement != null) signOutAcknowledgement = acknowledgement
        publishLocked(acknowledgement?.action ?: survivingAttention, mutablePresentation.value.browserLaunch.takeUnless { intent != null && it?.attemptId == intent.id })
        Triple(acknowledgement, task, expiry)
      }
    task?.cancel()
    expiry?.cancel()
    observeRetirement(retirement) { succeeded ->
      if (acknowledgement != null && signOutAcknowledgement === acknowledgement && mutablePresentation.value.attention === acknowledgement.action &&
        ownsRetirementPresentationLocked(retirement, acknowledgement.action.stableId, acknowledgement.registration)
      ) {
        val message =
          if (succeeded) {
            "This host’s Access session is signed out. Sign in to reconnect gateways using it."
          } else {
            "Could not clear this host’s saved Access session. Try Sign out again."
          }
        val completedAction = GatewayAccessAttention(acknowledgement.action.stableId, message)
        acknowledgement.completedAction = completedAction
        publishLocked(attention = completedAction)
      }
    }
    return retirement.task
  }

  private fun observeRetirement(
    retirement: CloudflareAccessSessionStore.Retirement,
    completed: (Boolean) -> Unit,
  ) {
    scope.launch {
      // Settings does not await this task. A success message must follow durable deletion,
      // and neither completion may overwrite a newer browser or profile owner.
      val succeeded =
        try {
          retirement.task.await()
          true
        } catch (error: CancellationException) {
          throw error
        } catch (_: Exception) {
          false
        }
      kotlin.coroutines.coroutineContext.ensureActive()
      synchronized(lock) { completed(succeeded) }
    }
  }

  private suspend fun admit(
    registration: Registration,
    snapshot: CloudflareAccessSessionStore.Snapshot,
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): Lease {
    checkRegistration(registration, isCurrent)
    val (lease, oldExpiry, expiry) =
      synchronized(lock) {
        val lease =
          store.withCurrentSnapshot(registration.origin, snapshot.revision, admissionCheckpoint) {
            checkRegistrationLocked(registration, isCurrent)
            val lease = Lease(registration, snapshot)
            registration.ordinaryAdmission = false
            leases.put(registration.endpoint.stableId, lease)?.active?.set(false)
            lease
          }
        val oldExpiry = expiryJobs[registration.origin]
        val expiry =
          scope.launch(start = CoroutineStart.LAZY) {
            delay(((snapshot.session.expiresAt - now()) * 1000).toLong().coerceAtLeast(1))
            invalidate(registration.origin, snapshot.revision)
          }
        expiryJobs[registration.origin] = expiry
        publishLocked(attention = attentionAfterAdmissionLocked(registration))
        Triple(lease, oldExpiry, expiry)
      }
    oldExpiry?.cancel()
    expiry.start()
    return lease
  }

  private fun invalidate(lease: Lease) {
    val current =
      synchronized(lock) {
        registrations[lease.registration.endpoint.stableId] === lease.registration && lease.active.get()
      }
    if (current) invalidate(lease.origin, lease.snapshot.revision)
  }

  private fun invalidate(
    origin: CloudflareAccessOrigin,
    revision: Long,
  ) {
    val registration =
      synchronized(lock) {
        val retiring = leases.values.filter { it.origin == origin && it.snapshot.revision == revision && it.active.get() }
        retiring.forEach { it.active.set(false) }
        retiring.firstOrNull { registrations[it.registration.endpoint.stableId] === it.registration }?.registration
      }
    // Expiry belongs to the stored origin revision. A profile chosen for attention
    // cannot veto its retirement after that profile was replaced or forgotten.
    val retirement = store.requireReauthentication(origin, revision) ?: return
    synchronized(lock) {
      if (registration != null && ownsRetirementPresentationLocked(retirement, registration.endpoint.stableId, registration)) {
        publishLocked(attention = requiredAttention(registration))
      }
    }
    observeRetirement(retirement) { succeeded ->
      if (!succeeded && registration != null && ownsRetirementPresentationLocked(retirement, registration.endpoint.stableId, registration)) {
        publishLocked(attention = GatewayAccessAttention(registration.endpoint.stableId, "Could not retire this host’s Access session. Sign in to retry."))
      }
    }
  }

  private fun ownsRetirementPresentationLocked(
    retirement: CloudflareAccessSessionStore.Retirement,
    stableId: String,
    registration: Registration?,
    attention: GatewayAccessAttention? = mutablePresentation.value.attention,
  ): Boolean =
    store.isCurrent(retirement) && browserIntent == null &&
      registrations[stableId] === registration && registration?.ordinaryAdmission != true &&
      registry.entries.value.any { it.stableId == stableId && it.accessOrigin == retirement.origin.uri.toString() } &&
      attention?.let { it.stableId != stableId } != true

  private fun showRequired(
    registration: Registration,
    isCurrent: () -> Boolean,
  ) {
    synchronized(lock) {
      checkRegistrationLocked(registration, isCurrent)
      if (browserIntent == null) publishLocked(attention = requiredAttention(registration))
    }
  }

  private fun requiredAttention(registration: Registration) = GatewayAccessAttention(registration.endpoint.stableId, "Sign in to Cloudflare Access to connect to this gateway.")

  private fun attentionAfterAdmissionLocked(registration: Registration): GatewayAccessAttention? =
    mutablePresentation.value.attention.takeUnless {
      it?.stableId == registration.endpoint.stableId && browserIntent?.let(::isLiveIntentLocked) != true
    }

  private fun isLiveIntentLocked(intent: BrowserIntent): Boolean = browserIntent === intent && !intent.canceled.get() && isRegisteredLocked(intent.registration) && callerIsCurrent(intent.isCurrent)

  private fun callerIsCurrent(isCurrent: () -> Boolean): Boolean =
    try {
      isCurrent()
    } catch (_: CancellationException) {
      false
    }

  private suspend fun checkRegistration(
    registration: Registration,
    isCurrent: () -> Boolean,
  ) {
    kotlin.coroutines.coroutineContext.ensureActive()
    synchronized(lock) { checkRegistrationLocked(registration, isCurrent) }
  }

  private fun checkRegistrationLocked(
    registration: Registration,
    isCurrent: () -> Boolean,
  ) {
    if (!isCurrent() || !isRegisteredLocked(registration)) {
      throw CancellationException("Gateway request superseded")
    }
  }

  private fun isRegisteredLocked(registration: Registration): Boolean =
    registrations[registration.endpoint.stableId] === registration &&
      registry.entries.value.any { it.stableId == registration.endpoint.stableId }

  private inner class Lease(
    val registration: Registration,
    val snapshot: CloudflareAccessSessionStore.Snapshot,
  ) : GatewayIngressAuthorization {
    val origin = registration.origin
    val active = AtomicBoolean(true)

    override suspend fun authorizeUpgrade(request: Request): Request {
      requireCurrent(request)
      if (registration.client.discover(registration.url, snapshot.session, customHeaders(registration.endpoint.stableId)) != null) {
        invalidate(this)
        throw GatewayExternalAuthorizationException()
      }
      requireCurrent(request)
      val token = snapshot.session.authorizationHeader(request.url.toString(), now()) ?: throw GatewayExternalAuthorizationException()
      return request.newBuilder().header("Cf-Access-Token", token).build()
    }

    fun hasCurrentSnapshot(): Boolean = runCatching { store.withCurrentSnapshot(origin, snapshot.revision, snapshot.revision) { } }.isSuccess

    override fun requireCurrent(request: Request) {
      val registered =
        synchronized(lock) {
          registrations[registration.endpoint.stableId] === registration &&
            registry.entries.value.any { it.stableId == registration.endpoint.stableId } && hasCurrentSnapshot()
        }
      if (!registered || !active.get() || snapshot.session.authorizationHeader(request.url.toString(), now()) == null) {
        if (snapshot.session.expiresAt <= now()) invalidate(this)
        throw GatewayExternalAuthorizationException()
      }
    }

    override fun rejection(response: Response): GatewayExternalAuthorizationException? {
      if (!CloudflareAccessClient.isChallenge(
          CloudflareAccessClient.Reply(response.request.url.toString(), response.code, response.headers, byteArrayOf()),
          origin,
        )
      ) {
        return null
      }
      invalidate(this)
      return GatewayExternalAuthorizationException()
    }
  }

  companion object {
    private val unavailable =
      object : GatewayIngressAuthorization {
        override suspend fun authorizeUpgrade(request: Request): Request = throw GatewayExternalAuthorizationException()

        override fun requireCurrent(request: Request): Unit = throw GatewayExternalAuthorizationException()

        override fun rejection(response: Response): GatewayExternalAuthorizationException? = null
      }

    private fun routeClient(
      endpoint: GatewayEndpoint,
      tls: GatewayTlsParams,
    ): CloudflareAccessClient {
      val origin = CloudflareAccessOrigin.from(buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath))
      val config = checkNotNull(buildGatewayTlsConfig(tls))
      val transport =
        OkHttpClient
          .Builder()
          .sslSocketFactory(config.sslSocketFactory, config.trustManager)
          .hostnameVerifier(config.hostnameVerifier)
          .followRedirects(false)
          .followSslRedirects(false)
          .cookieJar(CookieJar.NO_COOKIES)
          .cache(null)
          .build()
      return CloudflareAccessClient { request, maximumBytes, timeout ->
        if (origin.contains(request.url.toString())) {
          CloudflareAccessClient.send(request, maximumBytes, timeout, transport)
        } else {
          CloudflareAccessClient.send(request, maximumBytes, timeout)
        }
      }
    }
  }
}
