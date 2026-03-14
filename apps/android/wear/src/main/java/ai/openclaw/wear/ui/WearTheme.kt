package ai.openclaw.wear.ui

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ColorScheme

private val OpenClawDarkColorScheme = ColorScheme(
  primary = Color(0xFF9ECAFF),
  onPrimary = Color(0xFF003258),
  primaryContainer = Color(0xFF00497D),
  onPrimaryContainer = Color(0xFFD1E4FF),
  secondary = Color(0xFFBBC7DB),
  onSecondary = Color(0xFF263141),
  secondaryContainer = Color(0xFF3C4858),
  onSecondaryContainer = Color(0xFFD7E3F8),
  background = Color(0xFF0F1417),
  onBackground = Color(0xFFE1E2E8),
  onSurface = Color(0xFFE1E2E8),
  surfaceContainer = Color(0xFF1D2226),
  onSurfaceVariant = Color(0xFFC3C6CF),
  error = Color(0xFFFFB4AB),
  onError = Color(0xFF690005),
)

@Composable
fun WearTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = OpenClawDarkColorScheme,
    content = content,
  )
}
