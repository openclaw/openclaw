package ai.openclaw.app.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min

/**
 * Talk-mode orb overlay matching iOS TalkOrbOverlay dimensions and behavior.
 *
 * iOS reference (TalkOrbOverlay.swift):
 * - Outer rings: 320dp, stroke 2dp, two rings pulsing outward
 * - Core circle: 190dp with radial gradient
 * - Mic level bar: capsule 18–180 width × 6 height
 * - Agent name + status text
 * - VStack spacing 14, padding 28
 */
@Composable
fun TalkOrbOverlay(
  seamColor: Color,
  statusText: String,
  agentName: String = "",
  micLevel: Float = 0f,
  isListening: Boolean,
  isSpeaking: Boolean,
  onOrbTap: () -> Unit = {},
  modifier: Modifier = Modifier,
) {
  val mic = min(max(micLevel, 0f), 1f)
  val animatedMic by animateFloatAsState(
    targetValue = mic,
    animationSpec = tween(durationMillis = 120),
    label = "mic-level",
  )

  val transition = rememberInfiniteTransition(label = "talk-orb")

  // Ring 1: iOS .easeOut(duration: 1.3)
  val ring1T by
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 1f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 1300, easing = LinearEasing),
          repeatMode = RepeatMode.Restart,
        ),
      label = "ring1",
    )

  // Ring 2: iOS .easeOut(duration: 1.9).delay(0.2)
  val ring2T by
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 1f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 1900, delayMillis = 200, easing = LinearEasing),
          repeatMode = RepeatMode.Restart,
        ),
      label = "ring2",
    )

  val trimmed = statusText.trim()
  val showStatus = trimmed.isNotEmpty() && trimmed != "Off"
  val trimmedAgent = agentName.trim()

  Column(
    // iOS: padding(28)
    modifier = modifier.padding(28.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    // iOS: VStack spacing 14
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    // Orb + rings
    Box(
      contentAlignment = Alignment.Center,
      modifier =
        Modifier
          .clickable(
            interactionSource = remember { MutableInteractionSource() },
            indication = null,
            onClick = onOrbTap,
          )
          .semantics { contentDescription = "Talk Mode $trimmed" },
    ) {
      // iOS: Canvas is 320×320 for rings
      Canvas(modifier = Modifier.size(320.dp)) {
        val center = this.center
        val ringRadius = 320.dp.toPx() / 2f
        val coreRadius = 190.dp.toPx() / 2f

        // Ring 1: iOS scaleEffect(pulse ? 1.15 : 0.96), opacity(pulse ? 0.0 : 1.0)
        val r1Scale = 0.96f + (ring1T * 0.19f)
        val r1Alpha = (1f - ring1T) * 0.26f
        drawCircle(
          color = seamColor.copy(alpha = r1Alpha),
          radius = ringRadius * r1Scale,
          center = center,
          style = Stroke(width = 2.dp.toPx()),
        )

        // Ring 2: iOS scaleEffect(pulse ? 1.45 : 1.02), opacity(pulse ? 0.0 : 0.9)
        val r2Scale = 1.02f + (ring2T * 0.43f)
        val r2Alpha = (1f - ring2T) * 0.18f * 0.9f
        drawCircle(
          color = seamColor.copy(alpha = r2Alpha),
          radius = ringRadius * r2Scale,
          center = center,
          style = Stroke(width = 2.dp.toPx()),
        )

        // Core circle: iOS RadialGradient, 190dp
        // iOS: seam.opacity(0.75 + 0.20 * mic), seam.opacity(0.40), black.opacity(0.55)
        val coreScale = 1.0f + (0.12f * animatedMic)
        drawCircle(
          brush =
            Brush.radialGradient(
              colors =
                listOf(
                  seamColor.copy(alpha = 0.75f + 0.20f * animatedMic),
                  seamColor.copy(alpha = 0.40f),
                  Color.Black.copy(alpha = 0.55f),
                ),
              center = center,
              radius = coreRadius * coreScale * 1.18f,
            ),
          radius = coreRadius * coreScale,
          center = center,
        )

        // Core border: iOS stroke(seam.opacity(0.35), lineWidth: 1)
        drawCircle(
          color = seamColor.copy(alpha = 0.35f),
          radius = coreRadius * coreScale,
          center = center,
          style = Stroke(width = 1.dp.toPx()),
        )
      }
    }

    // Agent name: iOS .system(.caption, design: .rounded).weight(.semibold), white 0.70
    if (trimmedAgent.isNotEmpty()) {
      Text(
        text = "Bot: $trimmedAgent",
        color = Color.White.copy(alpha = 0.70f),
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        fontFamily = mobileFontFamily,
      )
    }

    // Status capsule: iOS Capsule bg black 0.40, stroke seam 0.22
    if (showStatus) {
      Box(
        modifier =
          Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(Color.Black.copy(alpha = 0.40f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
      ) {
        Text(
          text = trimmed,
          color = Color.White.copy(alpha = 0.92f),
          fontSize = 13.sp,
          fontWeight = FontWeight.SemiBold,
          fontFamily = mobileFontFamily,
        )
      }
    }

    // Mic level bar: iOS Capsule fill seam 0.90, width max(18, 180 * mic), height 6
    if (isListening) {
      val barWidth = max(18f, 180f * animatedMic)
      Box(
        modifier =
          Modifier
            .width(barWidth.dp)
            .height(6.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(seamColor.copy(alpha = 0.90f))
            .semantics { contentDescription = "Microphone level" },
      )
    }
  }
}
