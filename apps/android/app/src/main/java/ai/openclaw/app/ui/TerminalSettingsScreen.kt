package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.core.net.toUri

/**
 * Full-height terminal surface: embeds the gateway-served terminal-only
 * Control UI focus document (`/focus/terminal`, the same ghostty-web surface the
 * desktop Control UI uses) for the currently connected gateway.
 */
@Composable
internal fun TerminalSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  ControlUiScreenFrame(
    title = nativeString("Terminal"),
    icon = Icons.Outlined.Terminal,
    onBack = onBack,
    modifier = Modifier.imePadding(),
  ) {
    val page = controlPage
    if (isConnected && page != null) {
      // Trust changes recreate the WebView; unrelated recompositions preserve live shells.
      key(page) {
        ControlUiWebView(
          page = page,
          url = terminalUrl(page.baseUrl),
          modifier = Modifier.fillMaxSize(),
        )
      }
    } else {
      ControlUiUnavailable(
        title = nativeString("Terminal needs a connected gateway"),
        detail = nativeString("Connect to your gateway to open a shell in the agent workspace."),
      )
    }
  }
}

/** Builds the terminal focus route without putting gateway credentials in the URL. */
internal fun terminalUrl(baseUrl: String): String =
  baseUrl
    .trimEnd('/')
    .toUri()
    .buildUpon()
    .clearQuery()
    .fragment(null)
    .appendPath("focus")
    .appendPath("terminal")
    .build()
    .toString()
