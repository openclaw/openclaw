package ai.openclaw.app.ui

import ai.openclaw.app.CronEditorDraftState
import ai.openclaw.app.GatewayCronActionState
import ai.openclaw.app.GatewayCronJobDetail
import ai.openclaw.app.GatewayCronRunHistoryState
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.parseGatewayCronJobDetail
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.os.LocaleListCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CronDeletionIdentityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Before
  fun setUp() {
    NativeStringResources.install(RuntimeEnvironment.getApplication())
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
  }

  @After
  fun tearDown() {
    NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
  }

  @Test
  fun confirmationIdentifiesTheAutomationAndCancellationDoesNotDeleteIt() {
    val job = automation("d76e4c30-3d24-4ad2-8d01-fda4eab3b104", "Daily report")
    val selected = mutableStateOf(job)
    val deleted = mutableListOf<String>()
    showPanel(selected, deleted)

    openConfirmation()
    inDialog(job.name).assertIsDisplayed()
    inDialog(job.id).assertIsDisplayed()
    inDialog("This permanently removes the automation and its schedule from the gateway.").assertIsDisplayed()
    assertEquals(emptyList<String>(), deleted)

    inDialog("Cancel").performClick()
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    assertEquals(emptyList<String>(), deleted)

    openConfirmation()
    inDialog(job.name).assertIsDisplayed()
    inDialog(job.id).assertIsDisplayed()
    inDialog("Delete").performClick()
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    assertEquals(listOf(job.id), deleted)
  }

  @Test
  fun changingToAnEquallyNamedAutomationRetiresTheOldConfirmation() {
    val first = automation("d76e4c30-3d24-4ad2-8d01-fda4eab3b104", "Daily report")
    val second = automation("7c9b6d8e-0e4c-4a53-b93f-7cf58aac6f76", "Daily report")
    val selected = mutableStateOf(first)
    val deleted = mutableListOf<String>()
    showPanel(selected, deleted)

    openConfirmation()
    inDialog(first.id).assertIsDisplayed()
    composeRule.runOnIdle { selected.value = second }
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    assertEquals(emptyList<String>(), deleted)

    openConfirmation()
    inDialog(second.name).assertIsDisplayed()
    inDialog(second.id).assertIsDisplayed()
    inDialog(first.id).assertDoesNotExist()
    inDialog("Delete").performClick()
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertDoesNotExist()
    assertEquals(listOf(second.id), deleted)
  }

  private fun openConfirmation() {
    val delete = composeRule.onNodeWithText("Delete Automation")
    delete.performScrollTo()
    delete.performClick()
    composeRule.waitForIdle()
    composeRule.onNode(isDialog()).assertIsDisplayed()
  }

  private fun inDialog(text: String): SemanticsNodeInteraction = composeRule.onNode(hasText(text) and hasAnyAncestor(isDialog()))

  private fun showPanel(
    selected: State<GatewayCronJobDetail>,
    deleted: MutableList<String>,
  ) {
    composeRule.setContent {
      val job = selected.value
      ClawDesignTheme {
        Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
          CronJobManagementPanel(
            job = job,
            editorDraft = CronEditorDraftState.from(job),
            onEditorDraftChange = {},
            historyState = GatewayCronRunHistoryState.Idle,
            actionState = GatewayCronActionState.Idle,
            runPending = false,
            operatorAdminScopeAvailable = true,
            onRun = {},
            onToggleEnabled = {},
            onSave = {},
            onRefreshHistory = {},
            onDelete = { deleted.add(job.id) },
          )
        }
      }
    }
  }

  private fun automation(
    id: String,
    name: String,
  ): GatewayCronJobDetail {
    val payload =
      Json.parseToJsonElement(
        """
        {
          "id": "$id",
          "name": "$name",
          "enabled": true,
          "createdAtMs": 1000,
          "updatedAtMs": 2000,
          "sessionTarget": "isolated",
          "wakeMode": "now",
          "schedule": { "kind": "every", "everyMs": 60000 },
          "payload": { "kind": "agentTurn", "message": "Write a synthetic report." },
          "state": {}
        }
        """.trimIndent(),
      )
    return requireNotNull(parseGatewayCronJobDetail(payload.jsonObject))
  }
}
