package ai.openclaw.app.ui

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.R
import ai.openclaw.app.gateway.normalizeGatewayTlsFingerprintInput
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.view.ContextThemeWrapper
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okio.ByteString.Companion.toByteString

@Composable
internal fun ControlUiScreenFrame(
  title: String,
  icon: ImageVector,
  onBack: () -> Unit,
  modifier: Modifier = Modifier,
  headerActions: @Composable () -> Unit = {},
  content: @Composable BoxScope.() -> Unit,
) {
  ClawScaffold(
    contentPadding = PaddingValues(start = ClawTheme.spacing.lg, top = 14.dp, end = ClawTheme.spacing.lg, bottom = 6.dp),
  ) {
    Column(modifier = Modifier.fillMaxSize().then(modifier), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
      ) {
        ClawPlainIconButton(
          icon = Icons.AutoMirrored.Filled.ArrowBack,
          contentDescription = nativeString("Back"),
          onClick = onBack,
        )
        Text(
          text = title,
          style = ClawTheme.type.title,
          color = ClawTheme.colors.text,
          modifier = Modifier.weight(1f),
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        headerActions()
        Icon(imageVector = icon, contentDescription = null, tint = ClawTheme.colors.textMuted)
      }
      Box(modifier = Modifier.fillMaxWidth().weight(1f), content = content)
    }
  }
}

@Composable
internal fun ControlUiUnavailable(
  title: String,
  detail: String,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(top = 48.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
    Text(text = detail, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
  }
}

/** Authenticated, hardened WebView host for gateway-served Control UI pages. */
@SuppressLint("SetJavaScriptEnabled")
// Deprecated file-URL settings are still force-disabled defensively, like the canvas host.
@Suppress("DEPRECATION")
@Composable
internal fun ControlUiWebView(
  page: NodeRuntime.GatewayControlPage,
  url: String,
  modifier: Modifier = Modifier,
  interactive: Boolean = true,
  onExternalLink: ((String) -> Unit)? = null,
) {
  val context = LocalContext.current
  val focusManager = LocalFocusManager.current
  val darkAppearance = LocalResolvedAppearanceIsDark.current
  var rendererGeneration by remember { mutableIntStateOf(0) }
  val currentExternalLink by rememberUpdatedState(onExternalLink)
  var currentUrl by remember(page, url) { mutableStateOf(url) }

  // A WebView reads prefers-color-scheme from the Context it was built with, so an appearance
  // flip has to rebuild it; keying on the resolved boolean keeps that to real dark/light changes.
  // The reload is safe because both Control UI surfaces reattach to server-side state: the shell
  // outlives the page, and the desktop session lingers on the Gateway long enough to re-observe.
  key(page, currentUrl, darkAppearance, rendererGeneration) {
    AndroidView(
      modifier = modifier,
      factory = {
        val webView =
          object : WebView(controlUiWebViewContext(context, darkAppearance)) {
            override fun onDetachedFromWindow() {
              releaseControlUiInputFocus(this, focusManager)
              super.onDetachedFromWindow()
            }
          }
        // WRAP_CONTENT forces a zero-height CSS viewport even when Compose measures the view exactly.
        webView.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        val webSettings = webView.settings
        webSettings.setAllowContentAccess(false)
        webSettings.setAllowFileAccess(false)
        webSettings.setAllowFileAccessFromFileURLs(false)
        webSettings.setAllowUniversalAccessFromFileURLs(false)
        webSettings.setSafeBrowsingEnabled(true)
        webSettings.javaScriptEnabled = true
        webSettings.domStorageEnabled = true
        webSettings.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        webSettings.builtInZoomControls = false
        webSettings.displayZoomControls = false
        webSettings.setSupportZoom(false)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
          WebSettingsCompat.setAlgorithmicDarkeningAllowed(webSettings, false)
        }
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        // The native gateway connection already established this route's trust.
        // Reuse only that exact accepted fingerprint; every other SSL error cancels.
        // The same client protects both terminal and dashboard pages.
        val client =
          ControlUiWebViewClient(
            page = page,
            navigationUrl = url.takeIf { onExternalLink != null },
            onExternalLink = { currentExternalLink?.invoke(it) },
            onNavigate = { nextUrl ->
              currentUrl = nextUrl
              rendererGeneration += 1
            },
            onRendererGone = { rendererGeneration += 1 },
          )
        webView.webViewClient = client
        if (client.installAuth(webView) && client.isGatewayPage(currentUrl)) {
          webView.loadUrl(client.authenticatedUrl(currentUrl))
        } else {
          // Never silently create a separately paired browser identity for an invalid route.
          webView.loadData("Reconnect the app to reopen this gateway page.", "text/plain", "UTF-8")
        }
        webView
      },
      update = { webView ->
        if (!interactive) releaseControlUiInputFocus(webView, focusManager)
        webView.importantForAccessibility = if (interactive) View.IMPORTANT_FOR_ACCESSIBILITY_AUTO else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        webView.isFocusable = interactive
        webView.isFocusableInTouchMode = interactive
      },
      onRelease = { webView ->
        (webView.webViewClient as? ControlUiWebViewClient)?.release(webView)
      },
    )
  }
}

