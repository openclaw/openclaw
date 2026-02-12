package ai.openclaw.android.gateway

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.File
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Security
import java.security.Signature
import java.security.spec.NamedParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import net.i2p.crypto.eddsa.EdDSASecurityProvider
import org.conscrypt.Conscrypt

@Serializable
data class DeviceIdentity(
  val deviceId: String,
  val publicKeyRawBase64: String,
  val privateKeyPkcs8Base64: String,
  val createdAtMs: Long,
)

class DeviceIdentityStore(context: Context) {
  private data class GeneratedKey(
    val keyPair: KeyPair,
    val privateRef: String,
  )

  private val json = Json { ignoreUnknownKeys = true }
  private val identityFile = File(context.filesDir, "openclaw/identity/device.json")

  init {
    ensureCryptoProviders()
  }

  @Synchronized
  fun loadOrCreate(): DeviceIdentity {
    ensureCryptoProviders()
    val existing = load()
    if (existing != null) {
      val derived = deriveDeviceId(existing.publicKeyRawBase64)
      val normalized =
        if (derived != null && derived != existing.deviceId) {
          val updated = existing.copy(deviceId = derived)
          save(updated)
          updated
        } else {
          existing
        }
      val alias = keystoreAliasFromRef(normalized.privateKeyPkcs8Base64)
      if (alias != null && !hasKeystorePrivateKey(alias)) {
        val fresh = generate()
        save(fresh)
        return fresh
      }
      if (signPayload("identity-check", normalized).isNullOrBlank()) {
        val fresh = generate()
        save(fresh)
        return fresh
      }
      return normalized
    }
    val fresh = generate()
    save(fresh)
    return fresh
  }

  @Synchronized
  fun regenerate(): DeviceIdentity {
    ensureCryptoProviders()
    val fresh = generate()
    save(fresh)
    return fresh
  }

