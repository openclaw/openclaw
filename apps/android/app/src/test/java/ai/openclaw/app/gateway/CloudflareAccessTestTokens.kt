package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.util.Base64

internal object CloudflareAccessTestTokens {
  val application = CloudflareAccessApplication(CloudflareAccessOrigin.from("https://gateway.example.test:8443"), CloudflareAccessJWT.issuer("example.cloudflareaccess.com"), "test-audience")
  private val key = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
  private val publicKey = key.public as RSAPublicKey

  private fun unsigned(value: BigInteger): ByteArray = value.toByteArray().let { if (it.first() == 0.toByte()) it.copyOfRange(1, it.size) else it }

  private fun encode(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)

  val jwks =
    JsonObject(
      mapOf(
        "keys" to
          JsonArray(
            listOf(
              JsonObject(
                mapOf(
                  "kty" to JsonPrimitive("RSA"),
                  "kid" to JsonPrimitive("test-key"),
                  "alg" to JsonPrimitive("RS256"),
                  "use" to JsonPrimitive("sig"),
                  "n" to JsonPrimitive(encode(unsigned(publicKey.modulus))),
                  "e" to JsonPrimitive(encode(unsigned(publicKey.publicExponent))),
                ),
              ),
            ),
          ),
      ),
    ).toString().toByteArray()

  fun token(
    claims: JsonObject,
    algorithm: String = "RS256",
  ): String {
    val header = JsonObject(mapOf("alg" to JsonPrimitive(algorithm), "kid" to JsonPrimitive("test-key")))
    val message = "${encode(header.toString().toByteArray())}.${encode(claims.toString().toByteArray())}"
    val signature =
      Signature
        .getInstance("SHA256withRSA")
        .apply {
          initSign(key.private)
          update(message.toByteArray())
        }.sign()
    return "$message.${encode(signature)}"
  }

  fun claims(
    subject: String = "test-subject",
    expires: Double = System.currentTimeMillis() / 1000.0 + 3600,
  ): JsonObject =
    JsonObject(
      mapOf(
        "iss" to JsonPrimitive(application.issuer.toString()),
        "aud" to JsonArray(listOf(JsonPrimitive(application.audience))),
        "type" to JsonPrimitive("app"),
        "sub" to JsonPrimitive(subject),
        "exp" to JsonPrimitive(expires),
      ),
    )

  fun session(
    subject: String = "test-subject",
    expires: Double = System.currentTimeMillis() / 1000.0 + 3600,
  ): CloudflareAccessSession = CloudflareAccessSession(application, subject, expires, token(claims(subject, expires)))

  fun metadata(hostname: String = application.origin.uri.host): String =
    token(
      JsonObject(
        mapOf(
          "type" to JsonPrimitive("match"),
          "hostname" to JsonPrimitive(hostname),
          "auth_domain" to JsonPrimitive(application.issuer.host),
          "aud" to JsonPrimitive(application.audience),
          "iat" to JsonPrimitive(System.currentTimeMillis() / 1000.0),
        ),
      ),
    )
}
