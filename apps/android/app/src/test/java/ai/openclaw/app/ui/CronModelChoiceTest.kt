package ai.openclaw.app.ui

import ai.openclaw.app.CronEditorDraftState
import ai.openclaw.app.GatewayCronActionState
import ai.openclaw.app.GatewayCronModelChoices
import ai.openclaw.app.GatewayCronNoticeKind
import ai.openclaw.app.GatewayCronPayloadEdit
import ai.openclaw.app.GatewayCronRunHistoryState
import ai.openclaw.app.buildCronUpdateParams
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.parseGatewayCronJobDetail
import ai.openclaw.app.parseGatewayModelCatalog
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
class CronModelChoiceTest {
  @get:Rule val composeRule = createComposeRule()

  @Before fun setUp() {
    NativeStringResources.install(RuntimeEnvironment.getApplication())
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
  }

  @After fun tearDown() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
  }

  @Test fun choosesModelWithoutTypingItsReference() {
    val original = requireNotNull(parseGatewayCronJobDetail(Json.parseToJsonElement("""{"id":"model-proof","name":"Weekly writing digest","agentId":"writer","configRevision":"proof-v1","enabled":true,"createdAtMs":1000,"updatedAtMs":2000,"sessionTarget":"isolated","wakeMode":"now","schedule":{"kind":"every","everyMs":3600000},"payload":{"kind":"agentTurn","message":"Summarize the fictional editorial notes.","model":"custom/saved-model"},"state":{}}""").jsonObject))
    val job = mutableStateOf(original)
    val draft = mutableStateOf(CronEditorDraftState.from(original))
    val writes = mutableListOf<String>()
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronJobManagementPanel(
            job = job.value,
            editorDraft = draft.value,
            onEditorDraftChange = { draft.value = it },
            historyState = GatewayCronRunHistoryState.Idle,
            actionState = GatewayCronActionState.Idle,
            runPending = false,
            operatorAdminScopeAvailable = true,
            models = catalog(),
            onRefreshModels = {},
            onRun = {},
            onToggleEnabled = {},
            onSave = { writes.add(buildCronUpdateParams(job.value, it)) },
            onRefreshHistory = {},
            onDelete = {},
          )
        }
      }
    }
    composeRule.onNodeWithText("custom/saved-model").performScrollTo()
    capture("closed")
    composeRule.onNodeWithText("custom/saved-model").performClick()
    composeRule.onNodeWithText("Search models").performScrollTo().performTextReplacement("report")
    composeRule.onNodeWithText("Cancel").performScrollTo()
    capture("choices")
    composeRule.onNodeWithText("writing/report-model").performClick()
    assertEquals("writing/report-model", (draft.value.edit.payload as GatewayCronPayloadEdit.AgentTurn).model)
    assertTrue(writes.isEmpty())
    composeRule.onNodeWithText("Save Changes").performScrollTo().performClick()
    assertEquals(
      "\"writing/report-model\"",
      Json
        .parseToJsonElement(writes.single())
        .jsonObject["patch"]!!
        .jsonObject["payload"]!!
        .jsonObject["model"]
        .toString(),
    )
    composeRule.runOnIdle {
      val saved = original.copy(payloadModel = "writing/report-model", configRevision = "proof-v2")
      job.value = saved
      draft.value = draft.value.observeSaveNotice(GatewayCronNoticeKind.Success).observeJob(saved)
    }
    assertFalse(draft.value.isDirty)
    composeRule.onNodeWithText("Writing model").performScrollTo().performClick()
    composeRule.onNodeWithText("Default model").performScrollTo().performClick()
    assertEquals("", (draft.value.edit.payload as GatewayCronPayloadEdit.AgentTurn).model)
  }

  @Test fun preservesCustomDraftOnCancelAndRetainsReadOnlyAndUnavailableStates() {
    val value = mutableStateOf("custom/saved-model")
    val enabled = mutableStateOf(true)
    var refreshes = 0
    composeRule.setContent {
      ClawDesignTheme {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
          CronModelEditor(value.value, enabled.value, catalog(), { refreshes += 1 }) { value.value = it }
        }
      }
    }
    composeRule.onNodeWithText("custom/saved-model").performClick()
    composeRule.onNodeWithText("Unavailable model").performScrollTo().assertIsNotEnabled()
    composeRule.onNodeWithText("Hidden model").assertDoesNotExist()
    composeRule.onNodeWithText("Enter another model").performScrollTo().performClick()
    composeRule.onNodeWithText("Custom model").performScrollTo().performTextReplacement("another/custom-model")
    composeRule.onNodeWithText("Cancel").performScrollTo().performClick()
    assertEquals("custom/saved-model", value.value)
    composeRule.onNodeWithText("custom/saved-model").performScrollTo().performClick()
    composeRule.onNodeWithText("Enter another model").performScrollTo().performClick()
    composeRule.onNodeWithText("Custom model").performScrollTo().performTextReplacement("another/custom-model")
    composeRule.onNodeWithText("Use model").performScrollTo().performClick()
    assertEquals("another/custom-model", value.value)
    assertEquals(2, refreshes)
    composeRule.runOnIdle { enabled.value = false }
    composeRule.onNodeWithText("another/custom-model").assertIsNotEnabled()
  }

  private fun catalog() = GatewayCronModelChoices(parseGatewayModelCatalog(Json.parseToJsonElement("""{"models":[{"provider":"writing","id":"report-model","name":"Writing model"},{"provider":"review","id":"report-model","name":"Review model"},{"provider":"writing","id":"locked","name":"Unavailable model","available":false},{"provider":"writing","id":"hidden","name":"Hidden model","manualSelectionAllowed":false}]}""").jsonObject).models)

  private fun capture(name: String) {
    val directory = File("build/outputs/cron-model-proof", UUID.randomUUID().toString())
    check(directory.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    File(directory, name + ".png").outputStream().use { check(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    println("Cron model proof: " + File(directory, name + ".png").absolutePath)
  }
}
