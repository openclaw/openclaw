package ai.openclaw.app

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/** Show the actual navigated authority, never a provider's redirect/query/state payload. */
internal fun browserSecurityOrigin(url: String): String? {
  val parsed = url.toHttpUrlOrNull()?.takeIf { it.scheme == "https" } ?: return null
  val host = if (parsed.host.contains(':')) "[${parsed.host}]" else parsed.host
  return "https://$host" + if (parsed.port == 443) "" else ":${parsed.port}"
}

@Composable
internal fun BrowserSignInScreen(
  currentUrl: String,
  error: String?,
  browser: View?,
  busy: Boolean,
  canContinue: Boolean,
  showSignOut: Boolean,
  onCancel: () -> Unit,
  onContinue: () -> Unit,
  onSignOut: () -> Unit,
) {
  val origin = browserSecurityOrigin(currentUrl) ?: nativeString("Opening secure sign-in")
  var showActions by remember { mutableStateOf(false) }
  Surface(Modifier.fillMaxSize().testTag("browser-signin-root"), color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    BoxWithConstraints(
      Modifier
        .fillMaxSize()
        .safeDrawingPadding()
        .imePadding()
        .padding(8.dp),
    ) {
      // A short landscape/IME window gets one toolbar, not two rows of large text actions.
      val compact = maxHeight < 400.dp
      Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().heightIn(max = 64.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(
            origin,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
            modifier = Modifier.weight(1f).testTag("browser-security-origin").semantics { contentDescription = origin },
          )
          IconButton(onClick = onCancel, enabled = !busy) { Icon(Icons.Default.Close, contentDescription = nativeString("Cancel")) }
          if (compact) {
            IconButton(onClick = onContinue, enabled = canContinue) {
              Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = nativeString("Continue in OpenClaw"))
            }
          }
          if (showSignOut && compact) {
            BrowserSessionActions(showActions, { showActions = it }, !busy, onSignOut)
          }
        }
        if (error != null && !compact) {
          Text(error, color = ClawTheme.colors.warning, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.heightIn(max = 64.dp))
        }
        Box(Modifier.fillMaxWidth().weight(1f).clipToBounds()) {
          browser?.let { view ->
            // No surrounding vertical scroll container: AndroidView owns browser touches/scrolling.
            AndroidView(factory = { view }, modifier = Modifier.fillMaxSize().testTag("browser-viewport"))
          }
          if (error != null && compact) {
            Surface(color = ClawTheme.colors.canvas) {
              Text(error, color = ClawTheme.colors.warning, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
          }
        }
        if (!compact) {
          Row(Modifier.fillMaxWidth().heightIn(max = 64.dp), verticalAlignment = Alignment.CenterVertically) {
            Button(onClick = onContinue, enabled = canContinue, modifier = Modifier.weight(1f)) {
              Text(nativeString("Continue in OpenClaw"), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (showSignOut) BrowserSessionActions(showActions, { showActions = it }, !busy, onSignOut)
          }
        }
      }
    }
  }
}

@Composable
private fun BrowserSessionActions(
  expanded: Boolean,
  onExpanded: (Boolean) -> Unit,
  enabled: Boolean,
  onSignOut: () -> Unit,
) {
  Box {
    IconButton(onClick = { onExpanded(true) }, enabled = enabled) { Icon(Icons.Default.MoreVert, contentDescription = nativeString("More browser actions")) }
    DropdownMenu(expanded = expanded, onDismissRequest = { onExpanded(false) }) {
      DropdownMenuItem(
        text = { Text(nativeString("Sign out of saved browser session")) },
        enabled = enabled,
        onClick = {
          onExpanded(false)
          onSignOut()
        },
      )
    }
  }
}
