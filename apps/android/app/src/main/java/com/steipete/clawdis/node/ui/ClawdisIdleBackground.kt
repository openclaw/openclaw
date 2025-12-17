package com.steipete.clawdis.node.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.dp

@Composable
fun ClawdisIdleBackground(modifier: Modifier = Modifier) {
  val t = rememberInfiniteTransition(label = "clawdis-bg")
  val gridX =
    t.animateFloat(
      initialValue = -18f,
      targetValue = 14f,
      animationSpec = infiniteRepeatable(animation = tween(durationMillis = 22_000), repeatMode = RepeatMode.Reverse),
      label = "gridX",
    ).value
  val gridY =
    t.animateFloat(
      initialValue = 12f,
      targetValue = -10f,
      animationSpec = infiniteRepeatable(animation = tween(durationMillis = 22_000), repeatMode = RepeatMode.Reverse),
      label = "gridY",
    ).value

  val glowX =
    t.animateFloat(
      initialValue = -26f,
      targetValue = 20f,
      animationSpec = infiniteRepeatable(animation = tween(durationMillis = 18_000), repeatMode = RepeatMode.Reverse),
      label = "glowX",
    ).value
  val glowY =
    t.animateFloat(
      initialValue = 18f,
      targetValue = -14f,
      animationSpec = infiniteRepeatable(animation = tween(durationMillis = 18_000), repeatMode = RepeatMode.Reverse),
      label = "glowY",
    ).value

  Canvas(modifier = modifier.fillMaxSize()) {
    drawRect(Color.Black)

    val w = size.width
    val h = size.height

    fun radial(cx: Float, cy: Float, r: Float, color: Color): Brush =
      Brush.radialGradient(
        colors = listOf(color, Color.Transparent),
        center = Offset(cx, cy),
        radius = r,
      )

    drawRect(
      brush = radial(w * 0.15f, h * 0.20f, r = maxOf(w, h) * 0.85f, color = Color(0xFF2A71FF).copy(alpha = 0.18f)),
    )
    drawRect(
      brush = radial(w * 0.85f, h * 0.30f, r = maxOf(w, h) * 0.75f, color = Color(0xFFFF008A).copy(alpha = 0.14f)),
    )
    drawRect(
      brush = radial(w * 0.60f, h * 0.90f, r = maxOf(w, h) * 0.85f, color = Color(0xFF00D1FF).copy(alpha = 0.10f)),
    )

    rotate(degrees = -7f) {
      val spacing = 48.dp.toPx()
      val line = Color.White.copy(alpha = 0.02f)
      val offset = Offset(gridX.dp.toPx(), gridY.dp.toPx())

      var x = (-w * 0.6f) + (offset.x % spacing)
      while (x < w * 1.6f) {
        drawLine(color = line, start = Offset(x, -h * 0.6f), end = Offset(x, h * 1.6f))
        x += spacing
      }

      var y = (-h * 0.6f) + (offset.y % spacing)
      while (y < h * 1.6f) {
        drawLine(color = line, start = Offset(-w * 0.6f, y), end = Offset(w * 1.6f, y))
        y += spacing
      }
    }

    // Glow drift layer (approximation of iOS WebView scaffold).
    val glowOffset = Offset(glowX.dp.toPx(), glowY.dp.toPx())
    drawRect(
      brush = radial(w * 0.30f + glowOffset.x, h * 0.30f + glowOffset.y, r = maxOf(w, h) * 0.75f, color = Color(0xFF2A71FF).copy(alpha = 0.16f)),
      blendMode = BlendMode.Screen,
      alpha = 0.55f,
    )
    drawRect(
      brush = radial(w * 0.70f + glowOffset.x, h * 0.35f + glowOffset.y, r = maxOf(w, h) * 0.70f, color = Color(0xFFFF008A).copy(alpha = 0.12f)),
      blendMode = BlendMode.Screen,
      alpha = 0.55f,
    )
    drawRect(
      brush = radial(w * 0.55f + glowOffset.x, h * 0.75f + glowOffset.y, r = maxOf(w, h) * 0.85f, color = Color(0xFF00D1FF).copy(alpha = 0.10f)),
      blendMode = BlendMode.Screen,
      alpha = 0.55f,
    )
  }
}

