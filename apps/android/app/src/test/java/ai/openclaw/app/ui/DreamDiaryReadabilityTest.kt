package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDreamDiaryEntry
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.GatewaySummaryState
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.ClawDesignTheme
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class DreamDiaryReadabilityTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun diaryBodyRemainsFullyReadableWhenAShortEntryIsReplacedByALongerEntry() {
    val shortBody = "Connected the morning notes."
    var state by mutableStateOf(diaryState(shortBody))
    var mounted by mutableStateOf(true)
    try {
      composeRule.setContent {
        if (mounted) {
          ClawDesignTheme {
            Box(Modifier.width(360.dp)) {
              DreamingSettingsScreen(state = state, isConnected = true, onRefresh = {}, onBack = {})
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
      composeRule.runOnIdle { state = diaryState(longBody) }
      val longLayout = bodyLayout(longBody)
      assertFalse("The diary has no detail action: its complete body must be readable", longLayout.didOverflowHeight)
      assertTrue("The fixture must exercise more than two lines", longLayout.lineCount > 2)
      assertEquals(longBody.length, longLayout.getLineEnd(longLayout.lineCount - 1, visibleEnd = true))

      composeRule.runOnIdle { state = diaryState(shortBody) }
      assertEquals(1, bodyLayout(shortBody).lineCount)
      composeRule.onNodeWithText(longBody).assertDoesNotExist()
    } finally {
      composeRule.runOnIdle { mounted = false }
      composeRule.waitForIdle()
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
