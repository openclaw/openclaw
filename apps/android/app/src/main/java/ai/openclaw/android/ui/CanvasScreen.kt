package ai.openclaw.android.ui

import android.annotation.SuppressLint
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import ai.openclaw.android.MainViewModel
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayInputStream
import android.net.Uri

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun CanvasScreen(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  val isDebuggable = (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
  val webViewRef = remember { mutableStateOf<WebView?>(null) }

  DisposableEffect(viewModel) {
    onDispose {
      val webView = webViewRef.value ?: return@onDispose
      viewModel.canvas.detach(webView)
      webView.removeJavascriptInterface(CanvasA2UIActionBridge.interfaceName)
      webView.stopLoading()
      webView.destroy()
      webViewRef.value = null
    }
  }

  AndroidView(
    modifier = modifier,
    factory = {
      WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        settings.useWideViewPort = false
        settings.loadWithOverviewMode = false
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.setSupportZoom(false)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
          WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
        } else {
          disableForceDarkIfSupported(settings)
        }
        if (isDebuggable) {
          Log.d("OpenClawWebView", "userAgent: ${settings.userAgentString}")
        }
        isScrollContainer = true
        overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        isVerticalScrollBarEnabled = true
        isHorizontalScrollBarEnabled = true
        webViewClient =
          object : WebViewClient() {
            override fun onReceivedError(
              view: WebView,
              request: WebResourceRequest,
              error: WebResourceError,
            ) {
              if (!isDebuggable || !request.isForMainFrame) return
              Log.e("OpenClawWebView", "onReceivedError: ${error.errorCode} ${error.description} ${request.url}")
            }

            override fun onReceivedHttpError(
              view: WebView,
              request: WebResourceRequest,
              errorResponse: WebResourceResponse,
            ) {
              if (!isDebuggable || !request.isForMainFrame) return
              Log.e(
                "OpenClawWebView",
                "onReceivedHttpError: ${errorResponse.statusCode} ${errorResponse.reasonPhrase} ${request.url}",
              )
            }

            override fun onPageFinished(view: WebView, url: String?) {
              if (isDebuggable) {
                Log.d("OpenClawWebView", "onPageFinished: $url")
              }
              viewModel.canvas.onPageFinished()
            }

            override fun onRenderProcessGone(
              view: WebView,
              detail: android.webkit.RenderProcessGoneDetail,
            ): Boolean {
              if (isDebuggable) {
                Log.e(
                  "OpenClawWebView",
                  "onRenderProcessGone didCrash=${detail.didCrash()} priorityAtExit=${detail.rendererPriorityAtExit()}",
                )
              }
              return true
            }

            override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
              if (request == null) return null
              val url = request.url?.toString() ?: return null
              if (!url.contains("__openclaw__")) return null
              if (!isGatewayUrl(url, viewModel, isDebuggable)) return null
              return interceptGatewayRequest(url, request, isDebuggable, viewModel)
            }
          }
        webChromeClient =
          object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
              if (!isDebuggable) return false
              val msg = consoleMessage ?: return false
              Log.d(
                "OpenClawWebView",
                "console ${msg.messageLevel()} @ ${msg.sourceId()}:${msg.lineNumber()} ${msg.message()}",
              )
              return false
            }
          }

        val bridge = CanvasA2UIActionBridge { payload -> viewModel.handleCanvasA2UIActionFromWebView(payload) }
        addJavascriptInterface(bridge, CanvasA2UIActionBridge.interfaceName)
        viewModel.canvas.attach(this)
        webViewRef.value = this
      }
    },
  )
}

private fun disableForceDarkIfSupported(settings: WebSettings) {
  if (!WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) return
  @Suppress("DEPRECATION")
  WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_OFF)
}


/** Default port for a URL scheme. */
private fun defaultPort(scheme: String?): Int = when (scheme?.lowercase()) {
  "https" -> 443
  "http" -> 80
  else -> -1
}

/**
 * Validate that [url] belongs to the connected gateway by comparing
 * scheme, host, and port against the stored gateway config.
 * Returns false (and skips auth injection) for any unknown or mismatched origin.
 */
