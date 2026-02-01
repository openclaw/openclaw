package ai.openclaw.android.gateway

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Security
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
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

  init {
    ensureEd25519Provider()
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
    return try {
      val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
      // Must use a software provider — AndroidKeyStore only handles hardware-backed keys.
      val provider = softwareEd25519Provider()
      val keyFactory = KeyFactory.getInstance("Ed25519", provider)
      val privateKey = keyFactory.generatePrivate(keySpec)
      val signature = Signature.getInstance("Ed25519", provider)
      signature.initSign(privateKey)
      signature.update(payload.toByteArray(Charsets.UTF_8))
      base64UrlEncode(signature.sign())
    } catch (err: Throwable) {
      Log.e("DeviceIdentity", "signPayload failed: ${err::class.java.simpleName}: ${err.message}")
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
    val provider = softwareEd25519Provider()
    val keyPair = KeyPairGenerator.getInstance("Ed25519", provider).generateKeyPair()
    val spki = keyPair.public.encoded
    val rawPublic = stripSpkiPrefix(spki)
    val deviceId = sha256Hex(rawPublic)
    val privateKey = keyPair.private.encoded
    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(privateKey, Base64.NO_WRAP),
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
    private val ED25519_SPKI_PREFIX =
      byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      )

    /**
     * Android ships a stripped-down BouncyCastle provider that lacks Ed25519
     * on API 31-32. The platform Conscrypt provider added Ed25519 in API 33.
     *
     * Even on API 33+, [KeyFactory.getInstance] for Ed25519 may resolve to the
     * AndroidKeyStore provider, which only supports hardware-backed keys and
     * cannot import PKCS8 software keys. We must always route Ed25519
     * operations through an explicit software provider.
     *
     * Strategy: try Conscrypt ("AndroidOpenSSL") first — it's the fastest
     * software provider on modern Android. If it doesn't support Ed25519
     * (API 31-32), fall back to the full BouncyCastle provider.
     */
    private var providerReady = false
    @Volatile private var cachedProvider: String? = null

    // Conscrypt is the platform software crypto provider on modern Android.
    private const val CONSCRYPT_PROVIDER = "AndroidOpenSSL"

    @Synchronized
    private fun ensureEd25519Provider() {
      if (providerReady) return
      // Try Conscrypt (software) first — available on API 33+.
      // Probe both KeyPairGenerator and KeyFactory to make sure the provider
      // handles all Ed25519 operations, not just key generation.
      try {
        KeyPairGenerator.getInstance("Ed25519", CONSCRYPT_PROVIDER)
        KeyFactory.getInstance("Ed25519", CONSCRYPT_PROVIDER)
        cachedProvider = CONSCRYPT_PROVIDER
        providerReady = true
        return
      } catch (_: GeneralSecurityException) { /* Conscrypt doesn't support Ed25519 */ }

      // Fall back to full BouncyCastle (API 31-32 or stripped platform BC).
      Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME)
      Security.insertProviderAt(BouncyCastleProvider(), 1)
      // Verify the insertion actually works before caching.
      try {
        KeyPairGenerator.getInstance("Ed25519", BouncyCastleProvider.PROVIDER_NAME)
        cachedProvider = BouncyCastleProvider.PROVIDER_NAME
        providerReady = true
      } catch (err: GeneralSecurityException) {
        Log.e("DeviceIdentity", "BouncyCastle Ed25519 setup failed: ${err.message}")
      }
    }

    /**
     * Returns the name of a software provider that supports Ed25519
     * key generation, PKCS8 key import, and signing. Avoids AndroidKeyStore
     * which only handles hardware-backed keys.
     */
    fun softwareEd25519Provider(): String {
      ensureEd25519Provider()
      return cachedProvider ?: BouncyCastleProvider.PROVIDER_NAME
    }
  }
}
