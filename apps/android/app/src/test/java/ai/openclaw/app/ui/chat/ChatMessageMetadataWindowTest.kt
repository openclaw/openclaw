package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.res.Configuration
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
class ChatMessageMetadataWindowTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun openDetailsKeepTheCallersChangingTextDensity() {
    val scale = mutableStateOf(1.4f)
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, scale.value)) {
        ClawDesignTheme {
          ChatMessageTimestamp(1_789_776_060_000, listOf("Model" to "example-model"))
        }
      }
    }
    composeRule.onNode(hasClickAction()).performClick()
    for (expected in listOf(1.4f, 0.9f)) {
      composeRule.runOnIdle { scale.value = expected }
      val layouts = mutableListOf<TextLayoutResult>()
      composeRule
        .onNodeWithText("Model: example-model", useUnmergedTree = true)
        .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      assertEquals(
        expected,
        layouts
          .single()
          .layoutInput.density.fontScale,
        0.001f,
      )
    }
  }

  @Test
  fun timestampsAndOpenDetailsFollowConfigurationLocaleChanges() {
    val timestamp = 1_789_776_060_000L
    val globalLocale = Locale.getDefault()
    val changedLocale = if (globalLocale.language == "fr") Locale.US else Locale.FRANCE
    val configuration = mutableStateOf(Configuration(RuntimeEnvironment.getApplication().resources.configuration).apply { setLocale(globalLocale) })

    fun clock(
      time: Long,
      locale: Locale,
    ) = DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(Date(time))

    fun absolute(
      time: Long,
      locale: Locale,
    ) = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.LONG, locale).format(Date(time))
    composeRule.setContent {
      CompositionLocalProvider(LocalConfiguration provides configuration.value) {
        ClawDesignTheme {
          Column {
            ChatMessageTimestamp(timestamp, listOf("Model" to "example-model"))
            ChatMessageTimestamp(timestamp + 60_000, emptyList())
          }
        }
      }
    }
    composeRule.onNodeWithText(clock(timestamp, globalLocale)).assertIsDisplayed()
    composeRule.onNode(hasClickAction()).performClick()
    composeRule.onNodeWithText(absolute(timestamp, globalLocale)).assertIsDisplayed()
    composeRule.runOnIdle { configuration.value = Configuration(configuration.value).apply { setLocale(changedLocale) } }
    composeRule.onNodeWithText(clock(timestamp, changedLocale)).assertIsDisplayed()
    composeRule.onNodeWithText(clock(timestamp + 60_000, changedLocale)).assertIsDisplayed()
    composeRule.onNodeWithContentDescription(absolute(timestamp + 60_000, changedLocale)).assertIsDisplayed()
    composeRule.onNodeWithText(absolute(timestamp, changedLocale)).assertIsDisplayed()
    composeRule.onNodeWithText(absolute(timestamp, globalLocale)).assertDoesNotExist()
    assertEquals("The app configuration changed without changing the process locale", globalLocale, Locale.getDefault())
  }
}
