package ai.openclaw.app.gateway

import java.security.KeyStore
import java.security.cert.Certificate
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

internal fun syntheticPlatformTrust(vararg anchors: Certificate): X509TrustManager {
  val keyStore =
    KeyStore.getInstance("PKCS12").apply {
      load(null, null)
      anchors.forEachIndexed { index, anchor -> setCertificateEntry("synthetic-ca-$index", anchor) }
    }
  return TrustManagerFactory
    .getInstance(TrustManagerFactory.getDefaultAlgorithm())
    .apply { init(keyStore) }
    .trustManagers
    .filterIsInstance<X509TrustManager>()
    .first()
}
