package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ToolDisplayConfig
import ai.openclaw.app.chat.unwrapToolCallForDisplay
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.IntegrationInstructions
import androidx.compose.material.icons.filled.Language
import androidx.compose.material.icons.filled.Mail
import androidx.compose.material.icons.filled.PendingActions
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Terminal
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test
import java.io.File

class ToolActivityIconsTest {
  private val config =
    ToolDisplayConfig.parse(
      generateSequence(File(checkNotNull(System.getProperty("user.dir"))).absoluteFile) { it.parentFile }
        .map { it.resolve("apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json") }
        .first { it.isFile }
        .readText(),
    )

  @Test
  fun `every shared icon and row kind has a native vector`() {
    val icons =
      config.tools.values.map { it.icon } + config.fallback.icon +
        listOf("squareTerminal", "fileText", "pencil", "fileCode", "search", "globe")

    icons.toSet().forEach { name ->
      assertNotNull("Missing Android glyph for $name", toolIconVectors[name])
    }
  }

  @Test
  fun `row kind overrides shared icons and other tools use config then fallback`() {
    val cases =
      mapOf(
        "exec" to Icons.Default.Terminal,
        "read_file" to Icons.Default.Description,
        "edit" to Icons.Default.Edit,
        "notebook_edit" to Icons.Default.Edit,
        "write" to Icons.Default.IntegrationInstructions,
        "grep" to Icons.Default.Search,
        "fetch" to Icons.Default.Language,
        " WEB_SEARCH " to Icons.Default.Search,
        "web_fetch" to Icons.Default.Language,
        "message" to Icons.Default.Mail,
        "cron" to Icons.Default.PendingActions,
        "memory_search" to Icons.Default.Search,
        "image_generate" to Icons.Default.Image,
        "sessions_spawn" to Icons.Default.SmartToy,
        "browser" to Icons.Default.Language,
        "custom_search" to Icons.Default.Extension,
      )

    cases.forEach { (name, expected) ->
      assertSame(name, expected, config.iconForTool(name))
    }
    val alternateFallback = ToolDisplayConfig.parse("""{"tools":{},"fallback":{"icon":"image"}}""")
    assertSame(Icons.Default.Image, alternateFallback.iconForTool("unknown"))
  }

  @Test
  fun `dispatcher rows resolve the called tool and unknown plugins use puzzle`() {
    listOf(
      "openclaw:default:message" to Icons.Default.Mail,
      "mcp:github:search_issues" to Icons.Default.Extension,
    ).forEach { (id, expected) ->
      listOf("dispatch_action", "tool_call").forEach { dispatcher ->
        val call =
          unwrapToolCallForDisplay(
            dispatcher,
            Json.parseToJsonElement("""{"id":"$id","args":{}}""").jsonObject,
          )
        assertSame(id, expected, config.iconForTool(call.name))
      }
    }
  }
}
