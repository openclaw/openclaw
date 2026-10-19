package ai.openclaw.app

import android.content.Context
import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class SecurePrefsCommitTest {
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
