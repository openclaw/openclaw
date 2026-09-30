package ai.openclaw.wear

import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import androidx.annotation.StringRes

internal enum class WearGatewayState {
  CONNECTED,
  DISCONNECTED,
}

internal enum class WearChatRole {
  USER,
  ASSISTANT,
  SYSTEM,
}

internal val WearChatMessage.chatRole: WearChatRole
  get() =
    when (role.lowercase()) {
      "user" -> WearChatRole.USER
      "assistant" -> WearChatRole.ASSISTANT
      else -> WearChatRole.SYSTEM
    }

internal data class WearSessionSummary(
  val id: String,
  val title: String?,
  val activeOnPhone: Boolean = false,
  val openOnWatch: Boolean = false,
)

internal data class WearModelSummary(
  val ref: String,
  val name: String,
  val selected: Boolean,
)

internal data class WearConversationSnapshot(
  val gatewayState: WearGatewayState,
  val phoneNodeId: String? = null,
  val activeAgentId: String? = null,
  val replyTextSupported: Boolean = false,
  val agents: List<WearAgent> = emptyList(),
  val agentControlsSupported: Boolean = false,
  val gatewayControlsSupported: Boolean = false,
  val activeSessionId: String? = null,
  val activeSessionTitle: String? = null,
  val sessions: List<WearSessionSummary> = emptyList(),
  val sessionSearchQuery: String? = null,
  val sessionSearchResults: List<WearSessionSummary> = emptyList(),
  val sessionSearchHasMore: Boolean = false,
  val sessionSearchSupported: Boolean = false,
  val models: List<WearModelSummary> = emptyList(),
  val modelCatalogRefreshFailed: Boolean = false,
  val sessionModelCatalogSupported: Boolean = false,
  val modelSearchQuery: String? = null,
  val modelSearchResults: List<WearModelSummary> = emptyList(),
  val modelControlsSupported: Boolean = false,
  val modelSearchSupported: Boolean = false,
  val messages: List<WearChatMessage> = emptyList(),
  val streamingAssistantText: String? = null,
  val selectedModelRef: String? = null,
  val failure: WearConversationFailure? = null,
  val realtimeTalk: WearRealtimeTalkSnapshot = WearRealtimeTalkSnapshot(),
  val agentPulseSupported: Boolean = false,
  val agentPulse: WearAgentPulseSnapshot? = null,
  val agentPulseLoading: Boolean = false,
  val agentPulseFailure: WearConversationFailure? = null,
)

internal enum class WearConversationFailure(
  @StringRes val title: Int,
  @StringRes val detail: Int,
) {
  PHONE_UNAVAILABLE(R.string.phone_unavailable, R.string.phone_unavailable_detail),
  GATEWAY_OFFLINE(R.string.gateway_offline, R.string.gateway_offline_detail),
  NOT_FOUND(R.string.selection_not_found, R.string.refresh_and_try_again),
  ACTION_REJECTED(R.string.message_not_sent, R.string.try_again),
  INCOMPATIBLE(R.string.update_required, R.string.update_required_detail),
  INTERNAL_ERROR(R.string.something_went_wrong, R.string.try_again),
}

internal enum class WearInteractionState {
  READY,
  LISTENING,
  TYPING,
  SENDING,
  AGENT_WORKING,
  ERROR,
}

internal fun WearUiState.toConversationSnapshot(): WearConversationSnapshot? {
  if (phoneNodeId == null) return null
  val pulseSupported =
    connected &&
      WearProxyCapability.AgentPulse in proxyCapabilities

  fun sessionSummary(session: WearSession) =
    WearSessionSummary(
      id = session.key,
      title = session.title,
      activeOnPhone = session.key == phoneActiveSessionKey,
      openOnWatch = session.key == selectedSession?.key,
    )

  fun modelSummary(model: WearModel) =
    WearModelSummary(
      ref = model.ref,
      name = model.name,
      selected = model.ref == selectedModelRef,
    )

  return WearConversationSnapshot(
    phoneNodeId = phoneNodeId,
    activeAgentId = selectedSession?.agentId ?: activeAgentId,
    replyTextSupported = WearProxyCapability.ReplyText in proxyCapabilities,
    gatewayState = if (connected) WearGatewayState.CONNECTED else WearGatewayState.DISCONNECTED,
    agents = agents.map { agent -> agent.copy(selected = agent.id == activeAgentId) },
    agentControlsSupported = WearProxyCapability.AgentControls in proxyCapabilities,
    gatewayControlsSupported = WearProxyCapability.GatewayControls in proxyCapabilities,
    activeSessionId = selectedSession?.key,
    activeSessionTitle = selectedSession?.title,
    sessions = sessions.map(::sessionSummary),
    sessionSearchQuery = sessionSearchQuery,
    sessionSearchResults = sessionSearchResults.map(::sessionSummary),
    sessionSearchHasMore = sessionSearchHasMore,
    sessionSearchSupported = WearProxyCapability.SessionSearchPagination in proxyCapabilities,
    models = models.map(::modelSummary),
    modelControlsSupported = WearProxyCapability.ModelControls in proxyCapabilities,
    modelCatalogRefreshFailed = modelCatalogRefreshFailed,
    sessionModelCatalogSupported = WearProxyCapability.SessionScopedModelCatalog in proxyCapabilities,
    modelSearchSupported =
      WearProxyCapability.ModelCatalogSearch in proxyCapabilities &&
        WearProxyCapability.SessionScopedModelCatalog in proxyCapabilities,
    modelSearchQuery = modelSearchQuery,
    modelSearchResults = modelSearchResults.map(::modelSummary),
    messages = messages,
    streamingAssistantText = streamText,
    selectedModelRef = selectedModelRef,
    failure = conversationFailure,
    realtimeTalk = realtimeTalk,
    agentPulseSupported = pulseSupported,
    agentPulse = agentPulse.takeIf { pulseSupported },
    agentPulseLoading = pulseSupported && agentPulseLoading,
    agentPulseFailure = agentPulseFailure.takeIf { pulseSupported },
  )
}
