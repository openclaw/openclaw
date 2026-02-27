package ai.openclaw.android

enum class TelemetryRetention(val rawValue: String, val days: Int) {
  OneDay("1d", 1),
  SevenDays("7d", 7),
  ThirtyDays("30d", 30);

  companion object {
    fun fromRawValue(raw: String?): TelemetryRetention {
      return entries.firstOrNull { it.rawValue == raw } ?: SevenDays
    }
  }
}
