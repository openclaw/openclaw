package ai.openclaw.app.ui

import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AgentPickerTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun unknownSelectionRemainsVisibleAndCanSwitchToAnAvailableAgent() {
    var selectedAgentId: String? = null
    composeRule.setContent {
      ClawDesignTheme {
        AgentPicker(
          state =
            AgentPickerState(
              agents = listOf(GatewayAgentSummary(id = "main", name = "Main", emoji = null, kind = null)),
              selectedAgentId = "missing",
            ),
          onSelectAgent = { selectedAgentId = it },
        )
      }
    }

    composeRule.onNodeWithText("missing").assertIsDisplayed().performClick()
    composeRule
      .onNodeWithText("Main")
      .assertIsDisplayed()
      .assertIsNotSelected()
      .performClick()

    assertEquals("main", selectedAgentId)
  }

  @Test
  fun menuExposesCurrentSelectionAfterSwitchingAgents() {
    val selectedAgentId = mutableStateOf("main")
    val agents =
      listOf(
        GatewayAgentSummary(id = "main", name = "Main", emoji = null, kind = null),
        GatewayAgentSummary(id = "work", name = "Work", emoji = null, kind = null),
      )
    composeRule.setContent {
      ClawDesignTheme {
        AgentPicker(
          state = AgentPickerState(agents = agents, selectedAgentId = selectedAgentId.value),
          onSelectAgent = { selectedAgentId.value = it },
        )
      }
    }

    composeRule.onNodeWithText("Main").performClick()
    composeRule.onNode(hasText("Main") and hasAnyAncestor(isPopup())).assertIsSelected()
    composeRule.onNodeWithText("Work").assertIsNotSelected().performClick()
    composeRule.onNode(isPopup()).assertDoesNotExist()
    assertEquals("work", selectedAgentId.value)

    composeRule.onNodeWithText("Work").performClick()
    composeRule.onNode(hasText("Work") and hasAnyAncestor(isPopup())).assertIsSelected()
    composeRule.onNodeWithText("Main").assertIsNotSelected().performClick()
    assertEquals("main", selectedAgentId.value)
  }

  @Test
  fun compactPickerLeavesRoomForSidebarHeaderActions() {
    composeRule.setContent {
      ClawDesignTheme {
        Row(Modifier.width(360.dp)) {
          AgentPicker(
            state =
              AgentPickerState(
                agents = listOf(GatewayAgentSummary(id = "main", name = "A very long custom agent name that must not hide header actions", emoji = null, kind = null)),
                selectedAgentId = "main",
              ),
            onSelectAgent = {},
          )
          Spacer(Modifier.weight(1f))
          repeat(3) { index ->
            Box(Modifier.size(48.dp).testTag("header-action-$index"))
          }
        }
      }
    }

    composeRule.onNodeWithTag("header-action-2").assertIsDisplayed()
  }
}
