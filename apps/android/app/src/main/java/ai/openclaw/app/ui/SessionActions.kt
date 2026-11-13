package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatSessionPatch
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.operatorScopesAllowWrite
import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.launch

internal fun Context.copySessionReference(sessionKey: String) {
  copyTextWithConfirmation(
    label = nativeString("Session reference"),
    value = sessionKey,
    confirmation = nativeString("Session reference copied"),
  )
}

/** Catalog entries without a Gateway session are not rename/copy targets. */
@Composable
internal fun SessionRowActions(
  viewModel: MainViewModel,
  session: ChatSessionEntry?,
  content: @Composable (onLongClick: (() -> Unit)?) -> Unit,
) {
  if (session == null) {
    content(null)
    return
  }
  val gatewayId by viewModel.activeGatewayStableId.collectAsState()
  val connected by viewModel.isConnected.collectAsState()
  val scopes by viewModel.operatorScopes.collectAsState()
  val context = LocalContext.current
  var menuExpanded by remember(gatewayId, session.ownerAgentId, session.key) { mutableStateOf(false) }
  var renameTarget by rememberSaveable(gatewayId, session.ownerAgentId, session.key, stateSaver = SessionActionTargetSaver) {
    mutableStateOf<SessionActionTarget?>(null)
  }
  Box {
    content { menuExpanded = true }
    AppDropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
      DropdownMenuItem(
        text = { Text(nativeString("Rename…")) },
        enabled = connected && operatorScopesAllowWrite(scopes) && session.archived != true,
        onClick = {
          menuExpanded = false
          if (gatewayId == viewModel.activeGatewayStableId.value) renameTarget = session.toActionTarget(gatewayId)
        },
      )
      DropdownMenuItem(
        text = { Text(nativeString("Copy session reference")) },
        onClick = {
          menuExpanded = false
          if (gatewayId == viewModel.activeGatewayStableId.value) context.copySessionReference(session.key)
        },
      )
    }
  }
  renameTarget?.let { target ->
    SessionRenameDialog(viewModel, target, onDismiss = { renameTarget = null })
  }
}

@Composable
internal fun SessionRenameDialog(
  viewModel: MainViewModel,
  target: SessionActionTarget,
  onDismiss: () -> Unit,
) {
  val gatewayId by viewModel.activeGatewayStableId.collectAsState()
  val connected by viewModel.isConnected.collectAsState()
  val scopes by viewModel.operatorScopes.collectAsState()
  val scope = rememberCoroutineScope()
  var saving by remember(target.stateKey) { mutableStateOf(false) }
  var failed by rememberSaveable(target.stateKey) { mutableStateOf(false) }
  LaunchedEffect(gatewayId, target) {
    if (!target.matchesGateway(gatewayId)) onDismiss()
  }
  if (!target.matchesGateway(gatewayId)) return
  SessionTextDialog(
    title = nativeString("Rename thread"),
    stateKey = target.stateKey,
    initialValue = target.label ?: target.displayName.orEmpty(),
    confirmLabel = nativeString("Rename"),
    allowEmpty = true,
    enabled = !saving && connected && operatorScopesAllowWrite(scopes),
    error = if (failed) nativeString("Could not rename thread. Try again.") else null,
    onDismiss = { if (!saving) onDismiss() },
    onConfirm = { value ->
      if (!saving) {
        scope.launch {
          // Read live authority, not the snapshot that rendered the dialog button.
          if (!target.matchesGateway(viewModel.activeGatewayStableId.value) ||
            !viewModel.isConnected.value || !operatorScopesAllowWrite(viewModel.operatorScopes.value)
          ) {
            return@launch
          }
          saving = true
          failed = false
          try {
            val label = value.trim()
            val saved =
              viewModel.patchChatSession(
                ChatSessionPatch(
                  key = target.key,
                  ownerAgentId = target.ownerAgentId,
                  label = label.takeIf(String::isNotEmpty),
                  clearLabel = label.isEmpty(),
                ),
                expectedGatewayId = target.gatewayStableId,
              )
            if (saved) onDismiss() else failed = true
          } finally {
            saving = false
          }
        }
      }
    },
  )
}
