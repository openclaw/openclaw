package com.clawdbot.android.bridge

import android.annotation.SuppressLint
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

data class BridgeTlsParams(
  val required: Boolean,
  val expectedFingerprint: String?,
  val allowTOFU: Boolean,
  val stableId: String,
)

fun createBridgeSocket(params: BridgeTlsParams?, onStore: ((String) -> Unit)? = null): Socket {
  if (params == null) return Socket()
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
            throw CertificateException("bridge TLS fingerprint mismatch")
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

  val context = SSLContext.getInstance("TLS")
  context.init(null, arrayOf(trustManager), SecureRandom())
  return context.socketFactory.createSocket()
}

fun startTlsHandshakeIfNeeded(socket: Socket) {
  if (socket is SSLSocket) {
    socket.startHandshake()
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
    out.append(String.format("%02x", byte))
  }
  return out.toString()
}

private fun normalizeFingerprint(raw: String): String {
  return raw.lowercase().filter { it in '0'..'9' || it in 'a'..'f' }
}
