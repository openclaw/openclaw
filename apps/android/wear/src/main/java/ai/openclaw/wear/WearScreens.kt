package ai.openclaw.wear

import ai.openclaw.wear.shared.WearAgentSummary
import ai.openclaw.wear.shared.WearChatMessage
import ai.openclaw.wear.shared.WearChatRole
import ai.openclaw.wear.shared.WearConversationSnapshot
import ai.openclaw.wear.shared.WearGatewayState
import ai.openclaw.wear.shared.WearSessionSummary
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.HorizontalPagerScaffold
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text

private const val PAGE_COUNT = 4
private const val CHAT_PAGE = 0
private const val AGENTS_PAGE = 1
private const val SESSIONS_PAGE = 2

@Composable
internal fun OpenClawWearScreens(
  snapshot: WearConversationSnapshot?,
  failure: WearConversationFailure?,
  loading: Boolean,
  interaction: WearInteractionState,
  speaking: Boolean,
  actionBusy: Boolean,
  themeMode: WearThemeMode,
  autoSpeak: Boolean,
  onTalk: () -> Unit,
  onType: () -> Unit,
  onSelectSession: (String) -> Unit,
  onRefresh: () -> Unit,
  onThemeModeChange: (WearThemeMode) -> Unit,
  onAutoSpeakChange: (Boolean) -> Unit,
  onSpeakLatest: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  if (snapshot == null) {
    ConnectionStateScreen(
      loading = loading,
      failure = failure,
      onRefresh = onRefresh,
    )
    return
  }

  val colors = OpenClawWearTheme.colors
  val pagerState = rememberPagerState(pageCount = { PAGE_COUNT })
  HorizontalPagerScaffold(
    pagerState = pagerState,
    modifier =
      Modifier
        .fillMaxSize()
        .background(colors.canvas),
  ) {
    HorizontalPager(
      state = pagerState,
      modifier = Modifier.fillMaxSize(),
      rotaryScrollableBehavior = null,
    ) { page ->
      when (page) {
        CHAT_PAGE ->
          ChatPage(
            snapshot = snapshot,
            interaction = interaction,
            speaking = speaking,
            actionBusy = actionBusy,
            onTalk = onTalk,
            onType = onType,
            onSpeakLatest = onSpeakLatest,
            onStopSpeaking = onStopSpeaking,
          )
        AGENTS_PAGE ->
          AgentsPage(
            agents = snapshot.agents,
          )
        SESSIONS_PAGE ->
          SessionsPage(
            sessions = snapshot.sessions,
            actionBusy = actionBusy,
            onSelectSession = onSelectSession,
          )
        else ->
          ControlsPage(
            snapshot = snapshot,
            themeMode = themeMode,
            autoSpeak = autoSpeak,
            actionBusy = actionBusy,
            onThemeModeChange = onThemeModeChange,
            onAutoSpeakChange = onAutoSpeakChange,
            onRefresh = onRefresh,
          )
      }
    }
  }
}

@Composable
private fun ChatPage(
  snapshot: WearConversationSnapshot,
  interaction: WearInteractionState,
  speaking: Boolean,
  actionBusy: Boolean,
  onTalk: () -> Unit,
  onType: () -> Unit,
  onSpeakLatest: () -> Unit,
  onStopSpeaking: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  WearPage(pageLabel = stringResource(R.string.chat)) {
    item {
      ConversationIdentity(snapshot = snapshot)
    }
    item {
      ConversationStatus(
        interaction = interaction,
        speaking = speaking,
        gatewayConnected = snapshot.gatewayState == WearGatewayState.CONNECTED,
      )
    }
    item {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        ActionButton(
          label = stringResource(R.string.talk),
          enabled = !actionBusy && !speaking,
          onClick = onTalk,
          modifier = Modifier.weight(1f),
        )
        ActionButton(
          label = stringResource(R.string.type),
          enabled = !actionBusy && !speaking,
          onClick = onType,
          modifier = Modifier.weight(1f),
        )
      }
    }
    if (snapshot.messages.isEmpty() && snapshot.streamingAssistantText.isNullOrBlank()) {
      item {
        EmptyConversation()
      }
    } else {
      snapshot.messages
        .takeLast(VISIBLE_MESSAGE_COUNT)
        .forEach { message ->
          item(key = message.id) {
            MessageBubble(message = message)
          }
        }
      snapshot.streamingAssistantText
        ?.takeIf(String::isNotBlank)
        ?.let { streaming ->
          item {
            StreamingBubble(text = streaming)
          }
        }
    }
    if (snapshot.messages.any { message -> message.role == WearChatRole.ASSISTANT }) {
      item {
        SecondaryButton(
          label =
            if (speaking) {
              stringResource(R.string.stop_speaking)
            } else {
              stringResource(R.string.speak_reply)
            },
          enabled = !actionBusy || speaking,
          onClick = if (speaking) onStopSpeaking else onSpeakLatest,
        )
      }
    }
    snapshot.errorText
      ?.takeIf(String::isNotBlank)
      ?.let { error ->
        item {
          InlineError(text = error)
        }
      }
  }
}

