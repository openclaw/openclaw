package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertWidthIsAtLeast
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
class SettingsTogglePanelTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun labeledSwitchOwnsStateAndTheWholeRowTouchTarget() {
    var checked by mutableStateOf(false)
    val requests = mutableListOf<Boolean>()
    composeRule.setContent {
      ClawDesignTheme {
        SettingsTogglePanel(
          listOf(
            SettingsToggleRow("Camera", "Allow camera tools when requested", Icons.Default.CameraAlt, checked, {
              requests.add(it)
              checked = it
            }),
          ),
        )
      }
    }

    val row = composeRule.onNodeWithText("Camera")
    row
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
      .assertTextEquals("Camera", "Allow camera tools when requested")
      .assertIsOff()
      .assertHeightIsAtLeast(60.dp)
      .assertWidthIsAtLeast(300.dp)
    composeRule.onAllNodes(hasClickAction(), useUnmergedTree = true).assertCountEquals(1)

    row.performClick().assertIsOn()
    row.performTouchInput { click(Offset(width - 36.dp.toPx(), centerY)) }.assertIsOff()
    row.performTouchInput { click(Offset(12.dp.toPx(), centerY)) }.assertIsOn()
    assertEquals(listOf(true, false, true), requests)
  }

  @Test
  fun disabledSwitchKeepsItsLabelAndStateWithoutAcceptingTouches() {
    var requests = 0
    composeRule.setContent {
      ClawDesignTheme {
        SettingsTogglePanel(
          listOf(SettingsToggleRow("Camera", "Unavailable", Icons.Default.CameraAlt, true, { requests++ }, enabled = false)),
        )
      }
    }

    val row = composeRule.onNodeWithText("Camera")
    row
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
      .assertTextEquals("Camera", "Unavailable")
      .assertIsOn()
      .assertIsNotEnabled()
    composeRule.onAllNodes(hasClickAction(), useUnmergedTree = true).assertCountEquals(1)
    row.performTouchInput { click() }
    assertEquals(0, requests)
  }
}
