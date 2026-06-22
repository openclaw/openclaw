package ai.openclaw.app.node

import ai.openclaw.app.NotificationBurstLimiter
import ai.openclaw.app.NotificationForwardingPolicy
import ai.openclaw.app.NotificationNodeEventQueue
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.PendingNotificationNodeEvent
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.isWithinQuietHours
import android.app.Notification
import android.content.Context
import android.os.Process
import android.service.notification.StatusBarNotification
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
class DeviceNotificationListenerServiceTest {
  @Test
  fun recentPackages_migratesLegacyPreferenceKey() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs
      .edit()
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
    prefs
      .edit()
      .clear()
      .putString("notifications.forwarding.recentPackages", "com.example.new")
      .putString("notifications.recentPackages", "com.example.legacy")
      .commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.new"), packages)
    assertNull(prefs.getString("notifications.recentPackages", null))
  }

  @Test
  fun recentPackages_trimsDedupesAndPreservesRecencyOrder() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = context.getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
    prefs
      .edit()
      .clear()
      .putString(
        "notifications.forwarding.recentPackages",
        " com.example.recent , ,com.example.other,com.example.recent, com.example.third ",
      ).commit()

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(
      listOf("com.example.recent", "com.example.other", "com.example.third"),
      packages,
    )
  }

  @Test
  fun quietHoursAndRateLimitingUseWallClockTimeNotNotificationPostTime() {
    val zone = java.time.ZoneId.systemDefault()
    val now = java.time.ZonedDateTime.now(zone)
    val quietStart =
      now
        .minusMinutes(5)
        .toLocalTime()
        .withSecond(0)
        .withNano(0)
    val quietEnd =
      now
        .plusMinutes(5)
        .toLocalTime()
        .withSecond(0)
        .withNano(0)
    val stalePostTime =
      now
        .minusHours(2)
        .withMinute(0)
        .withSecond(0)
        .withNano(0)
        .toInstant()
        .toEpochMilli()

    val policy =
      NotificationForwardingPolicy(
        enabled = true,
        mode = NotificationPackageFilterMode.Blocklist,
        packages = emptySet(),
        quietHoursEnabled = true,
        quietStart = "%02d:%02d".format(quietStart.hour, quietStart.minute),
        quietEnd = "%02d:%02d".format(quietEnd.hour, quietEnd.minute),
        maxEventsPerMinute = 1,
        sessionKey = null,
      )

    assertFalse(policy.isWithinQuietHours(nowEpochMs = stalePostTime, zoneId = zone))
    assertTrue(policy.isWithinQuietHours(nowEpochMs = System.currentTimeMillis(), zoneId = zone))

    val limiter = NotificationBurstLimiter()
    assertTrue(limiter.allow(nowEpochMs = stalePostTime, maxEventsPerMinute = 1))
    assertTrue(limiter.allow(nowEpochMs = System.currentTimeMillis(), maxEventsPerMinute = 1))
    assertFalse(limiter.allow(nowEpochMs = System.currentTimeMillis(), maxEventsPerMinute = 1))
  }

  @Test
  fun burstLimiter_capsAnyForwardedNotificationEvent() {
    val limiter = NotificationBurstLimiter()
    val nowEpochMs = System.currentTimeMillis()

    assertTrue(limiter.allow(nowEpochMs = nowEpochMs, maxEventsPerMinute = 2))
    assertTrue(limiter.allow(nowEpochMs = nowEpochMs, maxEventsPerMinute = 2))
    assertFalse(limiter.allow(nowEpochMs = nowEpochMs, maxEventsPerMinute = 2))
  }

  @Test
  fun notificationNodeEventQueueDropsOldestAndRequeuesFailedFront() {
    val queue = NotificationNodeEventQueue(capacity = 2)
    val first =
      PendingNotificationNodeEvent(event = "notifications.changed", payloadJson = """{"key":"n1"}""")
    val second =
      PendingNotificationNodeEvent(event = "notifications.changed", payloadJson = """{"key":"n2"}""")
    val third =
      PendingNotificationNodeEvent(event = "notifications.changed", payloadJson = """{"key":"n3"}""")

    queue.enqueue(first)
    queue.enqueue(second)
    queue.enqueue(third)

    assertEquals(second, queue.poll())
    queue.enqueueFirst(second)
    assertEquals(second, queue.poll())
    assertEquals(third, queue.poll())
    assertNull(queue.poll())
  }

  @Test
  @Config(sdk = [34])
  fun reconcileActiveNotificationsReplaysOnlyUndeliveredPostedNotifications() {
    val context = RuntimeEnvironment.getApplication()
    context
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    SecurePrefs(context).setNotificationForwardingEnabled(true)
    val service =
      Robolectric
        .buildService(DeviceNotificationListenerService::class.java)
        .create()
        .get()
    service.onListenerConnected()
    val emitted = mutableListOf<String>()
    DeviceNotificationListenerService.setNodeEventSink { event, payloadJson ->
      if (event == "notifications.changed" && payloadJson != null) {
        emitted += payloadJson
      }
    }

    try {
      service.onNotificationPosted(sampleStatusBarNotification(context, id = 1, postTimeMs = 1_000L))
      val deliveredPayload = emitted.single()
      DeviceNotificationListenerService.markNotificationEventDelivered(
        "notifications.changed",
        deliveredPayload,
      )
      emitted.clear()

      service.onNotificationPosted(sampleStatusBarNotification(context, id = 2, postTimeMs = 2_000L))
      emitted.clear()

      DeviceNotificationListenerService.reconcileActiveNotifications()

      val replayedPayload = emitted.single()
      val replayed = Json.parseToJsonElement(replayedPayload).jsonObject
      assertEquals("posted", replayed["change"]?.jsonPrimitive?.content)
      assertEquals("com.example.bank", replayed["packageName"]?.jsonPrimitive?.content)
      assertEquals("2000", replayed["postTimeMs"]?.jsonPrimitive?.content)
      assertEquals("Payment 2", replayed["title"]?.jsonPrimitive?.content)
    } finally {
      DeviceNotificationListenerService.setNodeEventSink(null)
      service.onDestroy()
    }
  }

  private fun sampleStatusBarNotification(
    context: Context,
    id: Int,
    postTimeMs: Long,
  ): StatusBarNotification {
    val notification =
      Notification
        .Builder(context, "test-notifications")
        .setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("Payment $id")
        .setContentText("Card charge $id")
        .build()
    return StatusBarNotification(
      "com.example.bank",
      "com.example.bank",
      id,
      "tag-$id",
      1_000,
      0,
      notification,
      Process.myUserHandle(),
      postTimeMs,
    )
  }
}
