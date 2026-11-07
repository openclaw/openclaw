package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.os.Looper
import android.util.Log
import android.webkit.CookieManager
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import okhttp3.HttpUrl
import okhttp3.Request
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** App-owned browser profiles, separate from Control UI/Canvas and external browser cookies. */
internal class ReverseProxyBrowserSessions(
  private val prefs: SecurePrefs,
) {
  internal class Attempt internal constructor(
    val target: HttpUrl,
    val profileName: String,
    val cookies: CookieManager,
  )

  private class Session(
    val profileName: String,
    val cookies: CookieManager,
  ) {
    val live = AtomicBoolean(true)
  }

  private val sessions = ConcurrentHashMap<String, Session>()
  private val configuredOrigins = ConcurrentHashMap.newKeySet<String>()
  private val pendingProfiles = mutableSetOf<String>()

  init {
    checkMainThread()
    val saved = prefs.loadBrowserSessionProfiles()
    configuredOrigins.addAll(saved.keys)
    if (saved.values.any { it.isNotEmpty() } && isSupported()) {
      val store = ProfileStore.getInstance()
      for ((origin, profileName) in saved) {
        if (profileName.isNotEmpty()) {
          store.getProfile(profileName)?.let { sessions[origin] = Session(profileName, it.cookieManager) }
        }
      }
      removeAbandonedProfiles()
    }
  }

  fun isSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)

  fun hasSession(target: HttpUrl): Boolean = sessions.containsKey(target.browserSessionOrigin())

  fun begin(target: HttpUrl): Attempt {
    checkMainThread()
    require(target.scheme == "https" && target.username.isEmpty() && target.password.isEmpty())
    check(isSupported()) { "Update Android System WebView to use browser sign-in." }
    removeAbandonedProfiles()
    val name = "openclaw-proxy-" + UUID.randomUUID().toString()
    pendingProfiles.add(name)
    return Attempt(target, name, ProfileStore.getInstance().getOrCreateProfile(name).cookieManager)
  }

  fun revoke(target: HttpUrl) {
    sessions[target.browserSessionOrigin()]?.live?.set(false)
  }

  /** Caller destroys the login WebView and retires/drains native connections before replacement. */
  fun accept(attempt: Attempt) {
    checkMainThread()
    check(!attempt.cookies.getCookie(attempt.target.toString()).isNullOrBlank()) {
      "Finish signing in to the gateway before continuing."
    }
    val origin = attempt.target.browserSessionOrigin()
    attempt.cookies.flush()
    check(prefs.saveBrowserSessionProfile(origin, attempt.profileName)) { "Could not save the browser session securely." }
    pendingProfiles.remove(attempt.profileName)
    val previous = sessions.put(origin, Session(attempt.profileName, attempt.cookies))
    configuredOrigins.add(origin)
    previous?.let(::retire)
  }

  fun cancel(attempt: Attempt) {
    checkMainThread()
    pendingProfiles.remove(attempt.profileName)
    deleteProfile(attempt.profileName)
  }

  /** Local signout only: no assumed provider logout endpoint or server-side session revocation. */
  fun signOut(target: HttpUrl) {
    checkMainThread()
    val origin = target.browserSessionOrigin()
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
    val session = sessions[origin]
    return BrowserSessionAuthorization(
      origin = url,
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
    ProfileStore
      .getInstance()
      .allProfileNames
      .filter { it.startsWith("openclaw-proxy-") && it !in retained }
      .forEach(::deleteProfile)
  }

  private fun deleteProfile(name: String) {
    // References and native authority are already retired. Retry any browser-store cleanup
    // failure on the next process startup/sign-in; never reuse another account's profile.
    runCatching { ProfileStore.getInstance().deleteProfile(name) }
      .onFailure { Log.w("ReverseProxyBrowser", "Browser profile cleanup failed; it will be retried.", it) }
  }

  private fun checkMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper())
  }
}
