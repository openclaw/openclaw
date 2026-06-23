package ai.openclaw.app

import ai.openclaw.app.node.asObjectOrNull
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayExecApprovalParsingTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun parsesGatewayExecApprovalListPayload() {
    val rows =
      parseGatewayExecApprovalListPayload(
        """
        [
          {
            "id": "approval-2",
            "createdAtMs": 20,
            "expiresAtMs": 120,
            "request": {
              "host": "node",
              "nodeId": "node-1",
              "agentId": "agent-1",
              "command": "Sanitized command",
              "commandPreview": "Sanitized preview",
              "systemRunPlan": {
                "commandText": "/bin/sh -lc 'echo secret'",
                "commandPreview": "echo secret"
              },
              "allowedDecisions": ["allow-once", "deny"]
            }
          },
          {
            "id": "approval-1",
            "createdAtMs": 10,
            "expiresAtMs": 110,
            "request": {
              "host": "gateway",
              "command": "pnpm test --token secret",
              "commandPreview": "pnpm test",
              "unavailableDecisions": ["allow-always"]
            }
          }
        ]
        """.trimIndent(),
        json,
      )

    assertEquals(listOf("approval-1", "approval-2"), rows.map { it.id })
    assertEquals("pnpm test --token secret", rows[0].commandText)
    assertEquals("pnpm test", rows[0].commandPreview)
    assertEquals(emptyList<String>(), rows[0].allowedDecisions)
    assertEquals("Sanitized command", rows[1].commandText)
    assertEquals("Sanitized preview", rows[1].commandPreview)
    assertEquals("node-1", rows[1].nodeId)
    assertEquals("agent-1", rows[1].agentId)
  }

  @Test
  fun parsesGatewayExecApprovalGetPayload() {
    val root =
      json
        .parseToJsonElement(
          """
          {
            "id": "approval-1",
            "commandText": "rm -rf build",
            "commandPreview": "rm build",
            "allowedDecisions": ["allow-once", "allow-always", "deny"],
            "host": "gateway",
            "nodeId": null,
            "agentId": "agent-main",
            "expiresAtMs": 200
          }
          """.trimIndent(),
        ).asObjectOrNull()

    requireNotNull(root)
    val row = parseGatewayExecApprovalDetail(root, createdAtMs = 100)

    requireNotNull(row)
    assertEquals("approval-1", row.id)
    assertEquals("rm -rf build", row.commandText)
    assertEquals("rm build", row.commandPreview)
    assertEquals(listOf("allow-once", "allow-always", "deny"), row.allowedDecisions)
    assertEquals("gateway", row.host)
    assertNull(row.nodeId)
    assertEquals("agent-main", row.agentId)
    assertEquals(100L, row.createdAtMs)
    assertEquals(200L, row.expiresAtMs)
  }

  @Test
  fun ignoresMalformedGatewayExecApprovalListPayload() {
    assertTrue(parseGatewayExecApprovalListPayload("""{"approvals":[]}""", json).isEmpty())
    assertTrue(parseGatewayExecApprovalListPayload("not json", json).isEmpty())
  }
}
