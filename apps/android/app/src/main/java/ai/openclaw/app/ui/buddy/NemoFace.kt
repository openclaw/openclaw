package ai.openclaw.app.ui.buddy

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import ai.openclaw.app.buddy.BuddyState

@Composable
fun NemoFace(state: BuddyState, modifier: Modifier = Modifier) {
  Canvas(modifier = modifier.fillMaxSize()) {
    drawRect(Color(0xFF030507))
    drawEyes(state)
    drawNoseAndMouth(state)
  }
}

private fun DrawScope.drawEyes(state: BuddyState) {
  val w = size.width
  val h = size.height
  val eyeColor = faceEyeColor(state)
  val leftCenter = Offset(w * 0.31f, h * 0.42f)
  val rightCenter = Offset(w * 0.69f, h * 0.42f)

  when (state) {
    BuddyState.Thinking, BuddyState.Executing -> {
      drawFocusedEye(center = leftCenter, color = eyeColor, lookingRight = false)
      drawFocusedEye(center = rightCenter, color = eyeColor, lookingRight = true)
    }
    BuddyState.Disconnected, BuddyState.PowerSaving -> {
      drawSleepyEye(center = leftCenter, color = eyeColor)
      drawSleepyEye(center = rightCenter, color = eyeColor)
    }
    BuddyState.Speaking -> {
      drawOpenEye(center = leftCenter, color = eyeColor, pupilShift = -0.08f)
      drawOpenEye(center = rightCenter, color = eyeColor, pupilShift = 0.08f)
    }
    BuddyState.VisionScanning -> {
      drawOpenEye(center = leftCenter, color = eyeColor, pupilShift = 0.11f)
      drawOpenEye(center = rightCenter, color = eyeColor, pupilShift = 0.11f)
      drawScannerRing(center = Offset(w * 0.50f, h * 0.42f))
    }
    else -> {
      drawOpenEye(center = leftCenter, color = eyeColor, pupilShift = 0f)
      drawOpenEye(center = rightCenter, color = eyeColor, pupilShift = 0f)
    }
  }
}

private fun DrawScope.drawOpenEye(center: Offset, color: Color, pupilShift: Float) {
  val eyeW = size.width * 0.16f
  val eyeH = size.height * 0.35f
  drawOval(
    color = color,
    topLeft = Offset(center.x - eyeW / 2f, center.y - eyeH / 2f),
    size = Size(eyeW, eyeH),
  )
  val pupilW = eyeW * 0.26f
  val pupilH = eyeH * 0.78f
  drawOval(
    color = Color(0xFF05070A),
    topLeft = Offset(center.x - pupilW / 2f + eyeW * pupilShift, center.y - pupilH / 2f),
    size = Size(pupilW, pupilH),
  )
  drawCircle(
    color = Color.White.copy(alpha = 0.9f),
    radius = eyeW * 0.07f,
    center = Offset(center.x - eyeW * 0.15f, center.y - eyeH * 0.23f),
  )
}

private fun DrawScope.drawFocusedEye(center: Offset, color: Color, lookingRight: Boolean) {
  val eyeW = size.width * 0.16f
  val eyeH = size.height * 0.25f
  val topLeft = Offset(center.x - eyeW / 2f, center.y - eyeH / 2f)
  drawOval(color = color, topLeft = topLeft, size = Size(eyeW, eyeH))
  val pupilX = center.x + if (lookingRight) eyeW * 0.12f else -eyeW * 0.12f
  drawOval(
    color = Color(0xFF05070A),
    topLeft = Offset(pupilX - eyeW * 0.11f, center.y - eyeH * 0.37f),
    size = Size(eyeW * 0.22f, eyeH * 0.74f),
  )
}

private fun DrawScope.drawSleepyEye(center: Offset, color: Color) {
  val eyeW = size.width * 0.17f
  drawArc(
    color = color,
    startAngle = 10f,
    sweepAngle = 160f,
    useCenter = false,
    topLeft = Offset(center.x - eyeW / 2f, center.y - size.height * 0.05f),
    size = Size(eyeW, size.height * 0.16f),
    style = Stroke(width = size.height * 0.025f, cap = StrokeCap.Round),
  )
}

private fun DrawScope.drawScannerRing(center: Offset) {
  drawCircle(
    color = Color(0xFF9FD8FF).copy(alpha = 0.16f),
    radius = size.height * 0.20f,
    center = center,
  )
  drawCircle(
    color = Color(0xFFC9E9FF),
    radius = size.height * 0.19f,
    center = center,
    style = Stroke(width = size.height * 0.012f),
  )
}

private fun DrawScope.drawNoseAndMouth(state: BuddyState) {
  val w = size.width
  val h = size.height
  val nosePath =
    Path().apply {
      moveTo(w * 0.485f, h * 0.55f)
      quadraticTo(w * 0.50f, h * 0.59f, w * 0.515f, h * 0.55f)
      close()
    }
  drawPath(nosePath, Color(0xFFEAFBFF))

  val mouthColor = if (state == BuddyState.Speaking) Color(0xFFFF78A8) else Color(0xFFEAFBFF)
  val stroke = Stroke(width = h * 0.017f, cap = StrokeCap.Round)
  drawArc(
    color = mouthColor,
    startAngle = 15f,
    sweepAngle = 135f,
    useCenter = false,
    topLeft = Offset(w * 0.465f, h * 0.565f),
    size = Size(w * 0.045f, h * 0.09f),
    style = stroke,
  )
  drawArc(
    color = mouthColor,
    startAngle = 30f,
    sweepAngle = 135f,
    useCenter = false,
    topLeft = Offset(w * 0.49f, h * 0.565f),
    size = Size(w * 0.045f, h * 0.09f),
    style = stroke,
  )
  if (state == BuddyState.Speaking) {
    drawCircle(color = Color(0xFFFF78A8), radius = h * 0.032f, center = Offset(w * 0.50f, h * 0.67f))
  }
}

private fun faceEyeColor(state: BuddyState): Color =
  when (state) {
    BuddyState.NeedsConfirmation -> Color(0xFFFFF0A8)
    BuddyState.Recording, BuddyState.WakeDetected -> Color(0xFFD4FFF0)
    BuddyState.VisionScanning -> Color(0xFFC9E9FF)
    BuddyState.Disconnected, BuddyState.PermissionRequired -> Color(0xFFFFD4D4)
    else -> Color(0xFFE9FFFF)
  }
