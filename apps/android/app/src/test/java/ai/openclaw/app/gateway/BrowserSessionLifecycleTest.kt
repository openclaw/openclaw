package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebView
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class BrowserSessionLifecycleTest {
  @Test fun supersededAttemptCannotAcceptOrDeleteTheNewProfile() =
    runBlocking {
      val (prefs, backend) = fixture()
      val owner = ReverseProxyBrowserSessions(prefs, backend)
      val old = owner.begin(target)
      old.cookies.setCookie(target.toString(), "session=old")
      val stale = checkNotNull(owner.authorization(endpoint))
      stale.authorizeUpgrade(request)
      val fresh = owner.begin(target)
      fresh.cookies.setCookie(target.toString(), "session=fresh")
      assertFalse(stale.admitGatewayRole("operator") { true })
      val current = checkNotNull(owner.authorization(endpoint))
      current.authorizeUpgrade(request)
      assertTrue(current.admitGatewayRole("operator") { true })
      owner.cancel(old)
      assertTrue(owner.isAdmitted(fresh))
      assertTrue(fresh.profileName in backend.names())
      assertEquals(fresh.profileName, prefs.loadBrowserSessionProfiles()[target.browserSessionOrigin()])
    }

  @Test fun cookieChangeOrRetiredNativeAttemptCannotCommitLogin() =
    runBlocking {
      val (prefs, backend) = fixture()
      val owner = ReverseProxyBrowserSessions(prefs, backend)
      val attempt = owner.begin(target)
      attempt.cookies.setCookie(target.toString(), "session=first")
      val grant = checkNotNull(owner.authorization(endpoint))
      grant.authorizeUpgrade(request)
      attempt.cookies.setCookie(target.toString(), "session=second")
      assertFalse(grant.admitGatewayRole("operator") { true })
      assertFalse(owner.isAdmitted(attempt))
      val updated = checkNotNull(owner.authorization(endpoint))
      updated.authorizeUpgrade(request)
      assertFalse(updated.admitGatewayRole("operator") { false })
      assertEquals("", prefs.loadBrowserSessionProfiles()[target.browserSessionOrigin()])
    }

  @Test fun nodeGrantAndCookiesAreNotOperatorLoginButOperatorCommitIsIdempotent() =
    runBlocking {
      val (prefs, backend) = fixture()
      val owner = ReverseProxyBrowserSessions(prefs, backend)
      val attempt = owner.begin(target)
      attempt.cookies.setCookie(target.toString(), "session=synthetic")
      val grant = checkNotNull(owner.authorization(endpoint))
      grant.authorizeUpgrade(request)
      assertTrue(grant.admitGatewayRole("node") { true })
      assertFalse(owner.isAdmitted(attempt))
      assertFalse(attempt.admission.isCompleted)
      assertTrue(grant.admitGatewayRole("operator") { true })
      assertTrue(grant.admitGatewayRole("operator") { true })
      assertTrue(attempt.admission.await())
      assertEquals(1, backend.names().size)
      owner.cancel(attempt)
      assertTrue(owner.hasSession(target))
    }

  @Test fun acceptedEpochSurvivesOwnerRestartAndSignoutStaysFailClosed() =
    runBlocking {
      val (prefs, backend) = fixture()
      val first = ReverseProxyBrowserSessions(prefs, backend)
      val attempt = first.begin(target)
      attempt.cookies.setCookie(target.toString(), "session=synthetic")
      val original = checkNotNull(first.authorization(endpoint))
      original.authorizeUpgrade(request)
      assertTrue(original.admitGatewayRole("operator") { true })
      first.cancel(attempt)
      val reopened = ReverseProxyBrowserSessions(prefs, backend)
      val restored = checkNotNull(reopened.authorization(endpoint))
      assertEquals(original.deviceCredentialScope(endpoint.stableId), restored.deviceCredentialScope(endpoint.stableId))
      assertEquals("session=synthetic", restored.authorizeUpgrade(request).header("Cookie"))
      reopened.signOut(target)
      val afterSignout = ReverseProxyBrowserSessions(prefs, backend)
      assertFalse(afterSignout.hasSession(target))
      var denied = false
      try {
        checkNotNull(afterSignout.authorization(endpoint)).authorizeUpgrade(request)
      } catch (_: GatewayExternalAuthorizationException) {
        denied = true
      }
      assertTrue(denied)
    }

  @Test fun legacyAcceptedProfileKeepsRoleScopeAcrossCookieRotationAndRestart() {
    val (prefs, backend) = fixture()
    val name = "openclaw-proxy-legacy-accepted"
    checkNotNull(backend.cookies(name, true)).setCookie(target.toString(), "session=accepted")
    assertTrue(prefs.saveBrowserSessionProfile(target.browserSessionOrigin(), name))
    val owner = ReverseProxyBrowserSessions(prefs, backend)
    val grant = checkNotNull(owner.authorization(endpoint))
    val legacyScope = endpoint.stableId + ".browser." + name
    assertEquals(legacyScope, grant.deviceCredentialScope(endpoint.stableId))
    grant.receiveResponse(
      okhttp3.Response
        .Builder()
        .request(request)
        .protocol(okhttp3.Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .addHeader("Set-Cookie", "session=rotated; Secure")
        .build(),
    )
    val restored = ReverseProxyBrowserSessions(prefs, backend)
    val afterRestart = checkNotNull(restored.authorization(endpoint))
    assertEquals(legacyScope, afterRestart.deviceCredentialScope(endpoint.stableId))
    assertEquals("session=rotated", afterRestart.authorizeHttp(request).header("Cookie"))
    assertEquals(setOf(target.browserSessionOrigin()), restored.signedInOrigins.value)
  }

  @Test fun delayedUpgradeCannotRebindAnExistingEpochToNewCookies() =
    runBlocking {
      val (prefs, backend) = fixture()
      val owner = ReverseProxyBrowserSessions(prefs, backend)
      val login = owner.begin(target)
      login.cookies.setCookie(target.toString(), "session=account-a")
      val nodeA = checkNotNull(owner.authorization(endpoint))
      nodeA.authorizeUpgrade(request)
      assertTrue(nodeA.admitGatewayRole("node") { true })
      val delayedOperatorA = checkNotNull(owner.authorization(endpoint))
      login.cookies.setCookie(target.toString(), "session=account-b")
      val upgraded = runCatching { delayedOperatorA.authorizeUpgrade(request) }
      assertTrue("An authorization captured under A must refuse B before upgrade", upgraded.exceptionOrNull() is GatewayExternalAuthorizationException)
      val operatorB = checkNotNull(owner.authorization(endpoint))
      operatorB.authorizeUpgrade(request)
      assertTrue(operatorB.admitGatewayRole("operator") { true })
      assertFalse(nodeA.admitGatewayRole("node") { true })
      assertFalse(nodeA.deviceCredentialScope(endpoint.stableId) == operatorB.deviceCredentialScope(endpoint.stableId))
    }

  private fun fixture(): Pair<SecurePrefs, Profiles> {
    val context = RuntimeEnvironment.getApplication()
    return SecurePrefs(context, context.getSharedPreferences("browser-owner-${UUID.randomUUID()}", Context.MODE_PRIVATE)) to Profiles()
  }

  internal class Profiles : BrowserProfileAccess {
    private val profiles = mutableMapOf<String, CookieManager>()

    override fun supported(): Boolean = true

    override fun cookies(
      name: String,
      create: Boolean,
    ): CookieManager? = if (create) profiles.getOrPut(name) { Cookies() } else profiles[name]

    override fun names(): Collection<String> = profiles.keys.toList()

    override fun delete(name: String) {
      profiles.remove(name)
    }
  }

  // Android retains deprecated abstract cookie methods in the platform contract.
  @Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
  private class Cookies : CookieManager() {
    @Volatile private var cookie: String? = null

    override fun setAcceptCookie(accept: Boolean) {}

    override fun acceptCookie(): Boolean = true

    override fun setAcceptThirdPartyCookies(
      webview: WebView,
      accept: Boolean,
    ) {}

    override fun acceptThirdPartyCookies(webview: WebView): Boolean = false

    override fun setCookie(
      url: String,
      value: String,
    ) {
      cookie = value.substringBefore(';')
    }

    override fun setCookie(
      url: String,
      value: String,
      callback: ValueCallback<Boolean>?,
    ) {
      setCookie(url, value)
      callback?.onReceiveValue(true)
    }

    override fun getCookie(url: String): String? = cookie

    override fun removeSessionCookie() {
      cookie = null
    }

    override fun removeSessionCookies(callback: ValueCallback<Boolean>?) {
      cookie = null
      callback?.onReceiveValue(true)
    }

    override fun removeAllCookie() {
      cookie = null
    }

    override fun removeAllCookies(callback: ValueCallback<Boolean>?) {
      cookie = null
      callback?.onReceiveValue(true)
    }

    override fun hasCookies(): Boolean = cookie != null

    override fun removeExpiredCookie() {}

    override fun flush() {}
  }

  companion object {
    private val target = "https://gateway.example.test/".toHttpUrl()
    private val endpoint = GatewayEndpoint.manual(target.host, target.port, tlsEnabled = true)
    private val request = Request.Builder().url(target).build()
  }
}
