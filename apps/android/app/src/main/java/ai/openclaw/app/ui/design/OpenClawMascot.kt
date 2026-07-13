package ai.openclaw.app.ui.design

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.InfiniteRepeatableSpec
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics

// Canonical 120x120 mascot geometry from ui/public/favicon.svg; parts stay
// separate paths so claws, antennae, and eyes can animate independently.
private val BodyPath =
  PathParser()
    .parsePathString(
      "M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 " +
        "C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z",
    )
    .toPath()
private val LeftClawPath =
  PathParser().parsePathString("M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z").toPath()
private val RightClawPath =
  PathParser().parsePathString("M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z").toPath()
private val LeftAntennaPath = PathParser().parsePathString("M45 15 Q35 5 30 8").toPath()
private val RightAntennaPath = PathParser().parsePathString("M75 15 Q85 5 90 8").toPath()

private val CoralBright = Color(0xFFFF4D4D)
private val CoralDark = Color(0xFF991B1B)
private val EyeDark = Color(0xFF050810)
private val EyeGlow = Color(0xFF00E5CC)
// Claws hinge on their body-facing edge, antennae rotate around their own center.
private val LeftClawPivot = Offset(26f, 53f)
private val RightClawPivot = Offset(94f, 53f)
private val LeftAntennaPivot = Offset(37.5f, 11f)
private val RightAntennaPivot = Offset(82.5f, 11f)

private val EaseInOut = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)

private class MascotPose(
  val floatOffset: State<Float>,
  val antennaDegrees: State<Float>,
  val leftClawDegrees: State<Float>,
  val rightClawDegrees: State<Float>,
  val eyeGlowAlpha: State<Float>,
)

/**
 * Animated OpenClaw mascot mirroring the openclaw.ai hero mark: body float,
 * antenna wiggle, eye blink, and staggered claw snaps. With [tint] the mascot
 * renders as a single-color silhouette (replacement for tinted [Icon] usage).
 */
@Composable
fun OpenClawMascot(
  modifier: Modifier = Modifier,
  tint: Color? = null,
  contentDescription: String? = null,
) {
  val pose = rememberMascotPose()
  val semantics =
    if (contentDescription == null) {
      Modifier
    } else {
      Modifier.semantics {
        this.contentDescription = contentDescription
        role = Role.Image
      }
    }
  Canvas(modifier = modifier.then(semantics)) {
    val scale = size.minDimension / 120f
    withTransform({
      scale(scale, scale, pivot = Offset.Zero)
      translate(top = pose.floatOffset.value)
    }) {
      drawMascot(pose, tint)
    }
  }
}

@Composable
private fun rememberMascotPose(): MascotPose {
  val context = LocalContext.current
  // Compose infinite transitions ignore the system animator scale; honor the
  // OS "remove animations" setting explicitly with a static pose.
  val animationsEnabled =
    remember(context) {
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }
  if (!animationsEnabled) {
    return remember {
      val zero = mutableFloatStateOf(0f)
      MascotPose(zero, zero, zero, zero, mutableFloatStateOf(1f))
    }
  }

  val transition = rememberInfiniteTransition(label = "openclawMascot")
  val floatOffset =
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 0f,
      animationSpec =
        infiniteRepeatable(
          keyframes {
            durationMillis = 4000
            0f at 0 using EaseInOut
            -5f at 2000 using EaseInOut
          },
        ),
      label = "float",
    )
  val antennaDegrees =
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 0f,
      animationSpec =
        infiniteRepeatable(
          keyframes {
            durationMillis = 2000
            0f at 0 using EaseInOut
            -3f at 500 using EaseInOut
            3f at 1500 using EaseInOut
          },
        ),
      label = "antenna",
    )
  val leftClawDegrees =
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 0f,
      animationSpec = infiniteRepeatable(clawSnapKeyframes()),
      label = "clawLeft",
    )
  val rightClawDegrees =
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 0f,
      animationSpec =
        InfiniteRepeatableSpec(
          clawSnapKeyframes(),
          RepeatMode.Restart,
          initialStartOffset = StartOffset(200),
        ),
      label = "clawRight",
    )
  val eyeGlowAlpha =
    transition.animateFloat(
      initialValue = 1f,
      targetValue = 1f,
      animationSpec =
        infiniteRepeatable(
          keyframes {
            durationMillis = 3000
            1f at 0 using EaseInOut
            1f at 2700 using EaseInOut
            0.3f at 2850 using EaseInOut
          },
        ),
      label = "blink",
    )
  return remember(transition) {
    MascotPose(floatOffset, antennaDegrees, leftClawDegrees, rightClawDegrees, eyeGlowAlpha)
  }
}

private fun clawSnapKeyframes() = keyframes {
  durationMillis = 4000
  0f at 0 using EaseInOut
  0f at 3400 using EaseInOut
  -8f at 3600 using EaseInOut
  0f at 3800 using EaseInOut
}

private fun DrawScope.drawMascot(pose: MascotPose, tint: Color?) {
  val bodyBrush =
    if (tint == null) {
      Brush.linearGradient(
        colors = listOf(CoralBright, CoralDark),
        start = Offset.Zero,
        end = Offset(120f, 120f),
      )
    } else {
      SolidColor(tint)
    }
  // Same paint order as favicon.svg: body, claws, antennae, eyes.
  drawPath(BodyPath, bodyBrush)
  withTransform({ rotate(pose.leftClawDegrees.value, pivot = LeftClawPivot) }) {
    drawPath(LeftClawPath, bodyBrush)
  }
  withTransform({ rotate(pose.rightClawDegrees.value, pivot = RightClawPivot) }) {
    drawPath(RightClawPath, bodyBrush)
  }
  val antennaColor = tint ?: CoralBright
  val antennaStroke = Stroke(width = 3f, cap = StrokeCap.Round)
  withTransform({ rotate(pose.antennaDegrees.value, pivot = LeftAntennaPivot) }) {
    drawPath(LeftAntennaPath, antennaColor, style = antennaStroke)
  }
  withTransform({ rotate(pose.antennaDegrees.value, pivot = RightAntennaPivot) }) {
    drawPath(RightAntennaPath, antennaColor, style = antennaStroke)
  }
  drawCircle(tint ?: EyeDark, radius = 6f, center = Offset(45f, 35f))
  drawCircle(tint ?: EyeDark, radius = 6f, center = Offset(75f, 35f))
  val glowColor = tint ?: EyeGlow
  drawCircle(glowColor, radius = 2.5f, center = Offset(46f, 34f), alpha = pose.eyeGlowAlpha.value)
  drawCircle(glowColor, radius = 2.5f, center = Offset(76f, 34f), alpha = pose.eyeGlowAlpha.value)
}
