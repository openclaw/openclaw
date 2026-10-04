package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.rememberChatRealtimeTalkLauncher
import ai.openclaw.app.ui.design.ClawScaffold
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.DisplayFeature
import kotlinx.coroutines.flow.collectLatest

@Composable
internal fun UnifiedChatShellScreen(
  viewModel: MainViewModel,
  showSidebarButton: Boolean,
  onOpenSidebar: () -> Unit,
  onOpenDashboard: (String) -> Unit,
  onOpenGatewaySettings: () -> Unit,
  onOpenProvidersModels: () -> Unit,
  tabletopPanes: TabletopPaneBounds? = null,
  features: List<DisplayFeature> = emptyList(),
) {
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val startTalk = rememberChatRealtimeTalkLauncher(viewModel)
  val currentStartTalk by rememberUpdatedState(startTalk)
  val lifecycleOwner = LocalLifecycleOwner.current
  LaunchedEffect(viewModel) { viewModel.refreshTalkSetupReadiness() }
  LaunchedEffect(viewModel, lifecycleOwner) {
    lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
      viewModel.pendingAssistantTalkStart.collectLatest { request ->
        if (request == null) return@collectLatest
        val ready = viewModel.awaitAssistantTalkReady(request)
        // Consume before permission/setup admission; failures must never replay after setup.
        if (viewModel.consumeAssistantTalkStart(request)) {
          if (ready) currentStartTalk(request) else viewModel.showTalkSetupMessage(nativeText("Gateway not connected"))
        }
      }
    }
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = WindowInsets.safeDrawing,
  ) {
    ChatScreen(
      viewModel = viewModel,
      talkActive = talkModeEnabled,
      showSidebarButton = showSidebarButton,
      onOpenSidebar = onOpenSidebar,
      onToggleTalk = {
        if (talkModeEnabled) {
          viewModel.setTalkModeEnabled(false)
        } else {
          startTalk(null)
        }
      },
      onOpenDashboard = onOpenDashboard,
      onOpenGatewaySettings = onOpenGatewaySettings,
      onOpenProvidersModels = onOpenProvidersModels,
      tabletopPanes = tabletopPanes,
      features = features,
    )
  }
}
