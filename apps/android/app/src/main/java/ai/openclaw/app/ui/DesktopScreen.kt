package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.i18n.nativeString
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier

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
    icon = SettingsRoute.Desktop.icon,
    onBack = onBack,
    // Keep the viewer's touch toolbar above the soft keyboard.
    modifier = Modifier.imePadding(),
  ) {
    DesktopViewer(page = controlPage, isConnected = isConnected, source = source, session = session)
  }
}

/** Shared viewer; native presentation never takes control or settles a pending question. */
@Composable
internal fun DesktopViewer(
  page: NodeRuntime.GatewayControlPage?,
  isConnected: Boolean,
  source: String? = null,
  session: String? = null,
  interactive: Boolean = true,
) {
  if (isConnected && page != null) {
    if (page.tlsFingerprintSha256 != null) {
      ControlUiUnavailable(
        title = nativeString("Desktop unavailable"),
        detail = nativeString("Embedded pages are unavailable on certificate-pinned gateways. Use the native screens instead."),
      )
    } else {
      // GatewayControlPage equality includes its native operator owner and the accepted TLS pin.
      key(page, source, session) {
        ControlUiWebView(
          page = page,
          url = desktopUrl(baseUrl = page.baseUrl, source = source, session = session),
          modifier = Modifier.fillMaxSize(),
          interactive = interactive,
        )
      }
    }
  } else {
    ControlUiUnavailable(
      title = nativeString("Desktop needs a connected gateway"),
      detail = nativeString("Connect to your gateway to view a machine screen."),
    )
  }
}

/** Builds the desktop focus route without putting gateway credentials in the URL. */
internal fun desktopUrl(
  baseUrl: String,
  source: String? = null,
  session: String? = null,
): String {
  val normalizedSource = source?.trim()?.takeIf(String::isNotEmpty)
  val normalizedSession = session?.trim()?.takeIf(String::isNotEmpty)
  val builder = controlUiFocusUrlBuilder(baseUrl, "desktop")
  when {
    normalizedSource != null -> builder.appendPath("source").appendPath(normalizedSource)
    normalizedSession != null -> builder.appendPath("session").appendPath(normalizedSession)
  }
  return builder.build().toString()
}