@Composable
private fun AgentsPage(
  agents: List<WearAgentSummary>,
) {
  WearPage(pageLabel = stringResource(R.string.agents)) {
    if (agents.isEmpty()) {
      item {
        EmptyPanel(
          title = stringResource(R.string.no_agents),
          detail = stringResource(R.string.no_agents_detail),
        )
      }
    } else {
      agents.forEach { agent ->
        item(key = agent.id) {
          SelectionButton(
            title =
              listOfNotNull(
                agent.emoji?.takeIf(String::isNotBlank),
                agent.name,
              ).joinToString(" "),
            detail =
              if (agent.selected) {
                stringResource(R.string.active_agent)
              } else {
                stringResource(R.string.available_agent)
              },
            selected = agent.selected,
            enabled = false,
            onClick = {},
          )
        }
      }
    }
  }
}

@Composable
private fun SessionsPage(
  sessions: List<WearSessionSummary>,
  actionBusy: Boolean,
  onSelectSession: (String) -> Unit,
) {
  WearPage(pageLabel = stringResource(R.string.sessions)) {
    if (sessions.isEmpty()) {
      item {
        EmptyPanel(
          title = stringResource(R.string.no_sessions),
          detail = stringResource(R.string.no_sessions_detail),
        )
      }
    } else {
      sessions.forEach { session ->
        item(key = session.id) {
          SelectionButton(
            title = session.title,
            detail =
              if (session.selected) {
                stringResource(R.string.current_session)
              } else {
                stringResource(R.string.open_session)
              },
            selected = session.selected,
            enabled = !actionBusy && !session.selected,
            onClick = { onSelectSession(session.id) },
          )
        }
      }
    }
  }
}

@Composable
private fun ControlsPage(
  snapshot: WearConversationSnapshot,
  themeMode: WearThemeMode,
  autoSpeak: Boolean,
  actionBusy: Boolean,
  onThemeModeChange: (WearThemeMode) -> Unit,
  onAutoSpeakChange: (Boolean) -> Unit,
  onRefresh: () -> Unit,
) {
  WearPage(pageLabel = stringResource(R.string.controls)) {
    item {
      ConnectionPanel(snapshot = snapshot)
    }
    item {
      ThemeModeSelector(
        themeMode = themeMode,
        onThemeModeChange = onThemeModeChange,
      )
    }
    item {
      SelectionButton(
        title = stringResource(R.string.auto_speak),
        detail =
          if (autoSpeak) {
            stringResource(R.string.on)
          } else {
            stringResource(R.string.off)
          },
        selected = autoSpeak,
        enabled = !actionBusy,
        onClick = { onAutoSpeakChange(!autoSpeak) },
      )
    }
    item {
      PhoneBoundaryPanel()
    }
    item {
      SecondaryButton(
        label = stringResource(R.string.refresh),
        enabled = !actionBusy,
        onClick = onRefresh,
      )
    }
  }
}

@Composable
private fun ConnectionStateScreen(
  loading: Boolean,
  failure: WearConversationFailure?,
  onRefresh: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val listState = rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    TransformingLazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .background(colors.canvas),
      state = listState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        OpenClawHeader(pageLabel = stringResource(R.string.chat))
      }
      item {
        EmptyPanel(
          title =
            if (loading) {
              stringResource(R.string.checking_phone)
            } else {
              failureTitle(failure)
            },
          detail =
            if (loading) {
              stringResource(R.string.reading_conversation)
            } else {
              failureDetail(failure)
            },
        )
      }
      item {
        SecondaryButton(
          label = stringResource(R.string.retry),
          enabled = !loading,
          onClick = onRefresh,
        )
      }
    }
  }
}

