package ai.openclaw.app.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext

@Composable
fun OpenClawTheme(content: @Composable () -> Unit) {
  val context = LocalContext.current
  val isDark = isSystemInDarkTheme()
  // dynamicColorScheme requires Android 12+ (API 31); fall back to static scheme on older devices
  val colorScheme = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    if (isDark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
  } else {
    if (isDark) darkColorScheme() else lightColorScheme()
  }
  val mobileColors = if (isDark) darkMobileColors() else lightMobileColors()

  CompositionLocalProvider(LocalMobileColors provides mobileColors) {
    MaterialTheme(colorScheme = colorScheme, content = content)
  }
}

@Composable
fun overlayContainerColor(): Color {
  val scheme = MaterialTheme.colorScheme
  val isDark = isSystemInDarkTheme()
  val base = if (isDark) scheme.surfaceContainerLow else scheme.surfaceContainerHigh
  // Light mode: background stays dark (canvas), so clamp overlays away from pure-white glare.
  return if (isDark) base else base.copy(alpha = 0.88f)
}

@Composable
fun overlayIconColor(): Color {
  return MaterialTheme.colorScheme.onSurfaceVariant
}
