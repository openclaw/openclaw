package ai.openclaw.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ai.openclaw.app.R

// ---------------------------------------------------------------------------
// MobileColors – semantic color tokens with light + dark variants
// ---------------------------------------------------------------------------

internal data class MobileColors(
  val surface: Color,
  val surfaceStrong: Color,
  val cardSurface: Color,
  val border: Color,
  val borderStrong: Color,
  val text: Color,
  val textSecondary: Color,
  val textTertiary: Color,
  val accent: Color,
  val accentSoft: Color,
  val accentBorderStrong: Color,
  val success: Color,
  val successSoft: Color,
  val warning: Color,
  val warningSoft: Color,
  val danger: Color,
  val dangerSoft: Color,
  val codeBg: Color,
  val codeText: Color,
  val codeBorder: Color,
  val codeAccent: Color,
  val chipBorderConnected: Color,
  val chipBorderConnecting: Color,
  val chipBorderWarning: Color,
  val chipBorderError: Color,
)

internal fun lightMobileColors() =
  MobileColors(
    surface = Color(0xFFFDF8F0),
    surfaceStrong = Color(0xFFF4EDE4),
    cardSurface = Color(0xFFFFFFFF),
    border = Color(0xFFEDE4D9),
    borderStrong = Color(0xFFE0D4C3),
    text = Color(0xFF2A241E),
    textSecondary = Color(0xFF706050),
    textTertiary = Color(0xFFA89A88),
    accent = Color(0xFFD97706),
    accentSoft = Color(0xFFFEF3C7),
    accentBorderStrong = Color(0xFFB45309),
    success = Color(0xFF166534),
    successSoft = Color(0xFFDCFCE7),
    warning = Color(0xFF9A3412),
    warningSoft = Color(0xFFFFEDD5),
    danger = Color(0xFF991B1B),
    dangerSoft = Color(0xFFFEE2E2),
    codeBg = Color(0xFF1C1917),
    codeText = Color(0xFFF5F5F4),
    codeBorder = Color(0xFF44403C),
    codeAccent = Color(0xFFFBBF24),
    chipBorderConnected = Color(0xFFDCFCE7),
    chipBorderConnecting = Color(0xFFFEF3C7),
    chipBorderWarning = Color(0xFFFFEDD5),
    chipBorderError = Color(0xFFFEE2E2),
  )

internal fun darkMobileColors() =
  MobileColors(
    surface = Color(0xFF1C1917),
    surfaceStrong = Color(0xFF292524),
    cardSurface = Color(0xFF262626),
    border = Color(0xFF44403C),
    borderStrong = Color(0xFF57534E),
    text = Color(0xFFF5F5F4),
    textSecondary = Color(0xFFD6D3D1),
    textTertiary = Color(0xFF78716C),
    accent = Color(0xFFFBBF24),
    accentSoft = Color(0xFF451A03),
    accentBorderStrong = Color(0xFFF59E0B),
    success = Color(0xFF22C55E),
    successSoft = Color(0xFF064E3B),
    warning = Color(0xFFF97316),
    warningSoft = Color(0xFF431407),
    danger = Color(0xFFEF4444),
    dangerSoft = Color(0xFF450A0A),
    codeBg = Color(0xFF0C0A09),
    codeText = Color(0xFFF5F5F4),
    codeBorder = Color(0xFF292524),
    codeAccent = Color(0xFFFBBF24),
    chipBorderConnected = Color(0xFF064E3B),
    chipBorderConnecting = Color(0xFF451A03),
    chipBorderWarning = Color(0xFF431407),
    chipBorderError = Color(0xFF450A0A),
  )

internal val LocalMobileColors = staticCompositionLocalOf { lightMobileColors() }

internal object MobileColorsAccessor {
  val current: MobileColors
    @Composable get() = LocalMobileColors.current
}

// ---------------------------------------------------------------------------
// Backward-compatible top-level accessors (composable getters)
// ---------------------------------------------------------------------------
// These allow existing call sites to keep using `mobileSurface`, `mobileText`, etc.
// without converting every file at once. Each resolves to the themed value.

