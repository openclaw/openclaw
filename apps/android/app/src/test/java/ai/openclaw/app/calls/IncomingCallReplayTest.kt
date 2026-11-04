package ai.openclaw.app.calls

import ai.openclaw.app.SecurePrefs
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class IncomingCallReplayTest {
  @Test
  fun `consumed invitation survives prefs recreation without persisting briefing`() {
    val context = RuntimeEnvironment.getApplication()
    val backing = context.getSharedPreferences("calls-test-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(context, backing)
    val id = UUID.randomUUID().toString()
    val expires = System.currentTimeMillis() + 60_000
    assertTrue(prefs.consumeIncomingCallId(id, expires))
    assertFalse(SecurePrefs(context, backing).consumeIncomingCallId(id, expires))
  }

  @Test
  fun `failed durable commit rejects invitation instead of claiming it was consumed`() {
    val context = RuntimeEnvironment.getApplication()
    val backing = context.getSharedPreferences("calls-failed-commit-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(context, backing)
    var commits = 0
    val failingBacking =
      object : SharedPreferences by backing {
        override fun edit(): SharedPreferences.Editor =
          object : SharedPreferences.Editor by backing.edit() {
            override fun putStringSet(
              key: String?,
              values: MutableSet<String>?,
            ): SharedPreferences.Editor = this

            override fun commit(): Boolean {
              commits++
              return false
            }

            override fun apply() = error("Admission must await durable commit")
          }
      }
    ReflectionHelpers.setField(prefs, "plainPrefs", failingBacking)

    assertFalse(prefs.consumeIncomingCallId(UUID.randomUUID().toString(), System.currentTimeMillis() + 60_000))
    assertEquals(1, commits)
  }

  @Test
  fun `call surface is private and Telecom binding requires platform permission`() {
    val context = RuntimeEnvironment.getApplication()
    val service = context.packageManager.getServiceInfo(ComponentName(context, IncomingCallConnectionService::class.java), PackageManager.GET_META_DATA)
    assertEquals("android.permission.BIND_TELECOM_CONNECTION_SERVICE", service.permission)
    val activity = context.packageManager.getActivityInfo(ComponentName(context, IncomingCallActivity::class.java), 0)
    assertFalse(activity.exported)
  }
}
