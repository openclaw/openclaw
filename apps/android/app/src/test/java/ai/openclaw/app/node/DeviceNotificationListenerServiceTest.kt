package ai.openclaw.app.node

import ai.openclaw.app.NotificationBurstLimiter
import ai.openclaw.app.NotificationForwardingPolicy
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.gateway.OpenClawSQLiteStateStore
import ai.openclaw.app.isWithinQuietHours
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File

@RunWith(RobolectricTestRunner::class)
class DeviceNotificationListenerServiceTest {
  @Before
  fun resetState() {
    val context = RuntimeEnvironment.getApplication()
    File(context.filesDir, "openclaw").deleteRecursively()
  }

  @Test
  fun recentPackages_readsSqliteRows() {
    val context = RuntimeEnvironment.getApplication()
    OpenClawSQLiteStateStore(context).replaceRecentNotificationPackages(
      listOf("com.example.one", "com.example.two"),
    )

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.one", "com.example.two"), packages)
  }

  @Test
  fun recentPackages_trimsDedupesAndPreservesRecencyOrder() {
    val context = RuntimeEnvironment.getApplication()
    OpenClawSQLiteStateStore(context).replaceRecentNotificationPackages(
      listOf(" com.example.recent ", "", "com.example.other", "com.example.recent", "com.example.third"),
    )

    val packages = DeviceNotificationListenerService.recentPackages(context)

    assertEquals(listOf("com.example.recent", "com.example.other", "com.example.third"), packages)
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
}