internal val mobileSurface: Color @Composable get() = LocalMobileColors.current.surface
internal val mobileSurfaceStrong: Color @Composable get() = LocalMobileColors.current.surfaceStrong
internal val mobileCardSurface: Color @Composable get() = LocalMobileColors.current.cardSurface
internal val mobileBorder: Color @Composable get() = LocalMobileColors.current.border
internal val mobileBorderStrong: Color @Composable get() = LocalMobileColors.current.borderStrong
internal val mobileText: Color @Composable get() = LocalMobileColors.current.text
internal val mobileTextSecondary: Color @Composable get() = LocalMobileColors.current.textSecondary
internal val mobileTextTertiary: Color @Composable get() = LocalMobileColors.current.textTertiary
internal val mobileAccent: Color @Composable get() = LocalMobileColors.current.accent
internal val mobileAccentSoft: Color @Composable get() = LocalMobileColors.current.accentSoft
internal val mobileAccentBorderStrong: Color @Composable get() = LocalMobileColors.current.accentBorderStrong
internal val mobileSuccess: Color @Composable get() = LocalMobileColors.current.success
internal val mobileSuccessSoft: Color @Composable get() = LocalMobileColors.current.successSoft
internal val mobileWarning: Color @Composable get() = LocalMobileColors.current.warning
internal val mobileWarningSoft: Color @Composable get() = LocalMobileColors.current.warningSoft
internal val mobileDanger: Color @Composable get() = LocalMobileColors.current.danger
internal val mobileDangerSoft: Color @Composable get() = LocalMobileColors.current.dangerSoft
internal val mobileCodeBg: Color @Composable get() = LocalMobileColors.current.codeBg
internal val mobileCodeText: Color @Composable get() = LocalMobileColors.current.codeText
internal val mobileCodeBorder: Color @Composable get() = LocalMobileColors.current.codeBorder
internal val mobileCodeAccent: Color @Composable get() = LocalMobileColors.current.codeAccent

// Background gradient – light fades white→gray, dark fades near-black→dark-gray
internal val mobileBackgroundGradient: Brush
  @Composable get() {
    val colors = LocalMobileColors.current
    return Brush.verticalGradient(
      listOf(
        colors.surface,
        colors.surfaceStrong,
        colors.surfaceStrong,
      ),
    )
  }

// ---------------------------------------------------------------------------
// Typography tokens (theme-independent)
// ---------------------------------------------------------------------------

internal val mobileFontFamily =
  FontFamily(
    Font(resId = R.font.manrope_400_regular, weight = FontWeight.Normal),
    Font(resId = R.font.manrope_500_medium, weight = FontWeight.Medium),
    Font(resId = R.font.manrope_600_semibold, weight = FontWeight.SemiBold),
    Font(resId = R.font.manrope_700_bold, weight = FontWeight.Bold),
  )

internal val mobileDisplay =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Bold,
    fontSize = 34.sp,
    lineHeight = 40.sp,
    letterSpacing = (-0.8).sp,
  )

internal val mobileTitle1 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 24.sp,
    lineHeight = 30.sp,
    letterSpacing = (-0.5).sp,
  )

internal val mobileTitle2 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 20.sp,
    lineHeight = 26.sp,
    letterSpacing = (-0.3).sp,
  )

internal val mobileHeadline =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.SemiBold,
    fontSize = 16.sp,
    lineHeight = 22.sp,
    letterSpacing = (-0.1).sp,
  )

internal val mobileBody =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 15.sp,
    lineHeight = 22.sp,
  )

internal val mobileCallout =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 14.sp,
    lineHeight = 20.sp,
  )

internal val mobileCaption1 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 12.sp,
    lineHeight = 16.sp,
    letterSpacing = 0.2.sp,
  )

internal val mobileCaption2 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    letterSpacing = 0.4.sp,
  )
