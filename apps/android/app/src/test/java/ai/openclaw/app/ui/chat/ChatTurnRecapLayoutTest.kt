package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatTurnRecapLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun completedTurnKeepsTokensReadableAtLargeTextAndInlineAtStandardText() {
    val fontScale = mutableStateOf(2.8f)
    composeRule.setContent {
      val density = LocalDensity.current
      CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale.value)) {
        ClawDesignTheme {
          Box(Modifier.width(320.dp)) {
            ChatTurnRecapRow(TurnRecap(runtimeMs = 90_000L, outputTokens = 1_234L))
          }
        }
      }
    }

    val tokens = composeRule.onNodeWithText("1.2k tokens", useUnmergedTree = true)
    val duration = composeRule.onNode(hasText("Done in", substring = true), useUnmergedTree = true)
    val largeTokens = tokens.textLayout()
    assertTrue("The token total must receive visible width", largeTokens.size.width > 0)
    assertEquals(2.8f, largeTokens.layoutInput.density.fontScale, 0.001f)
    assertEquals("The short token total must fit on one line", 1, largeTokens.lineCount)
    assertFalse(largeTokens.didOverflowHeight)
    tokens.assertIsDisplayed()
    duration.assertIsDisplayed()
    assertTrue(
      "The token group must wrap below a full-width duration",
      tokens.fetchSemanticsNode().boundsInRoot.top >= duration.fetchSemanticsNode().boundsInRoot.bottom,
    )

    composeRule.runOnIdle { fontScale.value = 1f }
    val standardTokens = tokens.textLayout()
    assertEquals(1f, standardTokens.layoutInput.density.fontScale, 0.001f)
    assertEquals(1, standardTokens.lineCount)
    assertFalse(standardTokens.didOverflowHeight)
    assertEquals(
      "Ordinary text keeps the compact inline recap",
      duration.fetchSemanticsNode().boundsInRoot.top,
      tokens.fetchSemanticsNode().boundsInRoot.top,
      1f,
    )
  }

  @Test
  fun durationWithoutTokenMetadataDoesNotRenderASeparator() {
    composeRule.setContent {
      ClawDesignTheme {
        Box(Modifier.width(320.dp)) {
          ChatTurnRecapRow(TurnRecap(runtimeMs = 90_000L, outputTokens = null))
        }
      }
    }

    composeRule.onNode(hasText("Done in", substring = true)).assertIsDisplayed()
    composeRule.onNodeWithText("·").assertDoesNotExist()
    composeRule.onNodeWithText("tokens", substring = true).assertDoesNotExist()
  }

  private fun SemanticsNodeInteraction.textLayout(): TextLayoutResult {
    val layouts = mutableListOf<TextLayoutResult>()
    performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    return layouts.single()
  }
}
