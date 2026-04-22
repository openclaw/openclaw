package ai.openclaw.app.tools

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ToolDisplayRegistryTest {
  @Test
  fun resolveReadSummarizesPathRangeAndShortensHomePath() {
    val context = RuntimeEnvironment.getApplication()

    val summary =
      ToolDisplayRegistry.resolve(
        context = context,
        name = "read",
        args =
          buildJsonObject {
            put("path", JsonPrimitive("/home/tester/projects/openclaw/README.md"))
            put("offset", JsonPrimitive(10))
            put("limit", JsonPrimitive(5))
          },
      )

    assertEquals("read", summary.name)
    assertEquals("Read", summary.title)
    assertEquals("read", summary.label)
    assertEquals("~/projects/openclaw/README.md:10-15", summary.detail)
    assertEquals("~/projects/openclaw/README.md:10-15", summary.detailLine)
    assertEquals("🧩 read: ~/projects/openclaw/README.md:10-15", summary.summaryLine)
  }

  @Test
  fun resolveWriteUsesPathDetailWithoutVerb() {
    val context = RuntimeEnvironment.getApplication()

    val summary =
      ToolDisplayRegistry.resolve(
        context = context,
        name = "write",
        args =
          buildJsonObject {
            put("path", JsonPrimitive("/Users/alex/tmp/notes.txt"))
          },
      )

    assertEquals("~/tmp/notes.txt", summary.detail)
    assertNull(summary.verb)
    assertEquals("~/tmp/notes.txt", summary.detailLine)
  }

  @Test
  fun resolveFallsBackToMetaWhenArgsHaveNoDisplayableDetail() {
    val context = RuntimeEnvironment.getApplication()

    val summary =
      ToolDisplayRegistry.resolve(
        context = context,
        name = "mystery_tool",
        args = null,
        meta = "fallback detail",
      )

    assertEquals("fallback detail", summary.detail)
    assertEquals("🧩 mystery_tool: fallback detail", summary.summaryLine)
  }

  @Test
  fun toolDisplaySummaryCombinesVerbAndDetail() {
    val summary =
      ToolDisplaySummary(
        name = "browser",
        emoji = "🌐",
        title = "Browser",
        label = "Browser",
        verb = "open",
        detail = "https://example.com",
      )

    assertEquals("open · https://example.com", summary.detailLine)
    assertEquals("🌐 Browser: open · https://example.com", summary.summaryLine)
    assertTrue(summary.summaryLine.contains("https://example.com"))
  }
}
