package ai.openclaw.app.ui

import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewaySummaryState
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class ChannelsSettingsScreenTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun refreshFollowsConnectionsAndExplicitRequests() {
    var state by mutableStateOf(GatewaySummaryState<GatewayChannelsSummary>())
    var connected by mutableStateOf(false)
    var mounted by mutableStateOf(true)
    var refreshes = 0
    composeRule.setContent {
      if (mounted) {
        ClawDesignTheme {
          ChannelsSettingsScreen(state = state, isConnected = connected, onRefresh = { refreshes++ }, onBack = {})
        }
      }
    }
    try {
      composeRule.onNodeWithText("Refresh").assertIsNotEnabled()
      composeRule.runOnIdle { assertEquals(0, refreshes) }

      composeRule.runOnIdle { connected = true }
      composeRule.onNodeWithText("Refresh").assertIsEnabled()
      composeRule.runOnIdle { assertEquals(1, refreshes) }

      composeRule.runOnIdle { state = state.copy(refreshing = true) }
      composeRule.onNodeWithText("Refreshing").assertIsNotEnabled()
      composeRule.runOnIdle { state = state.copy(refreshing = false) }
      composeRule.onNodeWithText("Refresh").assertIsEnabled()
      composeRule.runOnIdle { assertEquals(1, refreshes) }

      composeRule.onNodeWithText("Refresh").performClick()
      composeRule.runOnIdle { assertEquals(2, refreshes) }

      composeRule.runOnIdle { connected = false }
      composeRule.onNodeWithText("Refresh").assertIsNotEnabled()
      composeRule.runOnIdle { connected = true }
      composeRule.onNodeWithText("Refresh").assertIsEnabled()
      composeRule.runOnIdle { assertEquals(3, refreshes) }
    } finally {
      composeRule.runOnIdle { mounted = false }
      composeRule.waitForIdle()
    }
  }
}
