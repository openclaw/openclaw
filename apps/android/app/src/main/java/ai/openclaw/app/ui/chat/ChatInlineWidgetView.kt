package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatWidgetPreview
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.UUID

private const val INLINE_WIDGET_PROFILE_PREFIX = "openclaw-inline-widget-"

@Composable
internal fun ChatInlineWidget(
  preview: ChatWidgetPreview,
  resolverReady: Boolean,
  resolveUrl: suspend (String, String?) -> String?,
) {
  var resolvedUrl by remember(preview.path) { mutableStateOf<String?>(null) }
  var unavailable by remember(preview.path) { mutableStateOf(false) }
  var didRefresh by remember(preview.path) { mutableStateOf(false) }
  var refreshInFlight by remember(preview.path) { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val isolatedProfileSupported = remember { WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) }

  LaunchedEffect(preview.path, resolverReady) {
    if (!resolverReady) return@LaunchedEffect
    resolvedUrl = resolveUrl(preview.path, null)
    unavailable = resolvedUrl == null
    didRefresh = false
  }

  Column(modifier = Modifier.fillMaxWidth()) {
    preview.title?.trim()?.takeIf(String::isNotEmpty)?.let { title ->
      Text(
        text = title,
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        modifier = Modifier.padding(bottom = 6.dp),
      )
    }
    when {
      resolvedUrl != null && isolatedProfileSupported -> {
        val url = checkNotNull(resolvedUrl)
        val allowsScripts = preview.sandbox == "scripts"
        key(url, allowsScripts) {
          Surface(
            modifier = Modifier.fillMaxWidth().height(preview.height.dp),
            shape = RoundedCornerShape(10.dp),
            border = BorderStroke(1.dp, ClawTheme.colors.border),
            color = ClawTheme.colors.surface,
          ) {
            InlineWidgetWebView(
              url = url,
              allowsScripts = allowsScripts,
              onFailure = {
                if (!refreshInFlight) {
                  if (!didRefresh) {
                    didRefresh = true
                    refreshInFlight = true
                    scope.launch {
                      resolvedUrl = resolveUrl(preview.path, url)
                      unavailable = resolvedUrl == null
                      refreshInFlight = false
                    }
                  } else {
                    resolvedUrl = null
                    unavailable = true
                  }
                }
              },
            )
          }
        }
      }
      unavailable || resolvedUrl != null ->
        Text(
          text = nativeString("Widget unavailable"),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      else ->
        Box(modifier = Modifier.fillMaxWidth().height(44.dp), contentAlignment = Alignment.Center) {
          CircularProgressIndicator(color = ClawTheme.colors.textMuted)
        }
    }
  }
}

@SuppressLint("SetJavaScriptEnabled")
@Suppress("DEPRECATION")
@Composable
private fun InlineWidgetWebView(
  url: String,
  allowsScripts: Boolean,
  onFailure: () -> Unit,
) {
  val profileName = remember(url, allowsScripts) { "$INLINE_WIDGET_PROFILE_PREFIX${UUID.randomUUID()}" }
  AndroidView(
    modifier = Modifier.fillMaxWidth(),
    factory = { context ->
      pruneStaleInlineWidgetProfiles()
      val webView = WebView(context)
      if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
        WebViewCompat.setProfile(webView, profileName)
      } else {
        error("isolated WebView profiles are unavailable")
      }
      webView.apply {
        settings.setAllowContentAccess(false)
        settings.setAllowFileAccess(false)
        settings.setAllowFileAccessFromFileURLs(false)
        settings.setAllowUniversalAccessFromFileURLs(false)
        settings.setSafeBrowsingEnabled(true)
        settings.javaScriptEnabled = allowsScripts
        settings.domStorageEnabled = false
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        isHorizontalScrollBarEnabled = false
        webViewClient = InlineWidgetWebViewClient(expectedUrl = url, onFailure = onFailure)
        loadUrl(url)
      }
    },
    onRelease = { webView ->
      webView.stopLoading()
      webView.webViewClient = WebViewClient()
      webView.removeAllViews()
      webView.destroy()
      deleteInlineWidgetProfile(profileName)
    },
  )
}

private fun pruneStaleInlineWidgetProfiles() {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
  val store = ProfileStore.getInstance()
  store.allProfileNames
    .asSequence()
    .filter { it.startsWith(INLINE_WIDGET_PROFILE_PREFIX) }
    .forEach { profileName -> runCatching { store.deleteProfile(profileName) } }
}

private fun deleteInlineWidgetProfile(profileName: String) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
  val store = ProfileStore.getInstance()
  val deleted = runCatching { store.deleteProfile(profileName) }.getOrDefault(false)
  if (!deleted) {
    Handler(Looper.getMainLooper()).post {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
        runCatching { ProfileStore.getInstance().deleteProfile(profileName) }
      }
    }
  }
}

private class InlineWidgetWebViewClient(
  private val expectedUrl: String,
  private val onFailure: () -> Unit,
) : WebViewClient() {
  override fun onPageCommitVisible(
    view: WebView,
    url: String,
  ) {
    // Compose can retain the pre-navigation WebView layer until the first damage event.
    // Invalidate once committed so the initial widget frame paints without user input.
    view.postInvalidateOnAnimation()
  }

  override fun shouldOverrideUrlLoading(
    view: WebView,
    request: WebResourceRequest,
  ): Boolean =
    request.isForMainFrame &&
      (!request.method.equals("GET", ignoreCase = true) || !sameDocument(expectedUrl, request.url.toString()))

  override fun shouldInterceptRequest(
    view: WebView,
    request: WebResourceRequest,
  ): WebResourceResponse? {
    val scheme = request.url.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return null
    val allowed =
      request.isForMainFrame &&
        request.method.equals("GET", ignoreCase = true) &&
        sameDocument(expectedUrl, request.url.toString())
    return if (allowed) null else blockedWidgetResponse()
  }

  override fun onReceivedError(
    view: WebView,
    request: WebResourceRequest,
    error: WebResourceError,
  ) {
    if (request.isForMainFrame) onFailure()
  }

  override fun onReceivedHttpError(
    view: WebView,
    request: WebResourceRequest,
    errorResponse: WebResourceResponse,
  ) {
    if (request.isForMainFrame && errorResponse.statusCode >= 400) onFailure()
  }

  override fun onRenderProcessGone(
    view: WebView,
    detail: RenderProcessGoneDetail,
  ): Boolean {
    onFailure()
    return true
  }
}

private fun sameDocument(
  expected: String,
  candidate: String,
): Boolean {
  val expectedUri = runCatching { URI(expected) }.getOrNull() ?: return false
  val candidateUri = runCatching { URI(candidate) }.getOrNull() ?: return false
  return expectedUri.scheme == candidateUri.scheme &&
    expectedUri.rawAuthority == candidateUri.rawAuthority &&
    expectedUri.rawPath == candidateUri.rawPath &&
    expectedUri.rawQuery == candidateUri.rawQuery
}

private fun blockedWidgetResponse(): WebResourceResponse =
  WebResourceResponse(
    "text/plain",
    "UTF-8",
    403,
    "Blocked",
    mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream(ByteArray(0)),
  )
