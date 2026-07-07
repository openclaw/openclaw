package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.WifiTethering
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

private val ScreenshotIconBoxSize = 44.dp

@Composable
fun AndroidScreenshotModeScreen(scene: AndroidScreenshotScene) {
  ClawDesignTheme(dark = true) {
    Column(
      modifier =
        Modifier
          .fillMaxSize()
          .background(ClawTheme.colors.canvas)
          .padding(
            horizontal = ClawTheme.spacing.md,
            vertical = 26.dp,
          ),
      verticalArrangement = Arrangement.SpaceBetween,
    ) {
      ScreenshotHeader(scene)
      ScreenshotSceneBody(scene = scene, modifier = Modifier.weight(1f))
      ScreenshotTabBar(activeScene = scene)
    }
  }
}

@Composable
private fun ScreenshotHeader(scene: AndroidScreenshotScene) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.SpaceBetween,
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Column {
      Text(text = "OpenClaw", style = ClawTheme.type.title, color = ClawTheme.colors.text)
      Text(
        text = sceneTitle(scene),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
    }
    StatusPill(label = "Connected", color = ClawTheme.colors.success)
  }
}

@Composable
private fun ScreenshotSceneBody(
  scene: AndroidScreenshotScene,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier.fillMaxWidth().padding(vertical = ClawTheme.spacing.md),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    when (scene) {
      AndroidScreenshotScene.Connect -> ConnectScene()
      AndroidScreenshotScene.Chat -> ChatScene()
      AndroidScreenshotScene.Voice -> VoiceScene()
      AndroidScreenshotScene.Screen -> ScreenScene()
      AndroidScreenshotScene.Settings -> SettingsScene()
    }
  }
}

@Composable
private fun ConnectScene() {
  FeaturePanel(icon = Icons.Default.WifiTethering, title = "Gateway paired", subtitle = "Mac Studio - Tailnet") {
    MetricRow(label = "Node", value = "Android Pixel 9")
    MetricRow(label = "Transport", value = "Secure WebSocket")
    MetricRow(label = "Capabilities", value = "Chat, Talk, Camera, Screen")
  }
  CompactList(
    title = "Ready",
    rows =
      listOf(
        "Push wakes active",
        "Approvals synced",
        "Device tools available",
      ),
  )
}

@Composable
private fun ChatScene() {
  ChatBubble(label = "You", text = "Hi Molty, are you there?")
  ChatBubble(
    label = "Molty",
    text = "Always. Lurking in the shadows, exfoliating.",
    raised = true,
  )
}

@Composable
private fun VoiceScene() {
  Box(
    modifier = Modifier.fillMaxWidth().padding(vertical = ClawTheme.spacing.md),
    contentAlignment = Alignment.Center,
  ) {
    // Scale the proof orb with compact capture widths while preserving its 196dp design cap.
    Surface(
      modifier = Modifier.widthIn(max = 196.dp).fillMaxWidth().aspectRatio(1f),
      shape = CircleShape,
      color = ClawTheme.colors.surfaceRaised,
      border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Icon(
          imageVector = Icons.Default.Mic,
          contentDescription = null,
          tint = ClawTheme.colors.primary,
          modifier = Modifier.fillMaxSize(0.37f),
        )
      }
    }
  }
  FeaturePanel(icon = Icons.Default.Mic, title = "Talk mode", subtitle = "Listening on device") {
    MetricRow(label = "Wake phrase", value = "OpenClaw")
    MetricRow(label = "Latency", value = "Realtime")
  }
}

@Composable
private fun ScreenScene() {
  FeaturePanel(icon = Icons.AutoMirrored.Filled.ScreenShare, title = "Screen tools", subtitle = "Shared with your gateway") {
    MetricRow(label = "Canvas", value = "Available")
    MetricRow(label = "Camera", value = "Permission granted")
    MetricRow(label = "Location", value = "On request")
  }
  Surface(
    modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(ClawTheme.spacing.sm), verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(text = "Live context", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      ContextBar(label = "Camera", fraction = 0.74f)
      ContextBar(label = "Screen", fraction = 0.58f)
      ContextBar(label = "Location", fraction = 0.38f)
    }
  }
}

@Composable
private fun SettingsScene() {
  CompactList(
    title = "Security",
    rows = listOf("Biometric lock enabled", "Gateway token encrypted", "Tool approvals required"),
  )
  CompactList(
    title = "Notifications",
    rows = listOf("Gateway status", "Approval requests", "Background presence"),
  )
}

