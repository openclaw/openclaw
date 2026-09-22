package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatToolActivity
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class ToolActivityPresentationTest {
  @Test
  fun `matches web group summary grammar`() {
    val tools =
      listOf(
        tool("exec"),
        tool("bash"),
        tool("progress_card"),
        tool("progress_card"),
      )

    assertEquals("Ran 2 commands, used Progress Card ×2", completedToolGroupSummary(tools))
  }

  @Test
  fun `group summaries preserve category grammar and ordering`() {
    val categories =
      listOf(
        Triple("exec", "Ran a command", "Ran 2 commands"),
        Triple("read", "Read a file", "Read 2 files"),
        Triple("edit", "Edited a file", "Edited 2 files"),
        Triple("write", "Created a file", "Created 2 files"),
        Triple("grep", "Ran a search", "Ran 2 searches"),
        Triple("web_fetch", "Fetched a page", "Fetched 2 pages"),
      )
    for ((name, single, multiple) in categories) {
      assertEquals(single, completedToolGroupSummary(listOf(tool(name))))
      assertEquals(multiple, completedToolGroupSummary(listOf(tool(name), tool(name))))
    }
    assertEquals(
      "Ran a command, read a file, edited a file, created a file, ran a search, fetched a page",
      completedToolGroupSummary(categories.reversed().map { tool(it.first) }),
    )
  }

  @Test
  fun `other tool summaries preserve first occurrence order and distinct names`() {
    val cases =
      listOf(
        emptyList<String>() to "Ran 0 tool calls",
        listOf("progress_card") to "Used Progress Card",
        listOf("progress_card", "progress_card") to "Used Progress Card ×2",
        listOf("cua_repl", "progress_card") to "Used Cua Repl.js, Progress Card",
        listOf("cua_repl", "progress_card", "cua_repl") to "Used Cua Repl.js, Progress Card ×3",
        listOf("cua_repl", "progress_card", "other") to "Used 3 tools",
      )
    for ((names, expected) in cases) {
      assertEquals(expected, completedToolGroupSummary(names.map { tool(it) }))
    }
  }

  @Test
  fun `command row omits tool name and shell wrapper`() {
    val tool =
      tool(
        "bash",
        buildJsonObject { put("command", "/bin/zsh -lc 'node scripts/check.mjs'") },
      )

    assertEquals("node scripts/check.mjs", completedCommandText(tool))
  }

  @Test
  fun `expanded terminal retains multiline command while summary stays one line`() {
    val command = "pwd\nprintf done"
    val tool = tool("bash", buildJsonObject { put("command", command) })
    assertEquals("pwd", completedCommandText(tool))
    assertEquals(command, completedCommandText(tool, singleLine = false))
  }

  @Test
  fun `progress note uses web receipt wording`() {
    val note = tool("progress_card", buildJsonObject { put("markdown", "Still working") })
    assertEquals("Progress note updated", progressReceiptLabel(note))
  }

  @Test
  fun `malformed projected strings do not crash command or progress rendering`() {
    val arguments =
      buildJsonObject {
        put("command", buildJsonArray {})
        put("markdown", buildJsonObject {})
      }
    assertEquals(null, completedCommandText(tool("bash", arguments)))
    assertEquals("Progress cleared", progressReceiptLabel(tool("progress_card", arguments)))
  }

  @Test
  fun `progress plan uses web receipt wording`() {
    val plan =
      tool(
        "progress_card",
        buildJsonObject {
          put(
            "plan",
            buildJsonArray {
              add(
                buildJsonObject {
                  put("step", "Inspect")
                  put("status", "completed")
                },
              )
              add(
                buildJsonObject {
                  put("step", "Build APK")
                  put("status", "in_progress")
                },
              )
            },
          )
        },
      )

    assertEquals("Progress updated — 1/2 · Build APK", progressReceiptLabel(plan))
  }

  @Test
  fun `error flag makes blank result expandable with web failure copy`() {
    val presentation = completedToolResultPresentation(tool("read", isError = true))

    assertEquals(true, presentation.expandable)
    assertEquals("Tool error", presentation.outputLabel)
    assertEquals("No output — tool failed.", presentation.output)
    assertEquals("Failed", presentation.outcome)
  }

  @Test
  fun `command errors preserve result and expose failure presentation`() {
    val presentation =
      completedToolResultPresentation(tool("exec", result = "permission denied", isError = true))

    assertEquals(true, presentation.expandable)
    assertEquals("Tool error", presentation.outputLabel)
    assertEquals("permission denied", presentation.output)
    assertEquals("Failed", presentation.outcome)
  }

  @Test
  fun `command without text or output remains nonexpandable and neutral`() {
    val presentation = completedToolResultPresentation(tool("exec"))

    assertEquals(false, presentation.expandable)
    assertEquals(null, presentation.outputLabel)
    assertEquals(null, presentation.output)
    assertEquals(null, presentation.outcome)
  }

  @Test
  fun `commands remain inspectable without output`() {
    val commands = listOf("mkdir -p reports\ncp report.txt reports/", "printf '%s' " + "long-argument".repeat(40))
    for (command in commands) {
      for (result in listOf(null, "", " \n\t")) {
        val call = tool("exec", arguments = buildJsonObject { put("command", command) }, result = result)
        val presentation = completedToolResultPresentation(call)
        assertEquals(true, presentation.expandable)
        assertEquals(command, completedCommandText(call, singleLine = false))
        assertEquals(null, presentation.output)
        assertEquals(null, presentation.outcome)
      }
    }
  }

  private fun tool(
    name: String,
    arguments: kotlinx.serialization.json.JsonObject? = null,
    result: String? = null,
    isError: Boolean = false,
  ) = ChatToolActivity("$name-id", name, null, result, isError, arguments)
}
