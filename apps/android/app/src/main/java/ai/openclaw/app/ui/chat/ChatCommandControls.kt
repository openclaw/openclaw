package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatCommandEntry
import java.util.Locale

internal fun slashCommandQuery(input: String): String? {
  val trimmed = input.trimStart()
  if (!trimmed.startsWith("/")) return null
  val token = trimmed.drop(1).takeWhile { !it.isWhitespace() }
  return token.lowercase(Locale.US)
}

internal fun isNewChatSlashCommand(input: String): Boolean =
  when (slashCommandQuery(input)) {
    "new", "reset" -> input.trim().count { it.isWhitespace() } == 0
    else -> false
  }

internal fun shouldShowSlashCommandMenu(input: String): Boolean = slashCommandQuery(input) != null

internal fun matchingSlashCommands(
  input: String,
  commands: List<ChatCommandEntry>,
  limit: Int = 6,
): List<ChatCommandEntry> {
  val query = slashCommandQuery(input) ?: return emptyList()
  val uniqueCommands = commands.distinctBy { slashCommandText(it) }
  val matches =
    if (query.isEmpty()) {
      uniqueCommands
    } else {
      uniqueCommands.filter { command ->
        slashCommandPrefixes(command).any { prefix -> prefix.startsWith(query) }
      }
    }
  return matches.take(limit)
}

internal fun slashCommandText(command: ChatCommandEntry): String {
  command.textAliases
    .firstOrNull { alias -> alias.startsWith("/") && alias.length > 1 }
    ?.let { return it }
  val name = command.name.trim().removePrefix("/").takeIf { it.isNotEmpty() } ?: "help"
  return "/$name"
}

internal fun slashCommandCompletion(command: ChatCommandEntry): String {
  val text = slashCommandText(command)
  return if (command.acceptsArgs) "$text " else text
}

private fun slashCommandPrefixes(command: ChatCommandEntry): List<String> =
  buildList {
    add(command.name.trim().removePrefix("/").lowercase(Locale.US))
    command.textAliases.forEach { alias ->
      add(alias.trim().removePrefix("/").lowercase(Locale.US))
    }
  }.filter { it.isNotEmpty() }
