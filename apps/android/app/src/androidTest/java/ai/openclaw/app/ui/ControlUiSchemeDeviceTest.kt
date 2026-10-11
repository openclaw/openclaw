package ai.openclaw.app.ui

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.isLocalCleartextGatewayHost
import ai.openclaw.app.gateway.isLoopbackGatewayHost
import ai.openclaw.app.gatewayControlPageBaseUrl
import ai.openclaw.app.node.ConnectionManager
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import okio.ByteString.Companion.toByteString
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.DERBitString
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.Certificate
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Time
import org.bouncycastle.asn1.x509.V3TBSCertificateGenerator
import org.bouncycastle.asn1.x509.Validity
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.Inet4Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket

/**
 * Loads the production Control UI WebView on a device.
 * Discovered LAN hosts omit the gatewayTls advertisement and still use HTTPS.
 * A manual private-LAN endpoint with the cleartext toggle off stays on HTTP.
 */
@RunWith(AndroidJUnit4::class)
class ControlUiSchemeDeviceTest {
  private val servers = mutableListOf<LocalPageServer>()

  @After
  fun closeServers() {
    servers.forEach { it.close() }
    servers.clear()
  }

  @Test fun discoveredLanWithoutTlsAdvertisementLoadsHttpsAndInstallsAuth() {
    val host = emulatorLanHost()
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Lan",
        name = "Lan",
        host = host,
        port = 1,
        tlsEnabled = false,
      )
    val tls =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )
    val server = LocalPageServer(proofSslContext())
    servers += server
    val routed = endpoint.copy(port = server.port)
    val url = gatewayControlPageBaseUrl(routed, tls)
    val text = loadControlPage(routed, url, certificateFingerprint())
    File(proofDirectory(), "https-discovered.txt").writeText("url=$url\npage=$text\n")
    assertTrue(text, text.startsWith("https://$host:${server.port}") && text.contains("wss://$host:${server.port}") && text.contains("NATIVE_AUTH"))
  }

  @Test fun manualLanCleartextLoadsHttpAndInstallsAuth() {
    val host = emulatorLanHost()
    val endpoint = GatewayEndpoint.manual(host = host, port = 1, tlsEnabled = false)
    val tls =
      ConnectionManager.resolveTlsParamsForEndpoint(
        endpoint,
        storedFingerprint = null,
        manualTlsEnabled = false,
      )
    val server = LocalPageServer(ssl = null)
    servers += server
    val routed = endpoint.copy(port = server.port)
    val url = gatewayControlPageBaseUrl(routed, tls)
    val text = loadControlPage(routed, url, fingerprint = null)
    File(proofDirectory(), "http-manual-lan.txt").writeText("url=$url\npage=$text\n")
    assertTrue(text, text.startsWith("http://$host:${server.port}") && text.contains("ws://$host:${server.port}") && text.contains("NATIVE_AUTH"))
  }

  private fun loadControlPage(
    endpoint: GatewayEndpoint,
    url: String,
    fingerprint: String?,
  ): String {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val device = UiDevice.getInstance(instrumentation)
    device.wakeUp()
    val page =
      NodeRuntime.GatewayControlPage(
        baseUrl = url,
        tlsFingerprintSha256 = fingerprint,
      )
    val intent = Intent(instrumentation.targetContext, ComponentActivity::class.java)
    return ActivityScenario.launch<ComponentActivity>(intent).use { scenario ->
      scenario.onActivity { activity ->
        activity.setContent {
          ClawDesignTheme {
            Box(Modifier.fillMaxSize()) {
              ControlUiWebView(page, url)
            }
          }
        }
      }
      val seen = AtomicReference("")
      val deadline = System.nanoTime() + 20_000_000_000L
      while (System.nanoTime() < deadline && "NATIVE_AUTH" !in seen.get()) {
        val latch = CountDownLatch(1)
        scenario.onActivity { activity ->
          val webView = findWebView(activity.findViewById(android.R.id.content))
          if (webView == null) {
            latch.countDown()
          } else {
            webView.evaluateJavascript(
              "(function(){var node=document.getElementById('place');return node?node.textContent:'';})()",
            ) { value ->
              seen.set(value.trim().trim('"'))
              latch.countDown()
            }
          }
        }
        latch.await(2, TimeUnit.SECONDS)
      }
      scenario.onActivity { activity ->
        findWebView(activity.findViewById(android.R.id.content))?.let { webView ->
          webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
          webView.reload()
        }
      }
      seen.set("")
      val paintDeadline = System.nanoTime() + 20_000_000_000L
      while (System.nanoTime() < paintDeadline && "NATIVE_AUTH" !in seen.get()) {
        val latch = CountDownLatch(1)
        scenario.onActivity { activity ->
          val webView = findWebView(activity.findViewById(android.R.id.content))
          if (webView == null) {
            latch.countDown()
          } else {
            webView.evaluateJavascript(
              "(function(){var node=document.getElementById('place');return node?node.textContent:'';})()",
            ) { value ->
              seen.set(value.trim().trim('"'))
              latch.countDown()
            }
          }
        }
        latch.await(2, TimeUnit.SECONDS)
      }
      val shot = File(proofDirectory(), if (url.startsWith("https")) "https-discovered.png" else "http-manual-lan.png")
      val painted = CountDownLatch(1)
      scenario.onActivity { activity ->
        val webView = findWebView(activity.findViewById(android.R.id.content))
        if (webView == null || webView.width == 0 || webView.height == 0) {
          painted.countDown()
          return@onActivity
        }

        fun drawUntilInk(remaining: Int) {
          val bitmap = android.graphics.Bitmap.createBitmap(webView.width, webView.height, android.graphics.Bitmap.Config.ARGB_8888)
          webView.draw(android.graphics.Canvas(bitmap))
          if (bitmapHasInk(bitmap) || remaining == 0) {
            shot.outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
            painted.countDown()
          } else {
            webView.post { drawUntilInk(remaining - 1) }
          }
        }
        webView.post { drawUntilInk(8) }
      }
      painted.await(3, TimeUnit.SECONDS)
      if (!shot.exists()) device.takeScreenshot(shot)
      seen.get()
    }
  }

  private fun proofDirectory(): File = File(checkNotNull(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)), "control-ui-scheme").apply { mkdirs() }

  private fun emulatorLanHost(): String {
    val host =
      java.net.NetworkInterface
        .getNetworkInterfaces()
        .toList()
        .flatMap { nif ->
          nif.inetAddresses.toList().filterIsInstance<Inet4Address>()
        }.firstOrNull { address ->
          val literal = address.hostAddress
          literal != null && isLocalCleartextGatewayHost(literal) && !isLoopbackGatewayHost(literal)
        }
    return checkNotNull(host?.hostAddress) { "No private LAN address on this device" }
  }

  private val proofIdentity: ProofIdentity by lazy { generateProofIdentity() }

  private fun certificateFingerprint(): String =
    proofIdentity.certificate.encoded
      .toByteString()
      .sha256()
      .hex()

  private fun proofSslContext(): SSLContext = proofIdentity.context

  private fun bitmapHasInk(bitmap: android.graphics.Bitmap): Boolean {
    val width = bitmap.width
    val height = bitmap.height
    var y = 0
    while (y < height) {
      var x = 0
      while (x < width) {
        if ((bitmap.getPixel(x, y) and 0x00FFFFFF) < 0x00F0F0F0) return true
        x += 24
      }
      y += 24
    }
    return false
  }

  private fun findWebView(view: View?): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findWebView(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }

  private class LocalPageServer(
    ssl: SSLContext?,
  ) : AutoCloseable {
    private val socket: ServerSocket =
      if (ssl == null) {
        ServerSocket(0, 8, InetAddress.getByName("0.0.0.0"))
      } else {
        (ssl.serverSocketFactory.createServerSocket(0, 8, InetAddress.getByName("0.0.0.0")) as SSLServerSocket)
      }
    val port: Int = socket.localPort
    private val worker =
      Thread {
        while (!socket.isClosed) {
          val client =
            try {
              socket.accept()
            } catch (_: Exception) {
              break
            }
          try {
            client.use(::writePage)
          } catch (_: Exception) {
            // A rejected handshake must not tear down the WebView result.
          }
        }
      }.apply {
        isDaemon = true
        start()
      }

    private fun writePage(client: Socket) {
      client.getInputStream().read(ByteArray(2048))
      val body = PAGE.toByteArray()
      val headers =
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"
      val output = client.getOutputStream()
      output.write(headers.toByteArray())
      output.write(body)
      output.flush()
    }

    override fun close() {
      socket.close()
      worker.join(1000)
    }
  }

  private data class ProofIdentity(
    val certificate: X509Certificate,
    val context: SSLContext,
  )

  private companion object {
    private fun generateProofIdentity(): ProofIdentity {
      val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
      val algorithm = AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE)
      val subject = X500Name("CN=control-ui-scheme-proof")
      val now = System.currentTimeMillis()
      val tbs =
        V3TBSCertificateGenerator()
          .apply {
            setSerialNumber(ASN1Integer.ONE)
            setSignature(algorithm)
            setIssuer(subject)
            setSubject(subject)
            setValidity(Validity(Time(Date(now - 60_000)), Time(Date(now + 86_400_000))))
            setSubjectPublicKeyInfo(SubjectPublicKeyInfo.getInstance(keyPair.public.encoded))
          }.generateTBSCertificate()
      val signature =
        Signature.getInstance("SHA256withRSA").apply {
          initSign(keyPair.private)
          update(tbs.encoded)
        }
      val encoded = Certificate(tbs, algorithm, DERBitString(signature.sign())).encoded
      val certificate = CertificateFactory.getInstance("X.509").generateCertificate(encoded.inputStream()) as X509Certificate
      val password = charArrayOf()
      val store =
        KeyStore.getInstance("PKCS12").apply {
          load(null, null)
          setKeyEntry("server", keyPair.private, password, arrayOf(certificate))
        }
      val keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, password) }
      val context = SSLContext.getInstance("TLS").apply { init(keys.keyManagers, null, null) }
      return ProofIdentity(certificate, context)
    }

    private const val PAGE =
      """<!DOCTYPE html><html><head><title>CONTROL_PAGE</title></head><body style="background:#ffffff;color:#111111;font:32px sans-serif;margin:24px"><p id="place">WAITING</p><script>var auth=window.__OPENCLAW_NATIVE_CONTROL_AUTH__;var gateway=auth&&auth.gatewayUrl?auth.gatewayUrl:"NO_GATEWAY_URL";var nativeAuth=auth&&auth.nativeConnectAuth?"NATIVE_AUTH":"NO_NATIVE_AUTH";document.getElementById("place").textContent=location.href+" "+gateway+" "+nativeAuth;</script></body></html>"""
  }
}