  fun signPayload(payload: String, identity: DeviceIdentity): String? {
    return try {
      ensureCryptoProviders()
      val privateKey = loadPrivateKey(identity.privateKeyPkcs8Base64) ?: return null
      val signatureBytes = signEd25519(privateKey, payload.toByteArray(Charsets.UTF_8)) ?: return null
      base64UrlEncode(signatureBytes)
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
    val generated = generateEd25519KeyPair()
    val spki =
      generated.keyPair.public.encoded
        ?: keystoreAliasFromRef(generated.privateRef)?.let(::loadKeystorePublicKeyEncoded)
        ?: throw IllegalStateException("missing Ed25519 public key encoding")
    val rawPublic = stripSpkiPrefix(spki)
    val deviceId = sha256Hex(rawPublic)
    return DeviceIdentity(
      deviceId = deviceId,
      publicKeyRawBase64 = Base64.encodeToString(rawPublic, Base64.NO_WRAP),
      privateKeyPkcs8Base64 = generated.privateRef,
      createdAtMs = System.currentTimeMillis(),
    )
  }

  private fun generateEd25519KeyPair(): GeneratedKey {
    // Prefer pure-Java EdDSA first to avoid OEM/provider differences.
    tryGenerateKeyPair(algorithm = "EdDSA", provider = "EdDSA", initializeEd25519 = false)?.let { return it }
    tryGenerateKeyPair(algorithm = "EdDSA", provider = null, initializeEd25519 = false)?.let { return it }

    // Prefer software keys from Conscrypt for deterministic decode/sign behavior.
    tryGenerateKeyPair(algorithm = "Ed25519", provider = "Conscrypt", initializeEd25519 = false)?.let {
      return it
    }
    tryGenerateKeyPair(algorithm = "Ed25519", provider = "Conscrypt", initializeEd25519 = true)?.let {
      return it
    }

    // Fall back to keystore-backed keys if software provider is unavailable.
    generateKeystoreEd25519KeyPair()?.let { return it }

    // Avoid AndroidKeyStore providers because we need an exportable PKCS#8 private key.
    val providers =
      (Security.getProviders("KeyPairGenerator.Ed25519") ?: emptyArray())
        .filterNot { it.name.contains("AndroidKeyStore", ignoreCase = true) }

    for (provider in providers) {
      tryGenerateKeyPair(algorithm = "Ed25519", provider = provider.name, initializeEd25519 = false)?.let {
        return it
      }
      tryGenerateKeyPair(algorithm = "Ed25519", provider = provider.name, initializeEd25519 = true)?.let {
        return it
      }
    }

    // Final fallback through default provider selection.
    tryGenerateKeyPair(algorithm = "Ed25519", provider = null, initializeEd25519 = false)?.let { return it }
    tryGenerateKeyPair(algorithm = "Ed25519", provider = null, initializeEd25519 = true)?.let { return it }

    throw IllegalStateException("unable to generate Ed25519 keypair")
  }

  private fun tryGenerateKeyPair(
    algorithm: String,
    provider: String?,
    initializeEd25519: Boolean,
  ): GeneratedKey? {
    return try {
      val generator =
        if (provider.isNullOrBlank()) {
          KeyPairGenerator.getInstance(algorithm)
        } else {
          KeyPairGenerator.getInstance(algorithm, provider)
        }
      if (initializeEd25519 && algorithm == "Ed25519") {
        generator.initialize(NamedParameterSpec("Ed25519"))
      }
      val keyPair = generator.generateKeyPair()
      if (isExportable(keyPair)) {
        val privateRef = Base64.encodeToString(keyPair.private.encoded, Base64.NO_WRAP)
        // Accept exportable keys only if we can reload and sign with them.
        val roundTripPrivate = decodeExportedPrivateKey(privateRef)
        if (roundTripPrivate == null || !canSignWithPrivateKey(roundTripPrivate)) {
          return null
        }
        GeneratedKey(
          keyPair = keyPair,
          privateRef = privateRef,
        )
      } else {
        null
      }
    } catch (err: Throwable) {
      null
    }
  }

  private fun isExportable(keyPair: KeyPair): Boolean {
    val privateEncoded = keyPair.private.encoded
    val publicEncoded = keyPair.public.encoded
    return privateEncoded != null && privateEncoded.isNotEmpty() &&
      publicEncoded != null && publicEncoded.isNotEmpty()
  }

  private fun generateKeystoreEd25519KeyPair(): GeneratedKey? {
    val tryDigestNone = listOf(false, true)
    for (useDigestNone in tryDigestNone) {
      val alias = "openclaw-ed25519-${UUID.randomUUID()}"
      try {
        val generator = KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore")
        val builder =
          KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
          )
        if (useDigestNone) {
          builder.setDigests(KeyProperties.DIGEST_NONE)
        }
        generator.initialize(builder.build())
        val keyPair = generator.generateKeyPair()
        val publicEncoded = keyPair.public.encoded ?: loadKeystorePublicKeyEncoded(alias)
        if (publicEncoded != null && publicEncoded.isNotEmpty() && hasKeystorePrivateKey(alias)) {
          return GeneratedKey(
            keyPair = keyPair,
            privateRef = "$KEYSTORE_REF_PREFIX$alias",
          )
        }
      } catch (_: Throwable) {
        // try the next keystore spec variant
      }
      deleteKeystoreKey(alias)
    }
    return null
  }

  private fun keystoreAliasFromRef(privateRef: String): String? {
    if (!privateRef.startsWith(KEYSTORE_REF_PREFIX)) return null
    val alias = privateRef.removePrefix(KEYSTORE_REF_PREFIX).trim()
    return alias.takeIf { it.isNotEmpty() }
  }

  private fun loadKeystorePrivateKey(alias: String): java.security.PrivateKey? {
    return try {
      val keyStore = KeyStore.getInstance("AndroidKeyStore")
      keyStore.load(null)
      keyStore.getKey(alias, null) as? java.security.PrivateKey
    } catch (_: Throwable) {
      null
    }
  }

  private fun hasKeystorePrivateKey(alias: String): Boolean {
    return loadKeystorePrivateKey(alias) != null
  }

