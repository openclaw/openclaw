package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayErrorDetails
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayNodeApprovalStateTest {
  @Test
  fun parsesNodeListApprovalStates() {
    val cases =
      listOf(
        "\"approved\"" to GatewayNodeCapabilityApproval.Approved,
        "\"pending-approval\"" to GatewayNodeCapabilityApproval.PendingApproval("request-1"),
        "\"pending-reapproval\"" to GatewayNodeCapabilityApproval.PendingReapproval("request-1"),
        "\"unapproved\"" to GatewayNodeCapabilityApproval.Unapproved,
        "null" to GatewayNodeCapabilityApproval.Loading,
        "\"future-state\"" to GatewayNodeCapabilityApproval.Loading,
        "{}" to GatewayNodeCapabilityApproval.Loading,
      )
    for ((raw, expected) in cases) {
      val payload = Json.parseToJsonElement("""{"nodeId":"self","approvalState":$raw,"pendingRequestId":" request-1 "}""")
      assertEquals(expected, parseGatewayNodeSummary(payload)?.approvalState)
    }
  }

  @Test
  fun nodePairingFailuresRefreshNodeDeviceState() {
    assertTrue(
      nodeConnectFailureNeedsApprovalRefresh(
        GatewaySession.ErrorShape(
          code = "NOT_PAIRED",
          message = "pairing required",
          details =
            GatewayErrorDetails(
              code = "PAIRING_REQUIRED",
              canRetryWithDeviceToken = false,
              recommendedNextStep = "wait_then_retry",
              pauseReconnect = false,
              reason = "not-paired",
            ),
        ),
      ),
    )
    assertFalse(
      nodeConnectFailureNeedsApprovalRefresh(
        GatewaySession.ErrorShape(
          code = "UNAUTHORIZED",
          message = "token mismatch",
          details =
            GatewayErrorDetails(
              code = "AUTH_TOKEN_MISMATCH",
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
            ),
        ),
      ),
    )
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
    assertEquals(GatewayNodeCapabilityApproval.PendingApproval("request-1"), node.approvalState)
    assertEquals(listOf("device"), node.capabilities)
    assertEquals(listOf("device.status"), node.commands)
    val summary = GatewayNodesDevicesSummary(listOf(node), emptyList(), emptyList())
    val expired = summary.withoutExactApprovalRequestIds()
    assertEquals(node.copy(approvalState = GatewayNodeCapabilityApproval.PendingApproval(null)), expired.nodes.single())
    assertEquals(expired, expired.withoutExactApprovalRequestIds())
  }

  @Test
  fun parsesSplitNodeListShapeFromGateway() {
    val root =
      Json
        .parseToJsonElement(
          """
          {
            "pending": [
              {
                "nodeId": "pending-node",
                "paired": false,
                "connected": false,
                "approvalState": "pending-approval",
                "pendingRequestId": "request-pending"
              }
            ],
            "paired": [
              {
                "nodeId": "self",
                "paired": true,
                "connected": true,
                "approvalState": "approved",
                "caps": ["device"],
                "commands": ["device.status"]
              }
            ]
          }
          """.trimIndent(),
        ).jsonObject

    val nodes = parseGatewayNodeList(root)

    assertEquals(2, nodes.size)
    assertEquals(
      GatewayNodeCapabilityApproval.Approved,
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "self"),
    )
    val primary = Json.parseToJsonElement("""[{"nodeId":"self","approvalState":"unapproved"}]""")
    val prioritized = parseGatewayNodeList(JsonObject(root + ("nodes" to primary)))
    assertEquals(listOf("self", "pending-node"), prioritized.map { it.id })
    assertEquals(GatewayNodeCapabilityApproval.Unapproved, currentNodeCapabilityApproval(prioritized, "self"))
  }

  @Test
  fun treatsMissingNodeApprovalStateAsUnsupported() {
    val node =
      parseGatewayNodeSummary(
        Json.parseToJsonElement("""{"nodeId":"android-node","paired":true,"connected":true}"""),
      )

    requireNotNull(node)
    assertEquals(GatewayNodeCapabilityApproval.Unsupported, node.approvalState)
    assertEquals(
      GatewayNodeCapabilityApproval.Unsupported,
      currentNodeCapabilityApproval(nodes = listOf(node), selfNodeId = "android-node"),
    )
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
          approvalState = GatewayNodeCapabilityApproval.Approved,
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
          approvalState = GatewayNodeCapabilityApproval.PendingApproval(" request-self "),
          capabilities = emptyList(),
          commands = emptyList(),
        ),
      )

    assertEquals(
      GatewayNodeCapabilityApproval.PendingApproval("request-self"),
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "self"),
    )
    assertEquals(
      GatewayNodeCapabilityApproval.Loading,
      currentNodeCapabilityApproval(nodes = nodes, selfNodeId = "missing"),
    )
    val unsafe = nodes.last().copy(approvalState = GatewayNodeCapabilityApproval.PendingReapproval("request-self; unsafe"))
    assertEquals(GatewayNodeCapabilityApproval.PendingReapproval(null), currentNodeCapabilityApproval(listOf(unsafe), "self"))
  }

  @Test
  fun ignoresStaleNodeApprovalRefreshResults() {
    val guard = LatestGatewayRefreshGuard()
    var approvalState: GatewayNodeCapabilityApproval = GatewayNodeCapabilityApproval.Loading
    val staleRefresh = guard.begin()
    val currentRefresh = guard.begin()

    assertFalse(guard.publishIfCurrent(staleRefresh) { approvalState = GatewayNodeCapabilityApproval.Approved })
    assertTrue(
      guard.publishIfCurrent(currentRefresh) { approvalState = GatewayNodeCapabilityApproval.PendingReapproval(null) },
    )
    assertEquals(GatewayNodeCapabilityApproval.PendingReapproval(null), approvalState)
  }
}
