package ai.openclaw.app.ui

import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Settings screen for gateway skills and their readiness state. */
@Composable
internal fun SkillsSettingsScreen(
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
  var selectedSkillKey by remember { mutableStateOf<String?>(null) }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshSkills()
    }
  }

  selectedSkillKey?.let { skillKey ->
    val selectedSkill = skills.firstOrNull { it.skillKey == skillKey }
    SkillDetailSettingsScreen(
      skill = selectedSkill,
      skillKey = skillKey,
      isConnected = isConnected,
      onBack = { selectedSkillKey = null },
    )
    return
  }

  SettingsDetailFrame(
    title = nativeString("Skills"),
    subtitle = nativeString("Installed capabilities available to OpenClaw."),
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric(nativeString("Installed"), skills.size.toString()),
          SettingsMetric(nativeString("Ready"), readyCount.toString()),
          SettingsMetric(nativeString("Needs Setup"), needsSetupCount.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (skillsRefreshing) nativeString("Refreshing") else nativeString("Refresh"),
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
          Text(text = nativeString("Connect the gateway to load skills."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      skills.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = nativeString("No skills installed."), style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = nativeString("Skills installed on the gateway will appear here."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> SkillsPanel(skills = skills, onSkillClick = { selectedSkillKey = it.skillKey })
    }
  }
}

@Composable
private fun SkillDetailSettingsScreen(
  skill: GatewaySkillSummary?,
  skillKey: String,
  isConnected: Boolean,
  onBack: () -> Unit,
) {
  BackHandler(onBack = onBack)

  SettingsDetailFrame(
    title = skill?.name ?: skillKey,
    subtitle = nativeString("Inspect installed skill capability and setup state."),
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    skill?.let { summary ->
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric(nativeString("Status"), skillStatusText(summary)),
            SettingsMetric(nativeString("Source"), skillSourceLabel(summary)),
            SettingsMetric(nativeString("Missing"), summary.missingCount.toString()),
          ),
      )
      SkillSetupPanel(summary)
    }
    SkillDetailPanel(skill = skill, isConnected = isConnected)
  }
}

@Composable
private fun SkillSetupPanel(skill: GatewaySkillSummary) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text(text = nativeString("Setup"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = skillConfigurationText(skill), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun SkillDetailPanel(
  skill: GatewaySkillSummary?,
  isConnected: Boolean,
) {
  if (!isConnected) {
    ClawPanel {
      Text(text = nativeString("Connect the gateway to load skill details."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    return
  }
  if (skill == null) {
    ClawPanel {
      Text(text = nativeString("Skill detail is not available in the current skills status."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    return
  }
  SettingsMetricPanel(
    rows =
      listOf(
        SettingsMetric(nativeString("Skill Key"), skill.skillKey),
        SettingsMetric(nativeString("Display"), skill.name),
        SettingsMetric(nativeString("Source"), skillSourceLabel(skill)),
        SettingsMetric(nativeString("Install Options"), skill.installCount.toString()),
      ),
  )
  skill.description?.let { description ->
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = nativeString("Description"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = description, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun SkillsPanel(
  skills: List<GatewaySkillSummary>,
  onSkillClick: (GatewaySkillSummary) -> Unit,
) {
  ClawListPanel(items = skills) { skill ->
    SkillListRow(skill = skill, onClick = { onSkillClick(skill) })
  }
}

@Composable
private fun SkillListRow(
  skill: GatewaySkillSummary,
  onClick: () -> Unit,
) {
  ClawDetailRow(
    title = skill.name,
    subtitle = skillSubtitle(skill),
    modifier = Modifier.clickable(onClickLabel = nativeString("Open skill detail"), onClick = onClick),
    leading = { ClawTextBadge(text = skillBadge(skill)) },
    trailing = {
      Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ClawStatusPill(text = skillStatusText(skill), status = skillStatus(skill))
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = null,
          tint = ClawTheme.colors.textSubtle,
        )
      }
    },
  )
}

private fun skillReady(skill: GatewaySkillSummary): Boolean = !skill.disabled && skill.eligible && skill.missingCount == 0

private fun skillNeedsSetup(skill: GatewaySkillSummary): Boolean = !skill.disabled && (skill.blockedByAllowlist || !skill.eligible || skill.missingCount > 0)

private fun skillStatusText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> nativeString("Off")
    skillNeedsSetup(skill) -> nativeString("Setup")
    else -> nativeString("Ready")
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
      skill.disabled -> nativeString("Disabled")
      skill.blockedByAllowlist -> nativeString("Blocked")
      skill.missingCount > 0 -> skillMissingItemsText(skill.missingCount)
      !skill.eligible -> nativeString("Needs setup")
      else -> null
    }
  return listOfNotNull(skill.description, skillSourceLabel(skill), issue).joinToString(" · ")
}

private fun skillConfigurationText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> nativeString("This skill is disabled on the gateway. Android shows detail only; enable or configure it from desktop or CLI.")
    skill.blockedByAllowlist -> nativeString("This skill is blocked by the gateway allowlist. Android can inspect it, but allowlist changes stay on desktop or CLI.")
    skill.missingCount > 0 -> skillMissingConfigurationText(skill.missingCount)
    !skill.eligible -> nativeString("This skill is installed but not currently eligible to run. Use desktop or CLI for configuration changes.")
    else -> nativeString("Ready on this gateway. Android detail is read-only; install, update, and configuration changes stay on desktop or CLI.")
  }

internal fun skillMissingItemsText(count: Int): String =
  when (count) {
    0 -> nativeString("No missing items")
    1 -> nativeString("1 missing item")
    else -> nativeString("\$count missing items", count)
  }

internal fun skillMissingConfigurationText(count: Int): String =
  when (count) {
    1 -> nativeString("This skill needs 1 setup item. Android shows what is installed; setup/config changes stay on desktop or CLI.")
    else -> nativeString("This skill needs \$count setup items. Android shows what is installed; setup/config changes stay on desktop or CLI.", count)
  }

private fun skillSourceLabel(skill: GatewaySkillSummary): String =
  when (skill.source) {
    "openclaw-bundled" -> if (skill.bundled) nativeString("Built-in") else nativeString("Bundled")
    "openclaw-managed" -> nativeString("Installed")
    "openclaw-workspace" -> nativeString("Workspace")
    "openclaw-extra" -> nativeString("Extra")
    else -> nativeString("Skill")
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
