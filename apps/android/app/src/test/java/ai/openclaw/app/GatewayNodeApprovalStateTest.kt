package ai.openclaw.app

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayNodeApprovalStateTest {
  @Test
  fun exactApprovalCommandsAgeOutToStatusFallbacks() {
    assertEquals(
      GatewayNodeCapabilityApproval.PendingApproval(requestId = null),
      GatewayNodeCapabilityApproval.PendingApproval(requestId = "request-1").withoutExactRequestId(),
    )
    assertEquals(
      GatewayNodeCapabilityApproval.PendingReapproval(requestId = null),
      GatewayNodeCapabilityApproval.PendingReapproval(requestId = "request-2").withoutExactRequestId(),
    )
    assertNull(GatewayNodeCapabilityApproval.PendingApproval(requestId = null).withoutExactRequestId())

    val summary =
      GatewayNodesDevicesSummary(
        nodes = listOf(pendingNode(requestId = "request-1")),
        pendingDevices = emptyList(),
        pairedDevices = emptyList(),
      )
    assertNull(
      summary
        .withoutExactApprovalRequestIds()
        .nodes
        .single()
        .pendingRequestId,
    )
  }

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
      GatewayNodeCapabilityApproval.Unsupported,
      currentNodeCapabilityApproval(nodes = listOf(node), selfNodeId = "android-node"),
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
          pendingRequestId = null,
          capabilities = emptyList(),
          commands = emptyList(),
        ),
      )

    assertEquals(
      GatewayNodeCapabilityApproval.PendingApproval(requestId = null),
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeCapabilityApproval.Loading,
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "missing"),
    )
  }

  @Test
  fun currentPhoneApprovalCarriesOnlySafePendingRequestIds() {
    val safe = pendingNode(requestId = "request-1")
    val unsafe = pendingNode(requestId = "request-1;echo unsafe")

    assertEquals(
      GatewayNodeCapabilityApproval.PendingApproval("request-1"),
      currentNodeCapabilityApproval(nodes = listOf(safe), selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeCapabilityApproval.PendingApproval(requestId = null),
      currentNodeCapabilityApproval(nodes = listOf(unsafe), selfNodeId = "self"),
    )
  }

  @Test
  fun ignoresStaleNodeApprovalRefreshResults() {
    val guard = GatewayNodeApprovalRefreshGuard()
    var approval: GatewayNodeCapabilityApproval = GatewayNodeCapabilityApproval.Loading
    val staleRefresh = guard.begin()
    val currentRefresh = guard.begin()

    assertFalse(guard.publishIfCurrent(staleRefresh) { approval = GatewayNodeCapabilityApproval.Approved })
    assertTrue(
      guard.publishIfCurrent(currentRefresh) { approval = GatewayNodeCapabilityApproval.PendingReapproval("request-2") },
    )
    assertEquals(GatewayNodeCapabilityApproval.PendingReapproval("request-2"), approval)
  }

  private fun pendingNode(requestId: String): GatewayNodeSummary =
    GatewayNodeSummary(
      id = "self",
      displayName = null,
      remoteIp = null,
      version = null,
      deviceFamily = null,
      paired = true,
      connected = true,
      approvalState = GatewayNodeApprovalState.PendingApproval,
      pendingRequestId = requestId,
      capabilities = emptyList(),
      commands = emptyList(),
    )
}
