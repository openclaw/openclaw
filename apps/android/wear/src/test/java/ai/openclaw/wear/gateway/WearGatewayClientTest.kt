package ai.openclaw.wear.gateway

import ai.openclaw.android.gateway.GatewayClientProfiles
import ai.openclaw.android.gateway.GatewayConnectBuilder
import java.math.BigInteger
import java.security.MessageDigest
import java.security.Principal
import java.security.PublicKey
import java.security.cert.X509Certificate
import java.util.Date
import javax.security.auth.x500.X500Principal
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.Request
import okhttp3.WebSocket

class WearGatewayClientTest {
  @Test
  fun `wear connect client info uses schema valid id and mode`() {
    val clientInfo =
      GatewayConnectBuilder.buildWearClientInfo(
        deviceId = "watch-device-123",
        versionName = "2026.3.14-dev",
      )

    assertEquals(GatewayClientProfiles.AndroidClientId, clientInfo.id)
    assertEquals(GatewayClientProfiles.UiMode, clientInfo.mode)
    assertEquals(GatewayClientProfiles.WearOsPlatform, clientInfo.platform)
    assertEquals(GatewayClientProfiles.WatchDeviceFamily, clientInfo.deviceFamily)
    assertEquals("watch-device-123", clientInfo.instanceId)
    assertEquals("2026.3.14-dev", clientInfo.version)
    assertTrue(clientInfo.displayName?.isNotBlank() == true)
  }

  @Test
  fun `wear connect params include shared operator scopes`() {
    val connectParams =
      buildWearConnectParams(
        config = WearGatewayConfig(token = "secret-token"),
        deviceId = "watch-device-123",
        versionName = "2026.3.14-dev",
      )

    assertEquals("operator", connectParams["role"]?.jsonPrimitive?.content)
    assertEquals(
      GatewayConnectBuilder.OperatorScopes,
      connectParams["scopes"]?.jsonArray?.map { it.jsonPrimitive.content },
    )
    assertEquals("secret-token", connectParams["auth"]?.jsonObject?.get("token")?.jsonPrimitive?.content)
  }

  @Test
  fun `wear connect params include bootstrap token when no token is present`() {
    val connectParams =
      buildWearConnectParams(
        config = WearGatewayConfig(bootstrapToken = "bootstrap-token"),
        deviceId = "watch-device-123",
        versionName = "2026.3.14-dev",
      )

    val auth = connectParams["auth"]?.jsonObject
    assertEquals("bootstrap-token", auth?.get("bootstrapToken")?.jsonPrimitive?.content)
  }

  @Test
  fun `current socket frame gate rejects stale epoch or socket`() {
    val activeSocket = TestWebSocket()

    assertTrue(
      isCurrentSocketFrame(
        frameEpoch = 5L,
        currentEpoch = 5L,
        activeSocket = activeSocket,
        sourceSocket = activeSocket,
      ),
    )
    assertFalse(
      isCurrentSocketFrame(
        frameEpoch = 4L,
        currentEpoch = 5L,
        activeSocket = activeSocket,
        sourceSocket = activeSocket,
      ),
    )
    assertFalse(
      isCurrentSocketFrame(
        frameEpoch = 5L,
        currentEpoch = 5L,
        activeSocket = activeSocket,
        sourceSocket = TestWebSocket(),
      ),
    )
  }

  @Test
  fun `wear tls params reuse stored fingerprint for manual endpoint`() {
    val pinStore = FakeWearGatewayTlsPinStore()
    val config = WearGatewayConfig(host = "[fd7a:115c:a1e0::1234]", port = 18789, useTls = true)
    val stableId = resolveWearGatewayStableId(config)
    pinStore.save(stableId, "sha256:ABCD1234")

    val params = resolveWearGatewayTlsParams(config, pinStore)

    assertEquals("manual|fd7a:115c:a1e0::1234|18789", params?.stableId)
    assertEquals("sha256:ABCD1234", params?.expectedFingerprint)
    assertFalse(params?.allowTOFU == true)
  }

