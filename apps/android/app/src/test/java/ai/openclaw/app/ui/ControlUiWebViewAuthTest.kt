package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.DeviceAuthPayload
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayClientInfo
import ai.openclaw.app.gateway.NativeControlUiCredential
import ai.openclaw.app.gateway.buildNativeControlUiConnectAuth
import android.content.Context
import android.net.Uri
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebMessage
import android.webkit.WebResourceRequest
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.webkit.JavaScriptExecutionException
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewOutcomeReceiver
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.fakes.RoboWebMessagePort
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  instrumentedPackages = ["androidx.webkit"],
  shadows = [ControlUiAuthFeatureShadow::class, ControlUiAuthCompatShadow::class, ControlUiAuthWebViewShadow::class],
)
class ControlUiWebViewAuthTest {
  @After
  fun resetPlatformBridge() {
    ControlUiAuthCompatShadow.registrations.clear()
    ControlUiAuthCompatShadow.scripts.clear()
    ControlUiAuthFeatureShadow.unsupported.clear()
  }

  @Test
  fun startupProjectionFollowsAcceptedSharedCredentialAndDropsRetiredBindings() {
    var accepted: JsonObject? = null
    val page =
      NodeRuntime.GatewayControlPage(
        baseUrl = "https://gateway.example/control/",
        tlsFingerprintSha256 = null,
        legacyAuth = { checkNotNull(accepted) { "Native connection unavailable" } },
      )
    val nativeOnly = Json.parseToJsonElement("""{"gatewayUrl":"wss://gateway.example/control/","nativeConnectAuth":true}""").jsonObject
    assertEquals(nativeOnly, controlUiStartupAuth(page))
    for (method in listOf("token", "password")) {
      accepted = JsonObject(mapOf(method to JsonPrimitive("accepted-$method")))
      val retiredToken = if (method == "password") mapOf("token" to JsonNull) else emptyMap()
      assertEquals(JsonObject(nativeOnly + requireNotNull(accepted) + retiredToken), controlUiStartupAuth(page))
    }
    accepted = null
    assertEquals(nativeOnly, controlUiStartupAuth(page))
    // Device-only sessions project no reusable browser credential.
    accepted = JsonObject(emptyMap())
    assertEquals(nativeOnly, controlUiStartupAuth(page))
  }

