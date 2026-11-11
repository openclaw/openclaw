package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
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
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatMarkdownListLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  private val markdown = mutableStateOf("")
  private val fontScale = mutableStateOf(1f)

  @Test
  fun fiveLevelListsKeepReadableTextAtNarrowWidthAndLargeFont() {
    show()
    val failures = mutableListOf<String>()
    val labels =
      listOf(
        "Prepare the release",
        "Review the Android app",
        "Check chat responses",
        "Inspect nested instructions",
        "Keep this final instruction readable without losing its marker.",
      )
    for (scale in listOf(1f, 1.4f)) {
      for ((name, markers) in listOf("bullets" to List(5) { "-" }, "numbers" to List(5) { "1." }, "mixed" to listOf("-", "1.", "-", "1.", "-"))) {
        var indent = ""
        val source =
          labels
            .mapIndexed { index, label ->
              "$indent${markers[index]} $label".also { indent += " ".repeat(markers[index].length + 1) }
            }.joinToString("\n")
        composeRule.runOnIdle {
          fontScale.value = scale
          markdown.value = "Release checklist\n\n$source"
        }
        capture("$name-$scale")
        val nodes = labels.map { composeRule.onNodeWithText(it, useUnmergedTree = true).fetchSemanticsNode() }
        if (nodes.last().size.width < 120) failures += "$name/$scale: deepest text has only ${nodes.last().size.width}px"
        nodes.zipWithNext().forEach { (parent, child) ->
          if (child.positionInRoot.x <= parent.positionInRoot.x) failures += "$name/$scale: nested level lost its indentation"
        }
        val layout = layout(labels.last())
        if (layout.didOverflowWidth || layout.lineCount > 8) failures += "$name/$scale: deepest sentence wraps into ${layout.lineCount} lines"
      }
    }
    assertTrue(failures.joinToString("\n"), failures.isEmpty())
  }

  @Test
  fun numberedAndTaskMarkersStayWholeAndShareTheirListsContentEdge() {
    show()
    val failures = mutableListOf<String>()
    for (scale in listOf(1.4f, 2f)) {
      composeRule.runOnIdle {
        fontScale.value = scale
        markdown.value =
          """
          9. Review the plan.
          10. Run the checks.
          11. Publish the result.

          Release notes

          99. Read the notes.
          100. Verify the release.

          - [ ] Pending review.
          - [x] Completed check.
          - Plain list item.
          """.trimIndent()
      }
      capture("markers-$scale")
      for (marker in listOf("9.", "10.", "11.", "99.", "100.", "☐", "☑", "•")) {
        val layout = layout(marker)
        if (layout.lineCount != 1 || layout.didOverflowWidth) failures += "$marker/$scale: marker wraps or clips"
      }
      for (labels in listOf(listOf("Review the plan.", "Run the checks.", "Publish the result."), listOf("Read the notes.", "Verify the release."), listOf("Pending review.", "Completed check.", "Plain list item."))) {
        val lefts =
          labels.map {
            composeRule
              .onNodeWithText(it, useUnmergedTree = true)
              .fetchSemanticsNode()
              .positionInRoot.x
          }
        assertEquals("Sibling content must align", lefts.first(), lefts.last(), 0.5f)
        labels.forEach { assertFalse("List content must not clip", layout(it).didOverflowWidth) }
      }
    }
    assertTrue(failures.joinToString("\n"), failures.isEmpty())
  }

  private fun show() {
    composeRule.setContent {
      CompositionLocalProvider(LocalDensity provides Density(1f, fontScale.value)) {
        ClawDesignTheme(dark = true) {
          Box(
            Modifier
              .size(360.dp, 800.dp)
              .background(ClawTheme.colors.canvas)
              .testTag("list-viewport")
              .verticalScroll(rememberScrollState())
              .padding(horizontal = 16.dp, vertical = 16.dp),
          ) {
            ChatMessageTextSurface(user = false) {
              ChatMarkdown(text = markdown.value, textColor = ClawTheme.colors.text, bodyStyle = ClawTheme.type.body.copy(fontWeight = FontWeight.Normal))
            }
          }
        }
      }
    }
  }

  private fun layout(text: String): TextLayoutResult {
    val results = mutableListOf<TextLayoutResult>()
    composeRule.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
      assertTrue(it(results))
    }
    return results.single()
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_LIST_PROOF_DIR") ?: return
    val file = File(directory, "$name.png")
    file.parentFile!!.mkdirs()
    file.outputStream().use {
      assertTrue(
        composeRule
          .onNodeWithTag("list-viewport")
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }
}
