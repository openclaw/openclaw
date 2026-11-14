package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl
import okhttp3.Request
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Platform profile operations; authentication and attempt state remain owned below. */
internal interface BrowserProfileAccess {
  fun supported(): Boolean

  fun cookies(
    name: String,
    create: Boolean,
  ): CookieManager?

  fun names(): Collection<String>

  fun delete(name: String)
}

private object AndroidBrowserProfileAccess : BrowserProfileAccess {
  override fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

  override fun cookies(
    name: String,
    create: Boolean,
  ): CookieManager? =
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      val store = ProfileStore.getInstance()
      (if (create) store.getOrCreateProfile(name) else store.getProfile(name))?.cookieManager
    } else {
      error("Update Android System WebView to use browser sign-in.")
    }

  override fun names(): Collection<String> =
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      ProfileStore.getInstance().allProfileNames
    } else {
      error("Update Android System WebView to use browser sign-in.")
    }

  override fun delete(name: String) {
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      ProfileStore.getInstance().deleteProfile(name)
    } else {
      error("Update Android System WebView to use browser sign-in.")
    }
  }
}

/** App-owned browser profiles, separate from Control UI/Canvas and external browser cookies. */
internal class ReverseProxyBrowserSessions(
  private val prefs: SecurePrefs,
  private val profiles: BrowserProfileAccess = AndroidBrowserProfileAccess,
) {
  internal class Attempt internal constructor(
    val target: HttpUrl,
    val profileName: String,
    val cookies: CookieManager,
  ) {
    val admission = CompletableDeferred<Boolean>()

    @Volatile internal var credentialEpoch: CookieEpoch? = null

    internal fun epochFor(cookie: String?): CookieEpoch =
      synchronized(this) {
        credentialEpoch?.takeIf { it.cookie == cookie } ?: CookieEpoch(cookie).also { credentialEpoch = it }
      }
  }

  internal class CookieEpoch(
    val cookie: String?,
  ) {
    val id: String = UUID.randomUUID().toString()
    val responseCookies = mutableListOf<Pair<HttpUrl, List<String>>>()
  }

  private class Session(
    val profileName: String,
    val cookies: CookieManager,
    val credentialEpoch: String,
  ) {
    val live = AtomicBoolean(true)
  }

  private val sessions = ConcurrentHashMap<String, Session>()
  private val _signedInOrigins = MutableStateFlow<Set<String>>(emptySet())
  val signedInOrigins = _signedInOrigins.asStateFlow()

  private fun publishSessions() {
    // A revoked session remains removable when connection draining or durable cleanup fails.
    _signedInOrigins.value = sessions.keys.toSet()
  }

  private val configuredOrigins = ConcurrentHashMap.newKeySet<String>()
  private val pendingProfiles = mutableSetOf<String>()
  private val attempts = ConcurrentHashMap<String, Attempt>()
  private val pendingByOrigin = ConcurrentHashMap<String, Attempt>()

  init {
    checkMainThread()
    val saved = prefs.loadBrowserSessionProfiles()
    configuredOrigins.addAll(saved.keys)
    if (saved.values.any { it.isNotEmpty() } && isSupported()) {
      val store = profiles
      for ((origin, profileName) in saved) {
        if (profileName.isNotEmpty()) {
          store.cookies(profileName, false)?.let { sessions[origin] = Session(profileName, it, prefs.loadBrowserCredentialEpoch(profileName)) }
        }
      }
      removeAbandonedProfiles()
    }
    publishSessions()
  }

  fun isSupported(): Boolean = profiles.supported()

  fun hasSession(target: HttpUrl): Boolean = sessions.containsKey(target.browserSessionOrigin())

  fun begin(target: HttpUrl): Attempt {
    checkMainThread()
    require(target.scheme == "https" && target.username.isEmpty() && target.password.isEmpty())
    check(isSupported()) { "Update Android System WebView to use browser sign-in." }
    val origin = target.browserSessionOrigin()
    pendingByOrigin[origin]?.let(::cancel)
    // Mark this origin as browser-authenticated before starting native work. Cancel/restart
    // must not fall back to another browser principal or a legacy device-token slot.
    check(prefs.saveBrowserSessionProfile(origin, "")) { "Could not start browser sign-in securely." }
    sessions.remove(origin)?.let(::retire)
    publishSessions()
    configuredOrigins.add(origin)
    removeAbandonedProfiles()
    val name = "openclaw-proxy-" + UUID.randomUUID().toString()
    val attempt = Attempt(target, name, checkNotNull(profiles.cookies(name, true)))
    pendingProfiles.add(name)
    attempts[name] = attempt
    pendingByOrigin[origin] = attempt
    return attempt
  }

  fun attempt(id: String?): Attempt? = id?.let(attempts::get)

  fun isAdmitted(attempt: Attempt): Boolean = sessions[attempt.target.browserSessionOrigin()]?.let { it.profileName == attempt.profileName && it.live.get() } == true

  fun isCurrent(attempt: Attempt): Boolean =
    pendingByOrigin[attempt.target.browserSessionOrigin()] === attempt ||
      sessions[attempt.target.browserSessionOrigin()]?.let { it.profileName == attempt.profileName && it.live.get() } == true

  fun revoke(target: HttpUrl) {
    sessions[target.browserSessionOrigin()]?.live?.set(false)
    publishSessions()
  }

  /** Caller destroys the login WebView and retires/drains native connections before replacement. */
  private fun acceptVerified(
    attempt: Attempt,
    epoch: CookieEpoch,
    proofIsCurrent: () -> Boolean,
  ): Boolean {
    checkMainThread()
    val origin = attempt.target.browserSessionOrigin()
    if (sessions[origin]?.let { it.profileName == attempt.profileName && it.credentialEpoch == epoch.id && it.live.get() } == true) return true
    if (pendingByOrigin[origin] !== attempt || attempt.credentialEpoch !== epoch || !proofIsCurrent()) return false
    attempt.cookies.flush()
    check(prefs.saveBrowserSessionProfile(origin, attempt.profileName, epoch.id)) { "Could not save the browser session securely." }
    pendingProfiles.remove(attempt.profileName)
    pendingByOrigin.remove(origin, attempt)
    sessions.put(origin, Session(attempt.profileName, attempt.cookies, epoch.id))?.let(::retire)
    synchronized(epoch.responseCookies) {
      for ((url, headers) in epoch.responseCookies) for (header in headers) attempt.cookies.setCookie(url.toString(), header)
      epoch.responseCookies.clear()
      attempt.cookies.flush()
    }
    publishSessions()
    attempt.admission.complete(true)
    return true
  }

  fun cancel(attempt: Attempt) {
    checkMainThread()
    attempts.remove(attempt.profileName, attempt)
    pendingByOrigin.remove(attempt.target.browserSessionOrigin(), attempt)
    pendingProfiles.remove(attempt.profileName)
    if (!attempt.admission.isCompleted) {
      attempt.admission.complete(false)
      deleteProfile(attempt.profileName)
    }
  }

  /** Local signout only: no assumed provider logout endpoint or server-side session revocation. */
  fun signOut(target: HttpUrl) {
    checkMainThread()
    val origin = target.browserSessionOrigin()
    pendingByOrigin[origin]?.let(::cancel)
    // Retain the browser-auth mode without a grant: reconnect must not silently fall
    // back to a saved Gateway/device credential after explicit signout or restart.
    check(prefs.saveBrowserSessionProfile(origin, "")) { "Could not remove the saved browser session. Try again." }
    sessions.remove(origin)?.let { retire(it) }
    publishSessions()
    configuredOrigins.add(origin)
  }

  fun authorization(endpoint: GatewayEndpoint): GatewayIngressAuthorization? {
    val url =
      Request
        .Builder()
        .url(buildGatewayWebSocketUrl(endpoint.host, endpoint.port, true, endpoint.contextPath))
        .build()
        .url
    val origin = url.browserSessionOrigin()
    if (!configuredOrigins.contains(origin)) return null
    pendingByOrigin[origin]?.let { attempt ->
      val epoch = attempt.epochFor(attempt.cookies.getCookie(url.toString()))
      return PendingBrowserAuthorization(
        target = url,
        profileName = attempt.profileName,
        credentialEpoch = epoch.id,
        expectedCookie = epoch.cookie,
        current = { isCurrent(attempt) && attempt.credentialEpoch === epoch },
        accepted = { sessions[origin]?.let { it.profileName == attempt.profileName && it.credentialEpoch == epoch.id && it.live.get() } == true },
        cookieHeader = { requestUrl -> attempt.cookies.getCookie(requestUrl.toString()) },
        receiveCookies = { requestUrl, headers ->
          if (sessions[origin]?.let { it.profileName == attempt.profileName && it.credentialEpoch == epoch.id } == true) {
            for (header in headers) attempt.cookies.setCookie(requestUrl.toString(), header)
            if (headers.isNotEmpty()) attempt.cookies.flush()
          } else {
            synchronized(epoch.responseCookies) { epoch.responseCookies.add(requestUrl to headers) }
          }
        },
        acceptOperator = { current -> withContext(Dispatchers.Main.immediate) { acceptVerified(attempt, epoch, current) } },
      )
    }
    val session = sessions[origin]
    return BrowserSessionAuthorization(
      origin = url,
      credentialEpoch = session?.let { if (it.credentialEpoch == it.profileName) it.profileName else it.profileName + "." + it.credentialEpoch },
      cookies = { requestUrl -> session?.cookies?.getCookie(requestUrl.toString()) },
      isCurrent = { session != null && session.live.get() && sessions[origin] === session },
      receiveCookies = { requestUrl, headers ->
        // A retired profile is never reused. Late browser-store work cannot populate a new account.
        for (header in headers) session?.cookies?.setCookie(requestUrl.toString(), header)
        if (headers.isNotEmpty()) session?.cookies?.flush()
      },
    )
  }

  private fun retire(session: Session) {
    session.live.set(false)
    deleteProfile(session.profileName)
  }

  private fun removeAbandonedProfiles() {
    val retained = sessions.values.map { it.profileName }.toSet() + pendingProfiles
    profiles
      .names()
      .filter { it.startsWith("openclaw-proxy-") && it !in retained }
      .forEach(::deleteProfile)
  }

  private fun deleteProfile(name: String) {
    // References and native authority are already retired. Retry any browser-store cleanup
    // failure on the next process startup/sign-in; never reuse another account's profile.
    runCatching { profiles.delete(name) }
      .onFailure { Log.w("ReverseProxyBrowser", "Browser profile cleanup failed; it will be retried.", it) }
  }

  private fun checkMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper())
  }
}
