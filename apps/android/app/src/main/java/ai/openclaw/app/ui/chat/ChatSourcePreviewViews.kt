package ai.openclaw.app.ui.chat

import ai.openclaw.app.gateway.GatewayLoadedImage
import ai.openclaw.app.gateway.GatewaySourcePreviewConfig
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImagePainter
import coil3.compose.LocalPlatformContext
import coil3.compose.rememberAsyncImagePainter
import coil3.request.ImageRequest
import kotlinx.coroutines.CancellationException

@Composable
internal fun ChatSourcePreviews(
  sources: List<ChatSourcePreview>,
  config: GatewaySourcePreviewConfig?,
  loadFavicon: suspend (GatewaySourcePreviewConfig, String) -> GatewayLoadedImage?,
) {
  if (sources.isEmpty()) return
  var selectedUrl by rememberSaveable(sources.map { it.url }) { mutableStateOf<String?>(null) }
  val selected = sources.firstOrNull { it.url == selectedUrl }
  val uriHandler = LocalUriHandler.current
  Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
    Text(nativeString("Sources"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Row(modifier = Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      sources.forEach { source ->
        Surface(
          onClick = { selectedUrl = source.url.takeUnless { selectedUrl == it } },
          shape = RoundedCornerShape(10.dp),
          color = ClawTheme.colors.surfaceRaised,
          border = BorderStroke(1.dp, if (selectedUrl == source.url) ClawTheme.colors.textMuted else ClawTheme.colors.border),
          modifier = Modifier.width(184.dp),
        ) {
          Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(source.title, style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold), color = ClawTheme.colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
              ChatSourceFavicon(source.domain, config, loadFavicon)
              Text(source.domain, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
          }
        }
      }
    }
    if (selected != null) {
      Surface(shape = RoundedCornerShape(10.dp), color = ClawTheme.colors.surfaceRaised, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
        Column(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            text =
              if (selected.excerpt == null) {
                nativeString("Preview unavailable")
              } else if (selected.pageExcerpt) {
                nativeString("Page excerpt")
              } else {
                nativeString("Search snippet")
              },
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
          selected.excerpt?.let { Text(it, style = ClawTheme.type.body, color = ClawTheme.colors.text) }
          TextButton(onClick = { uriHandler.openUri(selected.url) }, modifier = Modifier.align(Alignment.End)) {
            Text(nativeString("Open source"))
            Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, modifier = Modifier.padding(start = 6.dp).size(16.dp))
          }
        }
      }
    }
  }
}

@Composable
private fun ChatSourceFavicon(
  domain: String,
  config: GatewaySourcePreviewConfig?,
  loadFavicon: suspend (GatewaySourcePreviewConfig, String) -> GatewayLoadedImage?,
) {
  var bytes by remember(domain, config) { mutableStateOf<ByteArray?>(null) }
  LaunchedEffect(domain, config) {
    if (config?.automaticallyFetchFavicons == true) {
      bytes =
        try {
          loadFavicon(config, domain)?.bytes
        } catch (error: CancellationException) {
          throw error
        } catch (_: Exception) {
          null
        }
    }
  }
  val platform = LocalPlatformContext.current
  val request =
    remember(bytes, platform) {
      ImageRequest
        .Builder(platform)
        .data(bytes)
        .size(64)
        .build()
    }
  val painter = rememberAsyncImagePainter(request, contentScale = ContentScale.Fit)
  val state by painter.state.collectAsState()
  Box(modifier = Modifier.size(16.dp), contentAlignment = Alignment.Center) {
    if (state is AsyncImagePainter.State.Success) {
      Image(painter, contentDescription = null, modifier = Modifier.size(16.dp), contentScale = ContentScale.Fit)
    } else {
      Icon(Icons.Outlined.Language, contentDescription = null, tint = ClawTheme.colors.textMuted, modifier = Modifier.size(16.dp))
    }
  }
}
