package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatCommandEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatCommandControlsTest {
  @Test
  fun matchingSlashCommandsFiltersByNameAndAliasPrefixes() {
    val commands =
      listOf(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          category = "session",
          textAliases = listOf("/new"),
        ),
        ChatCommandEntry(
          name = "model",
          description = "Switch models",
          category = "model",
          textAliases = listOf("/model"),
          acceptsArgs = true,
        ),
        ChatCommandEntry(
          name = "agent",
          description = "Pick runtime",
          category = "agent",
          textAliases = listOf("/agent", "/delegate"),
          acceptsArgs = true,
        ),
      )

    assertEquals(
      listOf("/new", "/model", "/agent"),
      matchingSlashCommands(input = "/", commands = commands).map(::slashCommandText),
    )
    assertEquals(
      listOf("/new"),
      matchingSlashCommands(input = "/n", commands = commands).map(::slashCommandText),
    )
    assertEquals(
      listOf("/model"),
      matchingSlashCommands(input = "/mo", commands = commands).map(::slashCommandText),
    )
    assertEquals(
      listOf("/agent"),
      matchingSlashCommands(input = "/de", commands = commands).map(::slashCommandText),
    )
    assertEquals(emptyList<ChatCommandEntry>(), matchingSlashCommands(input = "/runtime", commands = commands))
    assertEquals(emptyList<ChatCommandEntry>(), matchingSlashCommands(input = "/session", commands = commands))
    assertEquals(emptyList<ChatCommandEntry>(), matchingSlashCommands(input = "hello", commands = commands))
  }

  @Test
  fun newChatSlashCommandsRequireExactToken() {
    assertTrue(isNewChatSlashCommand("/new"))
    assertTrue(isNewChatSlashCommand("  /reset"))
    assertFalse(isNewChatSlashCommand("/new please"))
    assertFalse(isNewChatSlashCommand("/model"))
    assertFalse(isNewChatSlashCommand("plain text"))
  }

  @Test
  fun slashCommandCompletionKeepsArgumentCommandsOpen() {
    assertEquals(
      "/model ",
      slashCommandCompletion(
        ChatCommandEntry(
          name = "model",
          description = "Switch models",
          textAliases = listOf("/model"),
          acceptsArgs = true,
        ),
      ),
    )
    assertEquals(
      "/new",
      slashCommandCompletion(
        ChatCommandEntry(
          name = "new",
          description = "Start fresh",
          textAliases = listOf("/new"),
        ),
      ),
    )
  }
}
