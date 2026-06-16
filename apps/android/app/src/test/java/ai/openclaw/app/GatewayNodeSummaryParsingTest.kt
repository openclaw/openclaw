package ai.openclaw.app

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayNodeSummaryParsingTest {
  @Test
  fun parsesNodeApprovalStatesFromNodeList() {
    val root =
      Json
        .parseToJsonElement(
          """
          {
            "nodes": [
              {
                "nodeId": "pending-node",
                "displayName": "Android",
                "deviceFamily": "Android",
                "paired": true,
                "connected": true,
                "approvalState": "pending-approval",
                "pendingRequestId": "node-request-1",
                "caps": ["device"],
                "commands": []
              },
              {
                "nodeId": "unapproved-node",
                "paired": true,
                "connected": false,
                "approvalState": "unapproved"
              },
              {
                "nodeId": "approved-node",
                "paired": true,
                "connected": true,
                "approvalState": "approved",
                "commands": ["device.status"]
              }
            ]
          }
          """.trimIndent(),
        ).jsonObject

    val nodes = parseGatewayNodeSummaries(root["nodes"] as? JsonArray)

    assertEquals(GatewayNodeApprovalState.PendingApproval, nodes[0].approvalState)
    assertEquals("node-request-1", nodes[0].pendingRequestId)
    assertEquals(listOf("device"), nodes[0].capabilities)
    assertEquals(GatewayNodeApprovalState.Unapproved, nodes[1].approvalState)
    assertNull(nodes[1].pendingRequestId)
    assertEquals(GatewayNodeApprovalState.Approved, nodes[2].approvalState)
    assertEquals(listOf("device.status"), nodes[2].commands)
  }
}
