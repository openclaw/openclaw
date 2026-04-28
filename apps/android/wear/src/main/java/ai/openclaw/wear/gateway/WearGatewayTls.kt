package ai.openclaw.wear.gateway

import android.annotation.SuppressLint
import android.content.Context
import ai.openclaw.android.gateway.GatewayUrlHelpers
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

internal data class WearGatewayTlsParams(
  val expectedFingerprint: String?,
  val stableId: String,
)

internal data class WearGatewayTlsConfig(
  val sslSocketFactory: javax.net.ssl.SSLSocketFactory,
  val trustManager: X509TrustManager,
  val hostnameVerifier: HostnameVerifier,
)

internal interface WearGatewayTlsPinStore {
  fun load(stableId: String): String?

  fun save(stableId: String, fingerprint: String)
}

internal class SharedPrefsWearGatewayTlsPinStore(
  context: Context,
) : WearGatewayTlsPinStore {
  private val prefs =
    context.applicationContext.getSharedPreferences("openclaw_wear_tls_pins", Context.MODE_PRIVATE)

  override fun load(stableId: String): String? {
    return prefs.getString(stableId, null)?.trim()?.ifEmpty { null }
  }

  override fun save(stableId: String, fingerprint: String) {
    prefs.edit().putString(stableId, fingerprint.trim()).apply()
  }
}

internal fun resolveWearGatewayStableId(config: WearGatewayConfig): String {
  val host = GatewayUrlHelpers.normalizeGatewayHost(config.host).lowercase(Locale.US)
  return "manual|$host|${config.port}"
}

internal fun resolveWearGatewayTlsParams(
  config: WearGatewayConfig,
  pinStore: WearGatewayTlsPinStore,
): WearGatewayTlsParams? {
  if (!config.useTls) return null
  val stableId = resolveWearGatewayStableId(config)
  val expectedFingerprint = pinStore.load(stableId)?.trim()?.ifEmpty { null }
  return WearGatewayTlsParams(
    expectedFingerprint = expectedFingerprint,
    stableId = stableId,
  )
}

internal fun buildWearGatewayTlsConfig(
  params: WearGatewayTlsParams,
  onStore: ((String) -> Unit)? = null,
  baseTrustManager: X509TrustManager = defaultTrustManager(),
): WearGatewayTlsConfig {
  val expected = params.expectedFingerprint?.let(::normalizeFingerprint)
  @SuppressLint("CustomX509TrustManager")
  val trustManager =
    object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        baseTrustManager.checkClientTrusted(chain, authType)
      }

      override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
        if (chain.isEmpty()) throw CertificateException("empty certificate chain")
        val fingerprint = sha256Hex(chain[0].encoded)
        if (expected != null) {
          if (fingerprint != expected) {
            throw CertificateException("gateway TLS fingerprint mismatch")
          }
          return
        }
        // Without an explicit pin, rely on the platform trust store and do
        // not persist a first-seen certificate fingerprint implicitly.
        baseTrustManager.checkServerTrusted(chain, authType)
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> = baseTrustManager.acceptedIssuers
    }

  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(trustManager), SecureRandom())
  val hostnameVerifier =
    if (expected != null) {
      // Explicitly pinned flows intentionally allow IP-based/manual host connections.
      HostnameVerifier { _, _ -> true }
    } else {
      HttpsURLConnection.getDefaultHostnameVerifier()
    }
  return WearGatewayTlsConfig(
    sslSocketFactory = context.socketFactory,
    trustManager = trustManager,
    hostnameVerifier = hostnameVerifier,
  )
}

private fun defaultTrustManager(): X509TrustManager {
  val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
  factory.init(null as java.security.KeyStore?)
  val trust = factory.trustManagers.firstOrNull { it is X509TrustManager } as? X509TrustManager
  return trust ?: throw IllegalStateException("No default X509TrustManager found")
}

private fun sha256Hex(data: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(data)
  val out = StringBuilder(digest.size * 2)
  for (byte in digest) {
    out.append(String.format(Locale.US, "%02x", byte))
  }
  return out.toString()
}

private fun normalizeFingerprint(raw: String): String {
  val stripped =
    raw.trim().replace(Regex("^sha-?256\\s*:?\\s*", RegexOption.IGNORE_CASE), "")
  return stripped.lowercase(Locale.US).filter { it in '0'..'9' || it in 'a'..'f' }
}
