package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

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

  private val lock = Any()
  private val registrations = mutableMapOf<String, Registration>()
  private val mutablePresentation = MutableStateFlow(GatewayAccessPresentation(browserRequired = requiredBrowserProfiles()))
  val presentation = mutablePresentation.asStateFlow()
  private val store = CloudflareAccessSessionStore(scope, persistence, retireTransports = retireTransports)

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
          registrations[endpoint.stableId] = current
          publishLocked()
        }
        current
      }
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

    // Existing service headers or WARP remain independent of browser authentication.
    // Only a verified Access challenge associates this profile with a managed origin.
    val preCommitOrdinary =
      synchronized(lock) {
        checkRegistrationLocked(registration, isCurrent)
        registration.ordinaryAdmission
      }
    val ordinaryChallenge = registration.client.discover(registration.url, customHeaders = customHeaders(endpoint.stableId))
    checkRegistration(registration, isCurrent)
    if (ordinaryChallenge == null) {
      val ordinary =
        synchronized(lock) {
          checkRegistrationLocked(registration, isCurrent)
          if (registration.ordinaryAdmission != preCommitOrdinary) {
            throw CancellationException("Gateway admission superseded")
          }
          val ordinary =
            registration.takeIf { it.ordinaryAdmission == true }
              ?: Registration(endpoint, registration.tls, registration.client).also { registrations[endpoint.stableId] = it }
          ordinary.ordinaryAdmission = true
          publishLocked(attention = mutablePresentation.value.attention.takeUnless { it?.stableId == endpoint.stableId })
          ordinary
        }
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

    associate(registration, managedIsCurrent)
    showRequired(registration, managedIsCurrent)
    throw GatewayExternalAuthorizationException()
  }

  fun authorization(endpoint: GatewayEndpoint): GatewayIngressAuthorization? =
    synchronized(lock) {
      if (registrations[endpoint.stableId]?.takeIf { it.endpoint == endpoint }?.ordinaryAdmission == true) return@synchronized null
      registry.entries.value
        .firstOrNull { it.stableId == endpoint.stableId }
        ?.accessOrigin
        ?.let { unavailable }
    }

  fun blocksAutomaticReconnect(stableId: String): Boolean =
    synchronized(lock) {
      registrations[stableId]?.ordinaryAdmission != true && mutablePresentation.value.attention?.stableId == stableId
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
