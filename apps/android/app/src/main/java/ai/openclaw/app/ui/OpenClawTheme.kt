package ai.openclaw.app.ui

import android.content.Context
import android.os.Build
import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

@Composable
fun OpenClawTheme(content: @Composable () -> Unit) {
  val context = LocalContext.current
  val isDark = isSystemInDarkTheme()
  val colorScheme = colorScheme(context, isDark)
  val mobileColors = if (isDark) darkMobileColors() else lightMobileColors()

  val view = LocalView.current
  if (!view.isInEditMode) {
    SideEffect {
      val window = (view.context as Activity).window
      WindowCompat.getInsetsController(window, window.decorView).apply {
        isAppearanceLightStatusBars = !isDark
        isAppearanceLightNavigationBars = !isDark
      }
    }
  }

  CompositionLocalProvider(LocalMobileColors provides mobileColors) {
    MaterialTheme(colorScheme = colorScheme, content = content)
  }
}

private fun colorScheme(context: Context, isDark: Boolean): ColorScheme {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    return when {
      isDark -> dynamicDarkColorScheme(context)
      else -> dynamicLightColorScheme(context)
    }
  }
  return when {
    isDark -> darkColorScheme()
    else -> lightColorScheme()
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
