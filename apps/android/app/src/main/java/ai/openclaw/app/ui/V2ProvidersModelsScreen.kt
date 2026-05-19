package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun V2ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
  onAddProvider: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val refreshing by viewModel.modelCatalogRefreshing.collectAsState()
  val errorText by viewModel.modelCatalogErrorText.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)
  val modelGroups = sortedModelGroups(models)

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshModelCatalog()
    }
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 13.dp, end = 20.dp, bottom = 13.dp)) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(7.dp), contentPadding = PaddingValues(bottom = 52.dp)) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              V2ProviderHeaderIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", onClick = onBack)
              V2ProviderHeaderIconButton(icon = Icons.Default.Add, contentDescription = "Add provider", outlined = true, onClick = onAddProvider)
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
              Text(text = "Providers & Models", style = ClawTheme.type.display.copy(fontSize = 14.8.sp, lineHeight = 18.sp), color = ClawTheme.colors.text, maxLines = 1)
              Text(
                text = "Connect and manage AI providers\nBrowse models and their capabilities.",
                style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        }

        item {
          V2ProviderSectionLabel(title = "Providers")
        }

        item {
          if (!isConnected && providerRows.isEmpty()) {
            ClawEmptyState(title = "Gateway offline", body = "Connect your Gateway to load provider readiness and model catalog.")
          } else {
            V2ProviderList(rows = providerRows, refreshing = refreshing)
          }
        }

        errorText?.let { message ->
          item {
            ClawPanel {
              Text(text = message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            }
          }
        }

        item {
          V2ProviderSectionLabel(title = "Model catalog")
        }

        if (modelGroups.isEmpty()) {
          item {
            V2ModelCatalogEmpty(
              title = if (refreshing) "Loading models" else "No models loaded",
              body = if (isConnected) "Refresh after configuring a provider on the Gateway." else "Connect the Gateway to browse models.",
            )
          }
        } else {
          items(modelGroups, key = { it.first }) { entry ->
            V2ModelGroup(provider = entry.first, models = entry.second)
          }
        }
      }
      V2ProviderAddButton(onClick = onAddProvider, modifier = Modifier.align(Alignment.BottomCenter))
    }
  }
}

private data class V2ProviderRow(
  val id: String,
  val name: String,
  val status: String,
  val ready: Boolean,
  val modelCount: Int,
)

private fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): List<V2ProviderRow> {
  val modelCounts = models.groupingBy { it.provider }.eachCount()
  val authRows =
    providers.map { provider ->
      val ready = modelProviderReady(provider.status)
      V2ProviderRow(
        id = provider.id,
        name = provider.displayName,
        status = if (ready) "Ready" else "Needs setup",
        ready = ready,
        modelCount = modelCounts[provider.id] ?: 0,
      )
    }
  val missingAuthRows =
    modelCounts.keys
      .filter { provider -> authRows.none { it.id == provider } }
      .map { provider ->
        V2ProviderRow(
          id = provider,
          name = providerDisplayName(provider),
          status = "Ready",
          ready = true,
          modelCount = modelCounts[provider] ?: 0,
        )
      }
  return (authRows + missingAuthRows).sortedWith(compareBy(::providerPriority, { it.name.lowercase() }))
}

internal fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" || normalized == "ready" || normalized == "healthy" || normalized == "configured"
}

private fun sortedModelGroups(models: List<GatewayModelSummary>): List<Pair<String, List<GatewayModelSummary>>> =
  models
    .groupBy { it.provider }
    .entries
    .sortedWith(compareBy({ providerPriority(it.key) }, { providerDisplayName(it.key).lowercase() }))
    .map { it.key to it.value }

private fun providerPriority(row: V2ProviderRow): Int = providerPriority(row.id)

private fun providerPriority(provider: String): Int =
  when (provider.trim().lowercase()) {
    "openai" -> 0
    "anthropic" -> 1
    "google" -> 2
    "openrouter" -> 3
    "ollama", "ollama-local" -> 4
    "codex", "openai-codex" -> 5
    else -> 100
  }

