package ai.openclaw.android.gateway

import android.annotation.SuppressLint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.net.InetSocketAddress
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

data class GatewayTlsParams(
  val required: Boolean,
  val expectedFingerprint: String?,
  val allowTOFU: Boolean,
  val stableId: String,
)

data class GatewayTlsConfig(
  val sslSocketFactory: SSLSocketFactory,
  val trustManager: X509TrustManager,
  val hostnameVerifier: HostnameVerifier,
)

/**
 * Builds a TLS configuration for gateway connections.
 *
 * Security Model:
 * - Fingerprint Pinning: If `expectedFingerprint` is provided, ONLY certificates matching the
 *   SHA-256 fingerprint are trusted. This is the most secure option.
 * - TOFU (Trust On First Use): If `allowTOFU` is true, the first certificate is trusted and its
 *   fingerprint is stored via `onStore`. Subsequent connections must match this fingerprint.
 *   WARNING: Only use TOFU in controlled environments (e.g., internal networks), as the first
 *   connection is vulnerable to MITM.
 * - Fallback: If neither pinning nor TOFU is used, the system's default trust manager is used.
 *
 * Hostname Verification:
 * - Disabled for pinned/TOFU connections because service discovery often returns IPs.
 * - Uses the system's default verifier otherwise.
 */
fun buildGatewayTlsConfig(
  params: GatewayTlsParams?,
  onStore: ((String) -> Unit)? = null,
): GatewayTlsConfig? {
  if (params == null) return null
  val expected = params.expectedFingerprint?.let(::normalizeFingerprint)
  val defaultTrust = defaultTrustManager()
  @SuppressLint("CustomX509TrustManager")
  val trustManager =
    object : X509TrustManager {
      override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {
        defaultTrust.checkClientTrusted(chain, authType)
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
        if (params.allowTOFU) {
          onStore?.invoke(fingerprint)
          return
        }
        defaultTrust.checkServerTrusted(chain, authType)
      }

      override fun getAcceptedIssuers(): Array<X509Certificate> = defaultTrust.acceptedIssuers
    }

  // Explicitly enforce TLSv1.2 to address SonarCloud warning and future-proof the implementation
  val context = SSLContext.getInstance("TLSv1.2")
  context.init(null, arrayOf(trustManager), SecureRandom())
  val verifier =
    if (expected != null || params.allowTOFU) {
      // When pinning, we intentionally ignore hostname mismatch (service discovery often yields IPs).
      HostnameVerifier { _, _ -> true }
    } else {
      HttpsURLConnection.getDefaultHostnameVerifier()
    }
  return GatewayTlsConfig(
    sslSocketFactory = context.socketFactory,
    trustManager = trustManager,
    hostnameVerifier = verifier,
  )
}

/**
 * Probes a server's TLS fingerprint for diagnostic purposes.
 *
 * WARNING: This function uses a TrustAllX509TrustManager and MUST NOT be used
 * in production. It is ONLY for fingerprint discovery in controlled environments.
 */
suspend fun probeGatewayTlsFingerprint(
  host: String,
  port: Int,
  timeoutMs: Int = 3_000,
): String? {
  val trimmedHost = host.trim()
  if (trimmedHost.isEmpty()) return null
  if (port !in 1..65535) return null

  return withContext(Dispatchers.IO) {
    val trustAll =
      @SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
      object : X509TrustManager {
        @SuppressLint("TrustAllX509TrustManager")
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
        @SuppressLint("TrustAllX509TrustManager")
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      }

    // Explicitly enforce TLSv1.2 for diagnostic connections as well
    val context = SSLContext.getInstance("TLSv1.2")
    context.init(null, arrayOf(trustAll), SecureRandom())

    val socket = (context.socketFactory.createSocket() as SSLSocket)
    try {
      socket.soTimeout = timeoutMs
      socket.connect(InetSocketAddress(trimmedHost, port), timeoutMs)

      // Best-effort SNI for hostnames (avoid crashing on IP literals).
      try {
        if (trimmedHost.any { it.isLetter() }) {
          val params = SSLParameters()
          params.serverNames = listOf(SNIHostName(trimmedHost))
          socket.sslParameters = params
        }
      } catch (_: Throwable) {
        // ignore
      }

      socket.startHandshake()
      val cert = socket.session.peerCertificates.firstOrNull() as? X509Certificate ?: return@withContext null
      sha256Hex(cert.encoded)
    } catch (_: Throwable) {
      null
    } finally {
      try {
        socket.close()
      } catch (_: Throwable) {
        // ignore
      }
    }
  }
}

private fun defaultTrustManager(): X509TrustManager {
  val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
  factory.init(null as java.security.KeyStore?)
  val trust =
    factory.trustManagers.firstOrNull { it is X509TrustManager } as? X509TrustManager
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
  val stripped = raw.trim()
    .replace(Regex("^sha-?256\\s*:?\\s*", RegexOption.IGNORE_CASE), "")
  return stripped.lowercase(Locale.US).filter { it in '0'..'9' || it in 'a'..'f' }
}
