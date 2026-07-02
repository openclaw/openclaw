package ai.openclaw.app.node

import ai.openclaw.app.NotificationBurstLimiter
import ai.openclaw.app.NotificationForwardingPolicy
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.isWithinQuietHours
import android.app.Notification
import android.content.Context
import android.service.notification.StatusBarNotification
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
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
@Config(sdk = [34])
class DeviceNotificationListenerServiceTest {
  @After
  fun tearDown() {
    DeviceNotificationListenerService.setNodeEventSink(null)
  }

  @Test
  fun onNotificationPosted_emitsForwardedNotificationEventWhenPolicyAllows() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = resetForwardingPrefs(context)
    prefs.setNotificationForwardingSessionKey("session-notifications")
    val service = notificationService()
    val events = captureNotificationEvents()
    val notification =
      statusBarNotification(
        context = context,
        packageName = "com.example.chat",
        title = "  Chat title  ",
        text = "  Chat body  ",
        subText = "  DM  ",
        category = Notification.CATEGORY_MESSAGE,
        channelId = "messages",
        postTimeMs = 1234L,
      )

    service.onNotificationPosted(notification)

    val event = events.single()
    assertEquals("notifications.changed", event.first)
    val payload = parsePayload(event.second)
    assertEquals("posted", payload.getValue("change").jsonPrimitive.content)
    assertEquals(notification.key, payload.getValue("key").jsonPrimitive.content)
    assertEquals("com.example.chat", payload.getValue("packageName").jsonPrimitive.content)
    assertEquals("1234", payload.getValue("postTimeMs").jsonPrimitive.content)
    assertEquals("Chat title", payload.getValue("title").jsonPrimitive.content)
    assertEquals("Chat body", payload.getValue("text").jsonPrimitive.content)
    assertEquals("DM", payload.getValue("subText").jsonPrimitive.content)
    assertEquals(Notification.CATEGORY_MESSAGE, payload.getValue("category").jsonPrimitive.content)
    assertEquals("messages", payload.getValue("channelId").jsonPrimitive.content)
    assertEquals("session-notifications", payload.getValue("sessionKey").jsonPrimitive.content)
    assertFalse(payload.getValue("isOngoing").jsonPrimitive.boolean)
    assertTrue(payload.getValue("isClearable").jsonPrimitive.boolean)
  }

  @Test
  fun onNotificationPosted_filtersSelfAndAllowlistBeforeEmitting() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = resetForwardingPrefs(context)
    prefs.setNotificationForwardingMode(NotificationPackageFilterMode.Allowlist)
    prefs.setNotificationForwardingPackages(listOf("com.example.allowed"))
    val service = notificationService()
    val events = captureNotificationEvents()

    service.onNotificationPosted(
      statusBarNotification(context = context, packageName = context.packageName, id = 1),
    )
    service.onNotificationPosted(
      statusBarNotification(context = context, packageName = "com.example.blocked", id = 2),
    )
    service.onNotificationPosted(
      statusBarNotification(context = context, packageName = "com.example.allowed", id = 3),
    )

    assertEquals(1, events.size)
    val payload = parsePayload(events.single().second)
    assertEquals("com.example.allowed", payload.getValue("packageName").jsonPrimitive.content)
  }

  @Test
  fun onNotificationPosted_appliesQuietHoursAndBurstLimit() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = resetForwardingPrefs(context)
    val service = notificationService()
    val events = captureNotificationEvents()
    val now = ZonedDateTime.now(ZoneId.systemDefault())
    val quietStart = now.minusMinutes(5).toLocalTime().withSecond(0).withNano(0)
    val quietEnd = now.plusMinutes(5).toLocalTime().withSecond(0).withNano(0)
    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = true,
        start = "%02d:%02d".format(quietStart.hour, quietStart.minute),
        end = "%02d:%02d".format(quietEnd.hour, quietEnd.minute),
      ),
    )

    service.onNotificationPosted(
      statusBarNotification(context = context, packageName = "com.example.quiet", id = 10),
    )
    assertTrue(events.isEmpty())

    assertTrue(
      prefs.setNotificationForwardingQuietHours(
        enabled = false,
        start = "22:00",
        end = "07:00",
      ),
    )
    prefs.setNotificationForwardingMaxEventsPerMinute(1)

    service.onNotificationPosted(
      statusBarNotification(context = context, packageName = "com.example.chat", id = 11),
    )
    service.onNotificationPosted(
      statusBarNotification(context = context, packageName = "com.example.mail", id = 12),
    )

    assertEquals(1, events.size)
    val payload = parsePayload(events.single().second)
    assertEquals("com.example.chat", payload.getValue("packageName").jsonPrimitive.content)
  }

  @Test
  fun onNotificationRemoved_emitsRemovedEventWithoutNotificationContent() {
    val context = RuntimeEnvironment.getApplication()
    resetForwardingPrefs(context)
    val service = notificationService()
    val events = captureNotificationEvents()
    val notification =
      statusBarNotification(
        context = context,
        packageName = "com.example.removed",
        id = 42,
        title = "Should not be forwarded",
        text = "Removed notifications only need identity fields",
        postTimeMs = 5678L,
      )

    service.onNotificationRemoved(notification)

    val payload = parsePayload(events.single().second)
    assertEquals("removed", payload.getValue("change").jsonPrimitive.content)
    assertEquals(notification.key, payload.getValue("key").jsonPrimitive.content)
    assertEquals("com.example.removed", payload.getValue("packageName").jsonPrimitive.content)
    assertEquals("5678", payload.getValue("postTimeMs").jsonPrimitive.content)
    assertFalse("title" in payload)
    assertFalse("text" in payload)
  }

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

  private fun resetForwardingPrefs(context: Context): SecurePrefs {
    context
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    context
      .getSharedPreferences("openclaw.secure", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    return SecurePrefs(context).apply {
      setNotificationForwardingEnabled(true)
      setNotificationForwardingMode(NotificationPackageFilterMode.Blocklist)
      setNotificationForwardingPackages(emptyList())
      setNotificationForwardingMaxEventsPerMinute(20)
      setNotificationForwardingSessionKey(null)
      assertTrue(
        setNotificationForwardingQuietHours(
          enabled = false,
          start = "22:00",
          end = "07:00",
        ),
      )
    }
  }

  private fun notificationService(): DeviceNotificationListenerService =
    Robolectric
      .buildService(DeviceNotificationListenerService::class.java)
      .create()
      .get()

  private fun captureNotificationEvents(): MutableList<Pair<String, String?>> {
    val events = mutableListOf<Pair<String, String?>>()
    DeviceNotificationListenerService.setNodeEventSink { event, payloadJson ->
      events += event to payloadJson
    }
    return events
  }

  private fun parsePayload(payloadJson: String?): kotlinx.serialization.json.JsonObject {
    val raw = payloadJson ?: error("expected notification payload")
    return Json.parseToJsonElement(raw).jsonObject
  }

  @Suppress("DEPRECATION")
  private fun statusBarNotification(
    context: Context,
    packageName: String,
    id: Int = 1,
    title: String = "Title",
    text: String = "Body",
    subText: String? = null,
    category: String? = null,
    channelId: String = "default",
    postTimeMs: Long = 1_000L,
  ): StatusBarNotification {
    val notification =
      Notification
        .Builder(context, channelId)
        .setContentTitle(title)
        .setContentText(text)
        .apply {
          subText?.let(::setSubText)
          category?.let(::setCategory)
        }.build()
    return StatusBarNotification(
      packageName,
      packageName,
      id,
      "tag-$id",
      1000,
      0,
      0,
      notification,
      android.os.Process.myUserHandle(),
      postTimeMs,
    )
  }
}
