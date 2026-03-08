package ai.openclaw.app.node

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class DeviceNotificationListenerServiceTest {
  @Test
  fun recentPackages_migratesLegacyPreferenceKey() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs.edit()
      .clear()
      .putString("notifications.recentPackages", "com.example.one, com.example.two")
      .commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.one", "com.example.two"), packages)
    assertEquals(
      "com.example.one, com.example.two",
      prefs.getString("notifications.forwarding.recentPackages", null),
    )
    assertFalse(prefs.contains("notifications.recentPackages"))
  }

  @Test
  fun recentPackages_cleansUpLegacyKeyWhenNewKeyAlreadyExists() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs.edit()
      .clear()
      .putString("notifications.forwarding.recentPackages", "com.example.new")
      .putString("notifications.recentPackages", "com.example.legacy")
      .commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.new"), packages)
    assertNull(prefs.getString("notifications.recentPackages", null))
  }
}
