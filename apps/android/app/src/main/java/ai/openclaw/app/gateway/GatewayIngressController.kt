package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLException

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
  // This observer must queue delivery; inline dispatch would invert Registry and ingress monitors.
  registryObserverDispatcher: CoroutineDispatcher = Dispatchers.Default,
  authenticate: suspend (CloudflareAccessApplication, suspend (String) -> Unit) -> CloudflareAccessSession =
    { application, browser -> CloudflareAccessTransfer().signIn(application, browser) },
) {
  private class Registration(
    val endpoint: GatewayEndpoint,
    val tls: GatewayTlsParams,
    val client: CloudflareAccessClient,
  ) {
    val origin = CloudflareAccessOrigin.from(url)

    // null is unclassified; false is a verified managed challenge, including pending sign-in.
    var ordinaryAdmission: Boolean? = null
    val url: String
      get() = buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath)
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

  private class BrowserParticipant(
    val registration: Registration,
    val context: kotlin.coroutines.CoroutineContext,
    val isCurrent: () -> Boolean,
  )

  private class DiscoveryOperation(
    val registration: Registration,
    val snapshot: CloudflareAccessSessionStore.Snapshot,
    val task: Deferred<CloudflareAccessApplication?>,
  )

  private class BrowserIntent(
    val id: UUID,
    val application: CloudflareAccessApplication,
  ) {
    val canceled = AtomicBoolean(false)
    val participants = mutableSetOf<BrowserParticipant>()

    // Caller withdrawal ends eligibility, not explicit-departure custody of a pending Store task.
    val registrationOwners = mutableSetOf<Registration>()

    @Volatile var task: Deferred<CloudflareAccessSessionStore.Snapshot>? = null
  }

  private val lock = Any()
  private val browserMutex = Mutex()
  private val registrations = mutableMapOf<String, Registration>()
  private val leases = mutableMapOf<String, Lease>()
  private val expiryJobs = mutableMapOf<CloudflareAccessOrigin, Job>()
  private val discoveries = mutableSetOf<DiscoveryOperation>()
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
      retireDiscoveries { it.snapshot.session.application.origin == origin }
      // No connect task awaits its own drain. Rejections schedule this store-owned boundary.
      retireTransports(origin)
    }

  init {
    scope.launch(registryObserverDispatcher) {
      val context = kotlin.coroutines.coroutineContext
      registry.entries.collect {
        synchronized(lock) {
          context.ensureActive()
          publishLocked()
        }
      }
    }
  }

  fun admissionCheckpoint(): Long = store.admissionCheckpoint()

  suspend fun prepare(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams,
    userInitiated: Boolean,
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): GatewayIngressAuthorization? {
    kotlin.coroutines.coroutineContext.ensureActive()
    return prepareRegistered(register(endpoint, tls, isCurrent), userInitiated, admissionCheckpoint, isCurrent)
  }

  private suspend fun register(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams,
    isCurrent: () -> Boolean,
  ): Registration {
    val context = kotlin.coroutines.coroutineContext
    val (registration, replacedIntent) =
      synchronized(lock) {
        context.ensureActive()
        if (!isCurrent() || registry.entries.value.none { it.stableId == endpoint.stableId }) {
          throw CancellationException("Gateway request superseded")
        }
        val previous = registrations[endpoint.stableId]
        val current =
          previous?.takeIf { it.endpoint == endpoint && it.tls == tls }
            ?: Registration(endpoint, tls, clientForRoute(endpoint, tls))
        val acknowledgement =
          signOutAcknowledgement?.takeIf {
            previous == null && it.registration == null && it.action.stableId == endpoint.stableId &&
              it.origin == current.origin && isAcknowledgementRegisteredLocked(it)
          }
        var retired: BrowserIntent? = null
        if (current !== previous) {
          leases.remove(endpoint.stableId)?.active?.set(false)
          registrations[endpoint.stableId] = current
          // A cold Sign out belongs to the saved entry until its first registration.
          // Bind before publication can invalidate that owner.
          acknowledgement?.registration = current
          retired = previous?.let(::retireBrowserParticipationLocked)
          publishLocked()
        }
        current to retired
      }
    replacedIntent?.let { finishCancellation(it, it.task).join() }
    retireDiscoveries { it.registration.endpoint.stableId == endpoint.stableId && it.registration !== registrations[endpoint.stableId] }
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
    if (previousRetirement != null &&
      !completeDeparture(endpoint.stableId, previousRetirement.origin.uri.toString(), previousRetirement) {
        checkRegistrationLocked(registration, isCurrent)
        true
      }
    ) {
      throw CancellationException("Gateway association superseded")
    }
    // Existing service headers or WARP must remain independent of a cached browser
    // grant. Only a verified Access challenge admits managed credentials for this profile.
    val (preCommitOrdinary, preCommitRevision) =
      synchronized(lock) {
        checkRegistrationLocked(registration, isCurrent)
        registration.ordinaryAdmission to leases[endpoint.stableId]?.takeIf { it.registration === registration }?.snapshot?.revision
      }
    val ordinaryChallenge = registration.client.discover(registration.url, customHeaders = customHeaders(endpoint.stableId))
    checkRegistration(registration, isCurrent)
    if (ordinaryChallenge == null) {
      val (ordinary, pending) =
        synchronized(lock) {
          checkRegistrationLocked(registration, isCurrent)
          val revision = leases[endpoint.stableId]?.takeIf { it.registration === registration }?.snapshot?.revision
          if (registration.ordinaryAdmission != preCommitOrdinary || revision != preCommitRevision) {
            throw CancellationException("Gateway admission superseded")
          }
          // A new identity permanently retires old browser waiters, even after a peer
          // settles their shared intent and this profile later becomes managed again.
          val ordinary =
            registration.takeIf { it.ordinaryAdmission == true }
              ?: Registration(endpoint, registration.tls, registration.client).also { registrations[endpoint.stableId] = it }
          ordinary.ordinaryAdmission = true
          leases.remove(endpoint.stableId)?.active?.set(false)
          val pending = discoveries.filter { it.registration === registration }
          val intent = browserIntent
          val participant = intent?.let(::liveParticipantLocked)
          // Participant predicates can reenter admission. Do not publish over their successor.
          if (!isRegisteredLocked(ordinary) || ordinary.ordinaryAdmission != true) throw CancellationException("Gateway admission superseded")
          val presentation = mutablePresentation.value
          val ownsIntent = intent != null && browserIntent === intent
          publishLocked(
            attention =
              when {
                ownsIntent && presentation.attention?.attemptId == intent.id -> participant?.let { presentation.attention.copy(stableId = it.registration.endpoint.stableId) }
                presentation.attention?.stableId == endpoint.stableId -> null
                else -> presentation.attention
              },
            browserLaunch = presentation.browserLaunch.takeUnless { ownsIntent && participant == null && it?.attemptId == intent.id },
          )
          ordinary to pending
        }
      retireDiscoveries(pending)
      kotlin.coroutines.coroutineContext.ensureActive()
      synchronized(lock) {
        checkRegistrationLocked(ordinary, isCurrent)
        if (ordinary.ordinaryAdmission != true) throw CancellationException("Gateway admission superseded")
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
    val application = if (previous == null) ordinaryChallenge else discover(registration, previous, managedIsCurrent)
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

  private suspend fun discover(
    registration: Registration,
    snapshot: CloudflareAccessSessionStore.Snapshot,
    isCurrent: () -> Boolean,
  ): CloudflareAccessApplication? {
    val caller = kotlin.coroutines.coroutineContext
    val operation =
      synchronized(lock) {
        caller.ensureActive()
        checkRegistrationLocked(registration, isCurrent)
        store.withCurrentSnapshot(registration.origin, snapshot.revision, snapshot.revision) {
          val task =
            scope.async(start = CoroutineStart.LAZY) {
              val requestContext = kotlin.coroutines.coroutineContext
              registration.client.discover(
                registration.url,
                snapshot.session,
                customHeaders(registration.endpoint.stableId),
              ) {
                val current =
                  synchronized(lock) {
                    callerIsCurrent {
                      caller.ensureActive()
                      requestContext.ensureActive()
                      isCurrent()
                    } && isRegisteredLocked(registration) && registration.ordinaryAdmission == false &&
                      runCatching { store.withCurrentSnapshot(registration.origin, snapshot.revision, snapshot.revision) { } }.isSuccess
                  }
                if (!current) throw GatewayExternalAuthorizationException()
              }
            }
          DiscoveryOperation(registration, snapshot, task).also(discoveries::add)
        }
      }
    try {
      // Enroll while revocation is excluded; starting or canceling coroutine work
      // under these monitors could synchronously reenter the owner.
      operation.task.start()
      return operation.task.await()
    } finally {
      withContext(NonCancellable) {
        operation.task.cancel()
        operation.task.join()
        synchronized(lock) { discoveries.remove(operation) }
      }
    }
  }

  private suspend fun retireDiscoveries(matches: (DiscoveryOperation) -> Boolean) {
    retireDiscoveries(synchronized(lock) { discoveries.filter(matches) })
  }

  private suspend fun retireDiscoveries(pending: List<DiscoveryOperation>) {
    // Keep custody until the operation settles, including overlapping retirement
    // and caller cancellation. Ordinary unauthenticated probes are independent.
    pending.forEach { it.task.cancel() }
    withContext(NonCancellable) { pending.forEach { it.task.join() } }
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
      val intent = browserIntent
      val participant = intent?.let { liveParticipantLocked(it, stableId) }
      // Browser attention can outlive a suspended caller's eligibility; only its live participant blocks.
      registrations[stableId]?.ordinaryAdmission != true &&
        (
          (participant != null && browserIntent === intent) ||
            mutablePresentation.value.attention?.let { it.stableId == stableId && it.attemptId == null } == true ||
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
          val current = liveParticipantLocked(it)
          it.canceled.set(true)
          publishLocked(
            attention = if (current != null) GatewayAccessAttention(current.registration.endpoint.stableId, message) else mutablePresentation.value.attention.takeUnless { attention -> attention?.attemptId == it.id },
            browserLaunch = mutablePresentation.value.browserLaunch.takeUnless { launch -> launch?.attemptId == it.id },
          )
        }
      } ?: return null
    return finishCancellation(intent, intent.task)
  }

  private fun retireBrowserParticipationLocked(registration: Registration): BrowserIntent? {
    val intent = browserIntent ?: return null

    fun departed(candidate: Registration): Boolean =
      candidate.endpoint.stableId == registration.endpoint.stableId &&
        (candidate === registration || !isRegisteredLocked(candidate))
    // Ordinary admission can rotate this profile's registration without canceling
    // its Store task. Explicit departure must also retire that obsolete generation.
    if (intent.registrationOwners.none(::departed) && intent.participants.none { departed(it.registration) }) return null
    intent.registrationOwners.removeAll(::departed)
    intent.participants.removeAll { departed(it.registration) }
    // A profile departure does not own a peer's shared task, including terminal
    // results whose waiters have not resumed. Only the last explicit owner cancels it.
    val participant = liveParticipantLocked(intent)
    if (browserIntent !== intent) return null
    if (participant == null) intent.canceled.set(true)
    reconcileBrowserPresentationLocked(intent, participant)
    return intent.takeIf { participant == null }
  }

  private fun reconcileBrowserPresentationLocked(
    intent: BrowserIntent,
    participant: BrowserParticipant?,
  ) {
    val presentation = mutablePresentation.value
    publishLocked(
      attention =
        if (presentation.attention?.attemptId == intent.id) {
          participant?.let { presentation.attention.copy(stableId = it.registration.endpoint.stableId) }
        } else {
          presentation.attention
        },
      browserLaunch = presentation.browserLaunch.takeUnless { participant == null && it?.attemptId == intent.id },
    )
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
        if (ownsAttempt) store.cancelSignIn(intent.application.origin)
      }
    }
  }

  fun cancelPending(stableId: String? = null) {
    val id =
      synchronized(lock) {
        browserIntent
          ?.takeIf { intent ->
            stableId == null || intent.registrationOwners.any { it.endpoint.stableId == stableId } ||
              intent.participants.any { it.registration.endpoint.stableId == stableId }
          }?.id
      } ?: return
    cancel(id)
  }

  suspend fun forget(stableId: String) = forget(stableId) {}

  private suspend fun forget(
    stableId: String,
    validate: () -> Unit,
  ) {
    val context = kotlin.coroutines.coroutineContext
    var associationFailed = false
    val (intent, retirement, association) =
      synchronized(lock) {
        context.ensureActive()
        validate()
        val registration = registrations[stableId]
        val association =
          registry.entries.value
            .firstOrNull { it.stableId == stableId }
            ?.accessOrigin
        val origin = association?.let { runCatching { CloudflareAccessOrigin.from(it) }.getOrNull() } ?: registration?.origin
        // Reserve last-owner retirement before any observable publication. Shared
        // departures release their association now, leaving the final owner durable.
        val retirement =
          origin
            ?.takeIf { selected -> registry.entries.value.none { it.stableId != stableId && it.accessOrigin == selected.uri.toString() } }
            ?.let(store::reserveForget)
        leases.remove(stableId)?.active?.set(false)
        registrations.remove(stableId)
        if (retirement == null && association != null) {
          associationFailed = !registry.setAccessOrigin(stableId, null)
        }
        val intent = registration?.let(::retireBrowserParticipationLocked)
        // Registry observers can reenter after the association commit. A newer
        // registration owns its UI even when it uses the same origin.
        if (registrations[stableId] == null) {
          publishLocked(
            attention = mutablePresentation.value.attention.takeUnless { it?.stableId == stableId },
            browserLaunch = mutablePresentation.value.browserLaunch,
          )
        }
        Triple(intent, retirement, association)
      }
    retirement?.start()
    retireDiscoveries { it.registration.endpoint.stableId == stableId && registrations[stableId] !== it.registration }
    val cancellation = intent?.let { finishCancellation(it, it.task) }
    cancellation?.join()
    if (retirement != null) {
      completeDeparture(stableId, association, retirement) { registrations[stableId] == null }
    } else {
      context.ensureActive()
      synchronized(lock) {
        if (associationFailed && registrations[stableId] == null &&
          registry.entries.value
            .firstOrNull { it.stableId == stableId }
            ?.accessOrigin == association
        ) {
          throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
        }
      }
    }
  }

  private suspend fun completeDeparture(
    stableId: String,
    association: String?,
    initialRetirement: CloudflareAccessSessionStore.Retirement,
    ownsProfileLocked: () -> Boolean,
  ): Boolean {
    val context = kotlin.coroutines.coroutineContext
    var retirement = initialRetirement
    while (true) {
      retirement.start()
      retirement.task.await()
      context.ensureActive()
      synchronized(lock) {
        if (!ownsProfileLocked() || registry.entries.value
            .firstOrNull { it.stableId == stableId }
            ?.accessOrigin != association
        ) {
          return false
        }
        val clearAssociation = {
          if (association != null && !registry.setAccessOrigin(stableId, null)) {
            throw CloudflareAccessException(CloudflareAccessException.Kind.StorageFailed)
          }
        }
        // A peer may renew while this caller waits after deletion. Keep its grant
        // if it still owns the origin; otherwise retire the renewed last-owner grant
        // before releasing the durable association that makes cleanup recoverable.
        val hasSibling = registry.entries.value.any { it.stableId != stableId && it.accessOrigin == retirement.origin.uri.toString() }
        val completed =
          if (hasSibling) {
            clearAssociation()
            true
          } else {
            store.withCurrentRetirement(retirement, clearAssociation)
          }
        if (completed) {
          // Registry publication may synchronously install a replacement owner.
          return ownsProfileLocked().also { if (it) publishLocked() }
        }
        retirement = store.reconcileForget(retirement.origin)
      }
    }
  }

  fun revalidate() {
    val expired = synchronized(lock) { leases.values.filter { it.active.get() && it.snapshot.session.expiresAt <= now() } }
    expired.forEach(::invalidate)
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
    val participant = BrowserParticipant(registration, kotlin.coroutines.coroutineContext, isCurrent)
    var joinedIntent: BrowserIntent? = null
    try {
      val (intent, task) =
        browserMutex.withLock {
          checkRegistration(registration, isCurrent)
          synchronized(lock) { browserIntent }?.let { cancelExisting(it) }
          checkRegistration(registration, isCurrent)
          val intent =
            synchronized(lock) {
              checkRegistrationLocked(registration, isCurrent)
              BrowserIntent(UUID.randomUUID(), application).also {
                it.participants.add(participant)
                it.registrationOwners.add(registration)
                joinedIntent = it
                browserIntent = it
              }
            }
          val task =
            store.signIn(application, admissionCheckpoint) { url ->
              synchronized(lock) {
                val current = liveParticipantLocked(intent) ?: throw CancellationException()
                publishLocked(
                  attention =
                    GatewayAccessAttention(
                      current.registration.endpoint.stableId,
                      "After approving sign-in, close the browser tab to return to OpenClaw.",
                      intent.id,
                    ),
                  browserLaunch = GatewayAccessBrowserLaunch(intent.id, url),
                )
              }
            }
          intent.task = task
          // Terminal tasks no longer need detached owners; attached waiters still own queued cancellation.
          task.invokeOnCompletion { synchronized(lock) { intent.registrationOwners.clear() } }
          if (intent.canceled.get()) task.cancel()
          intent to task
        }
      try {
        val result = task.await()
        kotlin.coroutines.coroutineContext.ensureActive()
        synchronized(lock) {
          checkRegistrationLocked(registration, isCurrent)
          if (intent.canceled.get()) throw CancellationException("Gateway sign-in canceled")
          if (result.session.application != application) throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
          // Completion belongs to the shared intent; any current waiter can settle it
          // even after the caller that originally presented its browser has retired.
          if (browserIntent === intent && intent.task === task) {
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
          if (browserIntent === intent && intent.task === task && !intent.canceled.get() && task.isCompleted && callerCurrent &&
            isRegisteredLocked(registration)
          ) {
            browserIntent = null
            publishLocked(
              attention =
                GatewayAccessAttention(
                  registration.endpoint.stableId,
                  when (error) {
                    is CancellationException -> "Sign-in canceled. Sign in again to reconnect."
                    is SSLException -> "TLS connection failed: ${error.message ?: "certificate validation failed"}"
                    is IOException -> "Connection failed: ${error.message ?: "network unavailable"}"
                    else -> error.message ?: "Sign-in failed. Try again."
                  },
                ),
              browserLaunch = null,
            )
          }
        }
        throw error
      }
    } finally {
      // Keep Store task custody for explicit Cancel, but project only live browser participants.
      synchronized(lock) {
        joinedIntent?.let { intent ->
          intent.participants.remove(participant)
          val current = liveParticipantLocked(intent)
          if (browserIntent === intent) reconcileBrowserPresentationLocked(intent, current)
        }
      }
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
    store.cancelSignIn(intent.application.origin)
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
        val intent = browserIntent?.takeIf { it.application.origin == origin && !isLiveIntentLocked(it) }
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
            // Preserve the original profile's displayed action, but give every explicit
            // Sign out new completion custody so an older acquired Retry cannot replace it.
            carried?.let { SignOutAcknowledgement(it.action, it.entry, it.registration, it.origin) }
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
  ): Boolean {
    val intent = browserIntent
    val presentation = mutablePresentation.value
    val live = intent?.let(::isLiveIntentLocked) == true
    return !live && browserIntent === intent && mutablePresentation.value === presentation &&
      store.isCurrent(retirement) && registrations[stableId] === registration && registration?.ordinaryAdmission != true &&
      registry.entries.value.any { it.stableId == stableId && it.accessOrigin == retirement.origin.uri.toString() } &&
      attention?.let { it.stableId != stableId } != true
  }

  private fun showRequired(
    registration: Registration,
    isCurrent: () -> Boolean,
  ) {
    synchronized(lock) {
      val intent = browserIntent
      val presentation = mutablePresentation.value
      val live = intent?.let(::isLiveIntentLocked) == true
      checkRegistrationLocked(registration, isCurrent)
      if (!live && browserIntent === intent && mutablePresentation.value === presentation) {
        publishLocked(attention = requiredAttention(registration))
      }
    }
  }

  private fun requiredAttention(registration: Registration) = GatewayAccessAttention(registration.endpoint.stableId, "Sign in to Cloudflare Access to connect to this gateway.")

  private fun attentionAfterAdmissionLocked(registration: Registration): GatewayAccessAttention? =
    mutablePresentation.value.attention.takeUnless {
      it?.stableId == registration.endpoint.stableId && browserIntent?.let(::isLiveIntentLocked) != true
    }

  private fun isLiveIntentLocked(intent: BrowserIntent): Boolean = liveParticipantLocked(intent) != null

  private fun liveParticipantLocked(
    intent: BrowserIntent,
    stableId: String? = null,
  ): BrowserParticipant? {
    if (browserIntent !== intent || intent.canceled.get()) return null
    // Caller predicates may reenter the owner; use a snapshot and recheck ownership after each predicate.
    return intent.participants.toList().firstOrNull { participant ->
      (stableId == null || participant.registration.endpoint.stableId == stableId) &&
        callerIsCurrent {
          participant.context.ensureActive()
          participant.isCurrent()
        } && isRegisteredLocked(participant.registration) && browserIntent === intent &&
        !intent.canceled.get() && participant in intent.participants
    }
  }

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
      if (discover(registration, snapshot) { active.get() } != null) {
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