  private fun loadPrivateKey(privateRef: String): PrivateKey? {
    val alias = keystoreAliasFromRef(privateRef)
    if (alias != null) {
      return loadKeystorePrivateKey(alias)
    }
    return decodeExportedPrivateKey(privateRef)
  }

  private fun decodeExportedPrivateKey(privateRef: String): PrivateKey? {
    return try {
      val privateKeyBytes = Base64.decode(privateRef, Base64.DEFAULT)
      val keySpec = PKCS8EncodedKeySpec(privateKeyBytes)
      val attempts = mutableListOf<Pair<String, String?>>()
      attempts += "Ed25519" to null
      attempts += "EdDSA" to null
      for (provider in Security.getProviders("KeyFactory.Ed25519") ?: emptyArray()) {
        attempts += "Ed25519" to provider.name
      }
      for (provider in Security.getProviders("KeyFactory.EdDSA") ?: emptyArray()) {
        attempts += "EdDSA" to provider.name
      }
      for ((algorithm, provider) in attempts.distinct()) {
        try {
          val keyFactory =
            if (provider.isNullOrBlank()) {
              KeyFactory.getInstance(algorithm)
            } else {
              KeyFactory.getInstance(algorithm, provider)
            }
          return keyFactory.generatePrivate(keySpec)
        } catch (_: Throwable) {
          // try the next provider/algorithm
        }
      }
      null
    } catch (_: Throwable) {
      null
    }
  }

  private fun signEd25519(privateKey: PrivateKey, payload: ByteArray): ByteArray? {
    val attempts = mutableListOf<Pair<String, String?>>()
    val algorithms = listOf("Ed25519", "NONEwithEdDSA", "EdDSA")
    val preferredProviders =
      listOf("EdDSA", "AndroidKeyStore", "AndroidKeyStoreBCWorkaround", "Conscrypt", "BC")
    for (algorithm in algorithms) {
      attempts += algorithm to null
      for (providerName in preferredProviders) {
        attempts += algorithm to providerName
      }
      for (provider in Security.getProviders("Signature.$algorithm") ?: emptyArray()) {
        attempts += algorithm to provider.name
      }
    }
    for ((algorithm, provider) in attempts.distinct()) {
      try {
        val signature =
          if (provider.isNullOrBlank()) {
            Signature.getInstance(algorithm)
          } else {
            Signature.getInstance(algorithm, provider)
          }
        signature.initSign(privateKey)
        signature.update(payload)
        val signed = signature.sign()
        if (signed.isNotEmpty()) {
          return signed
        }
      } catch (_: Throwable) {
        // try next signature algorithm/provider
      }
    }
    return null
  }

  private fun canSignWithPrivateKey(privateKey: PrivateKey): Boolean {
    return signEd25519(privateKey, "identity-check".toByteArray(Charsets.UTF_8)) != null
  }

  private fun ensureCryptoProviders() {
    if (Security.getProvider("EdDSA") == null) {
      try {
        Security.insertProviderAt(EdDSASecurityProvider(), 1)
      } catch (_: Throwable) {
        // best-effort only
      }
    }
    if (Security.getProvider("Conscrypt") == null) {
      try {
        Security.insertProviderAt(Conscrypt.newProvider(), 1)
      } catch (_: Throwable) {
        // best-effort only
      }
    }
  }

  private fun deleteKeystoreKey(alias: String) {
    try {
      val keyStore = KeyStore.getInstance("AndroidKeyStore")
      keyStore.load(null)
      if (keyStore.containsAlias(alias)) {
        keyStore.deleteEntry(alias)
      }
    } catch (_: Throwable) {
      // best-effort only
    }
  }

  private fun loadKeystorePublicKeyEncoded(alias: String): ByteArray? {
    return try {
      val keyStore = KeyStore.getInstance("AndroidKeyStore")
      keyStore.load(null)
      keyStore.getCertificate(alias)?.publicKey?.encoded
    } catch (_: Throwable) {
      null
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
    private const val KEYSTORE_REF_PREFIX = "keystore:"
    private val ED25519_SPKI_PREFIX =
      byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
      )
  }
}
