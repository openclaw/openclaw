package ai.openclaw.android.gateway

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
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
  private val logTag = "OpenClaw/DeviceIdentity"

  init {
    ensureBouncyCastle()
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

    // Try system JCA provider first (expects PKCS8-encoded key)
    if (privateKeyBytes.size > 32) {
      try {
        val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
        val keyFactory = KeyFactory.getInstance("Ed25519")
        val privateKey = keyFactory.generatePrivate(keySpec)
        val signature = Signature.getInstance("Ed25519")
        signature.initSign(privateKey)
        signature.update(payload.toByteArray(Charsets.UTF_8))
        return base64UrlEncode(signature.sign())
      } catch (err: Throwable) {
        Log.d(logTag, "System Ed25519 sign failed, falling back to BouncyCastle: ${err.message}")
      }
    }

    // Fall back to BouncyCastle JCE provider for PKCS8 keys, lightweight API for raw keys
    return try {
      if (privateKeyBytes.size == 32) {
        // Legacy raw 32-byte seed — use BC lightweight API directly
        val privateKeyParams = Ed25519PrivateKeyParameters(privateKeyBytes, 0)
        val signer = Ed25519Signer()
        signer.init(true, privateKeyParams)
        val payloadBytes = payload.toByteArray(Charsets.UTF_8)
        signer.update(payloadBytes, 0, payloadBytes.size)
        base64UrlEncode(signer.generateSignature())
      } else {
        // PKCS8-encoded key — use BC's JCE provider to parse it properly
        val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
        val keyFactory = KeyFactory.getInstance("Ed25519", BouncyCastleProvider.PROVIDER_NAME)
        val privateKey = keyFactory.generatePrivate(keySpec)
        val signature = Signature.getInstance("Ed25519", BouncyCastleProvider.PROVIDER_NAME)
        signature.initSign(privateKey)
        signature.update(payload.toByteArray(Charsets.UTF_8))
        base64UrlEncode(signature.sign())
      }
    } catch (err: Throwable) {
      Log.w(logTag, "BouncyCastle Ed25519 sign also failed: ${err.message}")
      null
    }
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
    } catch (err: Throwable) {
      Log.d(logTag, "System Ed25519 keygen failed, using BouncyCastle: ${err.message}")
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
    // Wrap raw 32-byte key in PKCS8 envelope so the stored format is always
    // consistent with system-provider keygen (signPayload expects PKCS8).
    val pkcs8Private = ED25519_PKCS8_PREFIX + rawPrivate
    val deviceId = sha256Hex(rawPublic)
    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(pkcs8Private, Base64.NO_WRAP),
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
    private val ED25519_PKCS8_PREFIX =
      byteArrayOf(
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
      )

    private var bcRegistered = false

    /**
     * Ensures BouncyCastle is registered as a fallback provider.
     * Required on Android versions where native Ed25519 support is missing or broken.
     */
    @Synchronized
    private fun ensureBouncyCastle() {
      if (bcRegistered) return
      if (Security.getProvider(BouncyCastleProvider.PROVIDER_NAME) == null) {
        Security.addProvider(BouncyCastleProvider())
      }
      bcRegistered = true
    }
  }
}
