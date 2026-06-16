package ai.openclaw.app

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GatewayNodeApprovalStateTest {
  @Test
  fun parsesGatewayNodeApprovalState() {
    assertEquals(GatewayNodeApprovalState.Approved, parseGatewayNodeApprovalState("approved"))
    assertEquals(GatewayNodeApprovalState.PendingApproval, parseGatewayNodeApprovalState("pending-approval"))
    assertEquals(GatewayNodeApprovalState.PendingReapproval, parseGatewayNodeApprovalState("pending-reapproval"))
    assertEquals(GatewayNodeApprovalState.Unapproved, parseGatewayNodeApprovalState("unapproved"))
    assertEquals(GatewayNodeApprovalState.Unknown, parseGatewayNodeApprovalState(null))
  }

  @Test
  fun parsesNodeListApprovalFields() {
    val node =
      parseGatewayNodeSummary(
        Json.parseToJsonElement(
          """
          {
            "nodeId": "android-node",
            "paired": true,
            "connected": true,
            "approvalState": "pending-approval",
            "pendingRequestId": "request-1",
            "caps": ["device"],
            "commands": ["device.status"]
          }
          """.trimIndent(),
        ),
      )

    requireNotNull(node)
    assertEquals(GatewayNodeApprovalState.PendingApproval, node.approvalState)
    assertEquals("request-1", node.pendingRequestId)
    assertEquals(listOf("device"), node.capabilities)
    assertEquals(listOf("device.status"), node.commands)
  }

  @Test
  fun treatsMissingNodeApprovalStateAsUnknown() {
    val node =
      parseGatewayNodeSummary(
        Json.parseToJsonElement("""{"nodeId":"android-node","paired":true,"connected":true}"""),
      )

    requireNotNull(node)
    assertEquals(GatewayNodeApprovalState.Unknown, node.approvalState)
    assertNull(node.pendingRequestId)
  }

  @Test
  fun resolvesCurrentPhoneNodeApprovalState() {
    val nodes =
      listOf(
        GatewayNodeSummary(
          id = "other",
          displayName = null,
          remoteIp = null,
          version = null,
          deviceFamily = null,
          paired = true,
          connected = false,
          approvalState = GatewayNodeApprovalState.Approved,
          pendingRequestId = null,
          capabilities = emptyList(),
          commands = emptyList(),
        ),
        GatewayNodeSummary(
          id = "self",
          displayName = null,
          remoteIp = null,
          version = null,
          deviceFamily = null,
          paired = true,
          connected = true,
          approvalState = GatewayNodeApprovalState.PendingApproval,
          pendingRequestId = null,
          capabilities = emptyList(),
          commands = emptyList(),
        ),
      )

    assertEquals(
      GatewayNodeApprovalState.PendingApproval,
      currentNodeCapabilityApprovalState(nodes = nodes, selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeApprovalState.Unknown,
      currentNodeCapabilityApprovalState(nodes = nodes, selfNodeId = "missing"),
    )
  }
}
