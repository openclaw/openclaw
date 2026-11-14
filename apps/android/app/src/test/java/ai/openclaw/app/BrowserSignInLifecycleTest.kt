package ai.openclaw.app

import ai.openclaw.app.gateway.BrowserProfileAccess
import ai.openclaw.app.gateway.BrowserSessionLifecycleTest
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.ReverseProxyBrowserSessions
import ai.openclaw.app.gateway.browserSessionOrigin
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWebView
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

/** Real Activity and registered WebViewClient; only AndroidX profile-provider I/O is substituted. */
@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  instrumentedPackages = ["androidx.webkit"],
  shadows = [BrowserSignInFeatureShadow::class, BrowserSignInCompatShadow::class, BrowserSignInProfileStoreShadow::class, BrowserSignInWebViewShadow::class],
)
class BrowserSignInLifecycleTest {
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private var previousRuntime: NodeRuntime? = null
  private lateinit var owner: ReverseProxyBrowserSessions
  private lateinit var previousProfiles: BrowserProfileAccess
  private lateinit var profiles: BrowserSessionLifecycleTest.Profiles
  private var controller: ActivityController<BrowserSignInActivity>? = null
  private val target = "https://gateway.example.test/".toHttpUrl()

  @Before
  fun bindRuntimeAndProfiles() {
    BrowserSignInFeatureShadow.supported = true
    BrowserSignInCompatShadow.attached.clear()
    BrowserSignInProfileStoreShadow.calls = 0
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("browser-signin-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    owner = app.browserSessions
    previousProfiles = ReflectionHelpers.getField(owner, "profiles")
    profiles = BrowserSessionLifecycleTest.Profiles()
    ReflectionHelpers.setField(owner, "profiles", profiles)
  }

  @After
  fun closeOwnedLifecycle() {
    try {
      controller?.pause()?.stop()?.destroy()
      shadowOf(Looper.getMainLooper()).idle()
    } finally {
      try {
        if (::owner.isInitialized) {
          owner.signOut(target)
          ReflectionHelpers.setField(owner, "profiles", previousProfiles)
        }
      } finally {
        try {
          if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
        } finally {
          if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
          BrowserSignInFeatureShadow.supported = true
          BrowserSignInCompatShadow.attached.clear()
          BrowserSignInProfileStoreShadow.calls = 0
        }
      }
    }
  }

  @Test
  fun rendererLossRetiresOnlyItsAttemptAndRejectsLateBrowserCallbacks() {
    val login = launch()
    val activity = checkNotNull(controller).get()
    val view = checkNotNull(ReflectionHelpers.getField<WebView?>(activity, "webView"))
    val client = view.webViewClient
    val platform = Shadow.extract<BrowserSignInWebViewShadow>(view)
    assertEquals(login.profileName, BrowserSignInCompatShadow.attached[view])
    assertTrue(view.settings.javaScriptEnabled)
    assertFalse(view.settings.allowFileAccess)
    assertFalse(view.settings.allowContentAccess)
    assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, view.settings.mixedContentMode)

    assertTrue(client.onRenderProcessGone(view, CrashedSignInRenderer))

    assertNull(view.parent)
    assertNull(ReflectionHelpers.getField<WebView?>(activity, "webView"))
    assertEquals(1, platform.destroyCalls)
    assertFalse(owner.isCurrent(login))
    assertFalse(login.profileName in profiles.names())
    assertEquals("", app.prefs.loadBrowserSessionProfiles()[target.browserSessionOrigin()])
    val replacement = owner.begin(target)
    client.onPageStarted(view, "https://identity.example.test/login", null)
    client.onPageCommitVisible(view, target.toString())
    client.onPageFinished(view, target.toString())
    assertTrue(client.onRenderProcessGone(view, CrashedSignInRenderer))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(1, platform.destroyCalls)
    assertTrue(owner.isCurrent(replacement))
    assertTrue(replacement.profileName in profiles.names())
    assertFalse(owner.hasSession(target))
    assertFalse(replacement.admission.isCompleted)
    assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
    owner.cancel(replacement)
  }

  @Test
  fun rendererLossAfterVerifiedNativeAdmissionKeepsTheAcceptedSession() =
    runBlocking {
      val login = launch()
      val activity = checkNotNull(controller).get()
      val view = checkNotNull(ReflectionHelpers.getField<WebView?>(activity, "webView"))
      login.cookies.setCookie(target.toString(), "session=synthetic")
      val endpoint = GatewayEndpoint.manual(target.host, target.port, tlsEnabled = true)
      val grant = checkNotNull(owner.authorization(endpoint))
      grant.authorizeUpgrade(Request.Builder().url(target).build())
      assertTrue(grant.admitGatewayRole("operator") { true })

      assertTrue(view.webViewClient.onRenderProcessGone(view, CrashedSignInRenderer))

      assertTrue(owner.hasSession(target))
      assertTrue(login.profileName in profiles.names())
      assertEquals(login.profileName, app.prefs.loadBrowserSessionProfiles()[target.browserSessionOrigin()])
      assertEquals(Activity.RESULT_OK, shadowOf(activity).resultCode)
      assertNull(ReflectionHelpers.getField<WebView?>(activity, "webView"))
    }

