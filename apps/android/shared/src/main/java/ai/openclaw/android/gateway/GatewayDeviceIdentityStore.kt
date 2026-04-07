package ai.openclaw.android.gateway

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

data class GatewayDeviceIdentity(
  val deviceId: String,
  val publicKeyRawBase64: String,
  val privateKeyPkcs8Base64: String,
  val createdAtMs: Long,
)

class GatewayDeviceIdentityStore(context: Context) {
  private val json = Json { ignoreUnknownKeys = true }
  private val identityFile = File(context.filesDir, "openclaw/identity/device.json")
  @Volatile private var cachedIdentity: GatewayDeviceIdentity? = null

  @Synchronized
  fun loadOrCreate(): GatewayDeviceIdentity {
    cachedIdentity?.let { return it }
    val existing = load()
    if (existing != null) {
      val derived = deriveDeviceId(existing.publicKeyRawBase64)
      if (derived != null && derived != existing.deviceId) {
        val updated = existing.copy(deviceId = derived)
        save(updated)
        cachedIdentity = updated
        return updated
      }
      cachedIdentity = existing
      return existing
    }
    val fresh = generate()
    save(fresh)
    cachedIdentity = fresh
    return fresh
  }

  fun signPayload(payload: String, identity: GatewayDeviceIdentity): String? {
    return try {
      val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val pkInfo = org.bouncycastle.asn1.pkcs.PrivateKeyInfo.getInstance(privateKeyBytes)
      val parsed = pkInfo.parsePrivateKey()
      val rawPrivate = org.bouncycastle.asn1.DEROctetString.getInstance(parsed).octets
      val privateKey = org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters(rawPrivate, 0)
      val signer = org.bouncycastle.crypto.signers.Ed25519Signer()
      signer.init(true, privateKey)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      signer.update(payloadBytes, 0, payloadBytes.size)
      base64UrlEncode(signer.generateSignature())
    } catch (e: Throwable) {
      Log.e("DeviceAuth", "signPayload FAILED: ${e.javaClass.simpleName}: ${e.message}", e)
      null
    }
  }

  fun publicKeyBase64Url(identity: GatewayDeviceIdentity): String? {
    return try {
      val raw = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      base64UrlEncode(raw)
    } catch (_: Throwable) {
      null
    }
  }

  fun verifySelfSignature(
    payload: String,
    signatureBase64Url: String,
    identity: GatewayDeviceIdentity,
  ): Boolean {
    return try {
      val rawPublicKey = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      val pubKey = org.bouncycastle.crypto.params.Ed25519PublicKeyParameters(rawPublicKey, 0)
      val sigBytes = base64UrlDecode(signatureBase64Url)
      val verifier = org.bouncycastle.crypto.signers.Ed25519Signer()
      verifier.init(false, pubKey)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      verifier.update(payloadBytes, 0, payloadBytes.size)
      verifier.verifySignature(sigBytes)
    } catch (e: Throwable) {
      Log.e("DeviceAuth", "self-verify exception: ${e.message}", e)
      false
    }
  }

  private fun load(): GatewayDeviceIdentity? {
    return try {
      if (!identityFile.exists()) return null
      val root = json.parseToJsonElement(identityFile.readText(Charsets.UTF_8)) as? JsonObject ?: return null
      val deviceId = (root["deviceId"] as? JsonPrimitive)?.content?.trim().orEmpty()
      val publicKeyRawBase64 = (root["publicKeyRawBase64"] as? JsonPrimitive)?.content?.trim().orEmpty()
      val privateKeyPkcs8Base64 = (root["privateKeyPkcs8Base64"] as? JsonPrimitive)?.content?.trim().orEmpty()
      val createdAtMs = (root["createdAtMs"] as? JsonPrimitive)?.content?.toLongOrNull() ?: return null
      if (deviceId.isEmpty() || publicKeyRawBase64.isEmpty() || privateKeyPkcs8Base64.isEmpty()) {
        return null
      }
      GatewayDeviceIdentity(
        deviceId = deviceId,
        publicKeyRawBase64 = publicKeyRawBase64,
        privateKeyPkcs8Base64 = privateKeyPkcs8Base64,
        createdAtMs = createdAtMs,
      )
    } catch (_: Throwable) {
      null
    }
  }

  private fun save(identity: GatewayDeviceIdentity) {
    try {
      identityFile.parentFile?.mkdirs()
      val encoded =
        buildJsonObject {
          put("deviceId", JsonPrimitive(identity.deviceId))
          put("publicKeyRawBase64", JsonPrimitive(identity.publicKeyRawBase64))
          put("privateKeyPkcs8Base64", JsonPrimitive(identity.privateKeyPkcs8Base64))
          put("createdAtMs", JsonPrimitive(identity.createdAtMs))
        }
      identityFile.writeText(encoded.toString(), Charsets.UTF_8)
    } catch (_: Throwable) {
      // best-effort only
    }
  }

  private fun generate(): GatewayDeviceIdentity {
    val kpGen = org.bouncycastle.crypto.generators.Ed25519KeyPairGenerator()
    kpGen.init(org.bouncycastle.crypto.params.Ed25519KeyGenerationParameters(java.security.SecureRandom()))
    val kp = kpGen.generateKeyPair()
    val pubKey = kp.public as org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
    val privKey = kp.private as org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
    val rawPublic = pubKey.encoded
    val deviceId = sha256Hex(rawPublic)
    val privKeyInfo = org.bouncycastle.crypto.util.PrivateKeyInfoFactory.createPrivateKeyInfo(privKey)
    val pkcs8Bytes = privKeyInfo.encoded
    return GatewayDeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(pkcs8Bytes, Base64.NO_WRAP),
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

  private fun sha256Hex(data: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(data)
    val out = CharArray(digest.size * 2)
    var i = 0
    for (byte in digest) {
      val v = byte.toInt() and 0xff
      out[i++] = HEX[v ushr 4]
      out[i++] = HEX[v and 0x0f]
    }
    return String(out)
  }

  private fun base64UrlEncode(data: ByteArray): String {
    return Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  }

  private fun base64UrlDecode(input: String): ByteArray {
    val normalized = input.replace('-', '+').replace('_', '/')
    val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
    return Base64.decode(padded, Base64.DEFAULT)
  }

  companion object {
    private val HEX = "0123456789abcdef".toCharArray()
  }
}
