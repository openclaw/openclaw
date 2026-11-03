package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ToolDisplayConfig
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AccountTree
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.BarChart
import androidx.compose.material.icons.filled.BorderColor
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.DataObject
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.DriveFileRenameOutline
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Groups
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.IntegrationInstructions
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Layers
import androidx.compose.material.icons.filled.Mail
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PendingActions
import androidx.compose.material.icons.filled.Pets
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Policy
import androidx.compose.material.icons.filled.Power
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.filled.Radio
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material.icons.filled.TrackChanges
import androidx.compose.material.icons.filled.VerifiedUser
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
