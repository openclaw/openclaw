package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale

/** Node-only W signer. The caller owns generation and secure persistence of its 32-byte seed. */
class OpenClawIdEnrollmentSigner(
  seed: ByteArray,
) : AutoCloseable {
  private val seedBytes = seed.copyOf().also { require(it.size == 32) { "invalid_seed" } }
  private var closed = false
  val publicKey: String = "ed25519:" + OpenClawIdEnrollmentCrypto.hex(Ed25519PrivateKeyParameters(seedBytes, 0).generatePublicKey().encoded)
  val peerKey: String = "iroh:" + publicKey.substringAfter(':')

  /** Signs the exact v1 statement domain and canonical body. */
  internal fun statement(
    type: String,
    body: JsonObject,
  ): JsonObject =
    buildJsonObject {
      put("v", 1)
      put("type", type)
      put("body", body)
      put("signer", publicKey)
      put("alg", "ed25519")
      put("sig", OpenClawIdEnrollmentCrypto.base64(sign("openclaw/$type/v1\u0000".toByteArray() + OpenClawIdCanonical.encode(body).toByteArray())))
    }

  /** Authenticate the exact method, origin-relative path including query, and transmitted bytes. */
  fun requestSignature(
    method: String,
    path: String,
    body: ByteArray,
    now: Long,
  ): String {
    require(now in 0..999999999999L) { "invalid_timestamp" }
    require(path.startsWith('/') && !path.startsWith("//") && '#' !in path && path.none { it.code < 32 }) { "invalid_request_path" }
    require(Regex("[A-Za-z]+").matches(method)) { "invalid_method" }
    val parts =
      buildJsonObject {
        put("body_sha256", OpenClawIdEnrollmentCrypto.hex(OpenClawIdEnrollmentCrypto.sha256(body)))
        put("method", method.uppercase(Locale.ROOT))
        put("path", path)
        put("ts", now)
      }
    val signature = sign("openclaw/discovery-request/v1\u0000".toByteArray() + OpenClawIdCanonical.encode(parts).toByteArray())
    return "keyid=$publicKey,ts=$now,sig=${OpenClawIdEnrollmentCrypto.base64(signature)}"
  }

  // BC lightweight Ed25519 avoids platform-provider differences on Android.
  private fun sign(bytes: ByteArray): ByteArray {
    check(!closed) { "signer_closed" }
    val signer = Ed25519Signer()
    signer.init(true, Ed25519PrivateKeyParameters(seedBytes, 0))
    signer.update(bytes, 0, bytes.size)
    return signer.generateSignature()
  }

  /** Erases this signer's seed copy; does not mutate caller-owned persisted bytes. */
  override fun close() {
    seedBytes.fill(0)
    closed = true
  }

  override fun toString(): String = "OpenClawIdEnrollmentSigner([redacted])"
}

/** Shared byte primitives for the enrollment and trust boundaries. */
internal object OpenClawIdEnrollmentCrypto {
  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

  fun unhex(text: String): ByteArray {
    require(text.length % 2 == 0 && Regex("[0-9a-f]*").matches(text)) { "invalid_hex" }
    return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
  }

  fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

  fun base64(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  fun decode64(
    text: String,
    size: Int,
  ): ByteArray {
    require(Regex("[A-Za-z0-9_-]+").matches(text)) { "invalid_base64" }
    val bytes =
      try {
        Base64.getUrlDecoder().decode(text)
      } catch (_: IllegalArgumentException) {
        throw IllegalArgumentException("invalid_base64")
      }
    require(bytes.size == size && base64(bytes) == text) { "invalid_base64" }
    return bytes
  }

  fun proofKey(secret: ByteArray): ByteArray {
    val hkdf = HKDFBytesGenerator(SHA256Digest())
    hkdf.init(HKDFParameters(secret, "openclaw/invite/v1".toByteArray(), "proof-key".toByteArray()))
    return ByteArray(32).also { hkdf.generateBytes(it, 0, it.size) }
  }

  fun hmac(
    key: ByteArray,
    bytes: ByteArray,
  ): ByteArray {
    val mac = HMac(SHA256Digest())
    mac.init(KeyParameter(key))
    mac.update(bytes, 0, bytes.size)
    return ByteArray(32).also { mac.doFinal(it, 0) }
  }

  fun verify(
    key: String,
    bytes: ByteArray,
    signature: String,
  ): Boolean {
    val verifier = Ed25519Signer()
    verifier.init(false, Ed25519PublicKeyParameters(unhex(key.substringAfter(':')), 0))
    verifier.update(bytes, 0, bytes.size)
    return verifier.verifySignature(decode64(signature, 64))
  }
}
