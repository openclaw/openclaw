package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatCompactionStatus
import ai.openclaw.app.chat.ChatFallbackStatus
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatModelCatalogEntry
import ai.openclaw.app.chat.ChatSessionDefaults
import ai.openclaw.app.chat.ChatSessionEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

class ChatSheetContentTest {
  @Test
  fun resolvesPendingAssistantAutoSendOnlyWhenChatIsReady() {
    assertNull(
      resolvePendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = false,
        pendingRunCount = 0,
      ),
    )
    assertNull(
      resolvePendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = true,
        pendingRunCount = 1,
      ),
    )
    assertEquals(
      "summarize mail",
      resolvePendingAssistantAutoSend(
        pendingPrompt = "  summarize mail  ",
        healthOk = true,
        pendingRunCount = 0,
      ),
    )
  }

  @Test
  fun keepsPendingAssistantAutoSendWhenDispatchRejected() = runBlocking {
    var dispatchedPrompt: String? = null

    val consumed =
      dispatchPendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = true,
        pendingRunCount = 0,
      ) { prompt ->
        dispatchedPrompt = prompt
        false
      }

    assertFalse(consumed)
    assertEquals("summarize mail", dispatchedPrompt)
  }

  @Test
  fun clearsPendingAssistantAutoSendOnlyAfterAcceptedDispatch() = runBlocking {
    var dispatchedPrompt: String? = null

    val consumed =
      dispatchPendingAssistantAutoSend(
        pendingPrompt = "summarize mail",
        healthOk = true,
        pendingRunCount = 0,
      ) { prompt ->
        dispatchedPrompt = prompt
        true
      }

    assertTrue(consumed)
    assertEquals("summarize mail", dispatchedPrompt)
  }

  @Test
  fun computesContextNoticeOnlyNearLimit() {
    assertNull(
      computeContextUsageNotice(
        ChatSessionEntry(key = "main", updatedAtMs = null, contextTokens = 100_000, totalTokens = 80_000, totalTokensFresh = true),
      ),
    )

    val warning =
      computeContextUsageNotice(
        ChatSessionEntry(key = "main", updatedAtMs = null, contextTokens = 100_000, totalTokens = 90_000, totalTokensFresh = true),
      )
    assertEquals(90, warning?.percentUsed)
    assertEquals(ContextUsageNotice.Severity.Warning, warning?.severity)

    val danger =
      computeContextUsageNotice(
        ChatSessionEntry(key = "main", updatedAtMs = null, contextTokens = 100_000, totalTokens = 97_000, totalTokensFresh = true),
      )
    assertEquals(ContextUsageNotice.Severity.Danger, danger?.severity)
  }

  @Test
  fun buildsCompactionAndFallbackStatusNotices() {
    val notices =
      buildChatStatusNotices(
        compactionStatus = ChatCompactionStatus(ChatCompactionStatus.Phase.Complete, runId = "run-1", completedAtMs = 123L),
        fallbackStatus =
          ChatFallbackStatus(
            phase = ChatFallbackStatus.Phase.Active,
            selectedModel = "openai/gpt-5",
            activeModel = "openai/gpt-5-mini",
            reason = "rate limited",
            attempts = listOf("openai/gpt-5: HTTP 429"),
            occurredAtMs = 123L,
          ),
      )

    assertEquals(2, notices.size)
    assertTrue(notices.any { it.detail.contains("Context compacted") })
    assertTrue(notices.any { it.detail.contains("Fallback active") })
  }

  @Test
  fun filtersThinkingAndToolBlocksFromCollapsedUi() {
    val message =
      ChatMessage(
        id = "assistant-1",
        role = "assistant",
        content =
          listOf(
            ChatMessageContent(type = "thinking", thinking = "secret chain"),
            ChatMessageContent(type = "toolcall", toolName = "read", toolArgumentsJson = "{}"),
            ChatMessageContent(type = "text", text = "done"),
          ),
        timestampMs = 1000L,
      )

    assertTrue(
      shouldDisplayMessage(
        message,
        ChatMessageUiState(showReasoning = false, showToolDetails = false),
      ),
    )
    assertFalse(
      shouldDisplayMessage(
        message.copy(content = listOf(ChatMessageContent(type = "thinking", thinking = "secret chain"))),
        ChatMessageUiState(showReasoning = false, showToolDetails = true),
      ),
    )
  }

  @Test
  fun hidesToolRoleMessagesWhenToolDetailsDisabled() {
    val toolMessage =
      ChatMessage(
        id = "tool-1",
        role = "toolResult",
        toolName = "read",
        content = listOf(ChatMessageContent(type = "text", text = "file contents")),
        timestampMs = 1000L,
      )

    assertFalse(
      shouldDisplayMessage(
        toolMessage,
        ChatMessageUiState(showReasoning = false, showToolDetails = false),
      ),
    )

    assertTrue(
      shouldDisplayMessage(
        toolMessage,
        ChatMessageUiState(showReasoning = false, showToolDetails = true),
      ),
    )
  }

  @Test
  fun resolvesMessageMetaFromSourceAndTool() {
    val meta =
      resolveChatMessageMeta(
        ChatMessage(
          id = "tool-msg",
          role = "toolResult",
          sourceId = "srv-22",
          toolName = "read",
          content = listOf(ChatMessageContent(type = "toolresult", text = "ok")),
          timestampMs = 1_700_000_000_000,
        ),
      )

    assertEquals("Tool result", meta.roleLabel)
    assertEquals("srv-22", meta.sourceIdLabel)
    assertEquals("read", meta.toolLabel)
    assertTrue(meta.technical)
  }

  @Test
  fun hidesTechnicalSubagentMessagesWhenToolDetailsDisabled() {
    val technical =
      ChatMessage(
        id = "assistant-subagent-1",
        role = "assistant",
        sourceId = "agent:main:subagent:abc",
        senderLabel = "Subagent: config-check",
        content = listOf(ChatMessageContent(type = "text", text = "Subagent completed successfully")),
        timestampMs = 1000L,
      )

    assertFalse(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = false),
      ),
    )

    assertTrue(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = true),
      ),
    )
  }

  @Test
  fun hidesSystemMessagesWhenToolDetailsDisabled() {
    val technical =
      ChatMessage(
        id = "system-1",
        role = "assistant",
        senderLabel = "System",
        content = listOf(ChatMessageContent(type = "text", text = "System: background task finished")),
        timestampMs = 1000L,
      )

    assertFalse(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = false),
      ),
    )

    assertTrue(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = true),
      ),
    )
  }

  @Test
  fun hidesUntrustedSystemMessagesWhenToolDetailsDisabled() {
    val technical =
      ChatMessage(
        id = "system-untrusted-1",
        role = "assistant",
        content = listOf(ChatMessageContent(type = "text", text = "System (untrusted): [2026-04-17] Exec completed")),
        timestampMs = 1000L,
      )

    assertFalse(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = false),
      ),
    )

    assertTrue(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = true),
      ),
    )
  }

  @Test
  fun hidesInternalContextMessagesWhenToolDetailsDisabled() {
    val technical =
      ChatMessage(
        id = "internal-context-1",
        role = "assistant",
        content = listOf(ChatMessageContent(type = "text", text = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> internal payload")),
        timestampMs = 1000L,
      )

    assertFalse(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = false),
      ),
    )

    assertTrue(
      shouldDisplayMessage(
        technical,
        ChatMessageUiState(showReasoning = false, showToolDetails = true),
      ),
    )
  }

  @Test
  fun togglesReasoningAndToolDetailsFlipUiState() {
    val initial = ChatMessageUiState(showReasoning = false, showToolDetails = false)

    val reasoningEnabled = toggleShowReasoning(initial)
    assertTrue(reasoningEnabled.showReasoning)
    assertFalse(reasoningEnabled.showToolDetails)

    val toolsEnabled = toggleShowToolDetails(reasoningEnabled)
    assertTrue(toolsEnabled.showReasoning)
    assertTrue(toolsEnabled.showToolDetails)
  }

  @Test
  fun normalizesAdaptiveThinkingAndBuildsDefaultLabel() {
    assertEquals("adaptive", normalizeThinkingLevelForUi("Adaptive"))
    assertEquals("Adaptive", thinkingLabel("adaptive"))

    val defaults = ChatSessionDefaults(model = "claude-sonnet-4.6", modelProvider = "anthropic")
    assertEquals(
      "Default (Adaptive)",
      thinkingDefaultLabel(activeSession = null, sessionDefaults = defaults, modelCatalog = emptyList()),
    )
  }

  @Test
  fun formatsCurrentModelLabelFromCatalog() {
    val catalog = listOf(ChatModelCatalogEntry(id = "gpt-5-mini", name = "GPT-5 Mini", provider = "openai", alias = "gpt-5-mini"))
    assertEquals("openai/gpt-5-mini", resolveCurrentModelValue(ChatSessionEntry(key = "main", updatedAtMs = null, model = "gpt-5-mini", modelProvider = "openai")))
    assertEquals("gpt-5-mini", formatModelLabel("openai/gpt-5-mini", catalog))
  }
}
