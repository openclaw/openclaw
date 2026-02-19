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
import org.conscrypt.Conscrypt
import org.bouncycastle.crypto.Signer
import org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator
import org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.PrivateKeyFactory
import org.bouncycastle.crypto.util.PrivateKeyInfoFactory
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory
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
    val payloadBytes = payload.toByteArray(Charsets.UTF_8)

    // 1) Try JCA (fast path)
    try {
      ensureEd25519Provider()
      val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
      val keyFactory = KeyFactory.getInstance("Ed25519")
      val privateKey = keyFactory.generatePrivate(keySpec)
      val signature = Signature.getInstance("Ed25519")
      signature.initSign(privateKey)
      signature.update(payloadBytes)
      return base64UrlEncode(signature.sign())
    } catch (_: Throwable) {
      // fall through
    }

    // 2) Fallback: BouncyCastle pure-Java Ed25519 signing (works even if JCA Ed25519 is missing)
    return try {
      val privateKeyPkcs8 = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val keyParam = PrivateKeyFactory.createKey(privateKeyPkcs8)
      val signer: Signer = Ed25519Signer()
      signer.init(true, keyParam)
      signer.update(payloadBytes, 0, payloadBytes.size)
      base64UrlEncode(signer.generateSignature())
    } catch (_: Throwable) {
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
    // Some Android/HarmonyOS builds don't ship Ed25519 KeyPairGenerator.
    // Try JCA first; if unavailable, fall back to BouncyCastle pure-Java Ed25519 keygen.
    ensureEd25519Provider()

    val (spki, privateKeyPkcs8) = try {
      val keyPair = KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
      Pair(keyPair.public.encoded, keyPair.private.encoded)
    } catch (_: Throwable) {
      generateEd25519WithBouncyCastle()
    }

    val rawPublic = stripSpkiPrefix(spki)
    val deviceId = sha256Hex(rawPublic)

    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(privateKeyPkcs8, Base64.NO_WRAP),
      createdAtMs = System.currentTimeMillis(),
    )
  }

  private fun generateEd25519WithBouncyCastle(): Pair<ByteArray, ByteArray> {
    val gen = Ed25519KeyPairGenerator()
    gen.init(Ed25519KeyGenerationParameters(SecureRandom()))
    val kp = gen.generateKeyPair()
    val priv = kp.private as Ed25519PrivateKeyParameters
    val pub = kp.public as Ed25519PublicKeyParameters

    val spki = SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(pub).encoded
    val pkcs8 = PrivateKeyInfoFactory.createPrivateKeyInfo(priv).encoded
    return Pair(spki, pkcs8)
  }

  private fun ensureEd25519Provider() {
    // If Ed25519 already works, do nothing.
    try {
      KeyPairGenerator.getInstance("Ed25519")
      return
    } catch (_: Throwable) {
      // fall through
    }

    try {
      // Conscrypt provides Ed25519 on many devices that otherwise lack it.
      val provider = Conscrypt.newProvider()
      Security.insertProviderAt(provider, 1)
      // Trigger lookup so any failure surfaces early.
      KeyPairGenerator.getInstance("Ed25519")
    } catch (_: Throwable) {
      // best-effort
    }
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
    private val ED25519_SPKI_PREFIX =
      byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      )
  }
}
