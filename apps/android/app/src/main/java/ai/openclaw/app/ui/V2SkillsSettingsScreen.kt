package ai.openclaw.app.ui

import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun V2SkillsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val skillsSummary by viewModel.skillsSummary.collectAsState()
  val skillsRefreshing by viewModel.skillsRefreshing.collectAsState()
  val skillsErrorText by viewModel.skillsErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val skills = skillsSummary.skills
  val readyCount = skills.count { skillReady(it) }
  val needsSetupCount = skills.count { skillNeedsSetup(it) }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshSkills()
    }
  }

  V2SettingsDetailFrame(
    title = "Skills",
    subtitle = "Installed capabilities available to OpenClaw.",
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Installed", skills.size.toString()),
          V2SettingsMetric("Ready", readyCount.toString()),
          V2SettingsMetric("Needs Setup", needsSetupCount.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (skillsRefreshing) "Refreshing" else "Refresh",
        onClick = viewModel::refreshSkills,
        enabled = isConnected && !skillsRefreshing,
        modifier = Modifier.weight(1f),
      )
    }
    skillsErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load skills.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      skills.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No skills installed.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Skills installed on the gateway will appear here.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> V2SkillsPanel(skills = skills)
    }
  }
}

@Composable
private fun V2SkillsPanel(skills: List<GatewaySkillSummary>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      skills.forEachIndexed { index, skill ->
        V2SkillListRow(skill = skill)
        if (index != skills.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2SkillListRow(skill: GatewaySkillSummary) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Surface(
      modifier = Modifier.size(30.dp),
      shape = CircleShape,
      color = ClawTheme.colors.surfacePressed,
      border = BorderStroke(1.dp, ClawTheme.colors.border),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Text(text = skillBadge(skill), style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 1)
      }
    }
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = skill.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text = skillSubtitle(skill), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    ClawStatusPill(text = skillStatusText(skill), status = skillStatus(skill))
  }
}

private fun skillReady(skill: GatewaySkillSummary): Boolean = !skill.disabled && skill.eligible && skill.missingCount == 0

private fun skillNeedsSetup(skill: GatewaySkillSummary): Boolean = !skill.disabled && (skill.blockedByAllowlist || !skill.eligible || skill.missingCount > 0)

private fun skillStatusText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> "Off"
    skillNeedsSetup(skill) -> "Setup"
    else -> "Ready"
  }

private fun skillStatus(skill: GatewaySkillSummary): ClawStatus =
  when {
    skill.disabled -> ClawStatus.Neutral
    skillNeedsSetup(skill) -> ClawStatus.Warning
    else -> ClawStatus.Success
  }

private fun skillSubtitle(skill: GatewaySkillSummary): String {
  val issue =
    when {
      skill.disabled -> "Disabled"
      skill.blockedByAllowlist -> "Blocked"
      skill.missingCount > 0 -> "${skill.missingCount} missing"
      !skill.eligible -> "Needs setup"
      else -> null
    }
  return listOfNotNull(skill.description, skillSourceLabel(skill), issue).joinToString(" · ")
}

private fun skillSourceLabel(skill: GatewaySkillSummary): String =
  when (skill.source) {
    "openclaw-bundled" -> if (skill.bundled) "Built-in" else "Bundled"
    "openclaw-managed" -> "Installed"
    "openclaw-workspace" -> "Workspace"
    "openclaw-extra" -> "Extra"
    else -> "Skill"
  }

private fun skillBadge(skill: GatewaySkillSummary): String {
  skill.emoji?.let { return it }
  return skill.name
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "S" }
}
