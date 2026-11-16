package ai.openclaw.app

import ai.openclaw.app.gateway.ReverseProxyBrowserSessions
import ai.openclaw.app.gateway.isBrowserGatewayReturn
import ai.openclaw.app.ui.OpenClawTheme
import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Bundle
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Credentials are entered only in this isolated browser; no JavaScript/native message bridge. */
class BrowserSignInActivity : ComponentActivity() {
  private val app get() = application as NodeApp
  private var attempt: ReverseProxyBrowserSessions.Attempt? = null
  private var webView: WebView? = null
  private var accepted = false
  private var currentUrl by mutableStateOf("")
  private var error by mutableStateOf<String?>(null)
  private var busy by mutableStateOf(false)
  private var loading by mutableStateOf(true)
  private var visitedAuthenticationRoute = false
  private var admissionWait: kotlinx.coroutines.Job? = null
  private var pageFailed by mutableStateOf(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    applyBrowserSignInWindowProtection(
      window,
      debuggable = BuildConfig.DEBUG && (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
      recordingOptIn = BuildConfig.BROWSER_SIGN_IN_RECORDING,
    )
    val login = app.browserSessions.attempt(intent.getStringExtra(ATTEMPT_ID))
    if (login == null || !app.browserSessions.isCurrent(login)) {
      finish()
      return
    }
    val target = login.target
    attempt = login
    visitedAuthenticationRoute = savedInstanceState?.getBoolean("visitedAuthenticationRoute") ?: false
    currentUrl = target.toString()
    if (app.browserSessions.isAdmitted(login)) {
      accepted = true
      setResult(Activity.RESULT_OK)
      finish()
      return
    }
    webView = createBrowser(login)
    lifecycleScope.launch {
      if (login.admission.await() && attempt === login && app.browserSessions.isCurrent(login)) {
        accepted = true
        setResult(Activity.RESULT_OK)
        finish()
      }
    }
    setContent {
      OpenClawTheme {
        BrowserSignInScreen(
          currentUrl = currentUrl,
          error = error,
          browser = webView,
          busy = busy,
          canContinue = !busy && !loading && !pageFailed,
          onCancel = { finish() },
          onContinue = { complete(target) },
        )
      }
    }
  }

  // HTTPS provider login requires JavaScript; this profile has no native bridge or local-file access.
  @SuppressLint("SetJavaScriptEnabled")
  private fun createBrowser(login: ReverseProxyBrowserSessions.Attempt): WebView? =
    if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      WebView(this).apply {
        WebViewCompat.setProfile(this, login.profileName)
        login.cookies.setAcceptCookie(true)
        login.cookies.setAcceptThirdPartyCookies(this, false)
        settings.apply {
          javaScriptEnabled = true // Authelia and other forward-auth login pages require JavaScript.
          domStorageEnabled = true
          allowFileAccess = false
          allowContentAccess = false
          mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
          safeBrowsingEnabled = true
          setSupportMultipleWindows(false)
        }
        // There is deliberately no WebChromeClient permission grant, download listener, or JS interface.
        webViewClient =
          object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
              view: WebView,
              request: WebResourceRequest,
            ): Boolean {
              if (!isCurrentBrowser(view, login)) return true
              val url = request.url.toString().toHttpUrlOrNull()
              if (url == null || url.scheme != "https" || url.username.isNotEmpty() || url.password.isNotEmpty()) return true
              if (request.isForMainFrame && isBrowserGatewayReturn(login.target, url.toString()) && visitedAuthenticationRoute) {
                // Never boot a second Control UI device identity in the returned Gateway SPA.
                loading = false
                view.stopLoading()
                complete(login.target)
                return true
              }
              return false
            }

            override fun onPageStarted(
              view: WebView,
              url: String,
              favicon: Bitmap?,
            ) {
              if (!isCurrentBrowser(view, login)) return
              if (!isBrowserGatewayReturn(login.target, url)) visitedAuthenticationRoute = true
              loading = true
              pageFailed = false
              error = null
            }

            override fun onPageCommitVisible(
              view: WebView,
              url: String,
            ) {
              if (!isCurrentBrowser(view, login)) return
              currentUrl = url
            }

            override fun onPageFinished(
              view: WebView,
              url: String,
            ) {
              if (!isCurrentBrowser(view, login)) return
              currentUrl = url
              loading = false
              if (isBrowserGatewayReturn(login.target, url)) complete(login.target)
            }

            override fun onReceivedError(
              view: WebView,
              request: WebResourceRequest,
              failure: WebResourceError,
            ) {
              if (isCurrentBrowser(view, login) && request.isForMainFrame) {
                pageFailed = true
                error = "Could not load the sign-in page. Check your connection and try again."
              }
            }

            override fun onReceivedSslError(
              view: WebView,
              handler: SslErrorHandler,
              sslError: SslError,
            ) {
              handler.cancel()
              if (!isCurrentBrowser(view, login)) return
              pageFailed = true
              error = "The sign-in site has an invalid TLS certificate. Contact your gateway administrator."
            }

            override fun onReceivedHttpError(
              view: WebView,
              request: WebResourceRequest,
              response: WebResourceResponse,
            ) {
              if (isCurrentBrowser(view, login) && request.isForMainFrame && response.statusCode >= 500) {
                pageFailed = true
                error = "The sign-in service is unavailable. Try again."
              }
            }

            override fun onRenderProcessGone(
              view: WebView,
              detail: RenderProcessGoneDetail,
            ): Boolean {
              if (webView !== view) return true
              admissionWait?.cancel()
              admissionWait = null
              busy = false
              loading = false
              pageFailed = true
              destroyBrowser(rendererGone = true)
              if (retireAttempt()) {
                // Only the already-recorded native admission can turn renderer loss into success.
                accepted = true
                setResult(Activity.RESULT_OK)
                finish()
              } else {
                error = "The sign-in browser stopped. Close sign-in and try again."
              }
              return true
            }
          }
        loadUrl(login.target.toString())
      }
    } else {
      retireAttempt()
      loading = false
      pageFailed = true
      error = "Update Android System WebView to use browser sign-in."
      null
    }

  private fun isCurrentBrowser(
    view: WebView,
    login: ReverseProxyBrowserSessions.Attempt,
  ): Boolean = webView === view && attempt === login && app.browserSessions.isCurrent(login)

  private fun complete(target: HttpUrl) {
    val login = attempt ?: return
    if (accepted || pageFailed || webView == null || admissionWait?.isActive == true || !app.browserSessions.isCurrent(login)) return
    // Navigation only requests a retry. Native connect admission is the only completion proof.
    app.ensureRuntime().resumeBrowserConnection(target) { app.browserSessions.isCurrent(login) }
    admissionWait =
      lifecycleScope.launch {
        busy = true
        val result = kotlinx.coroutines.withTimeoutOrNull(20_000) { login.admission.await() }
        if (result != true) {
          error = "The native Gateway has not verified this sign-in. Finish signing in or retry."
          busy = false
        }
      }
  }

  private fun destroyBrowser(rendererGone: Boolean = false) {
    val browser = webView ?: return
    webView = null
    // A dead renderer cannot service stopLoading; detach and destroy only this owned instance.
    if (!rendererGone) browser.stopLoading()
    (browser.parent as? android.view.ViewGroup)?.removeView(browser)
    browser.destroy()
  }

  private fun retireAttempt(): Boolean {
    val login = attempt ?: return false
    attempt = null
    val wasAdmitted = app.browserSessions.isAdmitted(login)
    app.browserSessions.cancel(login)
    if (!wasAdmitted) app.ensureRuntime().cancelBrowserCredentialEpoch(login.profileName)
    return wasAdmitted
  }

  override fun onSaveInstanceState(outState: Bundle) {
    outState.putBoolean("visitedAuthenticationRoute", visitedAuthenticationRoute)
    super.onSaveInstanceState(outState)
  }

  override fun onDestroy() {
    destroyBrowser()
    if (!isChangingConfigurations) retireAttempt()
    super.onDestroy()
  }

  companion object {
    internal const val ATTEMPT_ID = "ai.openclaw.app.BROWSER_SIGN_IN_ATTEMPT"
  }
}
