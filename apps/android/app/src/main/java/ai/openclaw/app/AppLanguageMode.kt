package ai.openclaw.app

import android.content.Context
import android.content.res.Configuration
import android.os.LocaleList
import java.util.Locale

internal const val appLanguageModePreferenceKey = "appearance.languageMode"
internal const val openClawPlainPrefsName = "openclaw.node"

enum class AppLanguageMode(
  val rawValue: String,
  val localeTag: String?,
  val displayLabel: String,
  val nativeLabel: String,
) {
  System("system", null, "System", "Use device language"),
  English("en", "en", "English", "English"),
  ChineseSimplified("zh-CN", "zh-CN", "Chinese (Simplified)", "简体中文"),
  ChineseTraditional("zh-TW", "zh-TW", "Chinese (Traditional)", "繁體中文"),
  PortugueseBrazil("pt-BR", "pt-BR", "Portuguese (Brazil)", "Português (Brasil)"),
  German("de", "de", "German", "Deutsch"),
  Spanish("es", "es", "Spanish", "Español"),
  Japanese("ja-JP", "ja-JP", "Japanese", "日本語"),
  Korean("ko", "ko", "Korean", "한국어"),
  French("fr", "fr", "French", "Français"),
  Hindi("hi", "hi", "Hindi", "हिन्दी"),
  Arabic("ar", "ar", "Arabic", "العربية"),
  Italian("it", "it", "Italian", "Italiano"),
  Turkish("tr", "tr", "Turkish", "Türkçe"),
  Ukrainian("uk", "uk", "Ukrainian", "Українська"),
  Indonesian("id", "id", "Indonesian", "Bahasa Indonesia"),
  Polish("pl", "pl", "Polish", "Polski"),
  Thai("th", "th", "Thai", "ไทย"),
  Vietnamese("vi", "vi", "Vietnamese", "Tiếng Việt"),
  Dutch("nl", "nl", "Dutch", "Nederlands"),
  Persian("fa", "fa", "فارسی", "فارسی"),
  Russian("ru", "ru", "Russian", "Русский"),
  Swedish("sv", "sv", "Swedish", "Svenska"),
  ;

  companion object {
    fun fromRawValue(raw: String?): AppLanguageMode = entries.firstOrNull { it.rawValue == raw?.trim() } ?: System

    fun fromLocaleTag(localeTag: String?): AppLanguageMode = entries.firstOrNull { it.localeTag == localeTag?.trim() } ?: System
  }
}

fun appLanguageOptions(): List<AppLanguageMode> = AppLanguageMode.entries

fun appLanguageModeForLabel(label: String): AppLanguageMode =
  AppLanguageMode.entries.firstOrNull { mode ->
    mode.displayLabel == label ||
      mode.nativeLabel == label ||
      appLanguageOptionLabel(mode) == label
  } ?: AppLanguageMode.System

fun appLanguageOptionLabel(mode: AppLanguageMode): String =
  if (mode == AppLanguageMode.System) {
    mode.displayLabel
  } else {
    "${mode.displayLabel} · ${mode.nativeLabel}"
  }

fun appLanguageSummary(mode: AppLanguageMode): String = appLanguageOptionLabel(mode)

fun currentDeviceLanguageTag(): String {
  val locales = LocaleList.getDefault()
  return if (locales.isEmpty) {
    Locale.getDefault().toLanguageTag()
  } else {
    locales[0].toLanguageTag()
  }
}

fun openClawLocalizedContext(
  base: Context,
  mode: AppLanguageMode,
): Context {
  val localeTag = mode.localeTag
  if (localeTag == null) {
    val baseLocales = base.resources.configuration.locales
    if (!baseLocales.isEmpty) {
      Locale.setDefault(baseLocales[0])
    }
    return base
  }
  val localeList = LocaleList.forLanguageTags(localeTag)
  if (localeList.isEmpty) return base
  val locale = localeList[0]
  Locale.setDefault(locale)
  val config = Configuration(base.resources.configuration)
  config.setLocales(localeList)
  config.setLayoutDirection(locale)
  return base.createConfigurationContext(config)
}

fun openClawLocalizedContextFromPrefs(base: Context): Context {
  val prefs = base.getSharedPreferences(openClawPlainPrefsName, Context.MODE_PRIVATE)
  return openClawLocalizedContext(
    base = base,
    mode = AppLanguageMode.fromRawValue(prefs.getString(appLanguageModePreferenceKey, null)),
  )
}
