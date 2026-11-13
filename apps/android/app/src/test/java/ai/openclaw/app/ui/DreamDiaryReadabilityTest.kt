package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDreamDiaryEntry
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.GatewaySummaryState
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class DreamDiaryReadabilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun diaryBodyRemainsFullyReadableWhenAShortEntryIsReplacedByALongerEntry() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val storage = app.getSharedPreferences("dream-diary-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    var mounted by mutableStateOf(true)
    try {
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("dream-diary", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isConnected").value = true
      val owner = ReflectionHelpers.getField<Any>(runtime, "dreamingSummary")
      val state =
        ReflectionHelpers.getField<MutableStateFlow<GatewaySummaryState<GatewayDreamingSummary>>>(
          owner,
          "mutableState",
        )
      val shortBody = "Connected the morning notes."
      state.value = diaryState(shortBody)
      composeRule.setContent {
        if (mounted) {
          ClawDesignTheme {
            Box(Modifier.width(360.dp)) {
              DreamingSettingsScreen(viewModel = model, onBack = {})
            }
          }
        }
      }
      val shortLayout = bodyLayout(shortBody)
      assertFalse("A short entry must remain readable", shortLayout.didOverflowHeight)
      assertEquals(1, shortLayout.lineCount)

      val longBody =
        "The morning notes connected three separate observations about the same project.\n" +
          "The first described the decision, the second explained the tradeoff, and the third\n" +
          "recorded the follow-up. Keeping these details together preserves the reason for\n" +
          "the decision rather than only its title. The final detail must remain readable."
      composeRule.runOnIdle { state.value = diaryState(longBody) }
      val longLayout = bodyLayout(longBody)
      assertFalse("The diary has no detail action: its complete body must be readable", longLayout.didOverflowHeight)
      assertTrue("The fixture must exercise more than two lines", longLayout.lineCount > 2)
      assertEquals(longBody.length, longLayout.getLineEnd(longLayout.lineCount - 1, visibleEnd = true))

      composeRule.runOnIdle { state.value = diaryState(shortBody) }
      assertEquals(1, bodyLayout(shortBody).lineCount)
      composeRule.onNodeWithText(longBody).assertDoesNotExist()
    } finally {
      try {
        composeRule.runOnIdle { mounted = false }
        composeRule.waitForIdle()
      } finally {
        try {
          try {
            models.clear()
          } finally {
            closeNodeRuntimeTestFixture(runtime)
          }
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
        }
      }
    }
  }

  private fun bodyLayout(body: String): TextLayoutResult {
    val node = composeRule.onNodeWithText(body, useUnmergedTree = true)
    node.performScrollTo()
    node.assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action ->
      assertTrue(action(layouts))
    }
    return layouts.single()
  }

  private fun diaryState(body: String): GatewaySummaryState<GatewayDreamingSummary> =
    GatewaySummaryState(
      summary =
        GatewayDreamingSummary(
          enabled = true,
          diaryFound = true,
          diaryEntries = listOf(GatewayDreamDiaryEntry(date = verbatimText("2026-11-09"), text = body)),
        ),
    )
}
