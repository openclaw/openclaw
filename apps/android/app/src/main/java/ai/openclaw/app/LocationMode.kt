package ai.openclaw.app

enum class LocationMode(val rawValue: String) {
  Off("off"),
  WhileUsing("whileUsing"),
  Always("always"),
  ;

  companion object {
    fun fromRawValue(raw: String?): LocationMode {
      val normalized = raw?.trim()?.lowercase()
      return entries.firstOrNull { it.rawValue.lowercase() == normalized } ?: Off
    }
  }
}

fun restoreLocationModeAfterCanceledAlwaysGrant(
  previousMode: LocationMode?,
  locationGranted: Boolean,
): LocationMode? {
  return when (previousMode) {
    null -> null
    LocationMode.Off -> LocationMode.Off
    LocationMode.WhileUsing,
    LocationMode.Always,
    -> if (locationGranted) LocationMode.WhileUsing else LocationMode.Off
  }
}
