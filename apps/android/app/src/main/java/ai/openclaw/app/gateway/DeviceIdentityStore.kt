package ai.openclaw.app.gateway

import android.content.Context
import android.util.Base64
import kotlinx.serialization.Serializable
import java.io.File
import java.security.MessageDigest

@Serializable
data class DeviceIdentity(
  val deviceId: String,
  val publicKeyRawBase64: String,
  val privateKeyPkcs8Base64: String,
  val createdAtMs: Long,
)

class DeviceIdentityStore(
  context: Context,
) {
  private val stateStore = OpenClawSQLiteStateStore(context)
  private val legacyIdentityFile = File(context.filesDir, "openclaw/identity/device.json")

  @Volatile private var cachedIdentity: DeviceIdentity? = null

  @Synchronized
  fun loadOrCreate(): DeviceIdentity {
    cachedIdentity?.let { return it }
    val existing = load()
    if (existing != null) {
      cachedIdentity = existing
      return existing
    }
    if (legacyIdentityFile.exists()) {
      throw IllegalStateException(
        "Legacy OpenClaw device identity file exists. Run openclaw doctor --fix before starting runtime.",
      )
    }
    val fresh = generate()
    save(fresh)
    cachedIdentity = fresh
    return fresh
  }

  fun signPayload(
    payload: String,
    identity: DeviceIdentity,
  ): String? =
    try {
      // Use BC lightweight API directly — JCA provider registration is broken by R8
      val privateKeyBytes = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
      val pkInfo =
        org.bouncycastle.asn1.pkcs.PrivateKeyInfo
          .getInstance(privateKeyBytes)
      val parsed = pkInfo.parsePrivateKey()
      val rawPrivate =
        org.bouncycastle.asn1.DEROctetString
          .getInstance(parsed)
          .octets
      val privateKey =
        org.bouncycastle.crypto.params
          .Ed25519PrivateKeyParameters(rawPrivate, 0)
      val signer =
        org.bouncycastle.crypto.signers
          .Ed25519Signer()
      signer.init(true, privateKey)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      signer.update(payloadBytes, 0, payloadBytes.size)
      base64UrlEncode(signer.generateSignature())
    } catch (e: Throwable) {
      android.util.Log.e("DeviceAuth", "signPayload FAILED: ${e.javaClass.simpleName}: ${e.message}", e)
      null
    }

  fun verifySelfSignature(
    payload: String,
    signatureBase64Url: String,
    identity: DeviceIdentity,
  ): Boolean =
    try {
      val rawPublicKey = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      val pubKey =
        org.bouncycastle.crypto.params
          .Ed25519PublicKeyParameters(rawPublicKey, 0)
      val sigBytes = base64UrlDecode(signatureBase64Url)
      val verifier =
        org.bouncycastle.crypto.signers
          .Ed25519Signer()
      verifier.init(false, pubKey)
      val payloadBytes = payload.toByteArray(Charsets.UTF_8)
      verifier.update(payloadBytes, 0, payloadBytes.size)
      verifier.verifySignature(sigBytes)
    } catch (e: Throwable) {
      android.util.Log.e("DeviceAuth", "self-verify exception: ${e.message}", e)
      false
    }

  private fun base64UrlDecode(input: String): ByteArray {
    val normalized = input.replace('-', '+').replace('_', '/')
    val padded = normalized + "=".repeat((4 - normalized.length % 4) % 4)
    return Base64.decode(padded, Base64.DEFAULT)
  }

  fun publicKeyBase64Url(identity: DeviceIdentity): String? =
    try {
      val raw = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
      base64UrlEncode(raw)
    } catch (_: Throwable) {
      null
    }

  private fun load(): DeviceIdentity? {
    val row = stateStore.readDeviceIdentity(IDENTITY_KEY) ?: return null
    return readIdentity(row)
      ?: throw IllegalStateException(
        "Stored OpenClaw device identity is invalid. Run openclaw doctor --fix.",
      )
  }

  private fun readIdentity(row: OpenClawSQLiteDeviceIdentityRow): DeviceIdentity? =
    PersistedDeviceIdentity(
      deviceId = row.deviceId,
      publicKeyPem = row.publicKeyPem,
      privateKeyPem = row.privateKeyPem,
      createdAtMs = row.createdAtMs,
    ).toRuntimeIdentity()

  private fun save(identity: DeviceIdentity) {
    val persisted = PersistedDeviceIdentity.fromRuntimeIdentity(identity)
    stateStore.writeDeviceIdentity(
      OpenClawSQLiteDeviceIdentityRow(
        deviceId = persisted.deviceId,
        publicKeyPem = persisted.publicKeyPem,
        privateKeyPem = persisted.privateKeyPem,
        createdAtMs = persisted.createdAtMs,
      ),
      identityKey = IDENTITY_KEY,
    )
  }

  private fun generate(): DeviceIdentity {
    // Use BC lightweight API directly to avoid JCA provider issues with R8
    val kpGen =
      org.bouncycastle.crypto.generators
        .Ed25519KeyPairGenerator()
    kpGen.init(
      org.bouncycastle.crypto.params
        .Ed25519KeyGenerationParameters(java.security.SecureRandom()),
    )
    val kp = kpGen.generateKeyPair()
    val pubKey = kp.public as org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
    val privKey = kp.private as org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
    val rawPublic = pubKey.encoded // 32 bytes
    val deviceId = sha256Hex(rawPublic)
    // Encode private key as PKCS8 for storage
    val privKeyInfo =
      org.bouncycastle.crypto.util.PrivateKeyInfoFactory
        .createPrivateKeyInfo(privKey)
    val pkcs8Bytes = privKeyInfo.encoded
    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = Base64.encodeToString(pkcs8Bytes, Base64.NO_WRAP),
      createdAtMs = System.currentTimeMillis(),
    )
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

  private fun base64UrlEncode(data: ByteArray): String =
    Base64.encodeToString(
      data,
      Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )

  @Serializable
  private data class PersistedDeviceIdentity(
    val version: Int = 1,
    val deviceId: String,
    val publicKeyPem: String,
    val privateKeyPem: String,
    val createdAtMs: Long,
  ) {
    fun toRuntimeIdentity(): DeviceIdentity? {
      if (version != 1 || deviceId.isBlank() || publicKeyPem.isBlank() || privateKeyPem.isBlank()) {
        return null
      }
      val publicDer = decodePem(publicKeyPem, "PUBLIC KEY") ?: return null
      if (!publicDer.startsWith(PUBLIC_KEY_INFO_PREFIX)) return null
      val publicRaw = publicDer.copyOfRange(PUBLIC_KEY_INFO_PREFIX.size, publicDer.size)
      if (publicRaw.size != ED25519_KEY_SIZE) return null
      val derivedDeviceId = sha256HexStatic(publicRaw)
      if (derivedDeviceId != deviceId.lowercase()) return null
      val privateDer = decodePem(privateKeyPem, "PRIVATE KEY") ?: return null
      return DeviceIdentity(
        deviceId = derivedDeviceId,
        publicKeyRawBase64 = Base64.encodeToString(publicRaw, Base64.NO_WRAP),
        privateKeyPkcs8Base64 = Base64.encodeToString(privateDer, Base64.NO_WRAP),
        createdAtMs = createdAtMs,
      )
    }

    companion object {
      fun fromRuntimeIdentity(identity: DeviceIdentity): PersistedDeviceIdentity {
        val publicRaw = Base64.decode(identity.publicKeyRawBase64, Base64.DEFAULT)
        val privateDer = Base64.decode(identity.privateKeyPkcs8Base64, Base64.DEFAULT)
        return PersistedDeviceIdentity(
          deviceId = identity.deviceId,
          publicKeyPem = encodePem("PUBLIC KEY", PUBLIC_KEY_INFO_PREFIX + publicRaw),
          privateKeyPem = encodePem("PRIVATE KEY", privateDer),
          createdAtMs = identity.createdAtMs,
        )
      }
    }
  }

  companion object {
    private const val IDENTITY_KEY = "default"
    private const val ED25519_KEY_SIZE = 32
    private val HEX = "0123456789abcdef".toCharArray()
    private val PUBLIC_KEY_INFO_PREFIX =
      byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)

    private fun ByteArray.startsWith(prefix: ByteArray): Boolean = size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }

    private fun encodePem(
      label: String,
      bytes: ByteArray,
    ): String {
      val body = Base64.encodeToString(bytes, Base64.NO_WRAP)
      val wrapped = body.chunked(64).joinToString("\n")
      return "-----BEGIN $label-----\n$wrapped\n-----END $label-----\n"
    }

    private fun decodePem(
      pem: String,
      label: String,
    ): ByteArray? {
      val header = "-----BEGIN $label-----"
      val footer = "-----END $label-----"
      val trimmed = pem.trim()
      if (!trimmed.startsWith(header) || !trimmed.endsWith(footer)) return null
      val body =
        trimmed
          .removePrefix(header)
          .removeSuffix(footer)
          .replace("\\s".toRegex(), "")
      return runCatching { Base64.decode(body, Base64.DEFAULT) }.getOrNull()
    }

    private fun sha256HexStatic(data: ByteArray): String {
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
  }
}
