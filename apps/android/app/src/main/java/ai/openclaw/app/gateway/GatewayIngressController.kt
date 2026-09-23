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
import kotlinx.coroutines.withContext
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.util.concurrent.atomic.AtomicBoolean

internal data class GatewayAccessAttention(
  val stableId: String,
  val message: String,
)

internal data class GatewayAccessPresentation(
  val attention: GatewayAccessAttention? = null,
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
) {
  private class Registration(
    val endpoint: GatewayEndpoint,
    val tls: GatewayTlsParams,
    val client: CloudflareAccessClient,
  ) {
    val origin = CloudflareAccessOrigin.from(url)

    // null is unclassified; false is a verified managed challenge.
    var ordinaryAdmission: Boolean? = null
    val url: String
      get() = buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath)
  }

  private class DiscoveryOperation(
    val registration: Registration,
    val snapshot: CloudflareAccessSessionStore.Snapshot,
    val task: Deferred<CloudflareAccessApplication?>,
  )

  private val lock = Any()
  private val registrations = mutableMapOf<String, Registration>()
  private val leases = mutableMapOf<String, Lease>()
  private val expiryJobs = mutableMapOf<CloudflareAccessOrigin, Job>()
  private val discoveries = mutableSetOf<DiscoveryOperation>()
  private val mutablePresentation = MutableStateFlow(GatewayAccessPresentation(browserRequired = requiredBrowserProfiles()))
  val presentation = mutablePresentation.asStateFlow()
  private val store =
    CloudflareAccessSessionStore(scope, persistence, now = now) { origin ->
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
    admissionCheckpoint: Long,
    isCurrent: () -> Boolean,
  ): GatewayIngressAuthorization? {
    kotlin.coroutines.coroutineContext.ensureActive()
    return prepareRegistered(register(endpoint, tls, isCurrent), admissionCheckpoint, isCurrent)
  }

  private suspend fun register(
    endpoint: GatewayEndpoint,
    tls: GatewayTlsParams,
    isCurrent: () -> Boolean,
  ): Registration {
    val context = kotlin.coroutines.coroutineContext
    val registration =
      synchronized(lock) {
        context.ensureActive()
        if (!isCurrent() || registry.entries.value.none { it.stableId == endpoint.stableId }) {
          throw CancellationException("Gateway request superseded")
        }
        val previous = registrations[endpoint.stableId]
        val current =
          previous?.takeIf { it.endpoint == endpoint && it.tls == tls }
            ?: Registration(endpoint, tls, clientForRoute(endpoint, tls))
        if (current !== previous) {
          leases.remove(endpoint.stableId)?.active?.set(false)
          registrations[endpoint.stableId] = current
          publishLocked()
        }
        current
      }
    retireDiscoveries { it.registration.endpoint.stableId == endpoint.stableId && it.registration !== registrations[endpoint.stableId] }
    checkRegistration(registration, isCurrent)
    return registration
  }

  private suspend fun prepareRegistered(
    registration: Registration,
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
          // A new identity retires pending admissions tied to the old route classification.
          val ordinary =
            registration.takeIf { it.ordinaryAdmission == true }
              ?: Registration(endpoint, registration.tls, registration.client).also { registrations[endpoint.stableId] = it }
          ordinary.ordinaryAdmission = true
          leases.remove(endpoint.stableId)?.active?.set(false)
          val pending = discoveries.filter { it.registration === registration }
          if (!isRegisteredLocked(ordinary) || ordinary.ordinaryAdmission != true) throw CancellationException("Gateway admission superseded")
          publishLocked(attention = mutablePresentation.value.attention.takeUnless { it?.stableId == endpoint.stableId })
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
    showRequired(registration, managedIsCurrent)
    throw GatewayExternalAuthorizationException()
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
      registrations[stableId]?.ordinaryAdmission != true &&
        (mutablePresentation.value.attention?.stableId == stableId || leases[stableId]?.active?.get() == false)
    }

  private fun requiredBrowserProfiles(): Set<String> =
    registry.entries.value
      .filter { it.accessOrigin != null && registrations[it.stableId]?.ordinaryAdmission != true }
      .map { it.stableId }
      .toSet()

  private fun publishLocked(attention: GatewayAccessAttention? = mutablePresentation.value.attention) {
    // One emission is the commit boundary for UI observers that can resume inline.
    mutablePresentation.value = GatewayAccessPresentation(attention, requiredBrowserProfiles())
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
    store.isCurrent(retirement) && registrations[stableId] === registration && registration?.ordinaryAdmission != true &&
      registry.entries.value.any { it.stableId == stableId && it.accessOrigin == retirement.origin.uri.toString() } &&
      attention?.let { it.stableId != stableId } != true

  private fun showRequired(
    registration: Registration,
    isCurrent: () -> Boolean,
  ) {
    synchronized(lock) {
      val presentation = mutablePresentation.value
      checkRegistrationLocked(registration, isCurrent)
      if (mutablePresentation.value === presentation) {
        publishLocked(attention = requiredAttention(registration))
      }
    }
  }

  private fun requiredAttention(registration: Registration) = GatewayAccessAttention(registration.endpoint.stableId, "Sign in to Cloudflare Access to connect to this gateway.")

  private fun attentionAfterAdmissionLocked(registration: Registration): GatewayAccessAttention? =
    mutablePresentation.value.attention.takeUnless { it?.stableId == registration.endpoint.stableId }

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
