package ai.openclaw.app.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val WarmLightColorScheme = lightColorScheme(
    primary = Color(0xFFD97706),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFEF3C7),
    onPrimaryContainer = Color(0xFF451A03),
    secondary = Color(0xFF706050),
    onSecondary = Color(0xFFFFFFFF),
    surface = Color(0xFFFDF8F0),
    onSurface = Color(0xFF2A241E),
    surfaceVariant = Color(0xFFEDE4D9),
    onSurfaceVariant = Color(0xFF4F4539),
    outline = Color(0xFF817567)
)

private val WarmDarkColorScheme = darkColorScheme(
    primary = Color(0xFFFBBF24),
    onPrimary = Color(0xFF451A03),
    primaryContainer = Color(0xFF78350F),
    onPrimaryContainer = Color(0xFFFEF3C7),
    secondary = Color(0xFFD6D3D1),
    onSecondary = Color(0xFF3A3D46),
    surface = Color(0xFF1C1917),
    onSurface = Color(0xFFF5F5F4),
    surfaceVariant = Color(0xFF44403C),
    onSurfaceVariant = Color(0xFFD6D3D1),
    outline = Color(0xFF918A82)
)

@Composable
fun OpenClawTheme(content: @Composable () -> Unit) {
  val isDark = isSystemInDarkTheme()
  // Use our custom warm schemes instead of dynamic system colors to ensure the "warm" look
  val colorScheme = if (isDark) WarmDarkColorScheme else WarmLightColorScheme
  val mobileColors = if (isDark) darkMobileColors() else lightMobileColors()

  val view = LocalView.current
  if (!view.isInEditMode) {
    SideEffect {
      val window = (view.context as Activity).window
      WindowCompat.getInsetsController(window, window.decorView)
        .isAppearanceLightStatusBars = !isDark
    }
  }

  CompositionLocalProvider(LocalMobileColors provides mobileColors) {
    MaterialTheme(colorScheme = colorScheme, content = content)
  }
}

@Composable
fun overlayContainerColor(): Color {
  val scheme = MaterialTheme.colorScheme
  val isDark = isSystemInDarkTheme()
  val base = if (isDark) scheme.surfaceContainerLow else scheme.surfaceContainerHigh
  return if (isDark) base else base.copy(alpha = 0.88f)
}

@Composable
fun overlayIconColor(): Color {
  return MaterialTheme.colorScheme.onSurfaceVariant
}
