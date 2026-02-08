package ai.openclaw.android.gateway

import android.content.Context
import android.util.Base64
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Security
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.SecureRandom

@Serializable
data class DeviceIdentity(
  val deviceId: String,
  val publicKeyRawBase64: String,
  val privateKeyPkcs8Base64: String,
  val createdAtMs: Long,
)

class DeviceIdentityStore(context: Context) {
  private val json = Json { ignoreUnknownKeys = true }
  private val identityFile = File(context.filesDir, "openclaw/identity/device.json")

  init {
    if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
      Security.addProvider(BouncyCastleProvider())
    }
  }

  @Synchronized
  fun loadOrCreate(): DeviceIdentity {
    val existing = load()
    if (existing != null) {
      val derived = deriveDeviceId(existing.publicKeyRawBase64)
      if (derived != null && derived != existing.deviceId) {
        val updated = existing.copy(deviceId = derived)
        save(updated)
        return updated
      }
      return existing
    }
    val fresh = generate()
    save(fresh)
    return fresh
  }

  fun signPayload(payload: String, identity: DeviceIdentity): String? {
    val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)

    // Try system JCA provider first (expects PKCS8 encoded key)
    if (privateKeyBytes.size > 32) {
      try {
        val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
        val keyFactory = KeyFactory.getInstance("Ed25519")
        val privateKey = keyFactory.generatePrivate(keySpec)
        val signature = Signature.getInstance("Ed25519")
        signature.initSign(privateKey)
        signature.update(payload.toByteArray(Charsets.UTF_8))
        return base64UrlEncode(signature.sign())
      } catch (_: Throwable) {
        // Fall through to BouncyCastle
      }
    }

    // Fall back to BouncyCastle lightweight API (expects raw 32-byte key)
    return try {
      val rawPrivateKey = if (privateKeyBytes.size == 32) {
        privateKeyBytes
      } else {
        stripPkcs8PrivateKeyPrefix(privateKeyBytes)
      }
      val privateKeyParams = Ed25519PrivateKeyParameters(rawPrivateKey, 0)
      val signer = Ed25519Signer()
      signer.init(true, privateKeyParams)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      signer.update(payloadBytes, 0, payloadBytes.size)
      base64UrlEncode(signer.generateSignature())
    } catch (_: Throwable) {
      null
    }
  }

  private fun stripPkcs8PrivateKeyPrefix(pkcs8: ByteArray): ByteArray {
    // Ed25519 PKCS8 structure: prefix + 32-byte raw key
    // The prefix is typically 16 bytes for Ed25519
    if (pkcs8.size == ED25519_PKCS8_PREFIX.size + 32 &&
      pkcs8.copyOfRange(0, ED25519_PKCS8_PREFIX.size).contentEquals(ED25519_PKCS8_PREFIX)
    ) {
      return pkcs8.copyOfRange(ED25519_PKCS8_PREFIX.size, pkcs8.size)
    }
    // If we can't parse it, return as-is and let BouncyCastle fail with a clear error
    return pkcs8
  }

  fun publicKeyBase64Url(identity: DeviceIdentity): String? {
    return try {
      val raw = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      base64UrlEncode(raw)
    } catch (_: Throwable) {
      null
    }
  }

  private fun load(): DeviceIdentity? {
    return readIdentity(identityFile)
  }

  private fun readIdentity(file: File): DeviceIdentity? {
    return try {
      if (!file.exists()) return null
      val raw = file.readText(Charsets.UTF_8)
      val decoded = json.decodeFromString(DeviceIdentity.serializer(), raw)
      if (decoded.deviceId.isBlank() ||
        decoded.publicKeyRawBase64.isBlank() ||
        decoded.privateKeyPkcs8Base64.isBlank()
      ) {
        null
      } else {
        decoded
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun save(identity: DeviceIdentity) {
    try {
      identityFile.parentFile?.mkdirs()
      val encoded = json.encodeToString(DeviceIdentity.serializer(), identity)
      identityFile.writeText(encoded, Charsets.UTF_8)
    } catch (_: Throwable) {
      // best-effort only
    }
  }

  private fun generate(): DeviceIdentity {
    // Try system Ed25519 first, fall back to BouncyCastle if it fails
    return try {
      val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
      val spki = keyPair.public.encoded
      val rawPublic = stripSpkiPrefix(spki)
      val deviceId = sha256Hex(rawPublic)
      val privateKey = keyPair.private.encoded
      DeviceIdentity(
        deviceId = deviceId,
        publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
        privateKeyPkcs8Base64 = Base64.encodeToString(privateKey, Base64.NO_WRAP),
        createdAtMs = System.currentTimeMillis(),
      )
    } catch (_: Throwable) {
      generateWithBouncyCastle()
    }
  }

  private fun generateWithBouncyCastle(): DeviceIdentity {
    val generator = Ed25519KeyPairGenerator()
    generator.init(Ed25519KeyGenerationParameters(SecureRandom()))
    val keyPair = generator.generateKeyPair()
    val publicKeyParams = keyPair.public as Ed25519PublicKeyParameters
    val privateKeyParams = keyPair.private as Ed25519PrivateKeyParameters
    val rawPublic = publicKeyParams.encoded
    val rawPrivate = privateKeyParams.encoded
    val deviceId = sha256Hex(rawPublic)
    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(rawPrivate, Base64.NO_WRAP),
      createdAtMs = System.currentTimeMillis(),
    )
  }

  private fun deriveDeviceId(publicKeyRawBase64: String): String? {
    return try {
      val raw = Base64.decode(publicKeyRawBase64, Base64.DEFAULT)
      sha256Hex(raw)
    } catch (_: Throwable) {
      null
    }
  }

  private fun stripSpkiPrefix(spki: ByteArray): ByteArray {
    if (spki.size == ED25519_SPKI_PREFIX.size + 32 &&
      spki.copyOfRange(0, ED25519_SPKI_PREFIX.size).contentEquals(ED25519_SPKI_PREFIX)
    ) {
      return spki.copyOfRange(ED25519_SPKI_PREFIX.size, spki.size)
    }
    return spki
  }

  private fun sha256Hex(data: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(data)
    val out = StringBuilder(digest.size * 2)
    for (byte in digest) {
      out.append(String.format("%02x", byte))
    }
    return out.toString()
  }

  private fun base64UrlEncode(data: ByteArray): String {
    return Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  }

  companion object {
    // SPKI prefix for Ed25519 public keys (12 bytes)
    private val ED25519_SPKI_PREFIX =
      byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      )

    // PKCS8 prefix for Ed25519 private keys (16 bytes)
    // 30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20
    private val ED25519_PKCS8_PREFIX =
      byteArrayOf(
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
      )
  }
}
