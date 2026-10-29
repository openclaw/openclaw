/*
 * Copyright (c) 2026 OkHttp Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package ai.openclaw.app.gateway

import kotlinx.coroutines.CompletableDeferred
import okhttp3.Call
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.bouncycastle.asn1.ASN1Integer
import org.bouncycastle.asn1.DERBitString
import org.bouncycastle.asn1.DERNull
import org.bouncycastle.asn1.pkcs.PKCSObjectIdentifiers
import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.AlgorithmIdentifier
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.ExtensionsGenerator
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.asn1.x509.SubjectPublicKeyInfo
import org.bouncycastle.asn1.x509.Time
import org.bouncycastle.asn1.x509.V3TBSCertificateGenerator
import org.bouncycastle.asn1.x509.Validity
import org.bouncycastle.asn1.x9.X9ObjectIdentifiers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import java.io.IOException
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Date
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSocketFactory

internal data class GatewayTlsTestFixture(
  val socketFactory: SSLSocketFactory,
  val leaf: X509Certificate,
  val blockedIntermediate: X509Certificate? = null,
) {
  val blockedIntermediateSpki: String? = blockedIntermediate?.let { tlsTestSha256(it.publicKey.encoded) }
  val fingerprint: String = tlsTestSha256(leaf.encoded)
  val wrongFingerprint: String = fingerprint.replaceRange(0, 1, if (fingerprint.first() == '0') "1" else "0")
}

/** Public upstream fixture adapted for owned loopback servers, BC/JCA and JUnit 4. */
internal fun gatewayTlsTestFixture(
  blocklisted: Boolean = false,
  platformTrusted: Boolean = false,
): GatewayTlsTestFixture {
  val keyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
  val subject = X500Name("CN=localhost")
  val intermediate =
    when {
      blocklisted -> decodeTlsTestCertificate(COMPROMISED_INTERMEDIATE)
      platformTrusted -> decodeTlsTestCertificate(NATIVE_TEST_ROOT)
      else -> null
    }
  val issuer = intermediate?.let { X500Name.getInstance(it.subjectX500Principal.encoded) } ?: subject
  val signingKey = if (intermediate != null) publicFixtureIntermediateKey(if (blocklisted) "4" else "8") else keyPair.private
  val algorithm =
    if (intermediate != null) {
      AlgorithmIdentifier(X9ObjectIdentifiers.ecdsa_with_SHA384)
    } else {
      AlgorithmIdentifier(PKCSObjectIdentifiers.sha256WithRSAEncryption, DERNull.INSTANCE)
    }
  val now = System.currentTimeMillis()
  val extensions =
    ExtensionsGenerator().apply {
      addExtension(Extension.subjectAlternativeName, false, GeneralNames(GeneralName(GeneralName.dNSName, "localhost")))
    }
  val tbs =
    V3TBSCertificateGenerator()
      .apply {
        setSerialNumber(ASN1Integer.ONE)
        setSignature(algorithm)
        setIssuer(issuer)
        setSubject(subject)
        setValidity(Validity(Time(Date(now - 60_000)), Time(Date(now + 86_400_000))))
        setSubjectPublicKeyInfo(SubjectPublicKeyInfo.getInstance(keyPair.public.encoded))
        setExtensions(extensions.generate())
      }.generateTBSCertificate()
  val signature =
    Signature.getInstance(if (intermediate != null) "SHA384withECDSA" else "SHA256withRSA").apply {
      initSign(signingKey)
      update(tbs.encoded)
    }
  val encoded =
    org.bouncycastle.asn1.x509
      .Certificate(tbs, algorithm, DERBitString(signature.sign()))
      .encoded
  val leaf = CertificateFactory.getInstance("X.509").generateCertificate(encoded.inputStream()) as X509Certificate
  val root = if (blocklisted) decodeTlsTestCertificate(COMPROMISED_ROOT) else null
  leaf.checkValidity()
  leaf.verify(intermediate?.publicKey ?: keyPair.public)
  if (intermediate != null && root != null) {
    // Bind the public regression fixture to independently verified incident identities.
    assertEquals("cb6e15165ac802e9b3f993f16c25d41f4e81c21ebde71ae1b012ac00bf9c7c3f", tlsTestSha256(intermediate.encoded))
    assertEquals("63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8", tlsTestSha256(intermediate.publicKey.encoded))
    intermediate.verify(root.publicKey)
  }
  val chain = listOfNotNull(leaf, intermediate, root)
  val password = charArrayOf()
  val keyStore =
    KeyStore.getInstance("PKCS12").apply {
      load(null, null)
      setKeyEntry("localhost", keyPair.private, password, chain.toTypedArray())
    }
  val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keyStore, password) }
  val context = SSLContext.getInstance("TLS").apply { init(managers.keyManagers, null, null) }
  return GatewayTlsTestFixture(context.socketFactory, leaf, if (blocklisted) intermediate else null)
}

