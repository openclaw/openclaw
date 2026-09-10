package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.i18n.nativeString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

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
  val segments = mutableListOf<String>()
  val counts = mutableMapOf<CompletedToolKind, Int>()
  val others = mutableListOf<ChatToolActivity>()
  tools.forEach { tool ->
    val kind = completedToolKind(tool.name)
    counts[kind] = (counts[kind] ?: 0) + 1
    if (kind == CompletedToolKind.Progress || kind == CompletedToolKind.Other) others += tool
  }

  fun count(kind: CompletedToolKind) = counts[kind] ?: 0
  val commands = count(CompletedToolKind.Command)
  if (commands > 0) segments += if (commands == 1) nativeString("ran a command") else nativeString("ran \$count commands", commands)
  listOf(
    CompletedToolKind.Read to (nativeString("read a file") to { count: Int -> nativeString("read \$count files", count) }),
    CompletedToolKind.Edit to (nativeString("edited a file") to { count: Int -> nativeString("edited \$count files", count) }),
    CompletedToolKind.Write to (nativeString("created a file") to { count: Int -> nativeString("created \$count files", count) }),
    CompletedToolKind.Search to (nativeString("ran a search") to { count: Int -> nativeString("ran \$count searches", count) }),
    CompletedToolKind.Fetch to (nativeString("fetched a page") to { count: Int -> nativeString("fetched \$count pages", count) }),
  ).forEach { (kind, labels) ->
    val amount = count(kind)
    if (amount > 0) segments += if (amount == 1) labels.first else labels.second(amount)
  }
  if (others.isNotEmpty()) {
    val names = others.map { completedToolDisplayName(it.name) }.distinct()
    segments +=
      if (names.size <= 2) {
        val suffix = if (others.size > names.size) nativeString(" ×\$count", others.size) else ""
        nativeString("used \$names\$suffix", names.joinToString(", "), suffix)
      } else {
        nativeString("used \$count tools", others.size)
      }
  }
  if (segments.isEmpty()) return nativeString("Ran \$count tool calls", tools.size)
  return segments.joinToString(", ").replaceFirstChar { it.uppercase() }
}

internal fun completedCommandText(
  tool: ChatToolActivity,
  singleLine: Boolean = true,
): String? {
  val raw =
    tool.arguments.string("command")
      ?: tool.arguments.string("cmd")
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
    val completed = steps.count { it.string("status") == "completed" }
    val current =
      steps.firstOrNull { it.string("status") == "in_progress" }
        ?: steps.firstOrNull { it.string("status") == "pending" }
        ?: steps.lastOrNull { it.string("status") == "completed" }
    return nativeString("Progress updated — \$completed/\$total · \$step", completed, steps.size, current?.string("step").orEmpty()).trimEnd(' ', '·')
  }
  return if (!args.string("markdown").isNullOrBlank()) nativeString("Progress note updated") else nativeString("Progress cleared")
}

private fun JsonObject?.string(key: String): String? = (this?.get(key) as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)
