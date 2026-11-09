package ai.openclaw.app.node

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SystemNotificationBodyTest {
  @Test
  fun postedNotificationExposesMultilineBodyWhenExpanded() {
    val context: Application = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val manager = context.getSystemService(NotificationManager::class.java)
    val body =
      "The train leaves from platform 8 at 18:42.\n" +
        "Use the north entrance because the main concourse is closed.\n" +
        "Bring the printed reservation and arrive fifteen minutes before departure."
    val params =
      buildJsonObject {
        put("title", "Travel reminder")
        put("body", body)
        put("priority", "passive")
        put("sound", "none")
      }
    val handler = SystemHandler(context)

    val result = handler.handleSystemNotify(params.toString())

    assertTrue(result.ok)
    val notification = manager.activeNotifications.single().notification
    val expandedBody = notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
    assertEquals(body, expandedBody?.toString())
    assertEquals(body, notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
    assertEquals("Travel reminder", notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
    assertEquals("openclaw.system.notify.passive", notification.channelId)
    assertEquals(NotificationManager.IMPORTANCE_LOW, manager.getNotificationChannel(notification.channelId).importance)
    assertNotNull(notification.contentIntent)
  }

  @Test
  fun titleOnlyNotificationStillPosts() {
    val context: Application = RuntimeEnvironment.getApplication()
    Shadows.shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    val manager = context.getSystemService(NotificationManager::class.java)
    val handler = SystemHandler(context)

    val result = handler.handleSystemNotify("""{"title":"Ready","body":""}""")

    assertTrue(result.ok)
    val notification = manager.activeNotifications.single().notification
    assertEquals("Ready", notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString())
    assertEquals("", notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString())
    assertEquals("openclaw.system.notify.active", notification.channelId)
    assertNotNull(notification.contentIntent)
  }
}
