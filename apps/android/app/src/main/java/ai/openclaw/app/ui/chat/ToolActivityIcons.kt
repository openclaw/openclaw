package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ToolDisplayConfig
import ai.openclaw.app.ui.icons.filled.AccountTree
import ai.openclaw.app.ui.icons.filled.AttachFile
import ai.openclaw.app.ui.icons.filled.AutoAwesome
import ai.openclaw.app.ui.icons.filled.BarChart
import ai.openclaw.app.ui.icons.filled.BorderColor
import ai.openclaw.app.ui.icons.filled.ChatBubbleOutline
import ai.openclaw.app.ui.icons.filled.Checklist
import ai.openclaw.app.ui.icons.filled.Dashboard
import ai.openclaw.app.ui.icons.filled.DataObject
import ai.openclaw.app.ui.icons.filled.Description
import ai.openclaw.app.ui.icons.filled.DesktopWindows
import ai.openclaw.app.ui.icons.filled.Devices
import ai.openclaw.app.ui.icons.filled.Difference
import ai.openclaw.app.ui.icons.filled.DriveFileRenameOutline
import ai.openclaw.app.ui.icons.filled.Extension
import ai.openclaw.app.ui.icons.filled.GraphicEq
import ai.openclaw.app.ui.icons.filled.Groups
import ai.openclaw.app.ui.icons.filled.Image
import ai.openclaw.app.ui.icons.filled.IntegrationInstructions
import ai.openclaw.app.ui.icons.filled.Key
import ai.openclaw.app.ui.icons.filled.Language
import ai.openclaw.app.ui.icons.filled.Layers
import ai.openclaw.app.ui.icons.filled.Mail
import ai.openclaw.app.ui.icons.filled.Mic
import ai.openclaw.app.ui.icons.filled.MusicNote
import ai.openclaw.app.ui.icons.filled.Palette
import ai.openclaw.app.ui.icons.filled.Pause
import ai.openclaw.app.ui.icons.filled.PendingActions
import ai.openclaw.app.ui.icons.filled.Pets
import ai.openclaw.app.ui.icons.filled.Policy
import ai.openclaw.app.ui.icons.filled.Power
import ai.openclaw.app.ui.icons.filled.Psychology
import ai.openclaw.app.ui.icons.filled.Radio
import ai.openclaw.app.ui.icons.filled.Schedule
import ai.openclaw.app.ui.icons.filled.SmartToy
import ai.openclaw.app.ui.icons.filled.SwapHoriz
import ai.openclaw.app.ui.icons.filled.Terminal
import ai.openclaw.app.ui.icons.filled.TrackChanges
import ai.openclaw.app.ui.icons.filled.VerifiedUser
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

internal val toolIconVectors: Map<String, ImageVector> by lazy {
  mapOf(
    "arrowLeftRight" to Icons.Default.SwapHoriz,
    "audioLines" to Icons.Default.GraphicEq,
    "barChart" to Icons.Default.BarChart,
    "bot" to Icons.Default.SmartToy,
    "braces" to Icons.Default.DataObject,
    "brain" to Icons.Default.Psychology,
    "calendarClock" to Icons.Default.PendingActions,
    "claw" to Icons.Default.Pets,
    "clock" to Icons.Default.Schedule,
    "edit" to Icons.Default.BorderColor,
    "fileCode" to Icons.Default.IntegrationInstructions,
    "fileDiff" to Icons.Default.Difference,
    "fileText" to Icons.Default.Description,
    "github" to Icons.Default.AccountTree,
    "globe" to Icons.Default.Language,
    "image" to Icons.Default.Image,
    "key" to Icons.Default.Key,
    "layers" to Icons.Default.Layers,
    "layoutDashboard" to Icons.Default.Dashboard,
    "listChecks" to Icons.Default.Checklist,
    "mail" to Icons.Default.Mail,
    "messageSquare" to Icons.Default.ChatBubbleOutline,
    "mic" to Icons.Default.Mic,
    "monitor" to Icons.Default.DesktopWindows,
    "monitorSmartphone" to Icons.Default.Devices,
    "music" to Icons.Default.MusicNote,
    "palette" to Icons.Default.Palette,
    "paperclip" to Icons.Default.AttachFile,
    "pause" to Icons.Default.Pause,
    "pencil" to Icons.Default.Edit,
    "penLine" to Icons.Default.DriveFileRenameOutline,
    "play" to Icons.Default.PlayArrow,
    "plug" to Icons.Default.Power,
    "puzzle" to Icons.Default.Extension,
    "radio" to Icons.Default.Radio,
    "search" to Icons.Default.Search,
    "send" to Icons.AutoMirrored.Filled.Send,
    "settings" to Icons.Default.Settings,
    "shieldCheck" to Icons.Default.VerifiedUser,
    "shieldQuestion" to Icons.Default.Policy,
    "spark" to Icons.Default.AutoAwesome,
    "squareTerminal" to Icons.Default.Terminal,
    "target" to Icons.Default.TrackChanges,
    "trash" to Icons.Default.Delete,
    "users" to Icons.Default.Groups,
    "wrench" to Icons.Default.Build,
  )
}

internal fun ToolDisplayConfig.iconForTool(
  name: String,
  kind: CompletedToolKind = completedToolKind(name),
): ImageVector {
  val rowIcon =
    when (kind) {
      CompletedToolKind.Command -> "squareTerminal"
      CompletedToolKind.Read -> "fileText"
      CompletedToolKind.Edit -> "pencil"
      CompletedToolKind.Write -> "fileCode"
      CompletedToolKind.Search -> "search"
      CompletedToolKind.Fetch -> "globe"
      CompletedToolKind.Progress, CompletedToolKind.Other -> null
    }
  val icon = rowIcon ?: tools[name.trim().lowercase()]?.icon ?: fallback.icon
  return toolIconVectors[icon] ?: toolIconVectors.getValue("puzzle")
}
