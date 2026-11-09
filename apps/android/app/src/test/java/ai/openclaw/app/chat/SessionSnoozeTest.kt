package ai.openclaw.app.chat

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

class SessionSnoozeTest {
  private val zone = ZoneId.of("America/Los_Angeles")
  private val previousLocale = Locale.getDefault()

  @Before
  fun setLocale() {
    Locale.setDefault(Locale.US)
  }

  @After
  fun restoreLocale() {
    Locale.setDefault(previousLocale)
  }

  @Test
  fun weekdayMorningOffersElapsedHoursAndLocalCalendarPresets() {
    val presets = SessionSnooze.presets(instant("2026-09-30T17:00:00Z"), zone)

    assertEquals(
      listOf(
        SessionSnooze.Preset("hour", "In 1 hour", instant("2026-09-30T18:00:00Z")),
        SessionSnooze.Preset("three-hours", "In 3 hours", instant("2026-09-30T20:00:00Z")),
        SessionSnooze.Preset("evening", "This evening", instant("2026-10-01T01:00:00Z")),
        SessionSnooze.Preset("tomorrow", "Tomorrow", instant("2026-10-01T16:00:00Z")),
        SessionSnooze.Preset("next-week", "Next week", instant("2026-10-05T16:00:00Z")),
      ),
      presets,
    )
  }

  @Test
  fun eveningRequiresMoreThanOneHourOfNotice() {
    val cases =
      listOf(
        "2026-09-30T23:59:59Z" to true,
        "2026-10-01T00:00:00Z" to false,
        "2026-10-01T00:30:00Z" to false,
      )

    for ((now, offersEvening) in cases) {
      assertEquals(now, offersEvening, SessionSnooze.presets(instant(now), zone).any { it.id == "evening" })
    }
  }

  @Test
  fun sundayOmitsNextWeekWhenItIsTomorrowButMondayUsesTheFollowingMonday() {
    val sunday = SessionSnooze.presets(instant("2026-10-04T17:00:00Z"), zone)
    assertFalse(sunday.any { it.id == "next-week" })
    assertEquals(instant("2026-10-05T16:00:00Z"), sunday.single { it.id == "tomorrow" }.wakeAtMs)

    val monday = SessionSnooze.presets(instant("2026-10-05T17:00:00Z"), zone)
    assertEquals(instant("2026-10-12T16:00:00Z"), monday.single { it.id == "next-week" }.wakeAtMs)
  }

  @Test
  fun daylightSavingChangesKeepCalendarPresetsAtLocalNineAndEighteen() {
    val spring = SessionSnooze.presets(instant("2026-03-08T09:30:00Z"), zone)
    assertEquals(instant("2026-03-08T10:30:00Z"), spring.single { it.id == "hour" }.wakeAtMs)
    assertEquals(instant("2026-03-08T12:30:00Z"), spring.single { it.id == "three-hours" }.wakeAtMs)
    assertEquals(instant("2026-03-09T01:00:00Z"), spring.single { it.id == "evening" }.wakeAtMs)
    assertEquals(instant("2026-03-09T16:00:00Z"), spring.single { it.id == "tomorrow" }.wakeAtMs)

    val autumn = SessionSnooze.presets(instant("2026-11-01T07:30:00Z"), zone)
    assertEquals(instant("2026-11-02T02:00:00Z"), autumn.single { it.id == "evening" }.wakeAtMs)
    assertEquals(instant("2026-11-02T17:00:00Z"), autumn.single { it.id == "tomorrow" }.wakeAtMs)
  }

  @Test
  fun snoozeIsActiveOnlyBeforeItsDeadline() {
    val now = instant("2026-09-30T17:00:00Z")
    val entry = ChatSessionEntry(key = "session", updatedAtMs = null)

    assertFalse(entry.isSnoozed(now))
    assertFalse(entry.copy(snoozedUntil = now - 1).isSnoozed(now))
    assertFalse(entry.copy(snoozedUntil = now).isSnoozed(now))
    assertTrue(entry.copy(snoozedUntil = now + 1).isSnoozed(now))
  }

  @Test
  fun wakeLabelsDistinguishTodayTomorrowNearWeekdaysAndDates() {
    val now = instant("2026-09-30T17:00:00Z")
    val cases =
      listOf(
        "2026-09-30T18:00:00Z" to "11:00 AM",
        "2026-10-01T16:00:00Z" to "tomorrow 9:00 AM",
        "2026-10-02T16:00:00Z" to "Fri 9:00 AM",
        "2026-10-07T17:00:00Z" to "Wed 10:00 AM",
        "2026-10-07T17:00:00.001Z" to "10/7/26, 10:00 AM",
        "2026-09-29T16:00:00Z" to "9/29/26, 9:00 AM",
      )

    for ((wake, expected) in cases) {
      assertEquals(wake, expected, normalizedLabel(SessionSnooze.wakeLabel(instant(wake), now, zone)))
    }
  }

  @Test
  fun wakeLabelsUseCalendarDaysAcrossDaylightSavingChanges() {
    val now = instant("2026-03-07T18:00:00Z")

    assertEquals("tomorrow 9:00 AM", normalizedLabel(SessionSnooze.wakeLabel(instant("2026-03-08T16:00:00Z"), now, zone)))
    assertEquals("Sat 10:00 AM", normalizedLabel(SessionSnooze.wakeLabel(instant("2026-03-14T17:00:00Z"), now, zone)))
    assertEquals("3/14/26, 10:00 AM", normalizedLabel(SessionSnooze.wakeLabel(instant("2026-03-14T17:00:00.001Z"), now, zone)))
  }

  @Test
  fun nextWakeSkipsExpiredAndAbsentDeadlinesAndChoosesTheEarliest() {
    val now = instant("2026-09-30T17:00:00Z")
    val entries =
      listOf(null, now - 1, now, now + 3_000, now + 1_000, now + 2_000).mapIndexed { index, wake ->
        ChatSessionEntry(key = "session-$index", updatedAtMs = null, snoozedUntil = wake)
      }

    assertEquals(now + 1_000, SessionSnooze.nextWakeMs(entries, now))
    assertEquals(now + 2_000, SessionSnooze.nextWakeMs(entries, now + 1_000))
    assertNull(SessionSnooze.nextWakeMs(entries, now + 3_000))
    assertNull(SessionSnooze.nextWakeMs(emptyList(), now))
  }

  private fun instant(value: String): Long = Instant.parse(value).toEpochMilli()

  private fun normalizedLabel(value: String): String = value.replace('\u202f', ' ').replace('\u00a0', ' ')
}