/** Observes the production client's raw chain without replacing its trust or hostname policy. */
internal class GatewayTlsTestObservation {
  val failure = CompletableDeferred<Throwable>()
  val peerCertificates = AtomicReference<List<X509Certificate>>(emptyList())
  val hostnameAccepted = AtomicBoolean(false)

  fun observe(client: OkHttpClient): OkHttpClient {
    val verifier = client.hostnameVerifier
    return client
      .newBuilder()
      .hostnameVerifier { host, session ->
        peerCertificates.set(session.peerCertificates.map { it as X509Certificate })
        verifier.verify(host, session).also { hostnameAccepted.set(it) }
      }.eventListener(
        object : EventListener() {
          override fun callFailed(
            call: Call,
            ioe: IOException,
          ) {
            failure.complete(ioe)
          }
        },
      ).build()
  }

  // RealWebSocket disables EventListener; observe its failure at the delivered callback instead.
  fun observeWebSocket(listener: WebSocketListener): WebSocketListener =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) = listener.onOpen(webSocket, response)

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) = listener.onMessage(webSocket, text)

      override fun onMessage(
        webSocket: WebSocket,
        bytes: ByteString,
      ) = listener.onMessage(webSocket, bytes)

      override fun onClosing(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) = listener.onClosing(webSocket, code, reason)

      override fun onClosed(
        webSocket: WebSocket,
        code: Int,
        reason: String,
      ) = listener.onClosed(webSocket, code, reason)

      override fun onFailure(
        webSocket: WebSocket,
        t: Throwable,
        response: Response?,
      ) {
        failure.complete(t)
        listener.onFailure(webSocket, t, response)
      }
    }

  // The native platform rejects this key during TLS, before OkHttp sees a peer chain.
  // Keep this independent from the pinned-path assertion of OkHttp's own gate below.
  fun assertPlatformBlocklisted(
    error: Throwable,
    fixture: GatewayTlsTestFixture,
  ) {
    val intermediate = checkNotNull(fixture.blockedIntermediate)
    val expectedMessage = "Certificate blocklisted by public key: $intermediate"
    assertTrue(
      "Conscrypt must reject the exact verified incident certificate key; original failure:\n${error.stackTraceToString()}",
      error.tlsTestCauses().any { cause ->
        cause is CertificateException &&
          cause.message == expectedMessage &&
          cause.stackTrace.any { it.className == "com.android.org.conscrypt.TrustManagerImpl" && it.methodName == "checkBlocklist" }
      },
    )
    assertFalse(hostnameAccepted.get())
    assertTrue(peerCertificates.get().isEmpty())
  }

  fun assertBlocklisted(
    error: Throwable,
    fixture: GatewayTlsTestFixture,
  ) {
    assertTrue(
      "TLS and the production hostname verifier must accept before OkHttp's gate; original failure:\n${error.stackTraceToString()}",
      hostnameAccepted.get(),
    )
    val chain = peerCertificates.get()
    assertEquals(fixture.fingerprint, chain.firstOrNull()?.let { tlsTestSha256(it.encoded) })
    assertTrue("The blocklisted intermediate must be in the actual raw peer chain", chain.any { tlsTestSha256(it.publicKey.encoded) == fixture.blockedIntermediateSpki })
    assertTrue(
      "Provider-first TLS rejection does not exercise OkHttp's blocklist",
      error.tlsTestCauses().any { it is SSLPeerUnverifiedException && it.message.orEmpty().contains("blocklisted by OkHttp") },
    )
  }
}

