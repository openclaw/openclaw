package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatReaderScrollControllerTest {
  @Test
  fun initialHistoryRestoresLatestUserWithoutFollowingFinishedReply() {
    val timeline = timeline(user("user-1"), assistant("assistant-1"))

    val transition = initialChatReaderTransition(timeline)

    assertEquals(1, transition.scrollIndex)
    assertFalse(transition.animated)
    assertNull(transition.state.followTarget)
    assertEquals("user-1", transition.state.latestUserMessageId)
  }

  @Test
  fun contentAfterManualDeparturePreservesPositionAndOffersJump() {
    val before = initialChatReaderTransition(timeline(user("user-1"), assistant("assistant-1"))).state
    val readerMoved = before.onViewportChanged(index = 3, offset = 50, timeline = timeline(user("user-1")), targetTolerancePx = 24)

    val transition = readerMoved.onTimelineChanged(timeline(user("user-1"), assistant("assistant-2")))

    assertNull(transition.scrollIndex)
    assertTrue(transition.state.hasNewerContent)
  }

  @Test
  fun streamingKeepsNewUserPromptAnchoredAndOffersLatestJump() {
    val previous = initialChatReaderTransition(timeline(assistant("assistant-1"))).state
    val active = activeTimeline(user("user-1"), stream = null)

    val newTurn = previous.onTimelineChanged(active)
    val streamUpdate = newTurn.state.onTimelineChanged(activeTimeline(user("user-1"), stream = "reply"))

    assertEquals(active.scrollTargetIndex, newTurn.scrollIndex)
    assertTrue(newTurn.animated)
    assertEquals(activeTimeline(user("user-1"), stream = "reply").scrollTargetIndex, streamUpdate.scrollIndex)
    assertTrue(streamUpdate.state.hasNewerContent)
  }

  @Test
  fun firstUserTurnAfterAssistantOnlyHistoryBecomesReadAnchor() {
    val previous = initialChatReaderTransition(timeline(assistant("assistant-1"))).state
    val active = activeTimeline(user("user-1"), stream = null)

    val transition = previous.onTimelineChanged(active)

    assertEquals(active.scrollTargetIndex, transition.scrollIndex)
    assertEquals("user-1", transition.state.latestUserMessageId)
  }

  @Test
  fun liveEdgeClearsNewerContentAndJumpFollowsLatest() {
    val timeline = activeTimeline(user("user-1"), stream = "reply")
    val waiting = ChatReaderState(initialized = true, hasNewerContent = true, latestUserMessageId = "user-1")

    val atLiveEdge = waiting.onViewportChanged(index = 0, offset = 20, timeline = timeline, targetTolerancePx = 24)
    val jump = waiting.jumpToLatest(timeline)

    assertFalse(atLiveEdge.hasNewerContent)
    assertEquals(0, jump.scrollIndex)
    assertTrue(jump.animated)
    assertFalse(jump.state.hasNewerContent)
  }

  @Test
  fun manuallyCrossingReadAnchorDoesNotResumeFollowing() {
    val timeline = activeTimeline(user("user-1"), stream = "reply")
    val following =
      ChatReaderState(
        initialized = true,
        followTarget = ChatScrollFollowTarget.ReadAnchor,
        hasNewerContent = true,
        latestUserMessageId = "user-1",
      )

    val moved =
      following.onViewportChanged(
        index = checkNotNull(timeline.scrollTargetIndex),
        offset = 0,
        timeline = timeline,
        targetTolerancePx = 24,
      )

    assertNull(moved.followTarget)
    assertTrue(moved.hasNewerContent)
  }

  @Test
  fun stateStartsFreshForEachSession() {
    val oldSession = ChatReaderState(initialized = true, hasNewerContent = true, latestUserMessageId = "old")

    val nextSession = initialChatReaderTransition(timeline(user("new")))

    assertTrue(oldSession.hasNewerContent)
    assertFalse(nextSession.state.hasNewerContent)
    assertEquals("new", nextSession.state.latestUserMessageId)
  }

  @Test
  fun emptyTimelineCanResetReaderStateBeforeSameSessionReload() {
    val previous = ChatReaderState(initialized = true, hasNewerContent = true, latestUserMessageId = "old")

    val reset = previous.onTimelineChanged(emptyTimeline()).state
    val reloaded = initialChatReaderTransition(timeline(user("new")))

    assertFalse(reset.initialized)
    assertFalse(reset.hasNewerContent)
    assertEquals("new", reloaded.state.latestUserMessageId)
  }

  @Test
  fun emptyBootstrapTimelinePreservesRestoredReaderState() {
    val restored =
      ChatReaderState(
        initialized = true,
        hasNewerContent = true,
        latestUserMessageId = "old",
        latestContentVersion = "old-version",
      )

    val loading = restored.onTimelineChanged(emptyTimeline(), historyLoading = true)

    assertEquals(restored, loading.state)
    assertNull(loading.scrollIndex)
  }

  @Test
  fun savedReaderStateRestoresViewportIntent() {
    val timeline = timeline(user("user-1"), assistant("assistant-1"))
    val state =
      ChatReaderState(
        initialized = true,
        followTarget = ChatScrollFollowTarget.ReadAnchor,
        hasNewerContent = true,
        latestUserMessageId = "user-1",
        latestContentVersion = timeline.latestContentVersion,
      )
    val saved = with(ChatReaderStateSaver) { SaverScope { true }.save(state) }

    val restored = ChatReaderStateSaver.restore(requireNotNull(saved))

    assertEquals(state, restored)
  }

  @Test
  fun restoredReaderTreatsCurrentTimelineAsBaseline() {
    val timeline = timeline(user("user-1"), assistant("assistant-1"))
    val restored =
      ChatReaderState(
        initialized = true,
        hasNewerContent = false,
        latestUserMessageId = "user-1",
        latestContentVersion = timeline.latestContentVersion,
      )

    val transition = restored.onTimelineChanged(timeline)

    assertEquals(restored, transition.state)
    assertNull(transition.scrollIndex)
  }

  private fun timeline(vararg messages: ChatMessage): ChatTimeline =
    buildChatTimeline(
      messages = messages.toList(),
      pendingRunCount = 0,
      pendingToolCalls = emptyList(),
      streamingAssistantText = null,
    )

  private fun emptyTimeline(): ChatTimeline = timeline()

  private fun activeTimeline(
    message: ChatMessage,
    stream: String?,
  ): ChatTimeline =
    buildChatTimeline(
      messages = listOf(message),
      pendingRunCount = 1,
      pendingToolCalls = emptyList(),
      streamingAssistantText = stream,
    )

  private fun user(id: String) = message(id, "user")

  private fun assistant(id: String) = message(id, "assistant")

  private fun message(
    id: String,
    role: String,
  ) = ChatMessage(
    id = id,
    role = role,
    content = listOf(ChatMessageContent(type = "text", text = id)),
    timestampMs = null,
  )
}
