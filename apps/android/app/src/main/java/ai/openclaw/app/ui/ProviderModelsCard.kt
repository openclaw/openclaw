package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderOutcome
import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.GatewayProviderSessionSpend
import ai.openclaw.app.GatewayUsageBilling
import ai.openclaw.app.GatewayUsageProviderSummary
import ai.openclaw.app.ProviderAuthProvider
import ai.openclaw.app.ProviderAuthState
import ai.openclaw.app.ProviderConnectionProbe
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.chat.formatCompactTokenCount
import ai.openclaw.app.ui.chat.formatContextEstimatedCost
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.ProviderBrandIcon
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.NumberFormat

internal fun providerCatalogStatus(outcomes: List<GatewayModelProviderOutcome>): String? {
  val providerOutcomes = outcomes.filter { it.profileId == null }
  val scoped = providerOutcomes.ifEmpty { outcomes }
  val priority = if (providerOutcomes.isNotEmpty()) listOf("auth-rejected", "unavailable", "ready") else listOf("ready", "auth-rejected", "unavailable")
  return priority.firstOrNull { status -> scoped.any { it.status == status } }
}

@Composable
internal fun ProviderModelsCard(
  row: ProviderRow,
  capability: ProviderAuthProvider?,
  agentLabel: String,
  usage: GatewayUsageProviderSummary?,
  usageLoading: Boolean,
  spend: GatewayProviderSessionSpend?,
  catalogStatus: String?,
  checkingModels: Boolean,
  tagsDescribeDefaults: Boolean,
  expanded: Boolean,
  expandedMore: Boolean,
  searching: Boolean,
  enabled: Boolean,
  actionState: ProviderAuthState?,
  onToggle: () -> Unit,
  onToggleMore: () -> Unit,
  onConnect: () -> Unit,
  onSetApiKey: () -> Unit,
  onProbe: () -> Unit,
  onRemoveKey: () -> Unit,
) {
  val hasCredentials = row.auth?.let { it.hasApiKey || it.profiles.any { profile -> profile.eligible } } == true
  val ready = catalogStatus == "ready" && row.modelCount > 0 && row.ready && row.auth?.status != "missing"
  val status =
    when {
      checkingModels -> nativeString("Checking models…")
      ready -> nativeString("Ready")
      row.renewalFailed -> nativeString("Renewal failed")
      row.auth?.status == "expired" -> nativeString("Expired")
      row.auth?.status == "expiring" -> nativeString("Expiring")
      row.auth?.status == "missing" && capability?.canSignIn == true -> nativeString("Not connected")
      catalogStatus == "auth-rejected" -> nativeString("Credentials rejected")
      catalogStatus == "unavailable" -> nativeString("Models unavailable")
      hasCredentials -> nativeString("Credentials configured")
      capability?.canSignIn != true -> nativeString("Set up on computer")
      else -> nativeString("Not connected")
    }
  val statusColor =
    when {
      checkingModels -> ClawTheme.colors.textMuted
      ready -> ClawTheme.colors.success
      row.renewalFailed || row.auth?.status == "expired" || catalogStatus == "auth-rejected" -> ClawTheme.colors.danger
      catalogStatus == "unavailable" || row.auth?.status == "expiring" -> ClawTheme.colors.warning
      else -> ClawTheme.colors.textMuted
    }
  val expansionState = if (expanded) nativeString("Expanded") else nativeString("Collapsed")
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .heightIn(min = ClawTheme.spacing.touchTarget)
            .clickable(onClick = onToggle)
            .semantics { stateDescription = expansionState },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        ProviderBrandIcon(row.id, size = 28.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(row.name, style = ClawTheme.type.body, color = ClawTheme.colors.text)
          Text(
            if (row.modelCount == 1) nativeString("\$provider · 1 model", row.id) else nativeString("\$provider · \$count models", row.id, row.modelCount),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        Icon(if (expanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(18.dp), tint = ClawTheme.colors.textMuted)
      }
      FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        usage?.plan?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
          Box(Modifier.size(6.dp).clip(CircleShape).background(statusColor))
          Text(status, style = ClawTheme.type.caption, color = statusColor)
        }
      }
      HorizontalDivider(color = ClawTheme.colors.border)
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(nativeString("Credentials for \$agent", agentLabel), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        Text(providerCredentialSummary(row.auth), style = ClawTheme.type.label, color = ClawTheme.colors.text)
        if (ready && row.auth?.renewalFailed == true) {
          Text(nativeString("Renewal failed for a credential."), style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
        }
      }
      HorizontalDivider(color = ClawTheme.colors.border)
      ProviderGlobalMetrics(usage, usageLoading, spend)
      FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (capability?.canSignIn == true) {
          ClawSecondaryButton(text = if (row.renewalFailed) nativeString("Reconnect") else nativeString("Connect Provider"), onClick = onConnect, enabled = enabled)
        }
        if (hasCredentials || row.models.any { it.available == true }) {
          ClawSecondaryButton(text = nativeString("Test connection"), onClick = onProbe, enabled = enabled)
        }
        if (capability?.apiKeySupported == true) {
          ClawSecondaryButton(text = nativeString("Set API key"), onClick = onSetApiKey, enabled = enabled)
        }
        if (row.auth?.canRemoveApiKey == true) {
          Surface(onClick = onRemoveKey, enabled = enabled, modifier = Modifier.heightIn(min = ClawTheme.spacing.touchTarget), shape = RoundedCornerShape(ClawTheme.radii.button), color = ClawTheme.colors.dangerSoft, contentColor = ClawTheme.colors.danger) {
            Text(nativeString("Remove key"), modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp), style = ClawTheme.type.label)
          }
        }
      }
      if (actionState?.busy == true) Text(nativeString("Working…"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      actionState?.probeResult?.let { ProviderProbeResult(it) }
      actionState?.noticeText?.let { Text(it.resolveNativeText(), style = ClawTheme.type.caption, color = ClawTheme.colors.success) }
      actionState?.errorText?.let { Text(it.resolveNativeText(), style = ClawTheme.type.caption, color = ClawTheme.colors.danger) }
      actionState?.warningText?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning) }
      if (expanded) {
        HorizontalDivider(color = ClawTheme.colors.border)
        Text(nativeString("Models"), style = ClawTheme.type.label, color = ClawTheme.colors.text)
        val (configured, more) = row.models.partition { model -> model.tags.any { it == "default" || it == "configured" || it.startsWith("fallback#") } }
        val visible = if (searching) row.models else configured
        visible.forEach { ProviderModelRow(it, row.availability, tagsDescribeDefaults) }
        if (!searching && more.isNotEmpty()) {
          TextButton(onClick = onToggleMore, modifier = Modifier.fillMaxWidth()) {
            Text(if (more.size == 1) nativeString("1 more model") else nativeString("\$count more models", more.size), modifier = Modifier.weight(1f))
            Icon(if (expandedMore) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = if (expandedMore) nativeString("Collapse") else nativeString("Expand"))
          }
          if (expandedMore) more.forEach { ProviderModelRow(it, row.availability, tagsDescribeDefaults) }
        }
        if (row.models.isEmpty()) Text(nativeString("No models configured"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        if (capability?.canSignIn != true) Text(nativeString("Sign-in is managed on the computer"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
    }
  }
}

private fun providerCredentialSummary(provider: GatewayModelProviderSummary?): String {
  if (provider == null) return nativeString("Not configured")
  val parts =
    buildList {
      val oauth = provider.profiles.count { it.eligible && it.type == "oauth" }
      val tokens = provider.profiles.count { it.eligible && it.type == "token" }
      val keys = provider.profiles.count { it.eligible && it.type == "api_key" }
      if (oauth > 0) add(nativeString("OAuth profiles: \$count", oauth))
      if (tokens > 0) add(nativeString("Token profiles: \$count", tokens))
      when (provider.apiKeySource) {
        "config" -> add(nativeString("API key set in config"))
        "env" -> add(provider.apiKeyEnvVar?.let { nativeString("API key from environment (\$name)", it) } ?: nativeString("API key from environment"))
      }
      if (keys > 0) add(nativeString("API key profiles: \$count", keys))
    }
  return parts.joinToString(" · ").ifEmpty { nativeString("Not configured") }
}

@Composable
private fun ProviderGlobalMetrics(
  usage: GatewayUsageProviderSummary?,
  loading: Boolean,
  spend: GatewayProviderSessionSpend?,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(nativeString("Global usage and cost"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    when {
      usage?.error != null -> {
        Text(usage.error, style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
      }

      usage == null -> {
        Text(if (loading) nativeString("Loading usage…") else nativeString("No live usage data reported by this provider."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }

      else -> {
        usage.summary?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
        usage.windows.forEach { window ->
          Text(nativeString("\$label · \$percent% used", listOfNotNull(window.groupLabel, window.label).joinToString(" · "), window.usedPercent.toInt()), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          LinearProgressIndicator(progress = { (window.usedPercent / 100.0).coerceIn(0.0, 1.0).toFloat() }, modifier = Modifier.fillMaxWidth(), color = ClawTheme.colors.accent, trackColor = ClawTheme.colors.surfacePressed)
        }
        usage.billing.forEach { bill ->
          val label =
            bill.label ?: when (bill.type) {
              "balance" -> nativeString("Balance")
              "budget" -> nativeString("Budget")
              else -> nativeString("Spend")
            }
          Text(listOfNotNull(label, providerBillingValue(bill), bill.period).joinToString(" · "), style = ClawTheme.type.caption, color = ClawTheme.colors.text)
        }
        if (usage.windows.isEmpty() && usage.billing.isEmpty() && usage.summary == null) Text(nativeString("No live usage data reported by this provider."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
    }
    if (spend != null && (spend.totalTokens > 0 || spend.totalCost > 0)) {
      HorizontalDivider(color = ClawTheme.colors.border)
      Text(nativeString("Global session spend · 30d"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      Text(formatContextEstimatedCost(spend.totalCost), style = ClawTheme.type.label, color = ClawTheme.colors.text)
      Text(nativeString("\$tokens tokens · \$messages messages", formatCompactTokenCount(spend.totalTokens), spend.messageCount), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

private fun providerBillingValue(billing: GatewayUsageBilling): String {
  val formatter = NumberFormat.getNumberInstance().apply { maximumFractionDigits = 2 }
  val amount = if (billing.type == "budget") "${billing.used?.let(formatter::format) ?: "—"} / ${billing.limit?.let(formatter::format) ?: "—"}" else billing.amount?.let(formatter::format) ?: "—"
  return "$amount ${billing.unit}"
}

@Composable
private fun ProviderProbeResult(result: ProviderConnectionProbe) {
  val partial = result.status == "ok" && result.results.any { it.status != "ok" }
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    Text(if (partial) nativeString("Connected with warnings") else providerProbeStatus(result.status), style = ClawTheme.type.label, color = if (result.status == "ok" && !partial) ClawTheme.colors.success else ClawTheme.colors.warning)
    result.latencyMs?.let { Text(nativeString("\$ms ms", it), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
    result.error?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning) }
    result.results.forEach { target ->
      Text(nativeString("\$label · \$status", target.label, providerProbeStatus(target.status)), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      target.error?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning) }
    }
  }
}

private fun providerProbeStatus(status: String): String =
  when (status) {
    "ok" -> nativeString("Connected")
    "auth" -> nativeString("Authentication failed")
    "rate_limit" -> nativeString("Rate limited")
    "billing" -> nativeString("Billing problem")
    "timeout" -> nativeString("Timed out")
    "format" -> nativeString("Invalid response")
    "no_model" -> nativeString("No model available to test")
    else -> nativeString("Connection failed")
  }

@Composable
private fun ProviderModelRow(
  model: GatewayModelSummary,
  providerAvailability: ProviderAvailability,
  tagsDescribeDefaults: Boolean,
) {
  val availability = model.available.toProviderAvailability()
  Column(Modifier.fillMaxWidth().padding(horizontal = ClawTheme.spacing.xs, vertical = ClawTheme.spacing.xxs)) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs)) {
      Text(model.name, modifier = Modifier.weight(1f), style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (tagsDescribeDefaults && "default" in model.tags) ModelTag(nativeString("Gateway default"), emphasized = true)
      if (tagsDescribeDefaults && model.tags.any { it.startsWith("fallback#") }) ModelTag(nativeString("Fallback"))
      model.contextTokens?.let { ModelTag(formatContextTokens(it)) }
    }
    if (availability != providerAvailability) {
      Text(
        when (availability) {
          ProviderAvailability.Available -> nativeString("Available")
          ProviderAvailability.Unavailable -> nativeString("Unavailable")
          ProviderAvailability.Unknown -> nativeString("Availability unknown")
        },
        style = ClawTheme.type.caption,
        color = availability.color(),
      )
    }
  }
}

@Composable
private fun ModelTag(
  label: String,
  emphasized: Boolean = false,
) {
  Surface(shape = RoundedCornerShape(ClawTheme.radii.row), color = if (emphasized) ClawTheme.colors.successSoft else ClawTheme.colors.surfacePressed) {
    Text(label, modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp), style = ClawTheme.type.captionSmall, color = if (emphasized) ClawTheme.colors.success else ClawTheme.colors.textMuted, maxLines = 1)
  }
}

@Composable
private fun ProviderAvailability.color(): Color =
  when (this) {
    ProviderAvailability.Available -> ClawTheme.colors.success
    ProviderAvailability.Unavailable -> ClawTheme.colors.warning
    ProviderAvailability.Unknown -> ClawTheme.colors.textSubtle
  }

private fun Boolean?.toProviderAvailability(): ProviderAvailability =
  when (this) {
    true -> ProviderAvailability.Available
    false -> ProviderAvailability.Unavailable
    null -> ProviderAvailability.Unknown
  }

private fun formatContextTokens(tokens: Long): String = if (tokens >= 1_000) "${tokens / 1_000}k" else tokens.toString()