internal fun closeGatewayTlsTestClients(vararg clients: OkHttpClient) {
  var failure: Throwable? = null
  for (client in clients) {
    try {
      client.dispatcher.cancelAll()
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdown()
      assertTrue("TLS client workers did not stop", client.dispatcher.executorService.awaitTermination(5, TimeUnit.SECONDS))
    } catch (error: Throwable) {
      val previous = failure
      if (previous == null) failure = error else previous.addSuppressed(error)
    }
  }
  failure?.let { throw it }
}

internal fun Throwable.tlsTestCauses(): List<Throwable> = listOf(this) + listOfNotNull(cause).flatMap { it.tlsTestCauses() } + suppressed.flatMap { it.tlsTestCauses() }

private fun tlsTestSha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

private fun decodeTlsTestCertificate(pem: String): X509Certificate = CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream()) as X509Certificate

// Public regression material, never production trust or an external target. Scalar four
// is the disclosed incident key below; scalar eight is the synthetic native test root.
// https://github.com/lysine-dev/okhttp/blob/parent-5.5.1/okhttp/src/commonTest/kotlin/okhttp3/CompromisedIntermediateTest.kt
private fun publicFixtureIntermediateKey(scalar: String): PrivateKey =
  KeyFactory.getInstance("EC").run {
    val secp384r1 =
      AlgorithmParameters.getInstance("EC").run {
        init(ECGenParameterSpec("secp384r1"))
        getParameterSpec(ECParameterSpec::class.java)
      }
    generatePrivate(ECPrivateKeySpec(java.math.BigInteger(scalar), secp384r1))
  }

private val COMPROMISED_ROOT =
  """
  -----BEGIN CERTIFICATE-----
  MIICKTCCAa+gAwIBAgIQDnYGcvFDRZ/I/gqwvAXjlDAKBggqhkjOPQQDAzBWMQsw
  CQYDVQQGEwJJTjElMCMGA1UECgwcZU11ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRl
  ZDEgMB4GA1UEAwwXZW1TaWduIFJvb3QgVExTIENBIC0gRzMwHhcNMjQwMjA4MDgx
  OTMyWhcNNDkwMjA3MDgxOTMyWjBWMQswCQYDVQQGEwJJTjElMCMGA1UECgwcZU11
  ZGhyYSBUZWNobm9sb2dpZXMgTGltaXRlZDEgMB4GA1UEAwwXZW1TaWduIFJvb3Qg
  VExTIENBIC0gRzMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARfD9w/q1cWxL6D9bMG
  H6CQ4u+gAV6GN9s+PwQx9Bl4hC+0iU8QOk8mWO/RwXQy10DCSxT8vSIJClHKp+Ao
  4qJKdYeV0SwZ7LMQziyLfxIUOY6Grja/sQFwLKYf8EdDXAyjQjBAMB0GA1UdDgQW
  BBThOqshfPHjTVSu1HK3/YtZQiCQVDAOBgNVHQ8BAf8EBAMCAQYwDwYDVR0TAQH/
  BAUwAwEB/zAKBggqhkjOPQQDAwNoADBlAjBhCFTkly7Yl7+s4hiw+k6ZJTXT2AiI
  rvmsmfqPr5E7ecwXb6kXA5LTFd6rjwTuV3sCMQC9w6ZSbVq1mveMO6dKFziOzClT
  KCT2RFT6yXtq6nzgRICgBmiXbJAXsmZ8yAwjyWc=
  -----END CERTIFICATE-----
  """.trimIndent()
