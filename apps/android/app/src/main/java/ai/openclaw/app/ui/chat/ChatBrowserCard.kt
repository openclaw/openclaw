package ai.openclaw.app.ui.chat

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.chat.ChatBrowserTab
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.ControlUiWebView
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri

/** Keep the browser mounted outside virtualized messages without changing transcript item indices. */
@Composable
internal fun ChatBrowserLayout(
  browser: @Composable (Dp) -> Unit,
  modifier: Modifier = Modifier,
  transcript: @Composable BoxScope.() -> Unit,
) {
  BoxWithConstraints(modifier) {
    val availableHeight = maxHeight
    Column {
      Box(Modifier.weight(1f), content = transcript)
      browser(availableHeight)
    }
  }
}

@Composable
internal fun ChatBrowserCard(
  tab: ChatBrowserTab,
  sessionKey: String,
  page: NodeRuntime.GatewayControlPage?,
  connected: Boolean,
  canControl: Boolean,
  availableHeight: Dp,
  onClose: () -> Unit,
) {
  val identity = listOf(sessionKey, tab.target, tab.node, tab.profile, tab.targetId)
  var expanded by rememberSaveable(page, identity) { mutableStateOf(false) }
  val uriHandler = LocalUriHandler.current
  val url = remember(page, identity) { page?.let { chatBrowserUrl(it.baseUrl, sessionKey, tab) } }
  BackHandler(enabled = expanded) { expanded = false }
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.sheet),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Column(Modifier.weight(1f)) {
          Text(nativeString("Agent browser"), style = ClawTheme.type.body, color = ClawTheme.colors.text)
          tab.title?.takeIf { it.isNotBlank() }?.let { title ->
            Text(
              title,
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        ClawPlainIconButton(
          icon = if (expanded) Icons.Default.ExpandMore else Icons.Default.ExpandLess,
          contentDescription = if (expanded) nativeString("Collapse browser") else nativeString("Control browser"),
          onClick = { expanded = !expanded },
          enabled = connected && canControl && page?.browserFocusAvailable == true,
        )
        ClawPlainIconButton(
          icon = Icons.Default.Close,
          contentDescription = nativeString("Close"),
          onClick = onClose,
        )
      }
      val notice =
        when {
          !connected || page == null -> nativeString("Browser offline. Reconnect to continue in this tab.")
          !canControl -> nativeString("Browser control is unavailable with your current Gateway permissions.")
          !page.browserFocusAvailable -> nativeString("Browser view unavailable. Update your Gateway and use its bundled Control UI.")
          else -> null
        }
      if (notice != null) {
        Text(
          notice,
          modifier = Modifier.padding(12.dp),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      } else if (page != null && url != null) {
        key(page, url) {
          val expandedHeight = (availableHeight * 0.6f).coerceIn(0.dp, 420.dp)
          val previewHeight = (availableHeight * 0.3f).coerceIn(0.dp, 180.dp)
          Box(Modifier.fillMaxWidth().height(if (expanded) expandedHeight else previewHeight)) {
            ControlUiWebView(
              page = page,
              url = url,
              modifier = Modifier.matchParentSize(),
              interactive = expanded,
              onExternalLink = { uriHandler.openUri(it) },
            )
            if (!expanded) {
              Box(Modifier.matchParentSize().clickable(onClickLabel = nativeString("Control browser")) { expanded = true })
            }
          }
        }
      }
    }
  }
}

internal fun chatBrowserUrl(
  baseUrl: String,
  sessionKey: String,
  tab: ChatBrowserTab,
): String =
  baseUrl
    .trimEnd('/')
    .toUri()
    .buildUpon()
    .clearQuery()
    .fragment(null)
    .appendPath("focus")
    .appendPath("browser")
    .appendQueryParameter("sessionKey", sessionKey)
    .appendQueryParameter("target", tab.target)
    .appendQueryParameter("profile", tab.profile)
    .appendQueryParameter("targetId", tab.targetId)
    .apply { tab.node?.let { appendQueryParameter("node", it) } }
    .build()
    .toString()
