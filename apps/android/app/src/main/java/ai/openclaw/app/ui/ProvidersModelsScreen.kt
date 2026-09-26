package ai.openclaw.app.ui

import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSettingsState
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.operatorScopesAllowAdmin
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

@Composable
internal fun ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val gatewayId by viewModel.activeGatewayStableId.collectAsState()
  val selectionGeneration by viewModel.chatSelectionGeneration.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val models by viewModel.providerModelCatalog.collectAsState()
  val decisionModels by viewModel.providerDecisionModels.collectAsState()
  val automaticUtilityModel by viewModel.providerAutomaticUtilityModel.collectAsState()
  val selectionRestricted by viewModel.providerModelSelectionRestricted.collectAsState()
  val policyDefaultModel by viewModel.providerPolicyDefaultModel.collectAsState()
  val outcomes by viewModel.providerModelOutcomes.collectAsState()
  val pendingProviders by viewModel.providerModelPendingProviders.collectAsState()
  val tagsDescribeDefaults by viewModel.providerModelTagsDescribeDefaults.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val capabilities by viewModel.modelAuthCapabilities.collectAsState()
  val refreshing by viewModel.providerModelCatalogRefreshing.collectAsState()
  val errorText by viewModel.providerModelCatalogErrorText.collectAsState()
  val usageState by viewModel.usageState.collectAsState()
  val spendState by viewModel.providerSessionSpendState.collectAsState()
  val installedAgentsAvailable by viewModel.installedAgentsAvailable.collectAsState()
  val installedAgentsState by viewModel.installedAgentsState.collectAsState()
  val operatorScopes by viewModel.operatorScopes.collectAsState()
  val gatewayCatalogRevision by viewModel.gatewayCatalogRevision.collectAsState()
  val gatewayConfigRevision by viewModel.gatewayConfigRevision.collectAsState()
  val settingsController = remember(gatewayId, isConnected, gatewayCatalogRevision) { if (isConnected) viewModel.createGatewayModelSettingsController() else null }
  val settingsState = settingsController?.state?.collectAsState()?.value ?: GatewayModelSettingsState()
  val canEditSettings = isConnected && operatorScopesAllowAdmin(operatorScopes)
  val installedRuntimeIds =
    installedAgentsState.summary
      .orEmpty()
      .map { it.runtimeId }
      .toSet()
  var query by rememberSaveable(gatewayId) { mutableStateOf("") }
  var expandedProviders by rememberSaveable(gatewayId) { mutableStateOf(emptyList<String>()) }
  var expandedMore by rememberSaveable(gatewayId) { mutableStateOf(emptyList<String>()) }
  var signIn by remember { mutableStateOf<ProviderAuthController?>(null) }
  var signInProvider by remember { mutableStateOf<String?>(null) }
  var startWithApiKey by remember { mutableStateOf(false) }
  var actionController by remember { mutableStateOf<ProviderAuthController?>(null) }
  var pendingRemoval by remember { mutableStateOf<ProviderKeyRemoval?>(null) }
  val actionState = actionController?.state?.collectAsState()?.value
  val snackbar = remember { SnackbarHostState() }
  val scope = rememberCoroutineScope()
  val screenOwner = viewModel.captureChatShareOwner()
  val agentId = screenOwner.agentId
  val agentLabel = agents.firstOrNull { it.id == agentId }?.name ?: agentId
  val additionalProviders =
    buildMap {
      outcomes.forEach { put(it.provider, providerDisplayName(it.provider)) }
      pendingProviders.forEach { put(it, providerDisplayName(it)) }
      usageState.summary
        ?.providers
        ?.filter { it.providerId.isNotBlank() }
        ?.forEach { put(it.providerId, it.displayName) }
      spendState.summary?.forEach { (provider, spend) ->
        if (spend.totalTokens > 0 || spend.totalCost > 0) putIfAbsent(provider, providerDisplayName(provider))
      }
    }
  val rows = providerRows(providers, models, additionalProviders).filterNot { it.id in installedRuntimeIds }
  val modelCount = rows.sumOf { it.modelCount }
  val search = query.trim()
  val searching = search.isNotEmpty()
  val visibleRows =
    if (!searching) {
      rows
    } else {
      rows.mapNotNull { row ->
        if (row.name.contains(search, ignoreCase = true) || row.id.contains(search, ignoreCase = true)) {
          row
        } else {
          val matches = row.models.filter { it.name.contains(search, ignoreCase = true) || it.id.contains(search, ignoreCase = true) }
          if (matches.isEmpty()) null else row.copy(models = matches)
        }
      }
    }

  fun controller(): ProviderAuthController? {
    val result = viewModel.createProviderAuthController(screenOwner)
    if (result == null) {
      scope.launch { snackbar.showSnackbar(nativeString("Provider setup is unavailable. Reconnect with administrator access and try again.")) }
    }
    return result
  }

  fun openConnection(
    provider: String?,
    apiKey: Boolean = false,
  ) {
    val next = controller() ?: return
    signIn?.close()
    signInProvider = provider
    startWithApiKey = apiKey
    signIn = next
  }

  fun beginAction(
    row: ProviderRow,
    remove: Boolean,
  ) {
    val next = controller() ?: return
    actionController?.close()
    actionController = next
    if (remove) pendingRemoval = ProviderKeyRemoval(row, next, agentLabel) else next.probe(row.id)
  }

  fun refresh() {
    viewModel.refreshProviderModels(refresh = true)
    viewModel.refreshUsage()
    viewModel.refreshProviderSessionSpend()
    settingsController?.refresh()
    if (installedAgentsAvailable) viewModel.refreshInstalledAgents()
  }

  LaunchedEffect(settingsController, gatewayConfigRevision) { settingsController?.refresh() }
  DisposableEffect(settingsController) { onDispose { settingsController?.close() } }
  LaunchedEffect(isConnected, gatewayId, installedAgentsAvailable) {
    if (isConnected && installedAgentsAvailable) viewModel.refreshInstalledAgents()
  }

  LaunchedEffect(isConnected, gatewayId, selectionGeneration) {
    signIn?.close()
    signIn = null
    actionController?.close()
    actionController = null
    pendingRemoval = null
    if (isConnected) viewModel.refreshProviderModels()
  }
  LaunchedEffect(isConnected, gatewayId) {
    if (isConnected) {
      viewModel.refreshUsage()
      viewModel.refreshProviderSessionSpend()
    }
  }
  DisposableEffect(actionController) {
    val current = actionController
    onDispose { current?.close() }
  }

  signIn?.let { active ->
    ProviderSignInDialog(
      controller = active,
      initialProviderId = signInProvider,
      initialApiKeySelected = startWithApiKey,
      onConnected = { provider ->
        scope.launch { snackbar.showSnackbar(nativeString("\$provider connected", providerDisplayName(provider))) }
      },
      onDismiss = { signIn = null },
    )
  }
  pendingRemoval?.let { pending ->
    val row = pending.provider
    AppAlertDialog(
      onDismissRequest = { pendingRemoval = null },
      title = { Text(nativeString("Remove API key?")) },
      text = {
        Text(
          if (row.auth?.apiKeySource == "config") {
            nativeString("Remove the shared Gateway API key for \$provider and this agent's saved API keys? Other agents using that shared key will also lose access. Account and token sign-ins stay connected.", row.name)
          } else {
            nativeString("Remove saved API keys for \$provider from \$agent? Account and token sign-ins stay connected.", row.name, pending.agentLabel)
          },
        )
      },
      confirmButton = {
        TextButton(onClick = {
          pendingRemoval = null
          pending.controller.removeApiKey(row.id)
        }) { Text(nativeString("Remove key"), color = ClawTheme.colors.danger) }
      },
      dismissButton = { TextButton(onClick = { pendingRemoval = null }) { Text(nativeString("Cancel")) } },
    )
  }

  ClawScaffold(
    contentPadding = PaddingValues(horizontal = ClawTheme.spacing.sm, vertical = ClawTheme.spacing.xxs),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    Box(Modifier.fillMaxSize()) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.sm),
        contentPadding = PaddingValues(bottom = ClawTheme.spacing.sm),
      ) {
        item(key = "header") {
          Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
              Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back"), tint = ClawTheme.colors.text)
            }
            Text(nativeString("Models"), modifier = Modifier.weight(1f), style = ClawTheme.type.title, color = ClawTheme.colors.text)
            IconButton(onClick = ::refresh, enabled = isConnected && !refreshing) {
              Icon(Icons.Default.Refresh, contentDescription = if (refreshing) nativeString("Refreshing") else nativeString("Refresh"), tint = ClawTheme.colors.textMuted)
            }
          }
        }
        item(key = "model-defaults") {
          ModelDefaultsPanel(
            controller = settingsController,
            state = settingsState,
            models = models,
            decisionModels = decisionModels,
            automaticUtilityModel = automaticUtilityModel,
            authProviders = providers,
            selectionRestricted = selectionRestricted,
            policyDefaultModel = policyDefaultModel,
            canEdit = canEditSettings,
            connected = isConnected,
          )
        }
        if (installedAgentsAvailable) {
          item(key = "installed-agents") {
            InstalledAgentsPanel(
              agents = installedAgentsState.summary,
              loading = installedAgentsState.refreshing || settingsState.loading,
              errorText = installedAgentsState.errorText,
              canRefresh = isConnected,
              canEdit = canEditSettings && settingsController != null,
              saving = settingsState.saving,
              nativeAgentFlags = settingsState.nativeAgentFlags,
              models = models,
              outcomes = outcomes,
              pendingProviders = pendingProviders,
              readOnlyReason = if (!canEditSettings) nativeText("Browsing only. Changes require administrator access.") else null,
              onRefresh = {
                viewModel.refreshInstalledAgents()
                viewModel.refreshProviderModels(refresh = true)
              },
              onEnabledChange = { id, enabled -> settingsController?.setInstalledAgentEnabled(id, enabled) },
            )
          }
        }
        item(key = "provider-access") {
          Text(nativeString("Provider access"), style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(nativeString("Connections for \$agent. Global defaults above apply to all agents.", agentLabel), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        }
        item(key = "search") {
          ClawTextField(value = query, onValueChange = { query = it }, placeholder = nativeString("Search providers or models"), modifier = Modifier.semantics { contentDescription = nativeString("Search providers or models") }, maxLines = 1)
        }
        item(key = "summary") {
          Text(
            if (rows.size == 1 && modelCount == 1) {
              nativeString("1 provider · 1 model")
            } else if (modelCount == 1) {
              nativeString("\$count providers · 1 model", rows.size)
            } else {
              nativeString("\$count providers · \$models models", rows.size, modelCount)
            },
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        when {
          !isConnected && rows.isEmpty() -> {
            item { ClawEmptyState(title = nativeString("Gateway offline"), body = nativeString("Connect your Gateway to load provider readiness.")) }
          }

          searching && visibleRows.isEmpty() -> {
            item { Text(nativeString("No providers or models match \"\$query\"", query), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) }
          }

          rows.isEmpty() -> {
            item { Text(if (refreshing) nativeString("Loading providers…") else nativeString("No providers connected"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) }
          }

          else -> {
            items(visibleRows, key = { "provider:${it.id}" }) { row ->
              val authProviderId = row.auth?.authProviderId ?: row.id
              val usage = usageState.summary?.providers?.firstOrNull { it.providerId == authProviderId || it.providerId == row.id } ?: row.auth?.usage
              ProviderModelsCard(
                row = row,
                capability = capabilities.firstOrNull { it.id == authProviderId },
                agentLabel = agentLabel,
                usage = usage,
                usageLoading = usageState.refreshing || usageState.summary?.refreshing == true,
                spend = spendState.summary?.get(row.id) ?: spendState.summary?.get(authProviderId),
                catalogStatus = providerCatalogStatus(outcomes.filter { it.provider == row.id || it.provider == authProviderId }),
                checkingModels = row.id in pendingProviders || authProviderId in pendingProviders,
                tagsDescribeDefaults = tagsDescribeDefaults,
                expanded = searching || row.id in expandedProviders,
                expandedMore = row.id in expandedMore,
                searching = searching,
                enabled = isConnected && signIn == null && actionState?.busy != true,
                actionState = actionState?.takeIf { it.actionProviderId == row.id },
                onToggle = { expandedProviders = if (row.id in expandedProviders) expandedProviders - row.id else expandedProviders + row.id },
                onToggleMore = { expandedMore = if (row.id in expandedMore) expandedMore - row.id else expandedMore + row.id },
                onConnect = { openConnection(authProviderId) },
                onSetApiKey = { openConnection(authProviderId, apiKey = true) },
                onProbe = { beginAction(row, remove = false) },
                onRemoveKey = { beginAction(row, remove = true) },
              )
            }
          }
        }
        if (!searching) {
          item(key = "add-provider") {
            TextButton(onClick = { openConnection(null) }, enabled = isConnected, modifier = Modifier.fillMaxWidth()) {
              Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
              Text(nativeString("Add provider"), modifier = Modifier.padding(start = ClawTheme.spacing.xxs))
            }
          }
        }
        val errors = listOfNotNull(errorText, usageState.errorText?.resolveNativeText(), spendState.errorText?.resolveNativeText())
        if (errors.isNotEmpty()) {
          item(key = "error") { ClawPanel { Text(errors.joinToString("\n"), style = ClawTheme.type.body, color = ClawTheme.colors.warning) } }
        }
      }
      SnackbarHost(snackbar, modifier = Modifier.align(Alignment.BottomCenter))
    }
  }
}

private data class ProviderKeyRemoval(
  val provider: ProviderRow,
  val controller: ProviderAuthController,
  val agentLabel: String,
)

internal data class ProviderRow(
  val id: String,
  val name: String,
  val status: String,
  val availability: ProviderAvailability,
  val modelCount: Int,
  val models: List<GatewayModelSummary> = emptyList(),
  val auth: GatewayModelProviderSummary? = null,
) {
  val ready: Boolean
    get() = availability == ProviderAvailability.Available

  val renewalFailed: Boolean
    get() = auth?.renewalFailed == true && !ready
}

internal enum class ProviderAvailability {
  Available,
  Unavailable,
  Unknown,
}

/** Combines gateway auth-provider readiness with configured model providers. */
internal fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
  additionalProviders: Map<String, String> = emptyMap(),
): List<ProviderRow> {
  val providersById = providers.associateBy { it.id.normalizedProviderId() }
  val modelsByProvider =
    models
      .groupBy { it.provider.normalizedProviderId() }
      .mapValues { (_, providerModels) -> providerModels.sortedWith(modelComparator) }
  val providerIds = providersById.keys + modelsByProvider.keys + additionalProviders.keys.map { it.normalizedProviderId() }
  return providerIds
    .map { providerId ->
      val providerModels = modelsByProvider[providerId].orEmpty()
      val authProvider = providersById[providerId]
      val availability = providerAvailability(authProvider = authProvider, models = providerModels)
      val displayId = providerModels.firstOrNull()?.provider?.takeIf { it.isNotBlank() } ?: authProvider?.id ?: additionalProviders.keys.firstOrNull { it.normalizedProviderId() == providerId } ?: providerId
      ProviderRow(
        id = displayId,
        name = authProvider?.displayName ?: additionalProviders[displayId] ?: providerDisplayName(displayId),
        status = availability.label,
        availability = availability,
        modelCount = providerModels.size,
        models = providerModels,
        auth = authProvider,
      )
    }.sortedBy { it.name.lowercase() }
}

