package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.nonBlankString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

internal enum class CompletedToolKind { Command, Read, Edit, Write, Search, Fetch, Progress, Other }

internal fun completedToolKind(name: String): CompletedToolKind =
  when (name.trim().lowercase()) {
    "bash", "exec", "shell", "run_command", "run_terminal_cmd", "terminal", "exec_command" -> CompletedToolKind.Command
    "read", "read_file", "readfile", "notebookread", "notebook_read" -> CompletedToolKind.Read
    "edit", "edit_file", "multiedit", "multi_edit", "apply_patch", "applypatch", "patch" -> CompletedToolKind.Edit
    "write", "write_file", "create_file" -> CompletedToolKind.Write
    "grep", "find", "glob", "ls", "list", "codebase_search" -> CompletedToolKind.Search
    "web_fetch", "webfetch", "fetch" -> CompletedToolKind.Fetch
    "progress_card" -> CompletedToolKind.Progress
    else -> CompletedToolKind.Other
  }

internal fun completedToolDisplayName(name: String): String =
  when (name.trim().lowercase()) {
    "progress_card" -> "Progress Card"
    "cua_repl", "cua_repl.js" -> "Cua Repl.js"
    else -> readableToolName(name)
  }

internal fun completedToolGroupSummary(tools: List<ChatToolActivity>): String {
  val items =
    tools
      .mapNotNull { it.activity }
      .filter { !it.suppressChannelProgress }
      .associateBy { it.toolCallId ?: it.itemId }
      .values
      .filter { it.isVisible }
  if (items.isEmpty()) return nativeString("Tool details")
  return items.groupingBy { if (it.status == "failed" || it.status == "blocked") nativeString("\${it.title} (\${it.status})", it.title, it.status) else it.title }.eachCount().entries.joinToString(", ") { (title, count) ->
    if (count == 1) title else nativeString("\$title ×\$count", title, count)
  }
}

internal fun completedCommandText(
  tool: ChatToolActivity,
  singleLine: Boolean = true,
): String? {
  val raw =
    tool.arguments.nonBlankString("command")
      ?: tool.arguments.nonBlankString("cmd")
      ?: tool.detail?.substringAfter(": ", tool.detail)
  var command = raw?.trim()?.takeIf(String::isNotEmpty) ?: return null
  command = command.replace(Regex("^(?:/bin/)?(?:bash|zsh|sh)\\s+-lc\\s+"), "").trim()
  if (command.length >= 2 && command.first() == command.last() && command.first() in charArrayOf('\'', '"')) {
    command = command.substring(1, command.lastIndex)
  }
  return if (singleLine) {
    command
      .lineSequence()
      .firstOrNull()
      ?.trim()
      ?.takeIf(String::isNotEmpty)
  } else {
    command
  }
}

internal data class CompletedToolResultPresentation(
  val expandable: Boolean,
  val output: String?,
  val outputLabel: String?,
  val outcome: String?,
)

internal fun completedToolResultPresentation(tool: ChatToolActivity): CompletedToolResultPresentation {
  val result = tool.result?.takeIf { it.isNotBlank() }
  val hasDetail =
    if (completedToolKind(tool.name) == CompletedToolKind.Command) {
      completedCommandText(tool, singleLine = false)?.isNotBlank() == true
    } else {
      tool.detail?.isNotBlank() == true
    }
  return CompletedToolResultPresentation(
    expandable = result != null || hasDetail || tool.isError,
    output = result ?: if (tool.isError) nativeString("No output — tool failed.") else null,
    outputLabel = if (tool.isError) nativeString("Tool error") else null,
    outcome = if (tool.isError) nativeString("Failed") else null,
  )
}

internal fun progressReceiptLabel(tool: ChatToolActivity): String {
  if (tool.isError) return nativeString("Progress update failed")
  val args = tool.arguments
  val steps = (args?.get("plan") as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
  if (steps.isNotEmpty()) {
    val completed = steps.count { it.nonBlankString("status") == "completed" }
    val current =
      steps.firstOrNull { it.nonBlankString("status") == "in_progress" }
        ?: steps.firstOrNull { it.nonBlankString("status") == "pending" }
        ?: steps.lastOrNull { it.nonBlankString("status") == "completed" }
    return nativeString("Progress updated — \$completed/\$total · \$step", completed, steps.size, current?.nonBlankString("step").orEmpty()).trimEnd(' ', '·')
  }
  return if (!args.nonBlankString("markdown").isNullOrBlank()) nativeString("Progress note updated") else nativeString("Progress cleared")
}
