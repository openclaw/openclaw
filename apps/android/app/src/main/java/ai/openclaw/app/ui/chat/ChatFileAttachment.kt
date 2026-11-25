package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.gateway.GatewayLoadedMedia
import ai.openclaw.app.gateway.GatewayMediaKind
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.takeUtf8Bytes
import ai.openclaw.app.ui.design.ClawTheme
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.InsertDriveFile
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

private enum class ChatFileAction { Open, Share }

private data class ChatDownloadedFile(
  val file: File,
  val mimeType: String,
)

@Composable
internal fun ChatFileAttachment(
  content: ChatMessageContent,
  resolverReady: Boolean,
  loadMedia: suspend (String, GatewayMediaKind, Boolean) -> GatewayLoadedMedia?,
) {
  val context = LocalContext.current
  val name = content.fileName?.takeIf(String::isNotBlank) ?: nativeString("Attachment")
  var requestedAction by remember(content.artifactId) { mutableStateOf<ChatFileAction?>(null) }
  var retryAction by remember(content.artifactId) { mutableStateOf(ChatFileAction.Open) }
  var downloaded by remember(content.artifactId) { mutableStateOf<ChatDownloadedFile?>(null) }
  var error by remember(content.artifactId) { mutableStateOf<String?>(null) }
  val loading = requestedAction != null
  val available = !content.artifactId.isNullOrBlank()

  fun request(action: ChatFileAction) {
    if (!resolverReady || loading || !available) return
    error = null
    retryAction = action
    requestedAction = action
  }

  LaunchedEffect(content.artifactId, resolverReady, requestedAction) {
    val action = requestedAction ?: return@LaunchedEffect
    try {
      if (!resolverReady) return@LaunchedEffect
      val local =
        downloaded?.takeIf { it.file.isFile } ?: run {
          val loaded =
            loadMedia(checkNotNull(content.artifactId), GatewayMediaKind.File, false) as? GatewayLoadedMedia.Buffered
              ?: error("File unavailable")
          stageChatFile(context, name, loaded).also { downloaded = it }
        }
      currentCoroutineContext().ensureActive()
      val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", local.file)
      val intent =
        Intent(if (action == ChatFileAction.Open) Intent.ACTION_VIEW else Intent.ACTION_SEND).apply {
          if (action == ChatFileAction.Open) {
            setDataAndType(uri, local.mimeType)
          } else {
            type = local.mimeType
            putExtra(Intent.EXTRA_STREAM, uri)
          }
          clipData = ClipData.newRawUri(local.file.name, uri)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
      context.startActivity(
        if (action == ChatFileAction.Share) Intent.createChooser(intent, name) else intent,
      )
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (_: ActivityNotFoundException) {
      error = nativeString("No app can open this file. Use Share to send it to another app.")
    } catch (_: Exception) {
      error =
        if (downloaded == null) {
          nativeString("Could not download. Try again or reconnect. If the file was removed or expired, ask for it to be sent again.")
        } else {
          nativeString("Could not open or share the file. Try again.")
        }
    } finally {
      requestedAction = null
    }
  }

  Surface(
    shape = RoundedCornerShape(10.dp),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.AutoMirrored.Filled.InsertDriveFile, contentDescription = null, tint = ClawTheme.colors.textMuted, modifier = Modifier.size(20.dp))
        Text(name, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis, style = ClawTheme.type.body, color = ClawTheme.colors.text)
        if (loading) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
      }
      Text(
        when {
          loading -> nativeString("Downloading…")
          !available -> nativeString("File unavailable. Ask for it to be sent again.")
          !resolverReady -> nativeString("Reconnect to open or share this file.")
          downloaded != null -> nativeString("Downloaded · Ready to open or share")
          else -> nativeString("Download to open or share")
        },
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
      error?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.danger) }
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (error != null && downloaded == null) {
          TextButton(onClick = { request(retryAction) }, enabled = resolverReady && available && !loading) {
            Text(nativeString("Retry"))
          }
        } else {
          val openDescription = nativeString("Open \${name}", name)
          TextButton(
            onClick = { request(ChatFileAction.Open) },
            enabled = resolverReady && available && !loading,
            modifier = Modifier.semantics { contentDescription = openDescription },
          ) { Text(nativeString("Open")) }
        }
        val shareDescription = nativeString("Share \${name}", name)
        TextButton(
          onClick = { request(ChatFileAction.Share) },
          enabled = resolverReady && available && !loading,
          modifier = Modifier.semantics { contentDescription = shareDescription },
        ) { Text(nativeString("Share")) }
      }
    }
  }
}

private suspend fun stageChatFile(
  context: Context,
  name: String,
  loaded: GatewayLoadedMedia.Buffered,
): ChatDownloadedFile =
  withContext(Dispatchers.IO) {
    val safeName =
      name
        .replace('\\', '/')
        .substringAfterLast('/')
        .filterNot { it.isISOControl() }
        .takeUtf8Bytes(180)
        .takeUnless { it.isBlank() || it == "." || it == ".." } ?: "Attachment"
    // External URI grants outlive the chat. Keep unique files in the OS-managed
    // cache rather than deleting or replacing bytes while another app reads them.
    val directory = File(context.cacheDir, "chat-files/${UUID.randomUUID()}")
    try {
      check(directory.mkdirs()) { "Could not create attachment directory" }
      val file = File(directory, safeName)
      file.writeBytes(loaded.bytes)
      ChatDownloadedFile(file, loaded.mimeType.substringBefore(';').trim())
    } catch (failure: Exception) {
      directory.deleteRecursively()
      throw failure
    }
  }