private fun releaseControlUiInputFocus(
  webView: WebView,
  focusManager: FocusManager,
) {
  val inputMethod = webView.context.getSystemService(InputMethodManager::class.java)
  if (webView.hasFocus() || inputMethod?.isActive(webView) == true) {
    inputMethod?.hideSoftInputFromWindow(webView.windowToken, 0)
    // Clear the interop target before detach can restore focus to the chat editor.
    focusManager.clearFocus()
    webView.clearFocus()
  }
}

private fun controlUiWebViewContext(
  context: Context,
  darkAppearance: Boolean,
): Context {
  val configuration = Configuration(context.resources.configuration)
  val nightMode = if (darkAppearance) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
  configuration.uiMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or nightMode
  // WebView derives prefers-color-scheme from the host theme's isLightTheme value.
  // Reapplying the app's DayNight theme to this resolved configuration keeps that value authoritative.
  return ContextThemeWrapper(context.createConfigurationContext(configuration), R.style.Theme_OpenClawNode)
}

private const val NATIVE_GATEWAY_AUTH_BRIDGE = "OpenClawNativeGatewayAuth"

// Encoded separators are valid session-key data, but must not hide traversal
// segments that a reverse proxy can decode outside the accepted Control UI mount.
private val controlUiDotSegmentPattern = Regex("""(?:^|/|%2f|%5c)(?:\.|%2e){1,2}(?=$|/|%2f|%5c)""", RegexOption.IGNORE_CASE)

private fun controlUiPath(url: String): String? =
  url
    .toHttpUrlOrNull()
    ?.encodedPath
    ?.takeUnless(controlUiDotSegmentPattern::containsMatchIn)

/** scheme://host[:port] origin for WebView script rules; brackets IPv6 hosts. */
internal fun controlUiOriginRule(baseUrl: String): String? {
  val uri = baseUrl.toUri()
  val scheme = uri.scheme?.lowercase(java.util.Locale.US)?.takeIf { it == "http" || it == "https" } ?: return null
  val host = uri.host?.lowercase(java.util.Locale.US) ?: return null
  val hostPart = if (host.contains(":") && !host.startsWith("[")) "[$host]" else host
  val port = if (uri.port != -1) ":${uri.port}" else ""
  return "$scheme://$hostPart$port"
}

private fun sameControlUiOrigin(
  left: String,
  right: String,
): Boolean {
  val first = left.toHttpUrlOrNull() ?: return false
  val second = right.toHttpUrlOrNull() ?: return false
  return first.scheme == second.scheme && first.host == second.host && first.port == second.port
}

/** Released UIs consume the accepted shared fields; current UI selects native signing. */
internal fun controlUiStartupAuth(page: NodeRuntime.GatewayControlPage): JsonObject =
  buildJsonObject {
    put("gatewayUrl", page.baseUrl.replaceFirst("http", "ws"))
    put("nativeConnectAuth", true)
    // Before hello or after retirement, omit credentials instead of clearing the
    // released UI's own saved browser login. Never export a native device grant.
    val legacy = runCatching { page.legacyAuth?.invoke() }.getOrNull()
    legacy?.forEach { (key, value) -> put(key, value) }
    // The released UI otherwise prefers its cached token over an accepted password.
    if (legacy?.containsKey("password") == true) put("token", JsonNull)
  }

private const val X509_CERTIFICATE_BUNDLE_KEY = "x509-certificate"

