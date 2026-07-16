package ai.openclaw.wear

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.core.content.edit
import androidx.wear.compose.material3.MaterialTheme

internal enum class WearThemeMode(
  val rawValue: String,
) {
  Dark(rawValue = "dark"),
  Light(rawValue = "light"),
  ;

  companion object {
    fun fromRawValue(value: String?): WearThemeMode = entries.firstOrNull { mode -> mode.rawValue == value?.trim()?.lowercase() } ?: Dark
  }
}

internal class WearThemePreferences(
  context: Context,
) {
  private val preferences =
    context.applicationContext.getSharedPreferences(
      PREFERENCES_NAME,
      Context.MODE_PRIVATE,
    )

  fun read(): WearThemeMode = WearThemeMode.fromRawValue(preferences.getString(THEME_MODE_KEY, null))

  fun write(mode: WearThemeMode) {
    preferences.edit {
      putString(THEME_MODE_KEY, mode.rawValue)
    }
  }

  private companion object {
    const val PREFERENCES_NAME = "openclaw.wear.appearance"
    const val THEME_MODE_KEY = "themeMode"
  }
}

internal class WearConversationPreferences(
  private val preferences: SharedPreferences,
) {
  constructor(context: Context) :
    this(
      context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
      ),
    )

  fun readAutoSpeak(): Boolean =
    preferences.getBoolean(
      AUTO_SPEAK_KEY,
      DEFAULT_AUTO_SPEAK,
    )

  fun writeAutoSpeak(enabled: Boolean) {
    preferences.edit {
      putBoolean(AUTO_SPEAK_KEY, enabled)
    }
  }

  private companion object {
    const val DEFAULT_AUTO_SPEAK = false
    const val PREFERENCES_NAME = "openclaw.wear.conversation"
    const val AUTO_SPEAK_KEY = "autoSpeak"
  }
}

@Immutable
internal data class WearColors(
  val canvas: Color,
  val surface: Color,
  val surfaceRaised: Color,
  val border: Color,
  val text: Color,
  val textMuted: Color,
  val primary: Color,
  val primaryText: Color,
  val success: Color,
  val warning: Color,
  val danger: Color,
)

private val DarkWearColors =
  WearColors(
    canvas = Color(0xFF030303),
    surface = Color(0xFF0A0A0A),
    surfaceRaised = Color(0xFF111111),
    border = Color(0xFF242424),
    text = Color(0xFFF8F8F8),
    textMuted = Color(0xFFA8A8A8),
    primary = Color(0xFFFFFFFF),
    primaryText = Color(0xFF050505),
    success = Color(0xFF3EDB82),
    warning = Color(0xFFE6B956),
    danger = Color(0xFFFF6B6B),
  )

private val LightWearColors =
  WearColors(
    canvas = Color(0xFFFAFBFC),
    surface = Color(0xFFFFFEFB),
    surfaceRaised = Color(0xFFFFFFFF),
    border = Color(0xFFDDE3EC),
    text = Color(0xFF111318),
    textMuted = Color(0xFF505865),
    primary = Color(0xFF111827),
    primaryText = Color(0xFFFFFFFF),
    success = Color(0xFF217747),
    warning = Color(0xFFA56F17),
    danger = Color(0xFFB82929),
  )

private val LocalWearColors = staticCompositionLocalOf { DarkWearColors }

internal object OpenClawWearTheme {
  val colors: WearColors
    @Composable
    @ReadOnlyComposable
    get() = LocalWearColors.current
}

@Composable
internal fun OpenClawWearTheme(
  themeMode: WearThemeMode,
  content: @Composable () -> Unit,
) {
  val colors =
    when (themeMode) {
      WearThemeMode.Dark -> DarkWearColors
      WearThemeMode.Light -> LightWearColors
    }
  val colorScheme =
    MaterialTheme.colorScheme.copy(
      primary = colors.primary,
      primaryContainer = colors.surfaceRaised,
      onPrimary = colors.primaryText,
      onPrimaryContainer = colors.text,
      surfaceContainerLow = colors.surface,
      surfaceContainer = colors.surface,
      surfaceContainerHigh = colors.surfaceRaised,
      onSurface = colors.text,
      onSurfaceVariant = colors.textMuted,
      outline = colors.border,
      outlineVariant = colors.border,
      background = colors.canvas,
      onBackground = colors.text,
      error = colors.danger,
      onError = colors.primaryText,
    )

  MaterialTheme(colorScheme = colorScheme) {
    CompositionLocalProvider(
      LocalWearColors provides colors,
      content = content,
    )
  }
}
