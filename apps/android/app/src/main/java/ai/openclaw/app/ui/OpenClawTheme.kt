package ai.openclaw.app.ui

import ai.openclaw.app.ThemeMode
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

internal val LocalIsDarkTheme = staticCompositionLocalOf { true }

@Composable
fun OpenClawTheme(themeMode: ThemeMode = ThemeMode.System, content: @Composable () -> Unit) {
    val context = LocalContext.current
    val isDark = when (themeMode) {
        ThemeMode.System -> isSystemInDarkTheme()
        ThemeMode.Light -> false
        ThemeMode.Dark -> true
    }
    val colorScheme = if (isDark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
    val mobileColors = if (isDark) darkMobileColors() else lightMobileColors()

    CompositionLocalProvider(
        LocalMobileColors provides mobileColors,
        LocalIsDarkTheme provides isDark,
    ) {
        MaterialTheme(colorScheme = colorScheme, content = content)
    }
}

@Composable
fun overlayContainerColor(): Color {
    val scheme = MaterialTheme.colorScheme
    val isDark = LocalIsDarkTheme.current
    val base = if (isDark) scheme.surfaceContainerLow else scheme.surfaceContainerHigh
    return if (isDark) base else base.copy(alpha = 0.88f)
}

@Composable
fun overlayIconColor(): Color {
    return MaterialTheme.colorScheme.onSurfaceVariant
}
