package ai.openclaw.app.ui.chat

import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.chat.ChatQuestionDraft
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.desktopHandoffQuestion
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.AppDialog
import ai.openclaw.app.ui.ControlUiScreenFrame
import ai.openclaw.app.ui.DesktopViewer
import ai.openclaw.app.ui.SettingsRoute
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.window.DialogProperties

/** The shared renderer owns Take control; the existing question owns explicit settlement. */
@Composable
internal fun ChatDesktopHandoff(
  prompt: ChatQuestionPrompt,
  page: NodeRuntime.GatewayControlPage?,
  connected: Boolean,
  foreground: Boolean,
  onDismiss: () -> Unit,
  onDraftChanged: (ChatQuestionPrompt, (ChatQuestionDraft) -> ChatQuestionDraft) -> Unit,
  onSubmit: (ChatQuestionPrompt, Map<String, List<String>>) -> Unit,
  onSkip: (ChatQuestionPrompt) -> Unit,
) {
  val question = prompt.desktopHandoffQuestion() ?: return
  val desktop = question.desktop ?: return
  AppDialog(
    onDismissRequest = onDismiss,
    properties =
      DialogProperties(
        usePlatformDefaultWidth = false,
        dismissOnClickOutside = false,
        decorFitsSystemWindows = false,
      ),
  ) {
    Box(
      Modifier
        .fillMaxSize()
        .background(ClawTheme.colors.surface)
        .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
      ControlUiScreenFrame(
        title = nativeString("Desktop"),
        icon = SettingsRoute.Desktop.icon,
        onBack = onDismiss,
        modifier = Modifier.imePadding(),
      ) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
          val questionHeight = maxHeight * 0.45f
          Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) {
              DesktopViewer(
                page = page,
                isConnected = connected,
                source = desktop.source.environmentId,
                interactive = foreground,
              )
            }
            // Keep long instructions and every declared choice reachable without remounting
            // the renderer when this card, the IME, or the viewport changes size.
            Box(Modifier.heightIn(max = questionHeight).verticalScroll(rememberScrollState())) {
              ChatQuestionCard(
                prompt = prompt,
                onDraftChanged = onDraftChanged,
                onSubmit = onSubmit,
                onSkip = onSkip,
                enabled = connected && foreground,
              )
            }
          }
        }
      }
    }
  }
}
