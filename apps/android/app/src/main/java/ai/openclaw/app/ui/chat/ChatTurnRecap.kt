package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeStringResource
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalConfiguration
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale

internal data class TurnRecap(
  val runtimeMs: Long,
  val outputTokens: Long?,
)

internal data class TurnRecapTokenFormat(
  val singular: Boolean,
  val count: String,
)

@Composable
internal fun localizedChatOutputTokens(count: Long): String {
  val locale = LocalConfiguration.current.locales[0]
  val format = turnRecapTokenFormat(count, locale)
  return if (format.singular) {
    nativeStringResource("1 token")
  } else {
    nativeStringResource("\$count tokens", format.count)
  }
}

internal fun turnRecapTokenFormat(
  count: Long,
  locale: Locale = Locale.getDefault(),
): TurnRecapTokenFormat = TurnRecapTokenFormat(singular = count == 1L, count = formatCompactTokenCount(count, locale))

internal fun formatCompactTokenCount(
  count: Long,
  locale: Locale = Locale.getDefault(),
): String {
  val decimalFormat =
    NumberFormat.getNumberInstance(locale).apply {
      isGroupingUsed = false
      minimumFractionDigits = 0
      maximumFractionDigits = 1
      roundingMode = RoundingMode.HALF_UP
    }

  fun decimal(value: Double): String = decimalFormat.format(value)

  fun millions(): String {
    val value = decimal(count / 1_000_000.0)
    return nativeString("\${decimal(count / 1_000_000.0)}M", value)
  }

  return when {
    count >= 1_000_000L -> {
      millions()
    }

    count >= 1_000L -> {
      val thousands = decimal(count / 1_000.0)
      if (count >= 999_950L) millions() else nativeString("\${thousands}k", thousands)
    }

    else -> {
      count.toString()
    }
  }
}
