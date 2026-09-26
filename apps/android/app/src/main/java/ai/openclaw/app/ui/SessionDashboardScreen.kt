package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPlainIconButton
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.DesktopWindows
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.net.toUri
import java.util.Locale

/** Gateway Control UI dashboard for one chat session. */
@Composable
internal fun SessionDashboardScreen(
  viewModel: MainViewModel,
  sessionKey: String,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val controlPage by viewModel.gatewayControlPage.collectAsState()
  val desktopObserveAvailable by viewModel.desktopObserveAvailable.collectAsState()
  val sessionOwnerAgentId by viewModel.chatSessionOwnerAgentId.collectAsState()
  val gatewayDefaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val dashboardUrl =
    controlPage?.let { page ->
      sessionDashboardUrl(
        baseUrl = page.baseUrl,
        sessionKey = sessionKey,
        fallbackAgentId = sessionOwnerAgentId ?: gatewayDefaultAgentId,
      )
    }
  var showingDesktop by rememberSaveable(sessionKey) { mutableStateOf(false) }
  if (showingDesktop) {
    // The viewer replaces this screen in place rather than pushing a shell tab, so it must
    // claim System Back itself; the shell handler would otherwise pop the whole dashboard.
    BackHandler { showingDesktop = false }
    DesktopScreen(viewModel = viewModel, session = sessionKey, onBack = { showingDesktop = false })
    return
  }
  ControlUiScreenFrame(
    title = nativeString("Dashboard"),
    icon = Icons.Outlined.Dashboard,
    onBack = onBack,
    headerActions = {
      if (desktopObserveAvailable && dashboardUrl != null) {
        ClawPlainIconButton(
          icon = Icons.Outlined.DesktopWindows,
          contentDescription = nativeString("Open desktop"),
          onClick = { showingDesktop = true },
        )
      }
    },
  ) {
    val page = controlPage
    if (isConnected && page != null && dashboardUrl != null) {
      key(page, dashboardUrl) {
        ControlUiWebView(
          page = page,
          url = dashboardUrl,
          modifier = Modifier.fillMaxSize(),
        )
      }
    } else {
      ControlUiUnavailable(
        title =
          if (isConnected && page != null) {
            nativeString("Session dashboard unavailable")
          } else {
            nativeString("Dashboard needs a connected gateway")
          },
        detail =
          if (isConnected && page != null) {
            nativeString("Go back and select a session to open its dashboard.")
          } else {
            nativeString("Connect to your gateway to open this session dashboard.")
          },
      )
    }
  }
}

/**
 * Only bare main/global keys are Gateway aliases. Canonical keys stay literal so
 * the device-owned main session cannot become the Gateway's main session or a slug.
 */
internal fun sessionDashboardUrl(
  baseUrl: String,
  sessionKey: String,
  fallbackAgentId: String? = null,
): String? {
  val rawKey = sessionKey.trim().takeIf(String::isNotEmpty) ?: return null
  val parsed = parseAgentSessionKey(rawKey)
  if (parsed == null && rawKey.startsWith("agent:", ignoreCase = true)) return null
  val rawAgentId = (parsed?.first ?: fallbackAgentId)?.trim()?.takeIf(String::isNotEmpty) ?: return null
  val agentId = normalizeDashboardAgentId(rawAgentId)
  val rest = parsed?.second ?: rawKey
  val segments = rest.split(':')
  if (segments.any(String::isEmpty)) return null
  val routeSegments =
    if (parsed == null && (rest.equals("main", ignoreCase = true) || rest.equals("global", ignoreCase = true))) {
      emptyList()
    } else {
      listOf("~key") + segments.map(::encodeDashboardPathSegment)
    }
  val uri = baseUrl.trimEnd('/').toUri()
  val basePath = uri.encodedPath.orEmpty().trimEnd('/')
  val encodedRoute =
    buildList {
      add("dashboard")
      add(encodeDashboardPathSegment(agentId))
      addAll(routeSegments)
    }.joinToString("/")
  return uri
    .buildUpon()
    .encodedPath("$basePath/$encodedRoute")
    .clearQuery()
    .fragment(null)
    .build()
    .toString()
}

private fun parseAgentSessionKey(sessionKey: String): Pair<String, String>? {
  val parts = sessionKey.split(':')
  if (parts.size < 3 || !parts.first().equals("agent", ignoreCase = true)) return null
  val agentId = parts[1].trim().takeIf(String::isNotEmpty) ?: return null
  val rest = parts.drop(2)
  if (rest.any(String::isEmpty)) return null
  return agentId to rest.joinToString(":")
}

private fun normalizeDashboardAgentId(agentId: String): String {
  val normalized =
    agentId
      .lowercase(Locale.ROOT)
      .replace(Regex("[^a-z0-9_-]+"), "-")
      .trim('-')
      .take(64)
  return normalized.ifEmpty { "main" }
}

private fun encodeDashboardPathSegment(segment: String): String =
  when (segment) {
    "." -> {
      "~dot"
    }

    ".." -> {
      "~dotdot"
    }

    else -> {
      android.net.Uri
        .encode(segment)
        .replace(".", "%2E")
        .let { encoded -> if (encoded.startsWith("~")) "~$encoded" else encoded }
    }
  }
