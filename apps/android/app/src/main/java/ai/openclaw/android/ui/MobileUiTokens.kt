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
      Color(0xFFFFFFFF),
      Color(0xFFF7F8FA),
      Color(0xFFEFF1F5),
    ),
  )

internal val mobileSurface = Color(0xFFF6F7FA)
internal val mobileSurfaceStrong = Color(0xFFECEEF3)
internal val mobileBorder = Color(0xFFE5E7EC)
internal val mobileBorderStrong = Color(0xFFD6DAE2)
internal val mobileText = Color(0xFF17181C)
internal val mobileTextSecondary = Color(0xFF5D6472)
internal val mobileTextTertiary = Color(0xFF99A0AE)
internal val mobileAccent = Color(0xFF1D5DD8)
internal val mobileAccentSoft = Color(0xFFECF3FF)
internal val mobileSuccess = Color(0xFF2F8C5A)
internal val mobileSuccessSoft = Color(0xFFEEF9F3)
internal val mobileWarning = Color(0xFFC8841A)
internal val mobileWarningSoft = Color(0xFFFFF8EC)
internal val mobileDanger = Color(0xFFD04B4B)
internal val mobileDangerSoft = Color(0xFFFFF2F2)
internal val mobileCodeBg = Color(0xFF15171B)
internal val mobileCodeText = Color(0xFFE8EAEE)

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