  @Test
  fun `wear tls params fall back to tofu when no fingerprint is stored`() {
    val params =
      resolveWearGatewayTlsParams(
        WearGatewayConfig(host = "gateway.example", port = 443, useTls = true),
        FakeWearGatewayTlsPinStore(),
      )

    assertEquals("manual|gateway.example|443", params?.stableId)
    assertEquals(null, params?.expectedFingerprint)
    assertTrue(params?.allowTOFU == true)
  }

  @Test
  fun `wear tls config stores fingerprint during tofu handshake`() {
    val certificateBytes = byteArrayOf(1, 2, 3, 4)
    val observedFingerprints = mutableListOf<String>()
    val tlsConfig =
      buildWearGatewayTlsConfig(
        WearGatewayTlsParams(
          expectedFingerprint = null,
          allowTOFU = true,
          stableId = "manual|gateway.example|443",
        ),
      ) { fingerprint ->
        observedFingerprints += fingerprint
      }

    tlsConfig.trustManager.checkServerTrusted(arrayOf(FakeX509Certificate(certificateBytes)), "RSA")

    assertEquals(listOf(sha256Hex(certificateBytes)), observedFingerprints)
  }
}

private class TestWebSocket : WebSocket {
  override fun queueSize(): Long = 0L

  override fun request(): Request = Request.Builder().url("ws://localhost").build()

  override fun send(text: String): Boolean = true

  override fun send(bytes: okio.ByteString): Boolean = true

  override fun close(code: Int, reason: String?): Boolean = true

  override fun cancel() = Unit
}

private class FakeWearGatewayTlsPinStore : WearGatewayTlsPinStore {
  private val values = linkedMapOf<String, String>()

  override fun load(stableId: String): String? = values[stableId]

  override fun save(stableId: String, fingerprint: String) {
    values[stableId] = fingerprint
  }
}

private class FakeX509Certificate(
  private val bytes: ByteArray,
) : X509Certificate() {
  override fun getEncoded(): ByteArray = bytes

  override fun checkValidity() = Unit

  override fun checkValidity(date: Date?) = Unit

  override fun getVersion(): Int = 3

  override fun getSerialNumber(): BigInteger = BigInteger.ONE

  override fun getIssuerDN(): Principal = X500Principal("CN=issuer")

  override fun getSubjectDN(): Principal = X500Principal("CN=subject")

  override fun getNotBefore(): Date = Date(0)

  override fun getNotAfter(): Date = Date(Long.MAX_VALUE)

  override fun getTBSCertificate(): ByteArray = bytes

  override fun getSignature(): ByteArray = ByteArray(0)

  override fun getSigAlgName(): String = "none"

  override fun getSigAlgOID(): String = "0.0"

  override fun getSigAlgParams(): ByteArray? = null

  override fun getIssuerUniqueID(): BooleanArray? = null

  override fun getSubjectUniqueID(): BooleanArray? = null

  override fun getKeyUsage(): BooleanArray? = null

  override fun getBasicConstraints(): Int = -1

  override fun verify(key: PublicKey?) = Unit

  override fun verify(key: PublicKey?, sigProvider: String?) = Unit

  override fun toString(): String = "FakeX509Certificate"

  override fun getPublicKey(): PublicKey {
    return object : PublicKey {
      override fun getAlgorithm(): String = "none"

      override fun getFormat(): String = "none"

      override fun getEncoded(): ByteArray = ByteArray(0)
    }
  }

  override fun hasUnsupportedCriticalExtension(): Boolean = false

  override fun getCriticalExtensionOIDs(): MutableSet<String>? = null

  override fun getNonCriticalExtensionOIDs(): MutableSet<String>? = null

  override fun getExtensionValue(oid: String?): ByteArray? = null

  override fun getExtendedKeyUsage(): MutableList<String>? = null

  override fun getSubjectAlternativeNames(): MutableCollection<MutableList<*>?>? = null

  override fun getIssuerAlternativeNames(): MutableCollection<MutableList<*>?>? = null

  override fun getSubjectX500Principal(): X500Principal = X500Principal("CN=subject")

  override fun getIssuerX500Principal(): X500Principal = X500Principal("CN=issuer")
}

private fun sha256Hex(data: ByteArray): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(data)
  return buildString(digest.size * 2) {
    for (byte in digest) {
      append(String.format("%02x", byte))
    }
  }
}
