package ai.openclaw.wear

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

class WearThemeTest {
  @Test
  fun `watch backgrounds stay black in both appearances`() {
    // WO-V13 requires a black app background even when the user selects light surfaces.
    assertEquals(Color.Black, wearColorsFor(WearThemeMode.Light).canvas)
    assertEquals(Color.Black, wearColorsFor(WearThemeMode.Dark).canvas)
  }

  @Test
  fun `canvas text and voice affordances stay readable above black`() {
    val colors = OpenClawWearTheme.canvasColors
    for (foreground in listOf(colors.text, colors.textMuted, colors.voiceAccent, colors.danger)) {
      assertTrue(
        "Canvas foreground must remain readable in either appearance",
        contrastRatio(foreground, Color.Black) >= MIN_TEXT_CONTRAST,
      )
    }
  }

  @Test
  fun `dark and light palettes keep panels distinct from the canvas`() {
    WearThemeMode.entries.forEach { mode ->
      val colors = wearColorsFor(mode)

      assertNotEquals("$mode canvas and panel must differ", colors.canvas, colors.surfaceRaised)
      assertTrue(
        "$mode panel outline must remain visible",
        contrastRatio(colors.borderStrong, colors.surfaceRaised) >= MIN_OUTLINE_CONTRAST,
      )
    }
  }

  @Test
  fun `dark and light palettes keep text readable on panels`() {
    WearThemeMode.entries.forEach { mode ->
      val colors = wearColorsFor(mode)

      assertTrue(
        "$mode text must remain readable",
        contrastRatio(colors.text, colors.surfaceRaised) >= MIN_TEXT_CONTRAST,
      )
      assertTrue(
        "$mode muted text must remain readable",
        contrastRatio(colors.textMuted, colors.surfaceRaised) >= MIN_TEXT_CONTRAST,
      )
    }
  }

  @Test
  fun `dark and light primary and voice accents keep their content readable`() {
    WearThemeMode.entries.forEach { mode ->
      val colors = wearColorsFor(mode)

      assertTrue(
        "$mode primary content must remain readable",
        contrastRatio(colors.primaryText, colors.primary) >= MIN_TEXT_CONTRAST,
      )
      assertTrue(
        "$mode voice accent content must remain readable",
        contrastRatio(colors.onVoiceAccent, colors.voiceAccent) >= MIN_TEXT_CONTRAST,
      )
    }
  }

  private fun contrastRatio(
    foreground: Color,
    background: Color,
  ): Double {
    val foregroundLuminance = relativeLuminance(foreground)
    val backgroundLuminance = relativeLuminance(background)
    return (max(foregroundLuminance, backgroundLuminance) + 0.05) /
      (min(foregroundLuminance, backgroundLuminance) + 0.05)
  }

  private fun relativeLuminance(color: Color): Double =
    0.2126 * linearize(color.red.toDouble()) +
      0.7152 * linearize(color.green.toDouble()) +
      0.0722 * linearize(color.blue.toDouble())

  private fun linearize(channel: Double): Double =
    if (channel <= 0.03928) {
      channel / 12.92
    } else {
      ((channel + 0.055) / 1.055).pow(2.4)
    }

  private companion object {
    const val MIN_OUTLINE_CONTRAST = 1.5
    const val MIN_TEXT_CONTRAST = 4.5
  }
}