private fun isGatewayUrl(url: String, viewModel: MainViewModel, debug: Boolean): Boolean {
  return try {
    val trustedOrigin = viewModel.gatewayOrigin() ?: return false
    val trustedUri = Uri.parse(trustedOrigin)
    val requestUri = Uri.parse(url)

    val reqScheme = requestUri.scheme?.lowercase()
    val trustedScheme = trustedUri.scheme?.lowercase()
    val reqHost = requestUri.host?.lowercase()
    val trustedHost = trustedUri.host?.lowercase()
    val reqPort = requestUri.port.takeIf { it != -1 } ?: defaultPort(reqScheme)
    val trustedPort = trustedUri.port.takeIf { it != -1 } ?: defaultPort(trustedScheme)

    val match = reqScheme == trustedScheme && reqHost == trustedHost && reqPort == trustedPort
    if (!match && debug) {
      Log.w("OpenClawWebView", "Auth injection blocked: origin mismatch")
    }
    match
  } catch (e: Exception) {
    if (debug) Log.w("OpenClawWebView", "URL validation failed")
    false
  }
}

/** Shared OkHttpClient for gateway-authenticated WebView requests. */
private val gatewayHttpClient: OkHttpClient by lazy { OkHttpClient.Builder().build() }

/**
 * Intercepts WebView requests to gateway __openclaw__ endpoints and
 * adds the Authorization: Bearer header so the gateway doesn't reject them.
 */
private fun interceptGatewayRequest(
  url: String,
  request: WebResourceRequest,
  debug: Boolean,
  viewModel: MainViewModel,
): WebResourceResponse? {
  try {
    val token = viewModel.loadGatewayToken()
    if (token.isNullOrBlank()) {
      if (debug) Log.w("OpenClawWebView", "Gateway token not available for: $url")
      return null
    }
    if (debug) Log.d("OpenClawWebView", "Adding auth header for gateway request: $url")

    val reqBuilder = Request.Builder()
      .url(url)
      .addHeader("Authorization", "Bearer $token")

    // Copy original headers (skip Authorization to avoid conflict)
    request.requestHeaders?.forEach { (key, value) ->
      if (!key.equals("Authorization", ignoreCase = true)) {
        reqBuilder.addHeader(key, value)
      }
    }

    // Mirror the HTTP method
    when (request.method?.uppercase()) {
      "POST" -> reqBuilder.post(ByteArray(0).toRequestBody(null))
      "PUT"  -> reqBuilder.put(ByteArray(0).toRequestBody(null))
      "DELETE" -> reqBuilder.delete()
      "HEAD" -> reqBuilder.head()
      else -> reqBuilder.get()
    }

    val response = gatewayHttpClient.newCall(reqBuilder.build()).execute()
    if (debug) Log.d("OpenClawWebView", "Gateway response: ${response.code} for $url")

    val body = response.body
    val inputStream = body?.byteStream() ?: ByteArrayInputStream(ByteArray(0))
    val contentType = response.header("Content-Type") ?: "text/html"
    val mimeType = contentType.split(";")[0].trim()
    val charset = Regex("charset=([^;\\s]+)", RegexOption.IGNORE_CASE)
      .find(contentType)?.groupValues?.get(1) ?: "UTF-8"
    // HTTP/2 may have empty reason phrase; WebResourceResponse needs something non-empty
    val reason = response.message.ifEmpty { "OK" }

    return WebResourceResponse(mimeType, charset, response.code, reason,
      response.headers.toMultimap().mapValues { it.value.joinToString(", ") },
      inputStream)
  } catch (e: Exception) {
    if (debug) Log.e("OpenClawWebView", "Failed to intercept gateway request: $url", e)
    return null
  }
}

private class CanvasA2UIActionBridge(private val onMessage: (String) -> Unit) {
  @JavascriptInterface
  fun postMessage(payload: String?) {
    val msg = payload?.trim().orEmpty()
    if (msg.isEmpty()) return
    onMessage(msg)
  }

  companion object {
    const val interfaceName: String = "openclawCanvasA2UIAction"
  }
}
