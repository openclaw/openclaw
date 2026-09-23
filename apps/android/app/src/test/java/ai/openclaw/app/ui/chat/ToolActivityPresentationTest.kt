package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatToolActivity
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test

class ToolActivityPresentationTest {
  @Test
  fun `summaries consume prepared titles and outcomes instead of tool names`() {
    val quiet =
      ai.openclaw.app.chat
        .ChatAgentActivity("wait", "tool", "end", "Wait", status = "completed", hideFromChannelProgress = true)
    val failed =
      ai.openclaw.app.chat
        .ChatAgentActivity("failed", "tool", "end", "Check process", status = "failed")
    val unknown =
      ai.openclaw.app.chat
        .ChatAgentActivity("unknown", "tool", "end", "Outcome unknown")
    val tools =
      listOf(
        tool("process").copy(activity = quiet, activityPrepared = true),
        tool("arbitrary_name").copy(activity = failed, activityPrepared = true),
        tool("read").copy(activity = unknown, activityPrepared = true),
      )
    assertEquals("Check process (failed), Outcome unknown", completedToolGroupSummary(tools))
    assertEquals("Tool details", completedToolGroupSummary(listOf(tools.first())))
    assertEquals("Tool details", completedToolGroupSummary(emptyList()))
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
