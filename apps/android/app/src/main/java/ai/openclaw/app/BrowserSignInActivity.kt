package ai.openclaw.app

import ai.openclaw.app.gateway.ReverseProxyBrowserSessions
import ai.openclaw.app.gateway.browserSessionOrigin
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.OpenClawTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Bundle
import android.view.WindowManager
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Button
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.webkit.WebViewCompat
import kotlinx.coroutines.CancellationException
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
  private var pageFailed by mutableStateOf(false)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    applyBrowserSignInWindowProtection(
      window,
      debuggable = BuildConfig.DEBUG && (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0,
      recordingOptIn = BuildConfig.BROWSER_SIGN_IN_RECORDING,
    )
    val target = intent.getStringExtra(TARGET_URL)?.toHttpUrlOrNull()
    if (target == null || target.scheme != "https" || target.username.isNotEmpty() || target.password.isNotEmpty() || target.fragment != null) {
      finish()
      return
    }
    if (!app.browserSessions.isSupported()) {
      error = "Update Android System WebView to use browser sign-in."
    } else {
      val login = app.browserSessions.begin(target)
      attempt = login
      currentUrl = target.toString()
      webView = createBrowser(login)
    }
    setContent {
      OpenClawTheme {
        BrowserSignInScreen(
          currentUrl = currentUrl,
          error = error,
          browser = webView,
          busy = busy,
          canContinue = !busy && !loading && !pageFailed,
          showSignOut = app.browserSessions.hasSession(target),
          onCancel = { finish() },
          onContinue = { complete(target) },
          onSignOut = { signOut(target) },
        )
      }
    }
  }

  private fun createBrowser(login: ReverseProxyBrowserSessions.Attempt): WebView =
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
          ): Boolean = request.url.scheme != "https"

          override fun onPageStarted(
            view: WebView,
            url: String,
            favicon: Bitmap?,
          ) {
            currentUrl = url
            loading = true
            pageFailed = false
            error = null
          }

          override fun onPageFinished(
            view: WebView,
            url: String,
          ) {
            currentUrl = url
            loading = false
          }

          override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            failure: WebResourceError,
          ) {
            if (request.isForMainFrame) {
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
            pageFailed = true
            error = "The sign-in site has an invalid TLS certificate. Contact your gateway administrator."
          }

          override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            response: WebResourceResponse,
          ) {
            if (request.isForMainFrame && response.statusCode >= 500) {
              pageFailed = true
              error = "The sign-in service is unavailable. Try again."
            }
          }
        }
      loadUrl(login.target.toString())
    }

  private fun returnedTo(target: HttpUrl): Boolean = currentUrl.toHttpUrlOrNull()?.let { it.scheme == "https" && it.browserSessionOrigin() == target.browserSessionOrigin() } == true

  private fun complete(target: HttpUrl) {
    val login = attempt ?: return
    if (loading || pageFailed || !returnedTo(target) || login.cookies.getCookie(target.toString()).isNullOrBlank()) {
      error = "Finish signing in to the gateway before continuing."
      return
    }
    busy = true
    destroyBrowser()
    app.browserSessions.revoke(target)
    lifecycleScope.launch {
      try {
        app.ensureRuntime().retireBrowserConnections(target.host, target.port)
        app.browserSessions.accept(login)
        accepted = true
        setResult(Activity.RESULT_OK, Intent().putExtra(TARGET_URL, target.toString()))
        finish()
      } catch (failure: CancellationException) {
        throw failure
      } catch (failure: Exception) {
        error = failure.message ?: "Could not finish browser sign-in. Try again."
        busy = false
      }
    }
  }

  private fun signOut(target: HttpUrl) {
    busy = true
    destroyBrowser()
    app.browserSessions.revoke(target)
    lifecycleScope.launch {
      try {
        app.ensureRuntime().retireBrowserConnections(target.host, target.port)
        app.browserSessions.signOut(target)
        finish()
      } catch (failure: CancellationException) {
        throw failure
      } catch (failure: Exception) {
        error = failure.message ?: "Could not sign out. Try again."
        busy = false
      }
    }
  }

  private fun destroyBrowser() {
    webView?.apply {
      stopLoading()
      (parent as? android.view.ViewGroup)?.removeView(this)
      destroy()
    }
    webView = null
  }

  override fun onDestroy() {
    destroyBrowser()
    if (!accepted) attempt?.let(app.browserSessions::cancel)
    super.onDestroy()
  }

  companion object {
    internal const val TARGET_URL = "ai.openclaw.app.BROWSER_SIGN_IN_TARGET"
  }
}
