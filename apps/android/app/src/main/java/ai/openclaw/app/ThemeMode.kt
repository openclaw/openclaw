package ai.openclaw.app

enum class ThemeMode(val rawValue: String) {
    System("system"),
    Light("light"),
    Dark("dark"),
    ;

    companion object {
        fun fromRawValue(raw: String?): ThemeMode {
            val normalized = raw?.trim()?.lowercase()
            return entries.firstOrNull { it.rawValue == normalized } ?: System
        }
    }
}