@Composable
private fun V2ProviderList(
  rows: List<V2ProviderRow>,
  refreshing: Boolean,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      if (rows.isEmpty()) {
        V2ProviderListRow(V2ProviderRow(id = "loading", name = "Provider catalog", status = if (refreshing) "Loading" else "No providers", ready = false, modelCount = 0))
      } else {
        val visibleRows = rows.take(5)
        visibleRows.forEachIndexed { index, row ->
          V2ProviderListRow(row)
          if (index != visibleRows.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun V2ProviderListRow(row: V2ProviderRow) {
  Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    V2ProviderBadge(text = row.name)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.name, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = if (row.modelCount > 0) "${row.modelCount} models" else "Provider setup", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (row.ready) ClawTheme.colors.success else ClawTheme.colors.warning))
      Text(text = row.status, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Open ${row.name}", modifier = Modifier.size(14.dp), tint = ClawTheme.colors.text)
    }
  }
}

@Composable
private fun V2ProviderBadge(text: String) {
  Surface(modifier = Modifier.size(24.dp), shape = RoundedCornerShape(6.dp), color = ClawTheme.colors.surfacePressed, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = providerInitials(text), style = ClawTheme.type.section, color = ClawTheme.colors.text, textAlign = TextAlign.Center)
    }
  }
}

private fun providerInitials(value: String): String =
  value
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "AI" }

@Composable
private fun V2ModelCatalogEmpty(
  title: String,
  body: String,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 11.dp, vertical = 10.dp)) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = body, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2ModelGroup(
  provider: String,
  models: List<GatewayModelSummary>,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        V2ProviderBadge(text = providerDisplayName(provider))
        Text(text = providerDisplayName(provider), style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
        V2ProviderMiniTag(text = "${models.size} models")
        Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
      }
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      models.take(3).forEach { model ->
        V2ModelRow(model)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      }
      if (models.size > 3) {
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(text = "View all models", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, modifier = Modifier.weight(1f))
          Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.text)
        }
      }
    }
  }
}

@Composable
private fun V2ModelRow(model: GatewayModelSummary) {
  Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(text = model.name, style = ClawTheme.type.mono, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    modelCapabilityLabels(model).take(3).forEach { label ->
      V2ProviderMiniTag(text = label)
    }
    Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(ClawTheme.colors.success))
  }
}

private fun modelCapabilityLabels(model: GatewayModelSummary): List<String> =
  buildList {
    if (model.supportsReasoning) add("Reasoning")
    if (model.supportsVision) add("Vision")
    if (model.supportsAudio) add("Voice")
    if (model.supportsDocuments) add("Docs")
    if ((model.contextTokens ?: 0L) >= 100_000L) add("Long context")
    if (isEmpty()) add("Fast")
  }

@Composable
private fun V2ProviderSectionLabel(title: String) {
  Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
  }
}

@Composable
private fun V2ProviderHeaderIconButton(
  icon: ImageVector,
  contentDescription: String,
  outlined: Boolean = false,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(if (outlined) 28.dp else 30.dp),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = if (outlined) BorderStroke(1.dp, ClawTheme.colors.borderStrong) else null,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(if (outlined) 15.dp else 19.dp))
    }
  }
}

@Composable
private fun V2ProviderAddButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.fillMaxWidth().height(30.dp),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Row(
      modifier = Modifier.fillMaxSize(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Icon(imageVector = Icons.Default.Add, contentDescription = null, modifier = Modifier.size(13.dp))
      Spacer(modifier = Modifier.width(7.dp))
      Text(text = "Add Provider", style = ClawTheme.type.label, maxLines = 1)
    }
  }
}

@Composable
private fun V2ProviderMiniTag(text: String) {
  Surface(
    shape = RoundedCornerShape(5.dp),
    color = Color.Transparent,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.textMuted,
  ) {
    Text(text = text, modifier = Modifier.padding(horizontal = 4.dp, vertical = 0.5.dp), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), maxLines = 1)
  }
}
