package ai.openclaw.app

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayNodeApprovalStateTest {
  @Test
  fun parsesGatewayNodeApprovalState() {
    assertEquals(GatewayNodeApprovalState.Approved, parseGatewayNodeApprovalState("approved"))
    assertEquals(GatewayNodeApprovalState.PendingApproval, parseGatewayNodeApprovalState("pending-approval"))
    assertEquals(GatewayNodeApprovalState.PendingReapproval, parseGatewayNodeApprovalState("pending-reapproval"))
    assertEquals(GatewayNodeApprovalState.Unapproved, parseGatewayNodeApprovalState("unapproved"))
    assertEquals(GatewayNodeApprovalState.Loading, parseGatewayNodeApprovalState(null))
    assertEquals(GatewayNodeApprovalState.Loading, parseGatewayNodeApprovalState("future-state"))
  }

  @Test
  fun nodePairingEventsInvalidateNodeDeviceState() {
    assertTrue(gatewayEventInvalidatesNodesDevices("node.pair.requested"))
    assertTrue(gatewayEventInvalidatesNodesDevices("node.pair.resolved"))
    assertFalse(gatewayEventInvalidatesNodesDevices("device.pair.resolved"))
    assertFalse(gatewayEventInvalidatesNodesDevices("exec.approval.resolved"))
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
  fun treatsMissingNodeApprovalStateAsUnsupported() {
    val node =
      parseGatewayNodeSummary(
        Json.parseToJsonElement("""{"nodeId":"android-node","paired":true,"connected":true}"""),
      )

    requireNotNull(node)
    assertEquals(GatewayNodeApprovalState.Unsupported, node.approvalState)
    assertEquals(
      GatewayNodeApprovalState.Unsupported,
      currentNodeCapabilityApprovalState(nodes = listOf(node), selfNodeId = "android-node"),
    )
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
          pendingRequestId = "request-self",
          capabilities = emptyList(),
          commands = emptyList(),
        ),
      )

    assertEquals(
      GatewayNodeApprovalState.PendingApproval,
      currentNodeCapabilityApprovalState(nodes = nodes, selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeApprovalStatus(
        state = GatewayNodeApprovalState.PendingApproval,
        pendingRequestId = "request-self",
      ),
      currentNodeCapabilityApprovalStatus(nodes = nodes, selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeApprovalState.Loading,
      currentNodeCapabilityApprovalState(nodes = nodes, selfNodeId = "missing"),
    )
    assertEquals(
      GatewayNodeApprovalStatus(
        state = GatewayNodeApprovalState.Loading,
        pendingRequestId = null,
      ),
      currentNodeCapabilityApprovalStatus(nodes = nodes, selfNodeId = "missing"),
    )
  }

  @Test
  fun ignoresStaleNodeApprovalRefreshResults() {
    val guard = GatewayNodeApprovalRefreshGuard()
    var approvalState = GatewayNodeApprovalState.Loading
    val staleRefresh = guard.begin()
    val currentRefresh = guard.begin()

    assertFalse(guard.publishIfCurrent(staleRefresh) { approvalState = GatewayNodeApprovalState.Approved })
    assertTrue(
      guard.publishIfCurrent(currentRefresh) { approvalState = GatewayNodeApprovalState.PendingReapproval },
    )
    assertEquals(GatewayNodeApprovalState.PendingReapproval, approvalState)
  }
}
