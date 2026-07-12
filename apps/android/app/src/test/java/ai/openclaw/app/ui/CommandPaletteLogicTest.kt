package ai.openclaw.app.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandPaletteLogicTest {
  @Test
  fun localizedCopyDrivesRenderingAndSearchWithoutChangingActionIdentity() {
    val item =
      CommandItem(
        action = CommandAction.Chat,
        title = "Ouvrir le chat",
        subtitle = "Démarrer ou poursuivre une conversation",
        icon = Icons.Outlined.ChatBubbleOutline,
        onClick = {},
      )

    assertEquals("Ouvrir le chat", item.title)
    assertEquals("Démarrer ou poursuivre une conversation", item.subtitle)
    assertTrue(item.matches("ouvrir"))
    assertTrue(item.matches("OUVRIR"))
    assertTrue(item.matches("conversation"))
    assertFalse(item.matches("open chat"))
    assertTrue(item.copy(title = "İletişim").matches("iletişim"))
    assertEquals(CommandAction.Chat, item.action)
  }

  @Test
  fun accessibilityDescriptionUsesLocalizedActionCopyWithoutDuplicateVerbs() {
    val chatDescription =
      commandActionAccessibilityDescription(CommandAction.Chat, "Ouvrir le chat") { _, _ ->
        error("verb-led commands should use their localized title directly")
      }
    val settingsDescription =
      commandActionAccessibilityDescription(CommandAction.Settings, "Paramètres") { source, title ->
        assertEquals("Open \${row.title}", source)
        "Ouvrir $title"
      }

    assertEquals("Ouvrir le chat", chatDescription)
    assertEquals("Ouvrir Paramètres", settingsDescription)
  }

  @Test
  fun stableActionDispatchDoesNotDependOnLocalizedCopy() {
    val calls = mutableListOf<CommandAction>()
    val item =
      CommandItem(
        action = CommandAction.Voice,
        title = "Démarrer la voix",
        subtitle = "Parler avec OpenClaw",
        icon = Icons.Outlined.ChatBubbleOutline,
        onClick = { calls += CommandAction.Voice },
      )

    item.onClick()

    assertEquals(CommandAction.Voice, item.action)
    assertEquals(listOf(CommandAction.Voice), calls)
  }
}
