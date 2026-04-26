package ai.openclaw.app.buddy

enum class BuddyAction {
  Play,
  StartVisionScan,
  StartShortListening,
  RepeatLastResponse,
  OpenSettings;

  companion object {
    fun fromTouchRegion(region: String): BuddyAction =
      when (region.trim().lowercase()) {
        "eye", "eyes", "nose" -> StartVisionScan
        "mouth", "chin" -> RepeatLastResponse
        "ear", "ears" -> StartShortListening
        "forehead", "top" -> Play
        "long_press" -> OpenSettings
        else -> Play
      }
  }
}
