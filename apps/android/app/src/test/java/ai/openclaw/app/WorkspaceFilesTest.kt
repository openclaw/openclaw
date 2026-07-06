package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceFilesTest {
  @Test
  fun listParamsIncludeAgentIdAndSkipRootPath() {
    val root = Json.parseToJsonElement(workspaceListParams("main", "")).jsonObject
    assertEquals("\"main\"", root["agentId"].toString())
    assertNull(root["path"])
    assertNull(root["offset"])

    val nested = Json.parseToJsonElement(workspaceListParams("main", "src/app", offset = 250)).jsonObject
    assertEquals("\"src/app\"", nested["path"].toString())
    assertEquals("250", nested["offset"].toString())
  }

  @Test
  fun parsesListingWithDirectoriesFilesAndTruncation() {
    val payload =
      """
      {
        "agentId": "main",
        "workspace": "/tmp/ws",
        "path": "src",
        "parentPath": "",
        "entries": [
          {"path": "src/app", "name": "app", "kind": "directory", "updatedAtMs": 1},
          {"path": "src/index.ts", "name": "index.ts", "kind": "file", "size": 42, "updatedAtMs": 2}
        ],
        "truncated": true
      }
      """.trimIndent()
    val listing = parseGatewayWorkspaceListing(Json.parseToJsonElement(payload).jsonObject)

    requireNotNull(listing)
    assertEquals("src", listing.path)
    assertEquals("", listing.parentPath)
    assertTrue(listing.truncated)
    assertEquals(2, listing.entries.size)
    assertTrue(listing.entries[0].isDirectory)
    assertFalse(listing.entries[1].isDirectory)
    assertEquals(42L, listing.entries[1].size)
  }

  @Test
  fun rejectsListingWithoutEntries() {
    val payload = """{"agentId": "main", "workspace": "/tmp/ws", "path": ""}"""
    assertNull(parseGatewayWorkspaceListing(Json.parseToJsonElement(payload).jsonObject))
  }

  @Test
  fun parsesTextAndBase64FilePreviews() {
    val text =
      """
      {
        "agentId": "main",
        "workspace": "/tmp/ws",
        "file": {
          "path": "notes/todo.md",
          "name": "todo.md",
          "size": 6,
          "updatedAtMs": 3,
          "encoding": "utf8",
          "mimeType": "text/markdown",
          "content": "# Todo"
        }
      }
      """.trimIndent()
    val textFile = parseGatewayWorkspaceFilePreview(Json.parseToJsonElement(text).jsonObject)
    requireNotNull(textFile)
    assertFalse(textFile.isBase64)
    assertEquals("# Todo", textFile.content)
    assertEquals("text/markdown", textFile.mimeType)

    val image =
      """
      {
        "agentId": "main",
        "workspace": "/tmp/ws",
        "file": {
          "path": "pixel.png",
          "name": "pixel.png",
          "size": 2,
          "updatedAtMs": 4,
          "encoding": "base64",
          "mimeType": "image/png",
          "content": "iVA="
        }
      }
      """.trimIndent()
    val imageFile = parseGatewayWorkspaceFilePreview(Json.parseToJsonElement(image).jsonObject)
    requireNotNull(imageFile)
    assertTrue(imageFile.isBase64)
    assertEquals("image/png", imageFile.mimeType)
  }

  @Test
  fun rejectsFilePreviewWithoutContent() {
    val payload =
      """
      {
        "agentId": "main",
        "workspace": "/tmp/ws",
        "file": {"path": "big.log", "name": "big.log", "size": 999, "updatedAtMs": 5, "encoding": "utf8"}
      }
      """.trimIndent()
    assertNull(parseGatewayWorkspaceFilePreview(Json.parseToJsonElement(payload).jsonObject))
  }
}
