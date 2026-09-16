package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CloudflareAccessPersistenceNativeTest {
  @Test fun encryptedGrantRestoresAndDeletesWithoutChangingGatewayPairing() =
    runBlocking {
      val context = InstrumentationRegistry.getInstrumentation().targetContext
      // No preferences override: this exercises AndroidKeyStore-backed EncryptedSharedPreferences.
      val prefs = SecurePrefs(context)
      val profile = "native-access-${UUID.randomUUID()}"
      val origin = CloudflareAccessOrigin.from("https://$profile.example.test")
      val application = CloudflareAccessApplication(origin, URI("https://example.cloudflareaccess.com"), "native-test")
      val expires = System.currentTimeMillis() / 1000.0 + 300
      val encoder = Base64.getUrlEncoder().withoutPadding()

      fun encode(value: String) = encoder.encodeToString(value.toByteArray())
      val input =
        encode("""{"alg":"RS256","kid":"native-test"}""") + "." +
          encode("""{"iss":"${application.issuer}","aud":["native-test"],"type":"app","sub":"native-test","exp":$expires}""")
      val key = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
      val signature =
        Signature
          .getInstance("SHA256withRSA")
          .apply {
            initSign(key.private)
            update(input.toByteArray())
          }.sign()
      val session = CloudflareAccessSession(application, "native-test", expires, "$input.${encoder.encodeToString(signature)}")
      val persistence = CloudflareAccessSessionStore.Persistence.securePrefs(prefs)
      val identity = DeviceIdentityStore.withPrefs(context, prefs).loadOrCreate().deviceId
      val deviceAuth = DeviceAuthStore(prefs)
      try {
        prefs.saveGatewayCredentials(profile, token = "native-test-gateway-token", password = "native-test-password")
        prefs.saveGatewayCustomHeaders(profile, mapOf("X-Test-Proxy" to "native-test-header"))
        assertTrue(deviceAuth.saveToken(profile, identity, "operator", "native-test-device-token", listOf("operator.read")))
        assertTrue(persistence.save(origin, session.encode()))
        val restoredPrefs = SecurePrefs(context)
        val restored = CloudflareAccessSessionStore(this, CloudflareAccessSessionStore.Persistence.securePrefs(restoredPrefs), retireTransports = {})
        val snapshot = checkNotNull(restored.snapshot(origin))
        assertNotNull(snapshot.session.authorizationHeader(origin.uri.toString()))
        assertNull(snapshot.session.authorizationHeader("https://other.example.test"))
        assertNull(snapshot.session.authorizationHeader(origin.uri.toString(), expires + 1))
        restored.forget(origin).task.await()
        val after = SecurePrefs(context)
        assertNull(CloudflareAccessSessionStore.Persistence.securePrefs(after).load(origin))
        assertEquals("native-test-gateway-token", after.loadGatewayCredentials(profile).token)
        assertEquals("native-test-password", after.loadGatewayCredentials(profile).password)
        assertEquals(mapOf("X-Test-Proxy" to "native-test-header"), after.loadGatewayCustomHeaders(profile))
        assertEquals(identity, DeviceIdentityStore.withPrefs(context, after).loadOrCreate().deviceId)
        assertEquals("native-test-device-token", DeviceAuthStore(after).loadToken(profile, identity, "operator"))
      } finally {
        persistence.delete(origin)
        deviceAuth.clearToken(profile, identity, "operator")
        prefs.clearGatewayCredentials(profile)
        prefs.clearGatewayCustomHeaders(profile)
      }
    }
}
