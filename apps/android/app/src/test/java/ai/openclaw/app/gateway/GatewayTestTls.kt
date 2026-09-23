package ai.openclaw.app.gateway

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
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.util.Date
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory

internal fun gatewayTestTls(): Pair<SSLSocketFactory, String> {
  val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
  val algorithm = AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE)
  val subject = X500Name("CN=source-favicon-test")
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
  val certificate = CertificateFactory.getInstance("X.509").generateCertificate(encoded.inputStream())
  val password = charArrayOf()
  val keyStore =
    KeyStore.getInstance("PKCS12").apply {
      load(null, null)
      setKeyEntry("server", keyPair.private, password, arrayOf(certificate))
    }
  val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, password) }
  val factory = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) }.socketFactory
  val fingerprint = MessageDigest.getInstance("SHA-256").digest(encoded).joinToString("") { "%02x".format(it) }
  return factory to fingerprint
}
