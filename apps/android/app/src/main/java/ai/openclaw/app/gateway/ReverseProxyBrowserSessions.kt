package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
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
  fun cookies(name: String, create: Boolean): CookieManager?
  fun names(): Collection<String>
  fun delete(name: String)
}

private object AndroidBrowserProfileAccess : BrowserProfileAccess {
  override fun supported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
  override fun cookies(name: String, create: Boolean): CookieManager? =
    if (create) ProfileStore.getInstance().getOrCreateProfile(name).cookieManager else ProfileStore.getInstance().getProfile(name)?.cookieManager
  override fun names(): Collection<String> = ProfileStore.getInstance().allProfileNames
  override fun delete(name: String) { ProfileStore.getInstance().deleteProfile(name) }
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
    internal val responseCookies = mutableListOf<Pair<HttpUrl, List<String>>>()
  }

  private class Session(
    val profileName: String,
    val cookies: CookieManager,
  ) {
    val live = AtomicBoolean(true)
  }

  private val sessions = ConcurrentHashMap<String, Session>()
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
          store.cookies(profileName, false)?.let { sessions[origin] = Session(profileName, it) }
        }
      }
      removeAbandonedProfiles()
    }
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
  }

  /** Caller destroys the login WebView and retires/drains native connections before replacement. */
  private fun acceptVerified(
    attempt: Attempt,
    proofIsCurrent: () -> Boolean,
  ): Boolean {
    checkMainThread()
    val origin = attempt.target.browserSessionOrigin()
    if (sessions[origin]?.let { it.profileName == attempt.profileName && it.live.get() } == true) return true
    if (pendingByOrigin[origin] !== attempt || !proofIsCurrent()) return false
    attempt.cookies.flush()
    check(prefs.saveBrowserSessionProfile(origin, attempt.profileName)) { "Could not save the browser session securely." }
    pendingProfiles.remove(attempt.profileName)
    pendingByOrigin.remove(origin, attempt)
    sessions.put(origin, Session(attempt.profileName, attempt.cookies))?.let(::retire)
    synchronized(attempt.responseCookies) {
      for ((url, headers) in attempt.responseCookies) for (header in headers) attempt.cookies.setCookie(url.toString(), header)
      attempt.responseCookies.clear()
      attempt.cookies.flush()
    }
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
      return PendingBrowserAuthorization(
        target = url,
        profileName = attempt.profileName,
        current = { isCurrent(attempt) },
        accepted = { sessions[origin]?.let { it.profileName == attempt.profileName && it.live.get() } == true },
        cookieHeader = { requestUrl -> attempt.cookies.getCookie(requestUrl.toString()) },
        receiveCookies = { requestUrl, headers ->
          if (sessions[origin]?.profileName == attempt.profileName) {
            for (header in headers) attempt.cookies.setCookie(requestUrl.toString(), header)
            if (headers.isNotEmpty()) attempt.cookies.flush()
          } else {
            synchronized(attempt.responseCookies) { attempt.responseCookies.add(requestUrl to headers) }
          }
        },
        acceptOperator = { current -> withContext(Dispatchers.Main.immediate) { acceptVerified(attempt, current) } },
      )
    }
    val session = sessions[origin]
    return BrowserSessionAuthorization(
      origin = url,
      credentialEpoch = session?.profileName,
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
    profiles.names()
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
