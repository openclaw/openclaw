package ai.openclaw.app

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayExternalAuthorizationException
import ai.openclaw.app.gateway.GatewayProxyCredentials
import ai.openclaw.app.gateway.GatewayProxySaveResult
import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.runBlocking
import okhttp3.Credentials
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class SecurePrefsCommitTest {
  @Test
  fun proxyEditsAreAtomicDestinationScopedAndKeepThePairedAccount() =
    runBlocking {
      val (prefs, backing) = fixture()
      val endpoint = GatewayEndpoint.manual("gateway.example", 443, true, "/team")
      val other = GatewayEndpoint.manual("other.example", 443, true)
      val gatewayAuth = GatewayCredentials(token = "gateway-token", password = "gateway-password")
      prefs.saveGatewayCredentials(endpoint.stableId, gatewayAuth)
      val tokens = DeviceAuthStore(prefs)
      assertTrue(tokens.saveToken(endpoint.stableId, "device", "operator", "paired-token"))
      assertEquals(GatewayProxySaveResult.SAVED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("alice", "first")))
      assertEquals(GatewayProxySaveResult.SAVED, prefs.saveGatewayProxyCredentials(other, GatewayProxyCredentials("bob", "other")))
      val grant = requireNotNull(prefs.gatewayProxyAuthorization(endpoint))
      val request = Request.Builder().url("https://gateway.example/team").build()
      assertEquals(Credentials.basic("alice", "first", Charsets.UTF_8), grant.authorizeUpgrade(request).header("Authorization"))
      assertTrue(runCatching { grant.authorizeUpgrade(request.newBuilder().header("Authorization", "Bearer existing").build()) }.exceptionOrNull() is GatewayExternalAuthorizationException)
      for (url in listOf("http://gateway.example/team", "https://other.example/team", "https://gateway.example/team-other")) {
        assertThrows(GatewayExternalAuthorizationException::class.java) { grant.requireCurrent(request.newBuilder().url(url).build()) }
      }
      assertThrows(IllegalArgumentException::class.java) { prefs.loadGatewayProxyCredentials(endpoint.copy(tlsEnabled = false)) }
      assertThrows(IllegalStateException::class.java) { prefs.loadGatewayProxyCredentials(endpoint.copy(host = "other.example")) }
      assertThrows(IllegalArgumentException::class.java) { GatewayProxyCredentials("invalid:username", "secret") }
      assertEquals("GatewayProxyCredentials([redacted])", GatewayProxyCredentials("alice", "first").toString())

      backing.failNextCommit = true
      assertEquals(GatewayProxySaveResult.FAILED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("alice", "second")))
      assertEquals("first", prefs.loadGatewayProxyCredentials(endpoint)?.password)
      grant.requireCurrent(request)
      assertEquals(GatewayProxySaveResult.SAVED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("alice", "second")))
      assertThrows(GatewayExternalAuthorizationException::class.java) { grant.requireCurrent(request) }
      val reopened = SecurePrefs(RuntimeEnvironment.getApplication(), securePrefsOverride = backing)
      assertEquals("second", reopened.loadGatewayProxyCredentials(endpoint)?.password)
      assertEquals("other", reopened.loadGatewayProxyCredentials(other)?.password)
      assertEquals(GatewayProxySaveResult.ACCOUNT_LOCKED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("bob", "other")))

      backing.failNextCommit = true
      assertEquals(GatewayProxySaveResult.FAILED, prefs.saveGatewayProxyCredentials(endpoint, null))
      assertEquals("second", prefs.loadGatewayProxyCredentials(endpoint)?.password)
      assertEquals(GatewayProxySaveResult.SAVED, prefs.saveGatewayProxyCredentials(endpoint, null))
      assertNull(prefs.loadGatewayProxyCredentials(endpoint))
      assertEquals(GatewayProxySaveResult.ACCOUNT_LOCKED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("bob", "other")))
      assertEquals(GatewayProxySaveResult.SAVED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("alice", "restored")))
      assertEquals(gatewayAuth, prefs.loadGatewayCredentials(endpoint.stableId))
      assertEquals("paired-token", tokens.loadToken(endpoint.stableId, "device", "operator"))
      prefs.putString("gateway.proxy.basic.${other.stableId}", "unreadable")
      assertEquals(GatewayProxySaveResult.ACCOUNT_LOCKED, prefs.saveGatewayProxyCredentials(other, null))
    }

  @Test
  fun acknowledgedRemovalKeepsGatewayCredentials() {
    val (prefs, _) = fixture()
    prefs.saveGatewayCredentials("gateway-a", token = "gateway-token", bootstrapToken = "bootstrap-token")
    assertTrue(prefs.commitSecureStrings(mapOf("access-a" to "app-token", "access-b" to "other-app-token")))

    assertTrue(prefs.commitSecureStrings(mapOf("access-a" to null)))

    assertNull(prefs.getString("access-a"))
    assertEquals("other-app-token", prefs.getString("access-b"))
    assertEquals(GatewayCredentials(token = "gateway-token", bootstrapToken = "bootstrap-token"), prefs.loadGatewayCredentials("gateway-a"))
  }

  @Test
  fun failedRemovalRestoresMemoryAndReportsFailure() {
    val (prefs, backing) = fixture()
    assertTrue(prefs.commitSecureStrings(mapOf("access-a" to "app-token")))
    backing.failNextCommit = true

    assertFalse(prefs.commitSecureStrings(mapOf("access-a" to null, "access-b" to "new-token")))

    assertEquals("app-token", prefs.getString("access-a"))
    assertNull(prefs.getString("access-b"))
  }

  private fun fixture(): Pair<SecurePrefs, CommitControlledPreferences> {
    val app = RuntimeEnvironment.getApplication()
    val backing = CommitControlledPreferences(app.getSharedPreferences("access-commit-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    return SecurePrefs(app, securePrefsOverride = backing) to backing
  }

  private class CommitControlledPreferences(
    private val delegate: SharedPreferences,
  ) : SharedPreferences by delegate {
    var failNextCommit = false

    override fun edit(): SharedPreferences.Editor {
      val editor = delegate.edit()
      return object : SharedPreferences.Editor by editor {
        override fun commit(): Boolean {
          if (!failNextCommit) return editor.commit()
          failNextCommit = false
          // SharedPreferences publishes memory before reporting a failed disk commit.
          editor.apply()
          return false
        }
      }
    }
  }
}
