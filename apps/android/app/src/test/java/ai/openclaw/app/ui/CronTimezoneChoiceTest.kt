package ai.openclaw.app.ui

import ai.openclaw.app.CronEditorDraftState
import ai.openclaw.app.GatewayCronActionState
import ai.openclaw.app.GatewayCronNoticeKind
import ai.openclaw.app.GatewayCronRunHistoryState
import ai.openclaw.app.GatewayCronScheduleEdit
import ai.openclaw.app.buildCronUpdateParams
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
import org.junit.Assert.assertFalse
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
class CronTimezoneChoiceTest {
  @get:Rule val composeRule = createComposeRule()

  @Before fun setUp() {
    NativeStringResources.install(RuntimeEnvironment.getApplication())
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
  }

  @After fun tearDown() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
  }

  @Test fun choosesTimezoneThenReopensAndRestoresGatewayDefault() {
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
    composeRule.onNodeWithText("US/Pacific").performScrollTo()
    capture("closed")
    composeRule.onNodeWithText("US/Pacific").performClick()
    composeRule.onNodeWithText("Search time zones").performScrollTo().performTextReplacement("Paris")
    composeRule.onNodeWithText("Cancel").performScrollTo()
    capture("choices")
    composeRule.onNodeWithText("Europe/Paris").performClick()
    assertEquals("Europe/Paris", (draft.value.edit.schedule as GatewayCronScheduleEdit.Cron).timezone)
    assertTrue(writes.isEmpty())
    composeRule.onNodeWithText("Save Changes").performScrollTo().performClick()
    assertEquals(
      "\"Europe/Paris\"",
      Json
        .parseToJsonElement(writes.single())
        .jsonObject["patch"]!!
        .jsonObject["schedule"]!!
        .jsonObject["tz"]
        .toString(),
    )
    composeRule.runOnIdle {
      draft.value = draft.value.observeSaveNotice(GatewayCronNoticeKind.Success).observeJob(job.copy(scheduleTimezone = "Europe/Paris"))
    }
    assertFalse(draft.value.isDirty)
    composeRule.onNodeWithText("Europe/Paris").performScrollTo().performClick()
    composeRule.onNodeWithText("Gateway time zone (default)").performScrollTo().performClick()
    assertEquals("", (draft.value.edit.schedule as GatewayCronScheduleEdit.Cron).timezone)
    composeRule.onNodeWithText("Save Changes").performScrollTo().performClick()
    val schedule =
      Json
        .parseToJsonElement(writes.last())
        .jsonObject["patch"]!!
        .jsonObject["schedule"]!!
        .jsonObject
    assertFalse(schedule.containsKey("tz"))
    assertEquals("\"0 9 * * *\"", schedule["expr"].toString())
    assertEquals("Daily report", draft.value.edit.name)
  }

  @Test fun customEntryCancelsWithoutReplacingTheSavedZoneAndRespectsReadOnlyState() {
    val selected = mutableStateOf("US/Pacific")
    val enabled = mutableStateOf(true)
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronTimezoneEditor(selected.value, enabled.value) { selected.value = it }
        }
      }
    }
    composeRule.onNodeWithText("US/Pacific").performClick()
    composeRule.onNodeWithText("Enter another time zone").performScrollTo().performClick()
    composeRule.onNodeWithText("Custom time zone").performScrollTo().performTextReplacement("Etc/GMT+12")
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    assertEquals("US/Pacific", selected.value)
    composeRule.onNodeWithText("US/Pacific").performScrollTo().performClick()
    composeRule.onNodeWithText("Enter another time zone").performScrollTo().performClick()
    composeRule.onNodeWithText("Custom time zone").performScrollTo().performTextReplacement("")
    composeRule.onNodeWithText("Use time zone").assertIsNotEnabled()
    composeRule.onNodeWithText("Custom time zone").performTextReplacement("Etc/GMT+12")
    composeRule.onNodeWithText("Use time zone").performScrollTo().performClick()
    assertEquals("Etc/GMT+12", selected.value)
    composeRule.runOnIdle { enabled.value = false }
    composeRule.onNodeWithText("Etc/GMT+12").assertIsNotEnabled()
  }

  private fun automation() =
    requireNotNull(
      parseGatewayCronJobDetail(
        Json
          .parseToJsonElement(
            """{"id":"timezone-proof","name":"Daily report","configRevision":"proof-v1","enabled":true,"createdAtMs":1000,"updatedAtMs":2000,"sessionTarget":"isolated","wakeMode":"now","schedule":{"kind":"cron","expr":"0 9 * * *","tz":"US/Pacific"},"payload":{"kind":"agentTurn","message":"Write a synthetic report."},"state":{}}""",
          ).jsonObject,
      ),
    )

  private fun capture(name: String) {
    val directory = File("build/outputs/cron-timezone-proof", UUID.randomUUID().toString())
    check(directory.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    File(directory, name + ".png").outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    println("Cron timezone proof: " + File(directory, name + ".png").absolutePath)
  }
}