// WebKit 1.17's lint detector reports Kotlin WebViewClient constructors even when this callback exists.
@SuppressLint("MissingOnRenderProcessGone")
private class ControlUiWebViewClient(
  private val page: NodeRuntime.GatewayControlPage,
  private val navigationUrl: String? = null,
  private val onExternalLink: (String) -> Unit = {},
  private val onNavigate: (String) -> Unit,
  private val onRendererGone: () -> Unit,
) : WebViewClient() {
  private var released = false
  private var navigationRetired = false
  private var authInstalled = false
  private var documentStarted = false
  private var authScript: ScriptHandler? = null
  private var usesMessagePort = false
  private var authPort: WebMessagePort? = null
  private val gatewayUrl = page.baseUrl.replaceFirst("http", "ws")
  private val basePath = controlUiPath(page.baseUrl)?.trimEnd('/')

  fun isGatewayPage(url: String?): Boolean {
    val path = url?.let(::controlUiPath) ?: return false
    if (!sameControlUiOrigin(url, page.baseUrl)) return false
    val root = basePath ?: return false
    return path == root || path.startsWith("$root/")
  }

  fun authenticatedUrl(url: String): String {
    if (!usesMessagePort) return url
    val uri = url.toUri()
    val fields =
      uri.encodedFragment
        .orEmpty()
        .split('&')
        .filter { it.isNotEmpty() && it.substringBefore('=') != "nativeControlAuth" }
    // Public startup metadata selects native auth before any browser handshake.
    // Unlike a JavaScript interface, the message port below is sent only to the main frame.
    return uri
      .buildUpon()
      .encodedFragment((fields + "nativeControlAuth=${android.net.Uri.encode(gatewayUrl)}").joinToString("&"))
      .build()
      .toString()
  }

  fun installAuth(view: WebView): Boolean {
    val origin = controlUiOriginRule(page.baseUrl) ?: return false
    val root = basePath ?: return false
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        WebViewCompat.addWebMessageListener(view, NATIVE_GATEWAY_AUTH_BRIDGE, setOf(origin)) { source, message, sourceOrigin, isMainFrame, reply ->
          if (message.type != WebMessageCompat.TYPE_STRING || !isActiveDocument(view) || source !== view || !isMainFrame ||
            !sameControlUiOrigin(sourceOrigin.toString(), page.baseUrl)
          ) {
            return@addWebMessageListener
          }
          val response = respondToChallenge(message.data) ?: return@addWebMessageListener
          if (isActiveDocument(view) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            reply.postMessage(response)
          }
        }
      } else {
        // Platform WebMessagePort is available since API 23, below our minimum SDK.
        usesMessagePort = true
        return true
      }
      authInstalled = true
      val payload = controlUiStartupAuth(page)
      authScript =
        WebViewCompat.addDocumentStartJavaScript(
          view,
          """
          (() => {
            if (window.top !== window) return;
            const base = ${JsonPrimitive(root)};
            if (new RegExp(${JsonPrimitive(controlUiDotSegmentPattern.pattern)}, "i").test(location.pathname)) return;
            if (base && location.pathname !== base && !location.pathname.startsWith(base + "/")) return;
            Object.defineProperty(window, "__OPENCLAW_NATIVE_CONTROL_AUTH__", {
              value: $payload,
              configurable: true,
            });
          })();
          """.trimIndent(),
          setOf(origin),
        )
      return true
    }
    usesMessagePort = true
    return true
  }

  private fun isActiveDocument(view: WebView): Boolean = !released && !navigationRetired && isGatewayPage(view.url)

  private fun respondToChallenge(data: String?): String? {
    val request = runCatching { Json.parseToJsonElement(data.orEmpty()) as? JsonObject }.getOrNull()
    val id = (request?.get("id") as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    if (id.isNullOrBlank() || id.length > 128) return null
    return buildJsonObject {
      put("id", id)
      try {
        require(request.keys == setOf("id", "nonce", "signedAt")) { "Invalid native connect request" }
        val nonce = (request["nonce"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
        val signedAt = (request["signedAt"] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        require(nonce != null && signedAt != null) { "Invalid gateway challenge" }
        val sign = checkNotNull(page.connectAuth) { "Reconnect the app to authenticate this page" }
        put("result", sign(nonce, signedAt))
      } catch (error: IllegalArgumentException) {
        put("error", "Invalid gateway challenge")
      } catch (error: IllegalStateException) {
        put("error", "Reconnect the app to authenticate this page")
      }
    }.toString()
  }

  override fun onPageFinished(
    view: WebView,
    url: String?,
  ) {
    if (!usesMessagePort || !documentStarted || !isActiveDocument(view) || !isGatewayPage(url) || authPort != null) return
    val origin = controlUiOriginRule(page.baseUrl)?.toUri() ?: return
    val ports = view.createWebMessageChannel()
    val nativePort = ports[0]
    authPort = nativePort
    nativePort.setWebMessageCallback(
      object : WebMessagePort.WebMessageCallback() {
        override fun onMessage(
          port: WebMessagePort,
          message: WebMessage,
        ) {
          if (port !== authPort || !isActiveDocument(view)) return
          val response = respondToChallenge(message.data) ?: return
          if (port === authPort && isActiveDocument(view)) port.postMessage(WebMessage(response))
        }
      },
    )
    val payload =
      buildJsonObject {
        put("type", "openclaw.native-control-auth")
        put("gatewayUrl", gatewayUrl)
      }
    // Page scripts have installed their listener by onPageFinished. The platform
    // transfers only to this main-frame origin, never to subframes or a wildcard.
    // The transferred end now belongs to JavaScript; retirement closes our end.
    view.postWebMessage(WebMessage(payload.toString(), arrayOf(ports[1])), origin)
  }

  private fun retireAuth(view: WebView) {
    navigationRetired = true
    authPort?.close()
    authPort = null
    authScript?.remove()
    authScript = null
    if (authInstalled && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      WebViewCompat.removeWebMessageListener(view, NATIVE_GATEWAY_AUTH_BRIDGE)
    }
    authInstalled = false
  }

  override fun shouldOverrideUrlLoading(
    view: WebView,
    request: WebResourceRequest,
  ): Boolean {
    if (released || navigationRetired) return true
    if (!request.isForMainFrame) return false
    val nextUrl = request.url.toString()
    navigationUrl?.let { expected ->
      if (nextUrl == expected || nextUrl == authenticatedUrl(expected)) return false
      // A streamed page stays mounted; an external link must not retire its auth bridge.
      if (request.hasGesture() && request.url.scheme in setOf("http", "https")) {
        onExternalLink(nextUrl)
      }
      return true
    }
    if (!isGatewayPage(nextUrl)) return true
    retireAuth(view)
    onNavigate(nextUrl)
    return true
  }

  override fun onPageStarted(
    view: WebView,
    url: String?,
    favicon: Bitmap?,
  ) {
    if (!isGatewayPage(url)) {
      retireAuth(view)
    } else if (documentStarted && !released && !navigationRetired) {
      // Full document navigation/reload gets a fresh bridge, unlike SPA history changes.
      // Queued callbacks from the old document retain only the retired listener.
      retireAuth(view)
      view.stopLoading()
      onNavigate(checkNotNull(url))
    }
    documentStarted = true
  }

  fun release(view: WebView) {
    if (released) return
    released = true
    retireAuth(view)
    view.stopLoading()
    view.destroy()
  }

  override fun onRenderProcessGone(
    view: WebView,
    detail: RenderProcessGoneDetail,
  ): Boolean {
    if (released) return true
    released = true
    retireAuth(view)
    // The renderer cannot be reused. Detach and destroy this instance before
    // advancing the Compose key so the authenticated page gets a fresh process.
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
    onRendererGone()
    return true
  }

  // Android lint cannot infer the exact pin and origin checks below; every other path cancels.
  // WebView exposes no pre-document certificate hook for successful CA-trusted handshakes;
  // this callback extends native pin trust only to recoverable self-signed errors.
  @SuppressLint("WebViewClientOnReceivedSslError")
  override fun onReceivedSslError(
    view: WebView,
    handler: android.webkit.SslErrorHandler,
    error: android.net.http.SslError,
  ) {
    // SslCertificate exposes the encoded leaf only through its AOSP saveState bundle.
    val encodedCertificate =
      android.net.http.SslCertificate
        .saveState(error.certificate)
        ?.getByteArray(X509_CERTIFICATE_BUNDLE_KEY)
    if (
      shouldProceedForPinnedControlUiSslError(
        pageBaseUrl = page.baseUrl,
        expectedFingerprint = page.tlsFingerprintSha256,
        errorUrl = error.url,
        encodedCertificate = encodedCertificate,
      )
    ) {
      // The native gateway connection already accepted this exact certificate.
      // Never extend the exception to another origin or a different certificate.
      handler.proceed()
    } else {
      handler.cancel()
    }
  }
}

internal fun shouldProceedForPinnedControlUiSslError(
  pageBaseUrl: String,
  expectedFingerprint: String?,
  errorUrl: String?,
  encodedCertificate: ByteArray?,
): Boolean {
  val expected =
    expectedFingerprint
      ?.let(::normalizeGatewayTlsFingerprintInput)
      ?: return false
  val certificate = encodedCertificate ?: return false
  if (!sameHttpsOrigin(pageBaseUrl, errorUrl)) return false
  return certificate.toByteString().sha256().hex() == expected
}

private fun sameHttpsOrigin(
  pageBaseUrl: String,
  errorUrl: String?,
): Boolean {
  val pageOrigin = parsedHttpsOrigin(pageBaseUrl) ?: return false
  val errorOrigin = errorUrl?.let(::parsedHttpsOrigin) ?: return false
  return pageOrigin == errorOrigin
}

private data class HttpsOrigin(
  val host: String,
  val port: Int,
)

private fun parsedHttpsOrigin(rawUrl: String): HttpsOrigin? {
  val uri = rawUrl.toUri()
  if (!uri.scheme.equals("https", ignoreCase = true)) return null
  val host = uri.host?.lowercase(java.util.Locale.US) ?: return null
  val port = uri.port.takeIf { it >= 0 } ?: 443
  return HttpsOrigin(host = host, port = port)
}