private val ProviderAvailability.label: String
  get() =
    when (this) {
      ProviderAvailability.Available -> nativeString("Ready")
      ProviderAvailability.Unavailable -> nativeString("Needs attention")
      ProviderAvailability.Unknown -> nativeString("Unknown")
    }

private fun providerAvailability(
  authProvider: GatewayModelProviderSummary?,
  models: List<GatewayModelSummary>,
): ProviderAvailability {
  if (models.any { it.available == true }) return ProviderAvailability.Available
  if (authProvider?.renewalFailed == true) return ProviderAvailability.Unavailable
  if (models.isNotEmpty()) {
    return if (models.all { it.available == false }) ProviderAvailability.Unavailable else ProviderAvailability.Unknown
  }
  return if (authProvider != null && modelProviderReady(authProvider.status)) {
    ProviderAvailability.Available
  } else {
    ProviderAvailability.Unavailable
  }
}

private fun String.normalizedProviderId(): String = trim().lowercase()

/** Normalizes gateway provider status strings into a ready/not-ready boolean. */
internal fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" ||
    normalized == "ready" ||
    normalized == "healthy" ||
    normalized == "configured" ||
    normalized == "static"
}

private val modelComparator =
  compareBy<GatewayModelSummary>(
    {
      if ("default" in it.tags) {
        0
      } else if (it.tags.any { tag -> tag.startsWith("fallback#") }) {
        1
      } else {
        2
      }
    },
    { it.name.lowercase() },
    { it.id.lowercase() },
  )
