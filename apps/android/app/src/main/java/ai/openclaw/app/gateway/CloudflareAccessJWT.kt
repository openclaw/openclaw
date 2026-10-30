package ai.openclaw.app.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import java.math.BigInteger
import java.net.URI
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.RSAPublicKeySpec
import java.util.Base64
import java.util.Locale

/** Cloudflare's signed discovery and app tokens use RS256, verified by the platform provider. */
internal object CloudflareAccessJWT {
  data class Claims(
    val subject: String,
    val expiresAt: Double,
  )

  fun issuer(authDomain: String): URI {
    val host = authDomain.lowercase(Locale.ROOT)
    if (!Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com").matches(host)) invalid()
    return URI("https://$host")
  }

  fun application(
    token: String,
    origin: CloudflareAccessOrigin,
    now: Double = System.currentTimeMillis() / 1000.0,
  ): CloudflareAccessApplication {
    val metadata = decode(token)
    val audience = metadata.string("aud")
    val issuedAt = metadata.number("iat")
    if (
      metadata.string("type") != "match" || metadata.string("hostname").lowercase(Locale.ROOT) != origin.uri.host ||
      audience.isEmpty() || audience.length > 512 || issuedAt <= 0 || issuedAt < now - 86400 || issuedAt > now + 300
    ) {
      invalid()
    }
    return CloudflareAccessApplication(origin, issuer(metadata.string("auth_domain")), audience)
  }

  fun appClaims(
    token: String,
    application: CloudflareAccessApplication,
    now: Double = System.currentTimeMillis() / 1000.0,
  ): Claims {
    val claims = decode(token)
    val audience =
      when (val value = claims["aud"]) {
        is JsonPrimitive -> if (value.isString) listOf(value.content) else invalid()
        is JsonArray -> value.map { (it as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content ?: invalid() }
        else -> invalid()
      }
    val subject = claims.string("sub")
    val expiresAt = claims.number("exp")
    val notBefore = if (claims.containsKey("nbf")) claims.number("nbf") else null
    if (
      issuer(application.issuer.host.orEmpty()) != application.issuer || claims.string("iss") != application.issuer.toString() ||
      audience.size > 16 || application.audience !in audience || claims.string("type") != "app" ||
      subject.isEmpty() || subject.length > 512 || expiresAt <= now || (notBefore != null && notBefore > now)
    ) {
      invalid()
    }
    return Claims(subject, expiresAt)
  }

  fun verify(
    token: String,
    jwks: ByteArray,
  ) {
    val parts = parts(token)
    val header = parse(base64URL(parts[0]))
    val keys = parse(jwks)["keys"] as? JsonArray ?: invalid()
    if (keys.size > 64) invalid()
    val key =
      keys.mapNotNull { it as? JsonObject }.firstOrNull {
        it.stringOrNull("kid") == header.string("kid") && it.stringOrNull("kty") == "RSA" &&
          (it["alg"] == null || it.string("alg") == "RS256") && (it["use"] == null || it.string("use") == "sig")
      } ?: invalid()
    val modulus = base64URL(key.string("n"))
    val exponent = base64URL(key.string("e"))
    if (modulus.size !in 256..1024 || exponent.size !in 1..8) invalid()
    val publicKey = KeyFactory.getInstance("RSA").generatePublic(RSAPublicKeySpec(BigInteger(1, modulus), BigInteger(1, exponent)))
    val verifier = Signature.getInstance("SHA256withRSA")
    verifier.initVerify(publicKey)
    verifier.update("${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII))
    if (!verifier.verify(base64URL(parts[2]))) invalid()
  }

  // Decode only to select the constrained issuer, or recheck a token already verified at admission.
  private fun decode(token: String): JsonObject = parse(base64URL(parts(token)[1]))

  private fun parts(token: String): List<String> {
    if (token.length > 32768) invalid()
    val parts = token.split('.')
    if (parts.size != 3) invalid()
    val header = parse(base64URL(parts[0]))
    val critical = header["crit"]
    if (
      header.string("alg") != "RS256" || header.string("kid").isEmpty() || header.string("kid").length > 512 ||
      (critical != null && (critical !is JsonArray || critical.isNotEmpty()))
    ) {
      invalid()
    }
    return parts
  }

  private fun base64URL(value: String): ByteArray {
    if (value.isEmpty() || !value.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }) invalid()
    return try {
      Base64.getUrlDecoder().decode(value)
    } catch (_: IllegalArgumentException) {
      invalid()
    }
  }

  private fun parse(bytes: ByteArray): JsonObject =
    try {
      Json.parseToJsonElement(bytes.decodeToString(throwOnInvalidSequence = true)).jsonObject
    } catch (_: IllegalArgumentException) {
      invalid()
    }

  private fun JsonObject.stringOrNull(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf(JsonPrimitive::isString)?.content

  private fun JsonObject.string(key: String): String = stringOrNull(key) ?: invalid()

  private fun JsonObject.number(key: String): Double = (this[key] as? JsonPrimitive)?.takeUnless(JsonPrimitive::isString)?.doubleOrNull?.takeIf(Double::isFinite) ?: invalid()

  private fun invalid(): Nothing = throw CloudflareAccessException(CloudflareAccessException.Kind.InvalidSession)
}
