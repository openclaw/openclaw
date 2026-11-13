package ai.openclaw.app.node

import android.Manifest
import android.app.NotificationManager
import android.os.Build
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@Config(sdk = [31, 34])
class NotificationPermissionStateTest : NodeHandlerRobolectricTest() {
  @Test
  fun appNotificationSettingIsReflectedByPermissionReportsAndPosting() {
    val app = RuntimeEnvironment.getApplication()
    if (Build.VERSION.SDK_INT >= 33) {
      shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }
    val manager = app.getSystemService(NotificationManager::class.java)
    val managerShadow = shadowOf(manager)
    val device = DeviceHandler(app)
    val system = SystemHandler(app)

    for (enabled in listOf(false, true)) {
      managerShadow.setNotificationsEnabled(enabled)

      val snapshot =
        readAndroidPermissionSnapshot(
          context = app,
          smsEnabled = false,
          callLogEnabled = false,
          photosEnabled = false,
          backgroundLocationEnabled = false,
        )
      assertEquals(enabled, snapshot.notifications)
      assertEquals(enabled, snapshot.gatewayPermissions().getValue("notifications"))

      val result = device.handleDevicePermissions(null)
      assertTrue(result.ok)
      val payload = Json.parseToJsonElement(requireNotNull(result.payloadJson)).jsonObject
      val permissions = payload.getValue("permissions").jsonObject
      val notification = permissions.getValue("notifications").jsonObject
      val status = notification.getValue("status").jsonPrimitive.content
      assertEquals(if (enabled) "granted" else "denied", status)

      val posted = system.handleSystemNotify("""{"title":"Permission test","body":"Synthetic notice"}""")
      assertEquals(enabled, posted.ok)
      if (!enabled) {
        assertEquals("NOT_AUTHORIZED", posted.error?.code)
        assertTrue(manager.activeNotifications.isEmpty())
      } else {
        assertEquals(1, manager.activeNotifications.size)
      }
    }
  }

  @Test
  @Config(sdk = [34])
  fun enabledAppSettingDoesNotOverrideDeniedRuntimePermission() {
    val app = RuntimeEnvironment.getApplication()
    shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val manager = app.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)

    val snapshot =
      readAndroidPermissionSnapshot(
        context = app,
        smsEnabled = false,
        callLogEnabled = false,
        photosEnabled = false,
        backgroundLocationEnabled = false,
      )

    assertFalse(snapshot.notifications)
    assertFalse(snapshot.gatewayPermissions().getValue("notifications"))
    val result = SystemHandler(app).handleSystemNotify("""{"title":"Permission test","body":"Denied"}""")
    assertFalse(result.ok)
    assertEquals("NOT_AUTHORIZED", result.error?.code)
    assertTrue(manager.activeNotifications.isEmpty())
  }
}
