package ai.openclaw.android.ui

import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import ai.openclaw.android.R

internal val mobileBackgroundGradient =
  Brush.verticalGradient(
    listOf(
      Color(0xFF0F1115),
      Color(0xFF151821),
      Color(0xFF1B1F29),
    ),
  )

internal val mobileSurface = Color(0xFF1E222B)
internal val mobileSurfaceStrong = Color(0xFF272C37)
internal val mobileBorder = Color(0xFF323847)
internal val mobileBorderStrong = Color(0xFF41495D)
internal val mobileText = Color(0xFFE6EBF5)
internal val mobileTextSecondary = Color(0xFFB8C0D1)
internal val mobileTextTertiary = Color(0xFF8C95A8)
internal val mobileAccent = Color(0xFF5A8FFF)
internal val mobileAccentSoft = Color(0xFF25395F)
internal val mobileSuccess = Color(0xFF37B26C)
internal val mobileSuccessSoft = Color(0xFF1F3A2B)
internal val mobileWarning = Color(0xFFE3A23E)
internal val mobileWarningSoft = Color(0xFF3A2D1A)
internal val mobileDanger = Color(0xFFF06A6A)
internal val mobileDangerSoft = Color(0xFF3F2528)
internal val mobileCodeBg = Color(0xFF11141B)
internal val mobileCodeText = Color(0xFFE7ECF8)

internal val mobileFontFamily =
  FontFamily(
    Font(resId = R.font.manrope_400_regular, weight = FontWeight.Normal),
    Font(resId = R.font.manrope_500_medium, weight = FontWeight.Medium),
    Font(resId = R.font.manrope_600_semibold, weight = FontWeight.SemiBold),
    Font(resId = R.font.manrope_700_bold, weight = FontWeight.Bold),
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
    lineHeight = 23.sp,
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
    letterSpacing = 0.1.sp,
  )

internal val mobileCaption2 =
  TextStyle(
    fontFamily = mobileFontFamily,
    fontWeight = FontWeight.Medium,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    letterSpacing = 0.25.sp,
  )
