package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.core.net.toUri

/** Full-height viewer for a gateway-observable desktop source. */
@Composable
internal fun DesktopScreen(
  viewModel: MainViewModel,
  source: String? = null,
  session: String? = null,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  ControlUiScreenFrame(
    title = nativeString("Desktop"),
    icon = Icons.Outlined.DesktopWindows,
    onBack = onBack,
    // Keep the viewer's touch toolbar above the soft keyboard.
    modifier = Modifier.imePadding(),
  ) {
    val page = controlPage
    if (isConnected && page != null) {
      // GatewayControlPage equality includes credentials and the accepted TLS pin.
      key(page, source, session) {
        ControlUiWebView(
          page = page,
          url = desktopUrl(baseUrl = page.baseUrl, source = source, session = session),
          modifier = Modifier.fillMaxSize(),
        )
      }
    } else {
      ControlUiUnavailable(
        title = nativeString("Desktop needs a connected gateway"),
        detail = nativeString("Connect to your gateway to view a machine screen."),
      )
    }
  }
}

/** Builds the desktop focus route; credentials stay in ControlUiWebView's startup script. */
internal fun desktopUrl(
  baseUrl: String,
  source: String? = null,
  session: String? = null,
): String {
  val normalizedSource = source?.trim()?.takeIf(String::isNotEmpty)
  val normalizedSession = session?.trim()?.takeIf(String::isNotEmpty)
  val builder =
    baseUrl
      .trimEnd('/')
      .toUri()
      .buildUpon()
      .clearQuery()
      .fragment(null)
      .appendPath("focus")
      .appendPath("desktop")
  when {
    normalizedSource != null -> builder.appendPath("source").appendPath(normalizedSource)
    normalizedSession != null -> builder.appendPath("session").appendPath(normalizedSession)
  }
  return builder.build().toString()
}
