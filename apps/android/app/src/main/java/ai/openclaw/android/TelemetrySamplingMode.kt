package ai.openclaw.android

enum class TelemetrySamplingMode(val rawValue: String) {
  LowPower("low_power"),
  Balanced("balanced"),
  HighDetail("high_detail");

  companion object {
    fun fromRawValue(raw: String?): TelemetrySamplingMode {
      return entries.firstOrNull { it.rawValue == raw } ?: Balanced
    }
  }
}