  @Test
  fun mountedBridgeSignsNativeIdentityAndCurrentTokenWithoutExportingStartupSecrets() {
    val app = RuntimeEnvironment.getApplication()
    val storage = app.getSharedPreferences("native-control-auth-test", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    val identityStore = DeviceIdentityStore.withPrefs(app, prefs)
    val identity = identityStore.loadOrCreate()
    val tokens = DeviceAuthStore(prefs)
    val scopes = listOf("operator.read")
    val client = GatewayClientInfo("openclaw-android", null, "test-version", "android", "ui", "native-instance", "Android", null)
    tokens.saveToken("gateway", identity.deviceId, "operator", "first-device-token", scopes)
    val mounted =
      mount { nonce, signedAt ->
        buildNativeControlUiConnectAuth(identityStore, client, scopes, NativeControlUiCredential.DeviceToken(requireNotNull(tokens.loadToken("gateway", identity.deviceId, "operator"))), nonce, signedAt)
      }
    try {
      val script = ControlUiAuthCompatShadow.scripts.getValue(mounted.view)
      assertFalse(script.contains("first-device-token"))
      assertFalse(script.contains(identity.privateKeyPkcs8Base64))
      assertEquals(setOf("https://gateway.example:8443"), mounted.registration.origins)
      for (token in listOf("first-device-token", "rotated-device-token")) {
        tokens.saveToken("gateway", identity.deviceId, "operator", token, scopes)
        val result = mounted.request().getValue("result").jsonObject
        assertEquals(
          token,
          result
            .getValue("auth")
            .jsonObject
            .getValue("deviceToken")
            .jsonPrimitive.content,
        )
        assertEquals(scopes, result.getValue("scopes").jsonArray.map { it.jsonPrimitive.content })
        val device = result.getValue("device").jsonObject
        assertEquals(identity.deviceId, device.getValue("id").jsonPrimitive.content)
        assertEquals(identityStore.publicKeyBase64Url(identity), device.getValue("publicKey").jsonPrimitive.content)
        val payload = DeviceAuthPayload.buildV3(identity.deviceId, client.id, client.mode, "operator", scopes, 1700000000123, token, "challenge", client.platform, client.deviceFamily)
        assertTrue(identityStore.verifySelfSignature(payload, device.getValue("signature").jsonPrimitive.content, identity))
        assertEquals(
          "test-version",
          result
            .getValue("client")
            .jsonObject
            .getValue("version")
            .jsonPrimitive.content,
        )
        assertFalse(result.toString().contains(identity.privateKeyPkcs8Base64))
      }
    } finally {
      mounted.close()
      storage.edit().clear().commit()
    }
  }

  @Test
  fun explicitDefaultPortAcceptsBrowserCanonicalOriginWithoutTrustingOtherOrigins() {
    var signed = 0
    val mounted =
      mount(baseUrl = "https://gateway.example:443/openclaw/") { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      assertEquals(setOf("https://gateway.example:443"), mounted.registration.origins)
      mounted.view.loadUrl("https://gateway.example/openclaw/dashboard")
      assertTrue(mounted.request(origin = "https://gateway.example").containsKey("result"))
      assertEquals(1, signed)
      assertNull(mounted.deliver(origin = "https://gateway.example:444"))
      assertNull(mounted.deliver(origin = "http://gateway.example"))
      assertEquals(1, signed)
    } finally {
      mounted.close()
    }
  }

  @Test
  fun directBridgeRejectsPathsThatEscapeTheGatewayMountWhenDecoded() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      for (path in listOf("openclaw%2F..%2Fother/", "openclaw/%2f..%2f..%2fother/", "openclaw/%5c..%5c..%5cother/", "openclaw/%2e%2e/other/", "openclaw/../other/", "openclaw-other/")) {
        // The origin-wide platform listener is callable without our startup script.
        // Exercise it with the WebView's current URL, not a helper path predicate.
        mounted.view.loadUrl("https://gateway.example:8443/$path")
        assertNull(path, mounted.deliver())
        assertEquals(path, 0, signed)
      }
    } finally {
      mounted.close()
    }
  }

  @Test
  fun mountedBridgePreservesEncodedRoutesUnicodeMountsAndQueryData() {
    var signed = 0
    for (mountPath in listOf("openclaw", "%E6%8E%A7%E5%88%B6", "控制")) {
      val mounted =
        mount(baseUrl = "https://gateway.example:8443/$mountPath/") { _, _ ->
          signed += 1
          JsonObject(emptyMap())
        }
      try {
        for (path in listOf("dashboard/~key/notes%2Ftoday", "dashboard/~key/report%20%E6%97%A5%E5%BF%97", "focus/browser?sessionKey=agent%3Amain%3Atest&next=..%2Fother")) {
          mounted.view.loadUrl("https://gateway.example:8443/$mountPath/$path")
          assertTrue(path, mounted.request().containsKey("result"))
        }
      } finally {
        mounted.close()
      }
    }
    assertEquals(9, signed)
  }

  @Test
  fun cancelledExternalNavigationKeepsCurrentDocumentBridgeAvailable() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      val originalUrl = mounted.view.url
      for (destination in listOf("https://foreign.example/", "https://gateway.example:8443/other/")) {
        assertTrue(mounted.view.webViewClient.shouldOverrideUrlLoading(mounted.view, navigationRequest(destination)))
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(originalUrl, mounted.view.url)
        assertTrue(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
        assertTrue(mounted.request().containsKey("result"))
      }
      assertEquals(2, signed)
    } finally {
      mounted.close()
    }
  }

  @Test
  @Config(sdk = [31])
  fun streamedBrowserNavigationKeepsNativeAuthForModernAndLegacyWebViews() {
    for (legacy in listOf(false, true)) {
      if (legacy) ControlUiAuthFeatureShadow.unsupported.add(WebViewFeature.DOCUMENT_START_SCRIPT)
      var signed = 0
      val external = mutableListOf<String>()
      val path = "focus/browser?sessionKey=agent%3Amain%3Atest&target=host"
      val mounted =
        mount(path = path, onExternalLink = external::add) { _, _ ->
          signed += 1
          JsonObject(mapOf("nativeDevice" to JsonPrimitive("accepted-native-device")))
        }
      try {
        val originalUrl = requireNotNull(mounted.view.url)
        val client = mounted.view.webViewClient
        val browserPort =
          if (legacy) {
            client.onPageStarted(mounted.view, originalUrl, null)
            client.onPageFinished(mounted.view, originalUrl)
            Shadow
              .extract<ControlUiAuthWebViewShadow>(mounted.view)
              .transfers
              .single()
              .first.ports!!
              .single() as RoboWebMessagePort
          } else {
            null
          }
        assertFalse(client.shouldOverrideUrlLoading(mounted.view, navigationRequest("https://gateway.example:8443/openclaw/$path")))
        assertFalse(client.shouldOverrideUrlLoading(mounted.view, navigationRequest(originalUrl)))
        for (destination in listOf("https://foreign.example/", "https://gateway.example:8443/openclaw/dashboard")) {
          assertTrue(client.shouldOverrideUrlLoading(mounted.view, navigationRequest(destination, gesture = false)))
          assertTrue(external.isEmpty())
          assertTrue(client.shouldOverrideUrlLoading(mounted.view, navigationRequest(destination)))
          assertEquals(listOf(destination), external)
          external.clear()
          shadowOf(Looper.getMainLooper()).idle()
          assertTrue(
            mounted.view ===
              findWebView(
                mounted.controller
                  .get()
                  .window.decorView,
              ),
          )
          assertEquals(originalUrl, mounted.view.url)
          val response =
            if (browserPort != null) {
              browserPort.postMessage(WebMessage(REQUEST))
              Json.parseToJsonElement(browserPort.receivedMessages.last()).jsonObject
            } else {
              mounted.request()
            }
          assertEquals(
            "accepted-native-device",
            response
              .getValue("result")
              .jsonObject
              .getValue("nativeDevice")
              .jsonPrimitive.content,
          )
        }
        assertEquals(2, signed)
      } finally {
        mounted.close()
        ControlUiAuthFeatureShadow.unsupported.clear()
      }
    }
  }

  @Test
  fun mountedBridgeRefusesForeignFramesMalformedRequestsAndRetiredDocuments() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      assertNull(mounted.deliver(origin = "https://foreign.example"))
      assertNull(mounted.deliver(mainFrame = false))
      assertNull(mounted.deliver(data = "not json"))
      assertNull(mounted.deliver(message = WebMessageCompat(REQUEST.toByteArray())))
      for (extra in listOf("\"scopes\":[\"operator.admin\"]", "\"role\":\"node\"", "\"token\":\"chosen\"", "\"payload\":\"arbitrary\"")) {
        val response = mounted.request(data = """{"id":"request","nonce":"challenge","signedAt":1700000000123,$extra}""")
        assertTrue(response.containsKey("error"))
      }
      assertEquals(0, signed)
      mounted.request()
      assertEquals(1, signed)
      // A redirect outside the native route retires even a previously captured listener.
      mounted.view.webViewClient.onPageStarted(mounted.view, "https://gateway.example:8443/other/", null)
      assertNull(mounted.deliver())
      assertEquals(1, signed)
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
    } finally {
      mounted.close()
    }
    assertNull(mounted.deliver())
    assertEquals(1, signed)
  }

  @Test
  fun sameOriginReloadRetiresOldDocumentBridge() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      val client = mounted.view.webViewClient
      client.onPageStarted(mounted.view, "https://gateway.example:8443/openclaw/dashboard", null)
      mounted.request()
      client.onPageStarted(mounted.view, "https://gateway.example:8443/openclaw/terminal", null)
      assertNull(mounted.deliver())
      assertEquals(1, signed)
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
      client.shouldOverrideUrlLoading(
        mounted.view,
        navigationRequest("https://gateway.example:8443/openclaw/stale-dashboard"),
      )
      shadowOf(Looper.getMainLooper()).idle()
      val replacement =
        requireNotNull(
          findWebView(
            mounted.controller
              .get()
              .window.decorView,
          ),
        )
      assertTrue(replacement !== mounted.view)
      assertEquals("https://gateway.example:8443/openclaw/terminal", replacement.url)
      assertTrue(ControlUiAuthCompatShadow.registrations.containsKey(replacement))
    } finally {
      mounted.close()
    }
  }

  @Test
  @Suppress("DEPRECATION") // Android only exposes this abstract platform callback as a test fixture.
  fun rendererLossRetiresCapturedBridge() {
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    try {
      mounted.view.webViewClient.onRenderProcessGone(
        mounted.view,
        object : RenderProcessGoneDetail() {
          override fun didCrash(): Boolean = true

          override fun rendererPriorityAtExit(): Int = WebView.RENDERER_PRIORITY_IMPORTANT
        },
      )
      assertNull(mounted.deliver())
      assertEquals(0, signed)
      assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
    } finally {
      mounted.close()
    }
  }

  @Test
  @Config(sdk = [31])
  fun olderWebViewsLoadGatewayAndExchangeNativeChallengesThroughMainFramePort() {
    for (unsupported in listOf(WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER)) {
      ControlUiAuthFeatureShadow.unsupported.add(unsupported)
      var signed = 0
      val mounted =
        mount { nonce, signedAt ->
          assertEquals("challenge", nonce)
          assertEquals(1700000000123, signedAt)
          signed += 1
          JsonObject(mapOf("nativeDevice" to JsonPrimitive("accepted-native-device")))
        }
      try {
        val uri = Uri.parse(requireNotNull(mounted.view.url))
        assertEquals("gateway.example", uri.host)
        val marker = Uri.parse("https://marker.invalid/?${uri.encodedFragment}")
        assertEquals("wss://gateway.example:8443/openclaw/", marker.getQueryParameter("nativeControlAuth"))
        assertFalse(ControlUiAuthCompatShadow.registrations.containsKey(mounted.view))
        assertNull(shadowOf(mounted.view).getJavascriptInterface("OpenClawNativeGatewayAuth"))
        val platform = Shadow.extract<ControlUiAuthWebViewShadow>(mounted.view)
        assertTrue(platform.transfers.isEmpty())
        val client = mounted.view.webViewClient
        client.onPageStarted(mounted.view, mounted.view.url, null)
        client.onPageFinished(mounted.view, mounted.view.url)
        client.onPageFinished(mounted.view, mounted.view.url)
        assertEquals(1, platform.transfers.size)
        val (message, targetOrigin) = platform.transfers.single()
        assertEquals("https://gateway.example:8443", targetOrigin.toString())
        assertEquals(
          Json.parseToJsonElement("""{"type":"openclaw.native-control-auth","gatewayUrl":"wss://gateway.example:8443/openclaw/"}"""),
          Json.parseToJsonElement(requireNotNull(message.data)),
        )
        val browserPort = message.ports!!.single() as RoboWebMessagePort
        browserPort.postMessage(WebMessage(REQUEST))
        assertEquals(1, signed)
        assertEquals(
          "accepted-native-device",
          Json
            .parseToJsonElement(browserPort.receivedMessages.single())
            .jsonObject
            .getValue("result")
            .jsonObject
            .getValue("nativeDevice")
            .jsonPrimitive.content,
        )
        browserPort.postMessage(WebMessage("""{"id":"invalid","nonce":"challenge","signedAt":1700000000123,"role":"node"}"""))
        assertTrue(Json.parseToJsonElement(browserPort.receivedMessages.last()).jsonObject.containsKey("error"))
        assertEquals(1, signed)
        // A canceled foreign navigation leaves this document usable.
        assertTrue(client.shouldOverrideUrlLoading(mounted.view, navigationRequest("https://foreign.example/")))
        browserPort.postMessage(WebMessage(REQUEST))
        assertEquals(2, signed)
        // Capture the native callback to exercise a message queued before retirement,
        // rather than relying only on the port's closed bit to drop stale requests.
        val nativePort = browserPort.connectedPort
        val queuedCallback = nativePort.webMessageCallback
        client.onPageStarted(mounted.view, "https://gateway.example:8443/openclaw/terminal", null)
        assertTrue(nativePort.isClosed)
        queuedCallback.onMessage(nativePort, WebMessage(REQUEST))
        client.onPageFinished(mounted.view, mounted.view.url)
        assertEquals(1, platform.transfers.size)
        assertEquals(2, signed)
      } finally {
        mounted.close()
        ControlUiAuthFeatureShadow.unsupported.clear()
      }
    }
  }

  @Test
  @Config(sdk = [31])
  fun legacyPortIsNotTransferredToForeignDocumentAndReleaseRetiresQueuedRequests() {
    ControlUiAuthFeatureShadow.unsupported.add(WebViewFeature.DOCUMENT_START_SCRIPT)
    var signed = 0
    val mounted =
      mount { _, _ ->
        signed += 1
        JsonObject(emptyMap())
      }
    val platform = Shadow.extract<ControlUiAuthWebViewShadow>(mounted.view)
    try {
      val client = mounted.view.webViewClient
      client.onPageStarted(mounted.view, mounted.view.url, null)
      for (url in listOf("https://foreign.example/", "https://gateway.example:8443/openclaw%2F..%2Fother/", "https://gateway.example:8443/openclaw/%2F..%2F..%2Fother/")) {
        client.onPageFinished(mounted.view, url)
        assertTrue(url, platform.transfers.isEmpty())
      }
      client.onPageFinished(mounted.view, mounted.view.url)
      val browserPort =
        platform.transfers
          .single()
          .first.ports!!
          .single() as RoboWebMessagePort
      val nativePort = browserPort.connectedPort
      val queuedCallback = nativePort.webMessageCallback
      mounted.close()
      assertTrue(nativePort.isClosed)
      queuedCallback.onMessage(nativePort, WebMessage(REQUEST))
      assertEquals(0, signed)
    } finally {
      // Activity destruction is owned above, even when assertions throw.
      if (!shadowOf(mounted.view).wasDestroyCalled()) mounted.close()
    }
  }

  private fun navigationRequest(
    url: String,
    gesture: Boolean = true,
  ): WebResourceRequest =
    object : WebResourceRequest {
      override fun getUrl(): Uri = Uri.parse(url)

      override fun isForMainFrame(): Boolean = true

      override fun isRedirect(): Boolean = false

      override fun hasGesture(): Boolean = gesture

      override fun getMethod(): String = "GET"

      override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

  private fun mount(
    baseUrl: String = "https://gateway.example:8443/openclaw/",
    path: String = "dashboard",
    onExternalLink: ((String) -> Unit)? = null,
    sign: (String, Long) -> JsonObject,
  ): Mounted {
    val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    val page = NodeRuntime.GatewayControlPage(baseUrl, null, sign)
    controller.get().setContent {
      OpenClawTheme(themeMode = AppearanceThemeMode.System) {
        ControlUiWebView(page, "${page.baseUrl}$path", onExternalLink = onExternalLink)
      }
    }
    shadowOf(Looper.getMainLooper()).idle()
    return Mounted(controller, requireNotNull(findWebView(controller.get().window.decorView)))
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    return (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
  }

  private class Mounted(
    val controller: org.robolectric.android.controller.ActivityController<ComponentActivity>,
    val view: WebView,
  ) {
    val registration =
      ControlUiAuthCompatShadow.registrations[view]
        ?: ControlUiAuthRegistration(emptySet()) { _, _, _, _, _ -> error("Bridge unavailable") }

    fun request(
      data: String = REQUEST,
      origin: String = "https://gateway.example:8443",
    ): JsonObject = Json.parseToJsonElement(requireNotNull(deliver(data = data, origin = origin))).jsonObject

    fun deliver(
      origin: String = "https://gateway.example:8443",
      mainFrame: Boolean = true,
      data: String = REQUEST,
      message: WebMessageCompat = WebMessageCompat(data),
    ): String? {
      var response: String? = null
      registration.listener.onPostMessage(
        view,
        message,
        Uri.parse(origin),
        mainFrame,
        object : JavaScriptReplyProxy() {
          override fun postMessage(message: String) {
            response = message
          }

          override fun postMessage(message: ByteArray) {
            error("Unexpected binary reply")
          }

          override fun executeJavaScript(
            script: String,
            receiver: WebViewOutcomeReceiver<String, JavaScriptExecutionException>?,
          ) {
            error("Unexpected script reply")
          }
        },
      )
      return response
    }

    fun close() {
      controller.pause().stop().destroy()
      shadowOf(Looper.getMainLooper()).idle()
    }
  }

  companion object {
    private const val REQUEST = """{"id":"request","nonce":"challenge","signedAt":1700000000123}"""
  }
}

internal data class ControlUiAuthRegistration(
  val origins: Set<String>,
  val listener: WebViewCompat.WebMessageListener,
)

@Implements(value = WebViewFeature::class, isInAndroidSdk = false)
class ControlUiAuthFeatureShadow {
  companion object {
    val unsupported = mutableSetOf<String>()

    @JvmStatic
    @Implementation
    fun isFeatureSupported(feature: String): Boolean = feature !in unsupported && feature in setOf(WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.DOCUMENT_START_SCRIPT)
  }
}

// Only AndroidX's absent platform bridge is replaced: the mounted WebView, registered
// callback, native Ed25519 identity/token store, and lifecycle callbacks are real.
@Implements(value = WebViewCompat::class, isInAndroidSdk = false)
class ControlUiAuthCompatShadow {
  companion object {
    internal val registrations = mutableMapOf<WebView, ControlUiAuthRegistration>()
    internal val scripts = mutableMapOf<WebView, String>()

    @JvmStatic
    @Implementation
    fun addWebMessageListener(
      view: WebView,
      name: String,
      origins: Set<String>,
      listener: WebViewCompat.WebMessageListener,
    ) {
      assertEquals("OpenClawNativeGatewayAuth", name)
      registrations[view] = ControlUiAuthRegistration(origins, listener)
    }

    @JvmStatic
    @Implementation
    fun removeWebMessageListener(
      view: WebView,
      name: String,
    ) {
      registrations.remove(view)
    }

    @JvmStatic
    @Implementation
    fun addDocumentStartJavaScript(
      view: WebView,
      script: String,
      origins: Set<String>,
    ): ScriptHandler {
      scripts[view] = script
      return ScriptHandler { scripts.remove(view) }
    }
  }
}

// Robolectric has real paired message-port fakes but does not implement the
// WebView main-frame transfer. Capture only that platform boundary.
@Implements(WebView::class)
class ControlUiAuthWebViewShadow : ShadowWebView() {
  val transfers = mutableListOf<Pair<WebMessage, Uri>>()

  @Implementation
  fun postWebMessage(
    message: WebMessage,
    targetOrigin: Uri,
  ) {
    transfers.add(message to targetOrigin)
  }
}
