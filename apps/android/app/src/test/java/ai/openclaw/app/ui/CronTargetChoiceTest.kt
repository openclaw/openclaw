package ai.openclaw.app.ui

import ai.openclaw.app.CronEditorDraftState
import ai.openclaw.app.GatewayCronActionState
import ai.openclaw.app.GatewayCronJobDetail
import ai.openclaw.app.GatewayCronNoticeKind
import ai.openclaw.app.GatewayCronPayloadEdit
import ai.openclaw.app.GatewayCronRunHistoryState
import ai.openclaw.app.buildCronUpdateParams
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.parseGatewayCronJobDetail
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.core.os.LocaleListCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w420dp-h900dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CronTargetChoiceTest {
  @get:Rule val composeRule = createComposeRule()

  @Before fun setUp() {
    NativeStringResources.install(RuntimeEnvironment.getApplication())
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
  }

  @After fun tearDown() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
  }

  @Test fun choosesTargetWithoutTypingItsCode() {
    val job = automation()
    val draft = mutableStateOf(CronEditorDraftState.from(job))
    val writes = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronJobManagementPanel(
            job = job,
            editorDraft = draft.value,
            onEditorDraftChange = { draft.value = it },
            historyState = GatewayCronRunHistoryState.Idle,
            actionState = GatewayCronActionState.Idle,
            runPending = false,
            operatorAdminScopeAvailable = true,
            onRun = {},
            onToggleEnabled = {},
            onSave = { writes.add(buildCronUpdateParams(job, it)) },
            onRefreshHistory = {},
            onDelete = {},
          )
        }
      }
    }
    composeRule.onNodeWithText("Session target").performScrollTo()
    capture("closed")
    composeRule.onNodeWithText("Isolated run").performClick()
    capture("choices")
    composeRule.onNodeWithText("Main session").performClick()
    assertEquals("main", draft.value.edit.sessionTarget)
    assertTrue(writes.isEmpty())
    composeRule.onNodeWithText("Save Changes").performScrollTo().performClick()
    assertEquals(
      "main",
      Json
        .parseToJsonElement(writes.single())
        .jsonObject["patch"]!!
        .jsonObject["sessionTarget"]
        ?.toString()
        ?.trim('"'),
    )
    assertEquals("Daily report", draft.value.edit.name)
  }

  @Test fun choosesNamedSessionsAndKeepsTheSavedReferenceWhenTheRosterChanges() {
    val job = automation().copy(sessionTarget = "session:agent:main:unlisted")
    val draft = mutableStateOf(CronEditorDraftState.from(job).withEdit(CronEditorDraftState.from(job).edit.copy(name = "Keep edited title")))
    val sessions =
      mutableStateOf(
        listOf(
          ChatSessionEntry(key = "agent:main:release", updatedAtMs = 1, label = "Release review"),
          ChatSessionEntry(key = "agent:main:other-release", updatedAtMs = 1, label = "Release review"),
          ChatSessionEntry(key = "agent:main:archived", updatedAtMs = 1, label = "Archived review", archived = true),
        ),
      )
    val writes = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronJobManagementPanel(
            job = job,
            editorDraft = draft.value,
            onEditorDraftChange = { draft.value = it },
            historyState = GatewayCronRunHistoryState.Idle,
            actionState = GatewayCronActionState.Idle,
            runPending = false,
            operatorAdminScopeAvailable = true,
            onRun = {},
            onToggleEnabled = {},
            onSave = { writes.add(buildCronUpdateParams(job, it)) },
            onRefreshHistory = {},
            onDelete = {},
            sessions = sessions.value,
          )
        }
      }
    }
    composeRule.onNodeWithText(job.sessionTarget).performScrollTo().performClick()
    // Reveal the expanded field in the page before scrolling its bounded choices.
    composeRule.onNodeWithText("Cancel").performScrollTo()
    composeRule.onNodeWithText("Search loaded sessions").performScrollTo().performTextReplacement("Release")
    composeRule.onNodeWithText("agent:main:other-release").performScrollTo()
    capture("search")
    composeRule.onNodeWithText("agent:main:other-release").performClick()
    assertEquals("session:agent:main:other-release", draft.value.edit.sessionTarget)
    assertEquals("Keep edited title", draft.value.edit.name)
    assertTrue(writes.isEmpty())
    composeRule.onNodeWithText("Save Changes").performScrollTo().performClick()
    val patch = Json.parseToJsonElement(writes.single()).jsonObject["patch"]!!.jsonObject
    assertEquals("\"session:agent:main:other-release\"", patch["sessionTarget"].toString())
    assertEquals("\"Keep edited title\"", patch["name"].toString())
    composeRule.runOnIdle {
      draft.value = draft.value.observeSaveNotice(GatewayCronNoticeKind.Success).observeJob(job.copy(name = "Keep edited title", sessionTarget = "session:agent:main:other-release"))
      sessions.value = emptyList()
    }
    assertTrue(!draft.value.isDirty)
    composeRule.onNodeWithText("session:agent:main:other-release").performScrollTo().performClick()
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    assertEquals("session:agent:main:other-release", draft.value.edit.sessionTarget)
  }

  @Test fun customEntryCancelsWithoutChangingTheDraftAndCanBeRetriedAfterFailure() {
    val job = automation()
    val draft = mutableStateOf(CronEditorDraftState.from(job))
    val writes = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronJobManagementPanel(
            job = job,
            editorDraft = draft.value,
            onEditorDraftChange = { draft.value = it },
            historyState = GatewayCronRunHistoryState.Idle,
            actionState = GatewayCronActionState.Idle,
            runPending = false,
            operatorAdminScopeAvailable = true,
            onRun = {},
            onToggleEnabled = {},
            onSave = {
              writes.add(buildCronUpdateParams(job, it))
              draft.value = draft.value.observeSaveNotice(GatewayCronNoticeKind.Error)
            },
            onRefreshHistory = {},
            onDelete = {},
          )
        }
      }
    }
    composeRule.onNodeWithText("Isolated run").performScrollTo().performClick()
    composeRule.onNodeWithText("Enter another session key").performScrollTo().performClick()
    composeRule.onNodeWithText("Session key").performScrollTo().performTextReplacement("agent:main:unlisted")
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    assertEquals("isolated", draft.value.edit.sessionTarget)
    composeRule.onNodeWithText("Isolated run").performScrollTo().performClick()
    composeRule.onNodeWithText("Enter another session key").performScrollTo().performClick()
    composeRule.onNodeWithText("Session key").performScrollTo().performTextReplacement("agent:main:unlisted")
    composeRule.onNodeWithText("Use session").performScrollTo().performClick()
    assertEquals("session:agent:main:unlisted", draft.value.edit.sessionTarget)
    composeRule.onNodeWithText("Save Changes").performScrollTo().performClick()
    assertTrue(draft.value.isDirty)
    assertTrue(!draft.value.savePending)
    assertEquals("session:agent:main:unlisted", draft.value.edit.sessionTarget)
    composeRule.onNodeWithText("Save Changes").performClick()
    assertEquals(2, writes.size)
  }

  @Test fun unavailableWritesDisableTheTargetControl() {
    val job = automation()
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronJobManagementPanel(
            job = job,
            editorDraft = CronEditorDraftState.from(job),
            onEditorDraftChange = { error("Read-only control changed") },
            historyState = GatewayCronRunHistoryState.Idle,
            actionState = GatewayCronActionState.Idle,
            runPending = false,
            operatorAdminScopeAvailable = false,
            onRun = {},
            onToggleEnabled = {},
            onSave = {},
            onRefreshHistory = {},
            onDelete = {},
          )
        }
      }
    }
    composeRule.onNodeWithText("Isolated run").performScrollTo().assertIsNotEnabled()
  }

  @Test fun systemEventsDoNotOfferIncompatibleTargets() {
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize()) {
          CronSessionTargetEditor(
            value = "main",
            payload = GatewayCronPayloadEdit.SystemEvent("Keep event"),
            onChange = {},
            enabled = true,
            sessions = emptyList(),
            loadingMore = false,
            hasMore = false,
            loadFailed = false,
            onLoadMore = {},
          )
        }
      }
    }
    composeRule.onNodeWithText("Main session").performClick()
    composeRule.onNodeWithText("Isolated run").assertDoesNotExist()
    composeRule.onNodeWithText("Linked run").assertDoesNotExist()
    composeRule.onNodeWithText("Search loaded sessions").assertDoesNotExist()
    composeRule.onNodeWithText("Cancel").performClick()
  }

  @Test fun loadingMoreUsesTheExistingCallbackAndDoesNotChangeSelection() {
    var loads = 0
    val loading = mutableStateOf(false)
    val selected = mutableStateOf("isolated")
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronSessionTargetEditor(
            value = selected.value,
            payload = GatewayCronPayloadEdit.AgentTurn("Keep prompt", "", ""),
            onChange = { selected.value = it },
            enabled = true,
            sessions = emptyList(),
            loadingMore = loading.value,
            hasMore = true,
            loadFailed = true,
            onLoadMore = {
              loads++
              loading.value = true
            },
          )
        }
      }
    }
    composeRule.onNodeWithText("Isolated run").performClick()
    composeRule.onNodeWithText("Load more sessions").performScrollTo().performClick()
    composeRule.onNodeWithText("Load more sessions").assertIsNotEnabled()
    assertEquals(1, loads)
    assertEquals("isolated", selected.value)
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    assertEquals("isolated", selected.value)
  }

  private fun automation(): GatewayCronJobDetail =
    requireNotNull(
      parseGatewayCronJobDetail(
        Json
          .parseToJsonElement(
            """{"id":"choice-proof","name":"Daily report","configRevision":"proof-v1","enabled":true,"createdAtMs":1000,"updatedAtMs":2000,"sessionTarget":"isolated","wakeMode":"now","schedule":{"kind":"every","everyMs":60000},"payload":{"kind":"agentTurn","message":"Write a synthetic report."},"state":{}}""",
          ).jsonObject,
      ),
    )

  private fun capture(name: String) {
    val directory = File("build/outputs/cron-target-proof", UUID.randomUUID().toString())
    check(directory.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    check(image.width >= 400 && image.height >= 700)
    File(directory, "$name.png").outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    println("Cron target proof: " + File(directory, "$name.png").absolutePath)
  }
}
