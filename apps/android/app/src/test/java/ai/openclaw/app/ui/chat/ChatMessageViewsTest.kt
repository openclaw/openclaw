package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxAttachment
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.parseChatMessageContent
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Intent
import android.graphics.Rect
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.inspector.WindowInspector
import android.widget.TextView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
class ChatMessageViewsTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun markdownListsPreserveNumberingAndNestedBulletIndentation() {
    composeRule.setContent {
      ClawDesignTheme {
        ChatMarkdown("3. outer\n   - nested\n4. next\n\n- bullet", textColor = ClawTheme.colors.text)
      }
    }

    listOf("3.", "4.", "outer", "nested", "next", "bullet").forEach {
      composeRule.onNodeWithText(it).assertIsDisplayed()
    }
    composeRule.onAllNodesWithText("•").assertCountEquals(2)
    val outer = composeRule.onNodeWithText("outer").fetchSemanticsNode().boundsInRoot
    val nested = composeRule.onNodeWithText("nested").fetchSemanticsNode().boundsInRoot
    assertTrue(nested.left > outer.left)
    assertTrue(nested.top > outer.top)
  }

  @Test
  fun representedFirstLinkSuppressesOnlyItsOriginalGenericPreview() {
    val represented = setOf("https://example.com/guide", "https://example.org/guide")
    composeRule.setContent {
      ClawDesignTheme {
        Column {
          ChatMessageLinkPreview(
            messageId = "across-blocks",
            role = "assistant",
            excludedUrls = represented,
            content =
              listOf(
                ChatMessageContent(text = "[source](https://example.com/guide#section)"),
                ChatMessageContent(text = "[session](https://gateway.example/chat/main/research)"),
              ),
          )
          ChatMessageLinkPreview(
            messageId = "same-block",
            role = "assistant",
            excludedUrls = represented,
            content = listOf(ChatMessageContent(text = "[redirected source](https://example.org/guide#section) [session](https://gateway.example/chat/main/research)")),
          )
          ChatMessageLinkPreview(
            messageId = "unrepresented-first",
            role = "assistant",
            excludedUrls = represented,
            content = listOf(ChatMessageContent(text = "[issue](https://github.com/openclaw/openclaw/issues/123) [source](https://example.com/guide)")),
          )
          ChatMessageLinkPreview(
            messageId = "user-link",
            role = "user",
            content = listOf(ChatMessageContent(text = "[article](https://reader.example/article)")),
          )
        }
      }
    }
    composeRule.onAllNodesWithText("Preview · example.com").assertCountEquals(0)
    composeRule.onAllNodesWithText("Preview · example.org").assertCountEquals(0)
    composeRule.onAllNodesWithText("Preview · gateway.example").assertCountEquals(0)
    composeRule.onNodeWithText("Preview · github.com").assertIsDisplayed()
    composeRule.onNodeWithText("Preview · reader.example").assertIsDisplayed()
  }

  @Test
  fun linkPreviewExpandsAndCollapsesWithoutOpeningUri() {
    val application = RuntimeEnvironment.getApplication()
    val shadowApp = org.robolectric.Shadows.shadowOf(application)
    shadowApp.clearNextStartedActivities()

    composeRule.setContent {
      ClawDesignTheme {
        ChatMessageLinkPreview(
          messageId = "expandable-link",
          role = "assistant",
          content = listOf(ChatMessageContent(text = "[issue](https://github.com/openclaw/openclaw/issues/123)")),
        )
      }
    }

    composeRule.onNodeWithText("Preview · github.com").assertIsDisplayed()
    composeRule.onNode(hasContentDescription("Expand link preview")).assertIsDisplayed()
    composeRule.onAllNodesWithText("github.com").assertCountEquals(0)

    composeRule.onNode(hasContentDescription("Expand link preview")).performClick()

    composeRule.onNodeWithText("github.com").assertIsDisplayed()
    composeRule.onNode(hasContentDescription("Collapse link preview")).assertIsDisplayed()
    org.junit.Assert.assertNull("Expanding preview must not launch browser activity", shadowApp.nextStartedActivity)

    // Verify collapsing preview returns to compact state without launching browser activity
    composeRule.onNode(hasContentDescription("Collapse link preview")).performClick()

    composeRule.onNodeWithText("Preview · github.com").assertIsDisplayed()
    composeRule.onNode(hasContentDescription("Expand link preview")).assertIsDisplayed()
    composeRule.onAllNodesWithText("github.com").assertCountEquals(0)
    org.junit.Assert.assertNull("Collapsing preview must not launch browser activity", shadowApp.nextStartedActivity)

    // Verify re-expanding and tapping card body launches external browser activity with URL
    composeRule.onNode(hasContentDescription("Expand link preview")).performClick()
    composeRule.onNodeWithText("github.com").performClick()
    val launchedIntent = shadowApp.nextStartedActivity
    org.junit.Assert.assertNotNull("Card body click must launch browser activity", launchedIntent)
    assertEquals(android.content.Intent.ACTION_VIEW, launchedIntent.action)
    assertEquals("https://github.com/openclaw/openclaw/issues/123", launchedIntent.dataString)
  }

  @Test
  fun transcriptBubblesExposeSpeakerWithoutReplacingMessageText() {
    val messages =
      listOf(
        Triple("user", "user body", false),
        Triple("user", "peer body", false),
        Triple("assistant", "assistant body", false),
        Triple("system", "system body", false),
        Triple("assistant", "live body", true),
      )

    composeRule.setContent {
      Column {
        messages.forEachIndexed { index, (role, body, live) ->
          ChatBubble(
            messageId = "message-$index",
            entryId = if (role == "user") "entry-$index" else null,
            role = role,
            live = live,
            content = listOf(ChatMessageContent(type = "text", text = body)),
            timestampMs = null,
            onReplyMessage = {},
            sessionActionsEnabled = true,
            onRewindMessage = {},
            onForkMessage = {},
            speechState = null,
            onToggleListen = { _, _ -> },
            inlineMediaPlaybackBlocked = false,
            inlineWidgetResolverReady = false,
            resolveInlineWidgetResource = { _, _ -> null },
            loadImageArtifact = { null },
            loadMediaArtifact = { _, _, _ -> null },
            senderLabel =
              when (body) {
                "peer body" -> "  Alex (Slack)  "
                "assistant body", "system body", "live body" -> "Spoofed sender"
                else -> null
              },
          )
        }
      }
    }

    val userBubble = composeRule.onNode(hasContentDescription("You") and hasText("user body")).assertExists()
    composeRule.onNode(hasContentDescription("Alex (Slack)") and hasText("peer body")).assertExists()
    composeRule.onNodeWithText("Alex (Slack)", useUnmergedTree = true).assertIsDisplayed()
    val assistantBubble = composeRule.onNode(hasContentDescription("OpenClaw") and hasText("assistant body")).assertExists()
    composeRule.onNode(hasContentDescription("System") and hasText("system body")).assertExists()
    composeRule.onNode(hasContentDescription("OpenClaw") and hasText("live body")).assertExists()
    listOf(userBubble, assistantBubble).forEach { bubble ->
      val semantics = bubble.fetchSemanticsNode().config
      assertTrue(semantics.isMergingSemanticsOfDescendants)
      assertTrue(SemanticsActions.OnLongClick in semantics)
    }
    composeRule.onAllNodesWithText("You", useUnmergedTree = true).assertCountEquals(0)
    composeRule.onAllNodesWithText("OpenClaw", useUnmergedTree = true).assertCountEquals(0)
    composeRule.onAllNodesWithText("Spoofed sender", useUnmergedTree = true).assertCountEquals(0)
    composeRule.onAllNodesWithText("System", useUnmergedTree = true).assertCountEquals(1)
    composeRule.onAllNodesWithText("OpenClaw · Live", useUnmergedTree = true).assertCountEquals(1)

    userBubble.performSemanticsAction(SemanticsActions.OnLongClick) { action -> action() }
    listOf("Select text", "Reply", "Rewind to here", "Fork from here").forEach { label ->
      composeRule.onNode(hasText(label) and hasClickAction()).assertExists()
    }
    composeRule.onNodeWithText("Select text").performClick()
    composeRule.onAllNodesWithText("user body").assertCountEquals(1)
    composeRule.runOnIdle {
      val reader = nativeReaders().single()
      assertEquals("user body", reader.text.toString())
      assertTrue(reader.isShown && reader.width > 0 && reader.height > 0)
      assertTrue(reader.getGlobalVisibleRect(Rect()))
    }
    composeRule.onNode(hasText("Done") and hasClickAction()).performClick()
    composeRule.runOnIdle { assertTrue(nativeReaders().isEmpty()) }

    assistantBubble.performSemanticsAction(SemanticsActions.OnLongClick) { action -> action() }
    composeRule.onNode(hasText("Listen") and hasClickAction()).assertExists()
    composeRule.onNode(hasText("Reply") and hasClickAction()).assertExists()
  }

  @Test
  fun attachmentOnlyUserTurnsRetainEntryActionsWithoutEmptyTextActions() {
    val actions = mutableListOf<String>()
    val messages =
      listOf(
        Triple("user", "photo.png", "photo-entry"),
        Triple("user", "report.pdf", "document-entry"),
        Triple("assistant", "assistant.pdf", "assistant-entry"),
        Triple("user", "unpersisted.pdf", null),
        Triple("user", "disabled.pdf", "disabled-entry"),
      )

    composeRule.setContent {
      Column {
        messages.forEach { (role, fileName, entryId) ->
          ChatBubble(
            messageId = fileName,
            entryId = entryId,
            role = role,
            live = false,
            content =
              listOf(
                ChatMessageContent(
                  type = if (fileName == "photo.png") "image" else "file",
                  fileName = fileName,
                ),
              ),
            timestampMs = null,
            onReplyMessage = { actions += "reply:$it" },
            sessionActionsEnabled = fileName != "disabled.pdf",
            onRewindMessage = { actions += "rewind:$it" },
            onForkMessage = { actions += "fork:$it" },
            speechState = null,
            onToggleListen = { _, _ -> actions += "listen" },
            inlineMediaPlaybackBlocked = false,
            inlineWidgetResolverReady = false,
            resolveInlineWidgetResource = { _, _ -> null },
            loadImageArtifact = { null },
            loadMediaArtifact = { _, _, _ -> null },
          )
        }
      }
    }

    listOf("assistant.pdf", "unpersisted.pdf", "disabled.pdf").forEach { fileName ->
      val speaker = if (fileName == "assistant.pdf") "OpenClaw" else "You"
      val semantics =
        composeRule
          .onNode(hasContentDescription(speaker) and hasText(fileName))
          .fetchSemanticsNode()
          .config
      assertTrue(SemanticsActions.OnLongClick !in semantics)
    }

    listOf("photo.png" to "Rewind to here", "report.pdf" to "Fork from here").forEach { (fileName, selectedAction) ->
      composeRule
        .onNode(hasContentDescription("You") and hasText(fileName))
        .performSemanticsAction(SemanticsActions.OnLongClick) { action -> action() }

      listOf("Rewind to here", "Fork from here").forEach { label ->
        composeRule.onNode(hasText(label) and hasClickAction()).assertExists()
      }
      listOf("Copy", "Select text", "Share", "Reply", "Listen").forEach { label ->
        composeRule.onAllNodesWithText(label).assertCountEquals(0)
      }
      composeRule.onNodeWithText(selectedAction).performClick()
    }

    assertEquals(listOf("rewind:photo-entry", "fork:document-entry"), actions)
  }

  @Test
  @Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi")
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun repeatedUserDisclosureActionsKeepDesiredStateAndRevealItsStart() {
    val introduction = "The first user paragraph must be readable."
    val text = introduction + "\n\n" + (1..80).joinToString("\n\n") { "User paragraph $it remains in this message." }
    val message = ChatMessage("user-disclosure", "user", listOf(ChatMessageContent(text = text)), null)
    composeRule.setContent {
      ClawDesignTheme {
        val timeline = prepareChatHistory(listOf(message), "agent:main:main", mainSessionKey = "agent:main:main").buildTimeline(0, emptyList(), null)
        val reader = rememberChatReaderScrollController("user-disclosure-owner", timeline, historyLoading = false)
        CompositionLocalProvider(LocalChatReaderNavigation provides reader.navigation) {
          LazyColumn(
            state = reader.listState,
            reverseLayout = true,
            modifier = Modifier.size(360.dp, 240.dp).clipToBounds(),
          ) {
            item {
              ChatBubble(
                messageId = message.id,
                entryId = null,
                role = "user",
                live = false,
                content = message.content,
                timestampMs = null,
                onReplyMessage = {},
                sessionActionsEnabled = false,
                onRewindMessage = {},
                onForkMessage = {},
                speechState = null,
                onToggleListen = { _, _ -> },
                inlineMediaPlaybackBlocked = false,
                inlineWidgetResolverReady = false,
                resolveInlineWidgetResource = { _, _ -> null },
                loadImageArtifact = { null },
                loadMediaArtifact = { _, _, _ -> null },
              )
            }
          }
        }
      }
    }

    fun repeatCurrentAction(label: String) {
      val target = composeRule.onNode(hasText(label) and hasClickAction())
      target.performScrollTo().assertIsDisplayed().assertIsEnabled()
      val action = checkNotNull(target.fetchSemanticsNode().config[SemanticsActions.OnClick].action)
      val autoAdvance = composeRule.mainClock.autoAdvance
      composeRule.mainClock.autoAdvance = false
      try {
        val frame = composeRule.mainClock.currentTime
        composeRule.runOnUiThread {
          assertTrue(action())
          assertTrue(action())
        }
        composeRule.mainClock.advanceTimeBy(0, ignoreFrameDuration = true)
        assertEquals("Both actions must precede the next frame", frame, composeRule.mainClock.currentTime)
      } finally {
        composeRule.mainClock.autoAdvance = autoAdvance
      }
      composeRule.waitForIdle()
    }

    repeatCurrentAction("View all")
    composeRule.onNodeWithText("Close").assertExists()
    composeRule.onNodeWithText(introduction, useUnmergedTree = true).assertIsDisplayed()
    repeatCurrentAction("Close")
    composeRule.onNodeWithText("Close").assertDoesNotExist()
    composeRule.onNodeWithText("View all").assertExists()
  }

  @Test
  @Config(sdk = [36], qualifiers = "en-rUS-w360dp-h800dp-420dpi")
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun outboxDeliveryStatesKeepConfirmedUserBubbleGeometry() {
    val text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
    val attachment = ChatOutboxAttachment("document", "file", "application/pdf", "notes.pdf", null, 12L)
    val queued =
      ChatOutboxItem(
        id = "geometry-outbox",
        sessionKey = "main",
        text = text,
        thinkingLevel = "low",
        createdAtMs = 0L,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "main",
        attachments = listOf(attachment),
      )
    val pending = mutableStateOf<ChatOutboxItem?>(queued)
    val retryEnabled = mutableStateOf(true)
    var retries = 0
    var deletes = 0
    var userSurface = Color.Unspecified
    var canvas = Color.Unspecified
    composeRule.setContent {
      ClawDesignTheme {
        userSurface = ClawTheme.colors.userMessageSurface
        canvas = ClawTheme.colors.canvas
        Column(Modifier.size(360.dp, 800.dp).background(ClawTheme.colors.canvas)) {
          Box(Modifier.testTag("confirmed-reference")) {
            GeometryTranscriptBubble("reference", "user", text)
          }
          Box(Modifier.testTag("delivery")) {
            val item = pending.value
            if (item == null) {
              GeometryTranscriptBubble("delivered", "user", text)
            } else {
              ChatOutboxBubble(item, retryEnabled.value, onRetry = { retries += 1 }, onDelete = { deletes += 1 })
            }
          }
        }
      }
    }
    val reference = composeRule.onNode(hasContentDescription("You") and hasAnyAncestor(hasTestTag("confirmed-reference")))
    val expectedBounds = reference.fetchSemanticsNode().boundsInRoot
    val rowBounds = composeRule.onNodeWithTag("confirmed-reference").fetchSemanticsNode().boundsInRoot
    assertTrue("Short text does not force a full-width bubble", expectedBounds.width < rowBounds.width * 0.78f)
    assertEquals(rowBounds.right, expectedBounds.right, 1f)
    val expectedPixels = reference.captureToImage().toPixelMap()
    val topBand = with(composeRule.density) { 6.dp.roundToPx() }
    assertEquals(userSurface.toArgb(), expectedPixels[expectedPixels.width / 2, topBand / 2].toArgb())
    val cornerX = with(composeRule.density) { 5.dp.roundToPx() }
    val cornerY = with(composeRule.density) { 4.dp.roundToPx() }
    assertEquals("The 24dp corner leaves this point outside the bubble", canvas.toArgb(), expectedPixels[cornerX, cornerY].toArgb())

    val states =
      listOf(
        queued to "Queued — sends when reconnected",
        queued.copy(status = ChatOutboxStatus.Sending) to "Sending…",
        queued.copy(status = ChatOutboxStatus.Accepted) to "Sent — confirming delivery…",
        queued.copy(status = ChatOutboxStatus.Failed, lastError = "Synthetic delivery failure") to "Failed — Synthetic delivery failure",
      )
    // The last failed pass is a recovery row: its delete action survives, but retry is suppressed.
    (states + states.last() + (null to null)).forEachIndexed { index, (item, status) ->
      composeRule.runOnIdle {
        pending.value = item
        retryEnabled.value = index != states.size
      }
      val actual = composeRule.onNode(hasContentDescription("You") and hasAnyAncestor(hasTestTag("delivery")))
      val bounds = actual.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
      assertTrue("$status: keeps the same maximum text budget", bounds.width <= rowBounds.width * 0.78f + 1f)
      assertTrue("$status: preserves the leading gutter", bounds.left >= rowBounds.right - rowBounds.width * 0.78f - 1f)
      assertEquals("$status: trailing edge", expectedBounds.right, bounds.right, 1f)
      val pixels = actual.captureToImage().toPixelMap()
      // Above the text: compare the painted corners, fill, and top border, not a style helper.
      val cornerBand = with(composeRule.density) { 24.dp.roundToPx() }
      for (y in 0 until topBand) {
        for (x in 0 until cornerBand) {
          assertEquals("$status: leading corner $x,$y", expectedPixels[x, y], pixels[x, y])
          assertEquals("$status: trailing corner $x,$y", expectedPixels[expectedPixels.width - 1 - x, y], pixels[pixels.width - 1 - x, y])
        }
        assertEquals("$status: fill", expectedPixels[expectedPixels.width / 2, y], pixels[pixels.width / 2, y])
      }
      val sideY = with(composeRule.density) { 30.dp.roundToPx() }
      assertEquals("$status: no leading border", userSurface.toArgb(), pixels[0, sideY].toArgb())
      assertEquals("$status: no trailing border", userSurface.toArgb(), pixels[pixels.width - 1, sideY].toArgb())
      if (status != null) {
        composeRule.onNodeWithText(status).assertIsDisplayed()
        composeRule.onNodeWithText("📎 notes.pdf", useUnmergedTree = true).assertIsDisplayed()
      }
      if (item?.status == ChatOutboxStatus.Failed && retryEnabled.value) {
        composeRule.onNodeWithText("Retry").performClick()
      } else {
        composeRule.onNodeWithText("Retry").assertDoesNotExist()
      }
      if (item?.status == ChatOutboxStatus.Queued || item?.status == ChatOutboxStatus.Failed) {
        composeRule.onNodeWithText("Delete").performClick()
      } else {
        composeRule.onNodeWithText("Delete").assertDoesNotExist()
      }
    }
    assertEquals(1, retries)
    assertEquals(3, deletes)
  }

  @Test
  @Config(sdk = [36], qualifiers = "en-rUS-w360dp-h800dp-420dpi")
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun typingStreamingAndConfirmedAssistantKeepInsetTransparentGeometry() {
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val phase = mutableStateOf(0)
    var canvas = Color.Unspecified
    try {
      composeRule.setContent {
        ClawDesignTheme {
          canvas = ClawTheme.colors.canvas
          Column(Modifier.size(360.dp, 800.dp).background(canvas)) {
            Box(Modifier.testTag("assistant-row")) {
              if (phase.value == 0) {
                ChatTypingIndicatorBubble("geometry-run", observedAtElapsedMs = 0L)
              } else {
                GeometryTranscriptBubble("assistant", "assistant", "Assistant reply", live = phase.value == 1)
              }
            }
          }
        }
      }
      for (nextPhase in 0..2) {
        composeRule.runOnIdle { phase.value = nextPhase }
        val row = composeRule.onNodeWithTag("assistant-row").fetchSemanticsNode().boundsInRoot
        val bubble = composeRule.onNode(hasContentDescription("OpenClaw"))
        val bounds = bubble.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("Phase $nextPhase: content fits the transcript", bounds.width <= row.width)
        assertEquals("Phase $nextPhase: leading edge", row.left, bounds.left, 1f)
        val pixels = bubble.captureToImage().toPixelMap()
        // The top padding and trailing edge must expose the canvas, not a raised panel or border.
        assertEquals(canvas.toArgb(), pixels[pixels.width / 2, 0].toArgb())
        assertEquals(canvas.toArgb(), pixels[pixels.width - 1, pixels.height / 2].toArgb())
        if (nextPhase == 0) {
          composeRule.onNode(hasContentDescription("Working"), useUnmergedTree = true).assertIsDisplayed()
        } else {
          composeRule.onNodeWithText("Assistant reply", useUnmergedTree = true).assertIsDisplayed()
        }
      }
    } finally {
      Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  @Composable
  private fun GeometryTranscriptBubble(
    messageId: String,
    role: String,
    text: String,
    live: Boolean = false,
  ) {
    ChatBubble(
      messageId = messageId,
      entryId = null,
      role = role,
      live = live,
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = null,
      onReplyMessage = {},
      sessionActionsEnabled = false,
      onRewindMessage = {},
      onForkMessage = {},
      speechState = null,
      onToggleListen = { _, _ -> },
      inlineMediaPlaybackBlocked = false,
      inlineWidgetResolverReady = false,
      resolveInlineWidgetResource = { _, _ -> null },
      loadImageArtifact = { null },
      loadMediaArtifact = { _, _, _ -> null },
    )
  }

  @Test
  fun outboxBubbleExposesSpeakerWithoutReplacingStatusOrActions() {
    composeRule.setContent {
      Column {
        ChatOutboxBubble(
          item =
            ChatOutboxItem(
              id = "outbox-1",
              sessionKey = "main",
              text = "queued body",
              thinkingLevel = "low",
              createdAtMs = 0L,
              status = ChatOutboxStatus.Queued,
              retryCount = 0,
              lastError = null,
              ownerAgentId = "main",
            ),
          onRetry = {},
          onDelete = {},
        )
        ChatBubble(
          messageId = "audio-message",
          entryId = null,
          role = "assistant",
          live = false,
          content =
            listOf(
              ChatMessageContent(
                type = "audio",
                mimeType = "audio/mpeg",
                fileName = "voice-note.mp3",
                artifactId = "audio-artifact",
              ),
            ),
          timestampMs = null,
          onReplyMessage = {},
          sessionActionsEnabled = false,
          onRewindMessage = {},
          onForkMessage = {},
          speechState = null,
          onToggleListen = { _, _ -> },
          inlineMediaPlaybackBlocked = false,
          inlineWidgetResolverReady = false,
          resolveInlineWidgetResource = { _, _ -> null },
          loadImageArtifact = { null },
          loadMediaArtifact = { _, _, _ -> null },
        )
      }
    }

    composeRule
      .onNode(
        hasContentDescription("You") and
          hasText("queued body") and
          hasAnyDescendant(hasText("Delete") and hasClickAction()),
      ).assertExists()
    composeRule
      .onNode(
        hasContentDescription("OpenClaw") and
          hasAnyDescendant(hasContentDescription("Play audio") and hasClickAction()),
      ).assertExists()
  }

  @Test
  fun attachmentOnlyAssistantTurnShowsDocumentFilenameWithoutLoadingItsUrl() {
    var artifactRequests = 0

    composeRule.setContent {
      ChatBubble(
        messageId = "document-message",
        entryId = null,
        role = "assistant",
        live = false,
        content =
          listOf(
            ChatMessageContent(
              type = "file",
              mimeType = "application/pdf",
              fileName = "quarterly-report.pdf",
              url = "https://example.test/quarterly-report.pdf",
            ),
          ),
        timestampMs = null,
        onReplyMessage = {},
        sessionActionsEnabled = false,
        onRewindMessage = {},
        onForkMessage = {},
        speechState = null,
        onToggleListen = { _, _ -> },
        inlineMediaPlaybackBlocked = false,
        inlineWidgetResolverReady = false,
        resolveInlineWidgetResource = { _, _ ->
          artifactRequests += 1
          null
        },
        loadImageArtifact = {
          artifactRequests += 1
          null
        },
        loadMediaArtifact = { _, _, _ ->
          artifactRequests += 1
          null
        },
      )
    }

    composeRule
      .onNode(hasContentDescription("OpenClaw") and hasText("quarterly-report.pdf"))
      .assertIsDisplayed()
    assertEquals(0, artifactRequests)
  }

  @Test
  fun omittedImageOnlyTurnsRemainVisibleWithoutLoadingBeyondTheImageCap() {
    val omittedImage =
      requireNotNull(
        parseChatMessageContent(
          Json.parseToJsonElement(
            """{"type":"image","mimeType":"image/png","omitted":true,"bytes":5}""",
          ),
        ),
      )
    var artifactRequests = 0

    composeRule.setContent {
      Column {
        listOf(
          listOf(omittedImage),
          (1..5).map { index -> omittedImage.copy(fileName = "redacted-$index.png") },
        ).forEachIndexed { index, images ->
          ChatBubble(
            messageId = "omitted-images-$index",
            entryId = null,
            role = "assistant",
            live = false,
            content = images,
            timestampMs = null,
            onReplyMessage = {},
            sessionActionsEnabled = false,
            onRewindMessage = {},
            onForkMessage = {},
            speechState = null,
            onToggleListen = { _, _ -> },
            inlineMediaPlaybackBlocked = false,
            inlineWidgetResolverReady = true,
            resolveInlineWidgetResource = { _, _ ->
              artifactRequests += 1
              null
            },
            loadImageArtifact = {
              artifactRequests += 1
              null
            },
            loadMediaArtifact = { _, _, _ ->
              artifactRequests += 1
              null
            },
          )
        }
      }
    }

    composeRule.onNode(hasContentDescription("OpenClaw") and hasText("Attachment")).assertIsDisplayed()
    (1..4).forEach { index -> composeRule.onNodeWithText("redacted-$index.png").assertIsDisplayed() }
    composeRule.onAllNodesWithText("redacted-5.png").assertCountEquals(0)
    composeRule.onNodeWithText("Next images").assertIsDisplayed().performClick()
    composeRule.onNodeWithText("redacted-5.png").assertIsDisplayed()
    (1..4).forEach { index -> composeRule.onAllNodesWithText("redacted-$index.png").assertCountEquals(0) }
    assertEquals(0, artifactRequests)
  }

  @Test
  fun managedImageCompositionRequestsItsArtifact() {
    val artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
    val requested = mutableListOf<String>()

    composeRule.setContent {
      ChatBubble(
        messageId = "managed-image",
        entryId = null,
        role = "assistant",
        live = false,
        content =
          listOf(
            ChatMessageContent(
              type = "image",
              mimeType = "image/png",
              artifactId = artifactId,
              alt = "Managed image",
            ),
          ),
        timestampMs = null,
        onReplyMessage = {},
        sessionActionsEnabled = false,
        onRewindMessage = {},
        onForkMessage = {},
        speechState = null,
        onToggleListen = { _, _ -> },
        inlineMediaPlaybackBlocked = false,
        inlineWidgetResolverReady = true,
        resolveInlineWidgetResource = { _, _ -> null },
        loadImageArtifact = { requestedArtifactId ->
          requested += requestedArtifactId
          null
        },
        loadMediaArtifact = { _, _, _ -> null },
      )
    }
    composeRule.waitUntil(timeoutMillis = 5_000) { requested.isNotEmpty() }

    assertEquals(listOf(artifactId), requested)
  }

  @Test
  fun systemRowsRenderNoticeLabelAndDividerMetric() {
    composeRule.setContent {
      Column {
        ChatSystemNoticeRow(
          ChatTimelineItem.SystemNotice(
            key = "system-notice:1:0",
            label = "System · restart recovery",
            body = "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.",
          ),
        )
        ChatSystemDividerRow(
          ChatTimelineItem.SystemDivider(
            key = "divider:compaction:checkpoint-1",
            kind = SystemDividerKind.Compaction,
            label = "Compacted history",
            metric = "saved 875.3k tokens",
          ),
        )
      }
    }

    composeRule.onNodeWithText("System · restart recovery").assertIsDisplayed()
    composeRule
      .onNodeWithText("Turn interrupted by a gateway restart — asked the agent to resume and finish the response.")
      .assertIsDisplayed()
    composeRule.onNodeWithText("Compacted history").assertIsDisplayed()
    composeRule.onNodeWithText("saved 875.3k tokens").assertIsDisplayed()
  }

  private fun nativeReaders(): List<TextView> {
    fun descendants(view: View): Sequence<View> =
      sequence {
        yield(view)
        if (view is ViewGroup) {
          for (index in 0 until view.childCount) yieldAll(descendants(view.getChildAt(index)))
        }
      }
    return WindowInspector
      .getGlobalWindowViews()
      .asSequence()
      .flatMap(::descendants)
      .filterIsInstance<TextView>()
      .filter { it.isTextSelectable && !it.onCheckIsTextEditor() }
      .toList()
  }
}
