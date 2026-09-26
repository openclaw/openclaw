package ai.openclaw.app.ui

import ai.openclaw.app.GatewayInstalledAgent
import ai.openclaw.app.GatewayInstalledAgentInstallation
import ai.openclaw.app.GatewayModelProviderOutcome
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.ProviderBrandIcon
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

@Composable
internal fun InstalledAgentsPanel(
  agents: List<GatewayInstalledAgent>?,
  loading: Boolean,
  errorText: NativeText?,
  canRefresh: Boolean,
  canEdit: Boolean,
  saving: Boolean,
  nativeAgentFlags: Map<String, Boolean>,
  models: List<GatewayModelSummary>,
  outcomes: List<GatewayModelProviderOutcome>,
  pendingProviders: Set<String>,
  readOnlyReason: NativeText?,
  onRefresh: () -> Unit,
  onEnabledChange: (String, Boolean) -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(nativeString("Installed agents"), modifier = Modifier.weight(1f), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        TextButton(onClick = onRefresh, enabled = canRefresh && !loading && !saving) {
          Text(if (loading) nativeString("Checking…") else nativeString("Check again"))
        }
      }
      Text(
        nativeString("Coding agents installed on the computer running your Gateway. Each agent manages its own sign-in. Enabling an agent does not sign you in."),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      if (!canEdit) {
        Text(readOnlyReason?.resolveNativeText() ?: nativeString("Installed agent settings are read-only."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
      errorText?.let {
        Text(it.resolveNativeText(), style = ClawTheme.type.body, color = ClawTheme.colors.warning)
        TextButton(onClick = onRefresh, enabled = canRefresh && !loading && !saving) { Text(nativeString("Retry")) }
      }
      if (loading && agents == null) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
          CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
          Text(nativeString("Checking installed agents…"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      } else if (agents != null) {
        if (agents.isEmpty()) {
          Text(nativeString("No installed agents reported by this Gateway."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
        agents.forEach { agent ->
          HorizontalDivider(color = ClawTheme.colors.border)
          InstalledAgentRow(
            agent = agent,
            enabled = nativeAgentFlags[agent.id] ?: agent.enabled,
            canEdit = canEdit && !saving && !loading,
            catalogStatus = providerCatalogStatus(outcomes.filter { it.provider == agent.runtimeId }),
            checkingModels = agent.runtimeId in pendingProviders,
            modelsAvailable = models.any { it.provider == agent.runtimeId && it.available == true },
            onEnabledChange = { onEnabledChange(agent.id, it) },
          )
        }
      }
      if (saving) Text(nativeString("Saving settings…"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun InstalledAgentRow(
  agent: GatewayInstalledAgent,
  enabled: Boolean,
  canEdit: Boolean,
  catalogStatus: String?,
  checkingModels: Boolean,
  modelsAvailable: Boolean,
  onEnabledChange: (Boolean) -> Unit,
) {
  val (status, hint) =
    when {
      agent.installation == GatewayInstalledAgentInstallation.Missing -> nativeString("Not detected") to nativeString("Install \$name on the computer running your Gateway, then check again.", agent.name)
      agent.installation == GatewayInstalledAgentInstallation.Unverified -> nativeString("Not verified") to nativeString("Check this agent's command on the computer running your Gateway.")
      !enabled -> nativeString("Installed") to nativeString("Disabled in model settings.")
      catalogStatus == "auth-rejected" -> nativeString("Sign-in required") to nativeString("Sign in to \$name on the computer running your Gateway, then check again.", agent.name)
      catalogStatus == "unavailable" -> nativeString("Models unavailable") to nativeString("Check that \$name works on the computer running your Gateway, then check again.", agent.name)
      checkingModels -> nativeString("Discovering models…") to null
      modelsAvailable -> nativeString("Models available") to null
      else -> nativeString("Installed") to nativeString("Sign in to \$name on the computer running your Gateway to load its models.", agent.name)
    }
  val statusColor =
    when {
      agent.installation == GatewayInstalledAgentInstallation.Unverified -> ClawTheme.colors.warning
      agent.installation != GatewayInstalledAgentInstallation.Installed || !enabled -> ClawTheme.colors.textMuted
      catalogStatus == "auth-rejected" -> ClawTheme.colors.danger
      catalogStatus == "unavailable" -> ClawTheme.colors.warning
      checkingModels -> ClawTheme.colors.textMuted
      modelsAvailable -> ClawTheme.colors.success
      else -> ClawTheme.colors.textMuted
    }
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
    ProviderBrandIcon(agent.id, size = 28.dp)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(agent.name, style = ClawTheme.type.body, color = ClawTheme.colors.text)
      Text(status, style = ClawTheme.type.caption, color = statusColor)
      hint?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
    }
    Switch(
      checked = enabled,
      onCheckedChange = onEnabledChange,
      enabled = canEdit,
      modifier = Modifier.semantics { contentDescription = nativeString("Use \$name", agent.name) },
    )
  }
}
