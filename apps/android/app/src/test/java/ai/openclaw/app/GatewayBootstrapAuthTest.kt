package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBootstrapAuthTest {
  @Test
  fun connectsOperatorSessionWhenBootstrapAuthExists() {
    assertTrue(shouldConnectOperatorSession(token = "", bootstrapToken = "bootstrap-1", password = "", storedOperatorToken = ""))
    assertTrue(shouldConnectOperatorSession(token = null, bootstrapToken = "bootstrap-1", password = null, storedOperatorToken = null))
  }

  @Test
  fun skipsOperatorSessionOnlyWhenNoSharedBootstrapOrStoredAuthExists() {
    assertTrue(shouldConnectOperatorSession(token = "shared-token", bootstrapToken = "bootstrap-1", password = null, storedOperatorToken = null))
    assertTrue(shouldConnectOperatorSession(token = null, bootstrapToken = "bootstrap-1", password = "shared-password", storedOperatorToken = null))
    assertTrue(shouldConnectOperatorSession(token = null, bootstrapToken = null, password = null, storedOperatorToken = "stored-token"))
    assertFalse(shouldConnectOperatorSession(token = null, bootstrapToken = "", password = null, storedOperatorToken = null))
  }

  @Test
  fun resolveGatewayConnectAuth_prefersExplicitSetupAuthOverStoredPrefs() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setGatewayToken("stale-shared-token")
    prefs.setGatewayBootstrapToken("")
    prefs.setGatewayPassword("stale-password")
    val runtime = NodeRuntime(app, prefs)

    val auth =
      runtime.resolveGatewayConnectAuth(
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        ),
      )

    assertNull(auth.token)
    assertEquals("setup-bootstrap-token", auth.bootstrapToken)
    assertNull(auth.password)
  }

  @Test
  fun acceptGatewayTrustPrompt_preservesExplicitSetupAuth() =
    runBlocking {
      val app = RuntimeEnvironment.getApplication()
      val securePrefs =
        app.getSharedPreferences(
          "openclaw.node.secure.test.${UUID.randomUUID()}",
          android.content.Context.MODE_PRIVATE,
        )
      val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
      prefs.setGatewayToken("stale-shared-token")
      prefs.setGatewayBootstrapToken("")
      prefs.setGatewayPassword("stale-password")
      val runtime =
        NodeRuntime(
          app,
          prefs,
          tlsFingerprintProbe = { _, _ -> "fp-1" },
        )
      val endpoint = GatewayEndpoint.manual(host = "gateway.example", port = 18789)
      val explicitAuth =
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        )

      runtime.connect(endpoint, explicitAuth)
      val prompt = waitForGatewayTrustPrompt(runtime)
      assertEquals("setup-bootstrap-token", prompt.auth.bootstrapToken)

      runtime.acceptGatewayTrustPrompt()

      assertEquals("fp-1", prefs.loadGatewayTlsFingerprint(endpoint.stableId))
      assertEquals("setup-bootstrap-token", desiredBootstrapToken(runtime, "nodeSession"))
      assertEquals("setup-bootstrap-token", desiredBootstrapToken(runtime, "operatorSession"))
    }

  private fun waitForGatewayTrustPrompt(runtime: NodeRuntime): NodeRuntime.GatewayTrustPrompt {
    repeat(50) {
      runtime.pendingGatewayTrust.value?.let { return it }
      Thread.sleep(10)
    }
    error("Expected pending gateway trust prompt")
  }

  private fun desiredBootstrapToken(runtime: NodeRuntime, sessionFieldName: String): String? {
    val session = readField<GatewaySession>(runtime, sessionFieldName)
    val desired = readField<Any?>(session, "desired") ?: return null
    return readField(desired, "bootstrapToken")
  }

  private fun <T> readField(target: Any, name: String): T {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(target) as T
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }
}