private val COMPROMISED_INTERMEDIATE =
  """
  -----BEGIN CERTIFICATE-----
  MIIDaDCCAu6gAwIBAgIPKWkmwiejoVJjkrGUgqUEMAoGCCqGSM49BAMDMFYxCzAJ
  BgNVBAYTAklOMSUwIwYDVQQKDBxlTXVkaHJhIFRlY2hub2xvZ2llcyBMaW1pdGVk
  MSAwHgYDVQQDDBdlbVNpZ24gUm9vdCBUTFMgQ0EgLSBHMzAeFw0yNTA0MzAxNTM3
  NDFaFw00MDA0MjgxODMwMDBaMEAxCzAJBgNVBAYTAlVTMRQwEgYDVQQKDAtlTXVk
  aHJhIEluYzEbMBkGA1UEAwwSRU0gT1YgVExTIENBIC0gRzNDMHYwEAYHKoZIzj0C
  AQYFK4EEACIDYgAEE4JRzVKskpjByKrZdzId65fnCb0LTKCspV3IrVHc/J0ViaFZ
  fjpRIOHv1jHGPhg1ysrimGmmLhYx6KKBgatWYW3EXZGKvAnzqw5jz3kqpNztc4e+
  N7ulaVSfHAKycO1no4IBljCCAZIwHwYDVR0jBBgwFoAU4TqrIXzx401UrtRyt/2L
  WUIgkFQwHQYDVR0OBBYEFDTq6gzryQra+dDF4u2beMmHnhtsMB0GA1UdJQQWMBQG
  CCsGAQUFBwMBBggrBgEFBQcDAjBdBgNVHSAEVjBUMDkGCysGAQQBg44hAQABMCow
  KAYIKwYBBQUHAgEWHGh0dHA6Ly9yZXBvc2l0b3J5LmVtc2lnbi5jb20wDQYLKwYB
  BAGDjiEBAm4wCAYGZ4EMAQICMHUGCCsGAQUFBwEBBGkwZzAkBggrBgEFBQcwAYYY
  aHR0cDovL29jc3AtYy5lbXNpZ24uY29tMD8GCCsGAQUFBzAChjNodHRwOi8vcmVw
  b3NpdG9yeS5lbXNpZ24uY29tL2NlcnRzL0VNT1ZUTFNDQUczQy5wN2MwNwYDVR0f
  BDAwLjAsoCqgKIYmaHR0cDovL2NybC5lbXNpZ24uY29tLz9yb290dGxzY2FnMy5j
  cmwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQAwCgYIKoZIzj0E
  AwMDaAAwZQIxAMSZt2xsPeumRdeSMSQ3CbzIZeQ/q7GDCWfeE1Pq+mhgA6gRM44c
  NVF3xJ+wsxJk+wIwFJbaDMokD8Ei6eNOiA8yUMYvfzQyngmrhZQMdPCK1SewrR79
  4rSb9vGqxZzelQth
  -----END CERTIFICATE-----
  """.trimIndent()

// Synthetic native-emulator root; its public test key is EC scalar eight.
private val NATIVE_TEST_ROOT =
  """
  -----BEGIN CERTIFICATE-----
  MIIB4jCCAWegAwIBAgIUKqR70SrRmPOj4S3fmb/3pMgTPbwwCgYIKoZIzj0EAwMw
  MDEuMCwGA1UEAwwlT3BlbkNsYXcgQW5kcm9pZCBuYXRpdmUgVExTIHRlc3Qgcm9v
  dDAeFw0yNjEwMjkwMjE4NDJaFw00NjEwMjQwMjE4NDJaMDAxLjAsBgNVBAMMJU9w
  ZW5DbGF3IEFuZHJvaWQgbmF0aXZlIFRMUyB0ZXN0IHJvb3QwdjAQBgcqhkjOPQIB
  BgUrgQQAIgNiAAQWkneOpZbgvnURQpem+jg0Rb8if75YGQqQDDxzJW8R+1oyWNb0
  A9Xs5umyadgiyH3c0jZXANQQaoNTiLo9uP0OIlVK3G1SHNS9HDDC7A7sGWut4enN
  0XCNb2q/pAIrCtKjQjBAMB0GA1UdDgQWBBSThGBAeS4OlJMbM21+ljbiYDkSZjAP
  BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAwNpADBm
  AjEAivq+qKceyW7zpkxp3g01Lm6JLlreZiIUrKHBTyd8dAtInXxxcrXDjLeWxnJY
  U7eEAjEAsxqF5FDh26tM1aHNbPhm/uUXxT3+sX81YftNPbvpLIGUXcL0YXcx2T8z
  0CyfAuBh
  -----END CERTIFICATE-----
  """.trimIndent()
