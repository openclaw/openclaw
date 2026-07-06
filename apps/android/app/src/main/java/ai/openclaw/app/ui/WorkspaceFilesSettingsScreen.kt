package ai.openclaw.app.ui

import ai.openclaw.app.GatewayWorkspaceEntry
import ai.openclaw.app.GatewayWorkspaceFilePreview
import ai.openclaw.app.GatewayWorkspaceFilePreviewState
import ai.openclaw.app.GatewayWorkspaceFilesState
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.text.format.Formatter
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import java.io.File

/**
 * Read-only workspace file browser (#100705): directory drill-down, text and
 * image preview, and share-intent export backed by `agents.workspace.*` RPCs.
 */
@Composable
internal fun WorkspaceFilesSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val filesState by viewModel.workspaceFilesState.collectAsState()
  val previewState by viewModel.workspaceFilePreviewState.collectAsState()
  var path by remember { mutableStateOf("") }
  var previewPath by remember { mutableStateOf<String?>(null) }

  val backToParentOrSettings = {
    when {
      previewPath != null -> {
        previewPath = null
        viewModel.clearWorkspaceFilePreview()
      }
      path.isNotEmpty() -> path = path.substringBeforeLast('/', missingDelimiterValue = "")
      else -> onBack()
    }
  }

  LaunchedEffect(isConnected, path) {
    if (isConnected) {
      viewModel.loadWorkspaceFiles(path)
    }
  }
  LaunchedEffect(previewPath) {
    previewPath?.let { viewModel.loadWorkspaceFilePreview(it) }
  }

  SettingsDetailFrame(
    title = previewPath?.substringAfterLast('/') ?: if (path.isEmpty()) "Files" else path.substringAfterLast('/'),
    subtitle = if (previewPath == null) "Browse the agent workspace (read-only)." else "",
    icon = Icons.Outlined.Folder,
    onBack = backToParentOrSettings,
  ) {
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to browse workspace files.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      previewPath != null -> WorkspaceFilePreviewPanel(previewState)
      else -> WorkspaceFileListPanel(filesState, onOpen = { entry ->
        if (entry.isDirectory) {
          path = entry.path
        } else {
          previewPath = entry.path
        }
      })
    }
  }
}

@Composable
private fun WorkspaceFileListPanel(
  state: GatewayWorkspaceFilesState,
  onOpen: (GatewayWorkspaceEntry) -> Unit,
) {
  when (state) {
    is GatewayWorkspaceFilesState.Idle, is GatewayWorkspaceFilesState.Loading ->
      ClawPanel {
        Text(text = "Loading files…", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    is GatewayWorkspaceFilesState.Error ->
      ClawPanel {
        Text(text = state.message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    is GatewayWorkspaceFilesState.Loaded ->
      if (state.listing.entries.isEmpty()) {
        ClawPanel {
          Text(text = "This folder is empty.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      } else {
        ClawPanel {
          Column {
            state.listing.entries.forEach { entry ->
              WorkspaceEntryRow(entry = entry, onOpen = { onOpen(entry) })
            }
            if (state.listing.truncated) {
              Text(
                text = "Large folder — showing the first entries only.",
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.textMuted,
                modifier = Modifier.padding(top = 8.dp),
              )
            }
          }
        }
      }
  }
}

@Composable
private fun WorkspaceEntryRow(
  entry: GatewayWorkspaceEntry,
  onOpen: () -> Unit,
) {
  val context = LocalContext.current
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .clickable(onClick = onOpen)
        .padding(vertical = 10.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(
      imageVector = if (entry.isDirectory) Icons.Outlined.Folder else Icons.AutoMirrored.Outlined.InsertDriveFile,
      contentDescription = null,
      tint = if (entry.isDirectory) ClawTheme.colors.primary else ClawTheme.colors.textMuted,
      modifier = Modifier.size(20.dp),
    )
    Column(modifier = Modifier.weight(1f)) {
      Text(text = entry.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      if (!entry.isDirectory && entry.size != null) {
        Text(
          text = Formatter.formatShortFileSize(context, entry.size),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      }
    }
    Icon(
      imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
      contentDescription = null,
      tint = ClawTheme.colors.textMuted,
      modifier = Modifier.size(18.dp),
    )
  }
}

@Composable
private fun WorkspaceFilePreviewPanel(state: GatewayWorkspaceFilePreviewState) {
  val context = LocalContext.current
  when (state) {
    is GatewayWorkspaceFilePreviewState.Idle, is GatewayWorkspaceFilePreviewState.Loading ->
      ClawPanel {
        Text(text = "Loading preview…", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    is GatewayWorkspaceFilePreviewState.Error ->
      ClawPanel {
        Text(text = state.message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    is GatewayWorkspaceFilePreviewState.Loaded -> {
      val file = state.file
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = listOfNotNull(Formatter.formatShortFileSize(context, file.size), file.mimeType).joinToString(" · "),
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
              modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { shareWorkspaceFile(context, file) }) {
              Icon(imageVector = Icons.Outlined.Share, contentDescription = null, modifier = Modifier.size(16.dp))
              Text(text = "Share", style = ClawTheme.type.caption, modifier = Modifier.padding(start = 6.dp))
            }
          }
          WorkspaceFileContent(file)
        }
      }
    }
  }
}

@Composable
private fun WorkspaceFileContent(file: GatewayWorkspaceFilePreview) {
  if (file.isBase64) {
    val bitmap =
      remember(file.path, file.content) {
        runCatching {
          val bytes = Base64.decode(file.content, Base64.DEFAULT)
          BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
      }
    if (bitmap != null) {
      Image(bitmap = bitmap.asImageBitmap(), contentDescription = file.name, modifier = Modifier.fillMaxWidth())
    } else {
      Text(text = "This image could not be decoded.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  } else {
    Text(
      text = file.content,
      style = ClawTheme.type.caption.copy(fontFamily = FontFamily.Monospace),
      color = ClawTheme.colors.text,
      modifier = Modifier.horizontalScroll(rememberScrollState()),
    )
  }
}

private fun shareWorkspaceFile(
  context: Context,
  file: GatewayWorkspaceFilePreview,
) {
  val bytes =
    if (file.isBase64) {
      runCatching { Base64.decode(file.content, Base64.DEFAULT) }.getOrNull() ?: return
    } else {
      file.content.toByteArray(Charsets.UTF_8)
    }
  val shareDir = File(context.cacheDir, "workspace-share").apply { mkdirs() }
  val target = File(shareDir, file.name.substringAfterLast('/').ifEmpty { "file" })
  target.writeBytes(bytes)
  val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", target)
  val intent =
    Intent(Intent.ACTION_SEND).apply {
      type = file.mimeType ?: "application/octet-stream"
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
  context.startActivity(Intent.createChooser(intent, file.name))
}
