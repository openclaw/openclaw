package ai.openclaw.app.chat

import ai.openclaw.app.i18n.nativeString
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeFormatterBuilder
import java.time.format.FormatStyle
import java.time.format.TextStyle
import java.time.temporal.ChronoField
import java.time.temporal.TemporalAdjusters

object SessionSnooze {
  data class Preset(
    val id: String,
    val title: String,
    val wakeAtMs: Long,
  )

  fun presets(
    nowMs: Long,
    zone: ZoneId = ZoneId.systemDefault(),
  ): List<Preset> {
    val now = Instant.ofEpochMilli(nowMs).atZone(zone)
    val today = now.toLocalDate()
    val evening =
      today
        .atTime(18, 0)
        .atZone(zone)
        .toInstant()
        .toEpochMilli()
    val tomorrow =
      today
        .plusDays(1)
        .atTime(9, 0)
        .atZone(zone)
        .toInstant()
        .toEpochMilli()
    val nextMonday =
      today
        .with(TemporalAdjusters.next(DayOfWeek.MONDAY))
        .atTime(9, 0)
        .atZone(zone)
        .toInstant()
        .toEpochMilli()
    return buildList {
      add(Preset("hour", nativeString("In 1 hour"), now.plusHours(1).toInstant().toEpochMilli()))
      add(Preset("three-hours", nativeString("In 3 hours"), now.plusHours(3).toInstant().toEpochMilli()))
      if (evening > now.plusHours(1).toInstant().toEpochMilli()) {
        add(Preset("evening", nativeString("This evening"), evening))
      }
      add(Preset("tomorrow", nativeString("Tomorrow"), tomorrow))
      if (nextMonday != tomorrow) {
        add(Preset("next-week", nativeString("Next week"), nextMonday))
      }
    }
  }

  fun wakeLabel(
    wakeAtMs: Long,
    nowMs: Long,
    zone: ZoneId = ZoneId.systemDefault(),
  ): String {
    val now = Instant.ofEpochMilli(nowMs).atZone(zone)
    val wake = Instant.ofEpochMilli(wakeAtMs).atZone(zone)
    val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).format(wake)
    return when {
      wake.toLocalDate() == now.toLocalDate() -> {
        time
      }

      wake.toLocalDate() == now.toLocalDate().plusDays(1) -> {
        nativeString("tomorrow \$time", time)
      }

      wake.isAfter(now) && !wake.isAfter(now.plusDays(7)) -> {
        DateTimeFormatterBuilder()
          .appendText(ChronoField.DAY_OF_WEEK, TextStyle.SHORT)
          .appendLiteral(' ')
          .appendLocalized(null, FormatStyle.SHORT)
          .toFormatter()
          .format(wake)
      }

      else -> {
        DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).format(wake)
      }
    }
  }

  fun nextWakeMs(
    entries: List<ChatSessionEntry>,
    nowMs: Long,
  ): Long? =
    entries
      .asSequence()
      .filter { it.isSnoozed(nowMs) }
      .mapNotNull { it.snoozedUntil }
      .minOrNull()
}