@Composable
private fun FeaturePanel(
  icon: ImageVector,
  title: String,
  subtitle: String,
  content: @Composable () -> Unit,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surface,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(ClawTheme.spacing.sm), verticalArrangement = Arrangement.spacedBy(14.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        IconBox(icon = icon)
        Column {
          Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        }
      }
      content()
    }
  }
}

@Composable
private fun CompactList(
  title: String,
  rows: List<String>,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(ClawTheme.spacing.sm), verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
      rows.forEach { row ->
        Row(verticalAlignment = Alignment.CenterVertically) {
          Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(ClawTheme.colors.success))
          Spacer(modifier = Modifier.width(10.dp))
          Text(text = row, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    }
  }
}

@Composable
private fun ChatBubble(
  label: String,
  text: String,
  raised: Boolean = false,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = if (raised) ClawTheme.colors.surfaceRaised else ClawTheme.colors.surface,
    border = BorderStroke(1.dp, if (raised) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Column(modifier = Modifier.padding(ClawTheme.spacing.sm), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      Text(text = text, style = ClawTheme.type.body, color = ClawTheme.colors.text)
    }
  }
}

@Composable
private fun MetricRow(
  label: String,
  value: String,
) {
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
    Text(text = label, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    Text(
      text = value,
      style = ClawTheme.type.label,
      color = ClawTheme.colors.text,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun ContextBar(
  label: String,
  fraction: Float,
) {
  Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
    Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Box(
      modifier =
        Modifier
          .fillMaxWidth()
          .height(7.dp)
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .background(ClawTheme.colors.surfacePressed),
    ) {
      Box(
        modifier =
          Modifier
            .fillMaxWidth(fraction)
            .height(7.dp)
            .background(ClawTheme.colors.primary),
      )
    }
  }
}

@Composable
private fun ScreenshotTabBar(activeScene: AndroidScreenshotScene) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surface,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      TabIcon(icon = Icons.Default.CheckCircle, active = activeScene == AndroidScreenshotScene.Connect)
      TabIcon(icon = Icons.Default.ChatBubble, active = activeScene == AndroidScreenshotScene.Chat)
      TabIcon(icon = Icons.Default.Mic, active = activeScene == AndroidScreenshotScene.Voice)
      TabIcon(icon = Icons.AutoMirrored.Filled.ScreenShare, active = activeScene == AndroidScreenshotScene.Screen)
      TabIcon(icon = Icons.Default.Settings, active = activeScene == AndroidScreenshotScene.Settings)
    }
  }
}

@Composable
private fun TabIcon(
  icon: ImageVector,
  active: Boolean,
) {
  Box(
    modifier =
      Modifier
        .size(ScreenshotIconBoxSize)
        .clip(RoundedCornerShape(ClawTheme.radii.control))
        .background(if (active) ClawTheme.colors.surfacePressed else Color.Transparent),
    contentAlignment = Alignment.Center,
  ) {
    Icon(
      imageVector = icon,
      contentDescription = null,
      tint = if (active) ClawTheme.colors.text else ClawTheme.colors.textSubtle,
      modifier = Modifier.size(20.dp),
    )
  }
}

@Composable
private fun IconBox(icon: ImageVector) {
  Box(
    modifier =
      Modifier
        .size(ScreenshotIconBoxSize)
        .clip(RoundedCornerShape(ClawTheme.radii.button))
        .background(ClawTheme.colors.surfacePressed),
    contentAlignment = Alignment.Center,
  ) {
    Icon(
      imageVector = icon,
      contentDescription = null,
      tint = ClawTheme.colors.primary,
      modifier = Modifier.size(22.dp),
    )
  }
}

@Composable
private fun StatusPill(
  label: String,
  color: Color,
) {
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.button),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(color))
      Spacer(modifier = Modifier.width(7.dp))
      Text(
        text = label,
        style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
        color = color,
      )
    }
  }
}

private fun sceneTitle(scene: AndroidScreenshotScene): String =
  when (scene) {
    AndroidScreenshotScene.Connect -> "Connect"
    AndroidScreenshotScene.Chat -> "Chat"
    AndroidScreenshotScene.Voice -> "Talk"
    AndroidScreenshotScene.Screen -> "Device tools"
    AndroidScreenshotScene.Settings -> "Settings"
  }