@Composable
private fun WearPage(
  pageLabel: String,
  content: androidx.wear.compose.foundation.lazy.TransformingLazyColumnScope.() -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val listState = rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    TransformingLazyColumn(
      modifier =
        Modifier
          .fillMaxSize()
          .background(colors.canvas),
      state = listState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item {
        OpenClawHeader(pageLabel = pageLabel)
      }
      content()
    }
  }
}

@Composable
private fun OpenClawHeader(pageLabel: String) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 18.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = stringResource(R.string.app_name).uppercase(),
      color = colors.text,
      fontSize = 16.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.4.sp,
      textAlign = TextAlign.Center,
      maxLines = 1,
    )
    Text(
      text = pageLabel.uppercase(),
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      letterSpacing = 1.4.sp,
      textAlign = TextAlign.Center,
    )
  }
}

@Composable
private fun ConversationIdentity(snapshot: WearConversationSnapshot) {
  val agent =
    snapshot.agents.firstOrNull(WearAgentSummary::selected)
      ?: snapshot.agents.firstOrNull()
  val session =
    snapshot.sessions.firstOrNull(WearSessionSummary::selected)
      ?: snapshot.sessions.firstOrNull()
  Panel {
    Text(
      text =
        listOfNotNull(
          agent?.emoji?.takeIf(String::isNotBlank),
          agent?.name ?: stringResource(R.string.agent),
        ).joinToString(" "),
      color = OpenClawWearTheme.colors.text,
      fontSize = 18.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    Spacer(modifier = Modifier.height(2.dp))
    Text(
      text = session?.title ?: stringResource(R.string.current_session),
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 12.sp,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
    snapshot.selectedModelRef
      ?.takeIf(String::isNotBlank)
      ?.let { model ->
        Text(
          text = model,
          color = OpenClawWearTheme.colors.textMuted,
          fontSize = 10.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
  }
}

@Composable
private fun ConversationStatus(
  interaction: WearInteractionState,
  speaking: Boolean,
  gatewayConnected: Boolean,
) {
  val colors = OpenClawWearTheme.colors
  val (label, color) =
    when {
      speaking -> stringResource(R.string.speaking) to colors.success
      interaction == WearInteractionState.LISTENING ->
        stringResource(R.string.listening) to colors.danger
      interaction == WearInteractionState.TYPING ->
        stringResource(R.string.typing) to colors.warning
      interaction == WearInteractionState.SENDING ->
        stringResource(R.string.sending) to colors.warning
      interaction == WearInteractionState.AGENT_WORKING ->
        stringResource(R.string.agent_working) to colors.warning
      interaction == WearInteractionState.ERROR ->
        stringResource(R.string.error) to colors.danger
      gatewayConnected -> stringResource(R.string.ready) to colors.success
      else -> stringResource(R.string.gateway_offline) to colors.danger
    }
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .background(colors.surface, RoundedCornerShape(12.dp))
        .border(1.dp, colors.border, RoundedCornerShape(12.dp))
        .padding(horizontal = 12.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      modifier =
        Modifier
          .size(8.dp)
          .background(color, CircleShape),
    )
    Spacer(modifier = Modifier.size(7.dp))
    Text(
      text = label,
      color = colors.text,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
    )
  }
}

@Composable
private fun MessageBubble(message: WearChatMessage) {
  val colors = OpenClawWearTheme.colors
  val isUser = message.role == WearChatRole.USER
  val background =
    when (message.role) {
      WearChatRole.USER -> colors.primary
      WearChatRole.ASSISTANT -> colors.surfaceRaised
      WearChatRole.SYSTEM -> colors.surface
    }
  val foreground = if (isUser) colors.primaryText else colors.text
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(
          start = if (isUser) 28.dp else 12.dp,
          end = if (isUser) 12.dp else 28.dp,
        ).background(background, RoundedCornerShape(14.dp))
        .then(
          if (isUser) {
            Modifier
          } else {
            Modifier.border(1.dp, colors.border, RoundedCornerShape(14.dp))
          },
        ).padding(horizontal = 12.dp, vertical = 9.dp),
  ) {
    Text(
      text =
        when (message.role) {
          WearChatRole.USER -> stringResource(R.string.you)
          WearChatRole.ASSISTANT -> stringResource(R.string.agent)
          WearChatRole.SYSTEM -> stringResource(R.string.system)
        }.uppercase(),
      color = if (isUser) foreground.copy(alpha = 0.72f) else colors.textMuted,
      fontSize = 9.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Text(
      text = message.text,
      color = foreground,
      fontSize = 13.sp,
      lineHeight = 17.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun StreamingBubble(text: String) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .background(colors.surfaceRaised, RoundedCornerShape(14.dp))
        .border(1.dp, colors.warning, RoundedCornerShape(14.dp))
        .padding(horizontal = 12.dp, vertical = 9.dp),
  ) {
    Text(
      text = stringResource(R.string.agent_working).uppercase(),
      color = colors.warning,
      fontSize = 9.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Text(
      text = text,
      color = colors.text,
      fontSize = 13.sp,
      lineHeight = 17.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun EmptyConversation() {
  EmptyPanel(
    title = stringResource(R.string.start_conversation),
    detail = stringResource(R.string.start_conversation_detail),
  )
}

@Composable
private fun ConnectionPanel(snapshot: WearConversationSnapshot) {
  val connected = snapshot.gatewayState == WearGatewayState.CONNECTED
  val colors = OpenClawWearTheme.colors
  Panel {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .background(
              if (connected) colors.success else colors.danger,
              CircleShape,
            ),
      )
      Spacer(modifier = Modifier.size(7.dp))
      Text(
        text = stringResource(R.string.connection).uppercase(),
        color = colors.textMuted,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.8.sp,
      )
    }
    Spacer(modifier = Modifier.height(5.dp))
    Text(
      text =
        if (connected) {
          stringResource(R.string.gateway_connected)
        } else {
          stringResource(R.string.gateway_offline)
        },
      color = colors.text,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
    )
    Text(
      text = stringResource(R.string.phone_ready),
      color = colors.textMuted,
      fontSize = 12.sp,
    )
  }
}

@Composable
private fun PhoneBoundaryPanel() {
  Panel {
    Text(
      text = stringResource(R.string.security_boundary).uppercase(),
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 0.8.sp,
    )
    Spacer(modifier = Modifier.height(5.dp))
    Text(
      text = stringResource(R.string.phone_controlled),
      color = OpenClawWearTheme.colors.text,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
    )
    Text(
      text = stringResource(R.string.phone_controlled_detail),
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 12.sp,
      lineHeight = 16.sp,
    )
  }
}

@Composable
private fun ThemeModeSelector(
  themeMode: WearThemeMode,
  onThemeModeChange: (WearThemeMode) -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  val shape = RoundedCornerShape(12.dp)
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
  ) {
    Text(
      text = stringResource(R.string.appearance).uppercase(),
      color = colors.textMuted,
      fontSize = 10.sp,
      fontWeight = FontWeight.SemiBold,
      letterSpacing = 1.sp,
      modifier = Modifier.padding(start = 4.dp, bottom = 4.dp),
    )
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .background(colors.surface, shape)
          .border(width = 1.dp, color = colors.border, shape = shape)
          .padding(3.dp),
    ) {
      ThemeModeOption(
        label = stringResource(R.string.theme_dark),
        selected = themeMode == WearThemeMode.Dark,
        colors = colors,
        onClick = { onThemeModeChange(WearThemeMode.Dark) },
        modifier = Modifier.weight(1f),
      )
      ThemeModeOption(
        label = stringResource(R.string.theme_light),
        selected = themeMode == WearThemeMode.Light,
        colors = colors,
        onClick = { onThemeModeChange(WearThemeMode.Light) },
        modifier = Modifier.weight(1f),
      )
    }
  }
}

@Composable
private fun ThemeModeOption(
  label: String,
  selected: Boolean,
  colors: WearColors,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Box(
    modifier =
      modifier
        .height(40.dp)
        .background(
          color = if (selected) colors.primary else Color.Transparent,
          shape = RoundedCornerShape(9.dp),
        ).selectable(
          selected = selected,
          onClick = onClick,
          role = Role.RadioButton,
        ),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      color = if (selected) colors.primaryText else colors.textMuted,
      fontSize = 12.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      modifier = Modifier.padding(horizontal = 8.dp),
    )
  }
}

@Composable
private fun SelectionButton(
  title: String,
  detail: String,
  selected: Boolean,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  Button(
    onClick = onClick,
    enabled = enabled,
    colors =
      ButtonDefaults.buttonColors(
        containerColor = if (selected) colors.primary else colors.surfaceRaised,
        contentColor = if (selected) colors.primaryText else colors.text,
        disabledContainerColor =
          if (selected) colors.primary else colors.surfaceRaised,
        disabledContentColor =
          if (selected) colors.primaryText else colors.textMuted,
      ),
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
    label = {
      Column(modifier = Modifier.fillMaxWidth()) {
        Text(
          text = title,
          fontSize = 14.sp,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = detail,
          fontSize = 10.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    },
  )
}

@Composable
private fun ActionButton(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val colors = OpenClawWearTheme.colors
  Button(
    onClick = onClick,
    enabled = enabled,
    colors =
      ButtonDefaults.buttonColors(
        containerColor = colors.primary,
        contentColor = colors.primaryText,
      ),
    modifier = modifier,
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        fontWeight = FontWeight.SemiBold,
        textAlign = TextAlign.Center,
      )
    },
  )
}

@Composable
private fun SecondaryButton(
  label: String,
  enabled: Boolean,
  onClick: () -> Unit,
) {
  val colors = OpenClawWearTheme.colors
  Button(
    onClick = onClick,
    enabled = enabled,
    colors =
      ButtonDefaults.buttonColors(
        containerColor = colors.surfaceRaised,
        contentColor = colors.text,
      ),
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
      )
    },
  )
}

@Composable
private fun EmptyPanel(
  title: String,
  detail: String,
) {
  Panel {
    Text(
      text = title,
      color = OpenClawWearTheme.colors.text,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
    Spacer(modifier = Modifier.height(3.dp))
    Text(
      text = detail,
      color = OpenClawWearTheme.colors.textMuted,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      textAlign = TextAlign.Center,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun InlineError(text: String) {
  val colors = OpenClawWearTheme.colors
  Text(
    text = text,
    color = colors.danger,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    textAlign = TextAlign.Center,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 18.dp),
    maxLines = 4,
    overflow = TextOverflow.Ellipsis,
  )
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
  val colors = OpenClawWearTheme.colors
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp)
        .background(colors.surfaceRaised, RoundedCornerShape(12.dp))
        .border(
          width = 1.dp,
          color = colors.border,
          shape = RoundedCornerShape(12.dp),
        ).padding(horizontal = 14.dp, vertical = 12.dp),
    content = content,
  )
}

@Composable
private fun failureTitle(failure: WearConversationFailure?): String =
  when (failure) {
    WearConversationFailure.PHONE_UNAVAILABLE ->
      stringResource(R.string.phone_unavailable)
    WearConversationFailure.PHONE_NOT_READY ->
      stringResource(R.string.open_phone_app)
    WearConversationFailure.GATEWAY_OFFLINE ->
      stringResource(R.string.gateway_offline)
    WearConversationFailure.NOT_FOUND ->
      stringResource(R.string.selection_not_found)
    WearConversationFailure.ACTION_REJECTED ->
      stringResource(R.string.message_not_sent)
    WearConversationFailure.INCOMPATIBLE ->
      stringResource(R.string.update_required)
    WearConversationFailure.INTERNAL_ERROR,
    null,
    -> stringResource(R.string.something_went_wrong)
  }

@Composable
private fun failureDetail(failure: WearConversationFailure?): String =
  when (failure) {
    WearConversationFailure.PHONE_UNAVAILABLE ->
      stringResource(R.string.phone_unavailable_detail)
    WearConversationFailure.PHONE_NOT_READY ->
      stringResource(R.string.phone_not_ready_detail)
    WearConversationFailure.GATEWAY_OFFLINE ->
      stringResource(R.string.gateway_offline_detail)
    WearConversationFailure.NOT_FOUND ->
      stringResource(R.string.refresh_and_try_again)
    WearConversationFailure.ACTION_REJECTED ->
      stringResource(R.string.try_again)
    WearConversationFailure.INCOMPATIBLE ->
      stringResource(R.string.update_required_detail)
    WearConversationFailure.INTERNAL_ERROR,
    null,
    -> stringResource(R.string.try_again)
  }

private const val VISIBLE_MESSAGE_COUNT = 8