  @Test
  fun validHttpsRedirectReturnsOnlyAfterNativeAdmission() =
    runBlocking {
      val login = launch()
      val activity = checkNotNull(controller).get()
      val view = checkNotNull(ReflectionHelpers.getField<WebView?>(activity, "webView"))
      val client = view.webViewClient
      assertFalse(client.shouldOverrideUrlLoading(view, request("https://identity.example.test/login")))
      assertTrue(client.shouldOverrideUrlLoading(view, request("http://identity.example.test/login")))
      client.onPageStarted(view, "https://identity.example.test/login", null)
      assertTrue(client.shouldOverrideUrlLoading(view, request(target.toString())))
      assertFalse(login.admission.isCompleted)
      assertFalse(owner.hasSession(target))
      assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
      login.cookies.setCookie(target.toString(), "session=synthetic")
      val endpoint = GatewayEndpoint.manual(target.host, target.port, tlsEnabled = true)
      val grant = checkNotNull(owner.authorization(endpoint))
      grant.authorizeUpgrade(Request.Builder().url(target).build())
      assertTrue(grant.admitGatewayRole("operator") { true })
      shadowOf(Looper.getMainLooper()).idle()
      assertTrue(activity.isFinishing)
      assertEquals(Activity.RESULT_OK, shadowOf(activity).resultCode)
    }

  @Test
  fun unsupportedWebViewCannotAttachOrNavigateAnUnisolatedBrowser() {
    val login = launch(supportedAtAttach = false)
    val activity = checkNotNull(controller).get()
    assertNull(ReflectionHelpers.getField<WebView?>(activity, "webView"))
    assertTrue(BrowserSignInCompatShadow.attached.isEmpty())
    assertFalse(owner.isCurrent(login))
    assertFalse(login.profileName in profiles.names())
    assertEquals(Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
  }

  @Test
  fun unsupportedPlatformProfileOperationsRefuseBeforeEnteringAndroidX() {
    BrowserSignInFeatureShadow.supported = false
    for (operation in listOf<() -> Any?>({ previousProfiles.cookies("synthetic", true) }, { previousProfiles.cookies("synthetic", false) }, { previousProfiles.names() }, { previousProfiles.delete("synthetic") })) {
      assertTrue(runCatching { operation() }.exceptionOrNull() is IllegalStateException)
    }
    assertEquals(0, BrowserSignInProfileStoreShadow.calls)
  }

  private fun request(url: String): WebResourceRequest =
    object : WebResourceRequest {
      override fun getUrl(): Uri = Uri.parse(url)

      override fun isForMainFrame(): Boolean = true

      override fun isRedirect(): Boolean = false

      override fun hasGesture(): Boolean = true

      override fun getMethod(): String = "GET"

      override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

  private fun launch(supportedAtAttach: Boolean = true): ReverseProxyBrowserSessions.Attempt {
    val login = owner.begin(target)
    BrowserSignInFeatureShadow.supported = supportedAtAttach
    controller =
      Robolectric.buildActivity(
        BrowserSignInActivity::class.java,
        Intent(app, BrowserSignInActivity::class.java).putExtra(BrowserSignInActivity.ATTEMPT_ID, login.profileName),
      )
    checkNotNull(controller).setup()
    return login
  }
}

@Implements(value = WebViewFeature::class, isInAndroidSdk = false)
class BrowserSignInFeatureShadow {
  companion object {
    var supported = true

    @JvmStatic
    @Implementation
    fun isFeatureSupported(feature: String): Boolean = supported && feature == WebViewFeature.MULTI_PROFILE
  }
}

@Implements(value = WebViewCompat::class, isInAndroidSdk = false)
class BrowserSignInCompatShadow {
  companion object {
    val attached = mutableMapOf<WebView, String>()

    @JvmStatic
    @Implementation
    fun setProfile(
      view: WebView,
      name: String,
    ) {
      attached[view] = name
    }
  }
}

@Implements(value = ProfileStore::class, isInAndroidSdk = false)
class BrowserSignInProfileStoreShadow {
  companion object {
    var calls = 0

    @JvmStatic
    @Implementation
    fun getInstance(): ProfileStore {
      calls += 1
      throw AssertionError("Unsupported profile operation reached AndroidX")
    }
  }
}

@Implements(WebView::class)
class BrowserSignInWebViewShadow : ShadowWebView() {
  var destroyCalls = 0

  @Implementation
  public override fun destroy() {
    destroyCalls += 1
    super.destroy()
  }
}

@Suppress("DEPRECATION") // The platform exposes renderer-loss details through this abstract callback.
private object CrashedSignInRenderer : RenderProcessGoneDetail() {
  override fun didCrash(): Boolean = true

  override fun rendererPriorityAtExit(): Int = WebView.RENDERER_PRIORITY_IMPORTANT
}
