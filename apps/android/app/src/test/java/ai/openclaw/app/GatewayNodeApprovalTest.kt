package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestOutcomeUnknown
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GatewayNodeApprovalTest {
  @Test
  fun approvalTargetsOnlyThisPhoneAndWaitsForEffectiveCameraReadback() =
    runTest {
      val gateway = Gateway()
      val action = GatewayNodeApproval()
      action.refresh(gateway.context(), gateway.nodes())
      assertEquals(
        "phone-request",
        action.state.value.pending
          ?.requestId,
      )

      val readback = CompletableDeferred<Unit>()
      gateway.beforeRequest = { method -> if (method == "node.list" && gateway.approvedRequests.isNotEmpty()) readback.await() }
      val approval = async { action.approve("phone-request") }
      runCurrent()
      assertTrue(action.state.value.approving)
      assertFalse(action.state.value.verified)
      action.approve("phone-request")
      assertEquals(listOf("phone-request"), gateway.approvedRequests)

      gateway.cameraEffective = true
      readback.complete(Unit)
      approval.await()
      assertTrue(action.state.value.verified)
      assertFalse(action.state.value.approving)
      assertNull(action.state.value.pending)
      assertEquals(1, gateway.requests.count { it == "node.pair.approve" })
    }

  @Test
  fun replacedRequestNeedsFreshUserConsent() =
    runTest {
      val gateway = Gateway()
      val action = GatewayNodeApproval()
      action.refresh(gateway.context(), gateway.nodes())
      gateway.requestId = "replacement-request"

      action.approve("phone-request")

      assertTrue(gateway.approvedRequests.isEmpty())
      assertEquals(
        "replacement-request",
        action.state.value.pending
          ?.requestId,
      )
      assertNotNull(action.state.value.errorText)
      assertFalse(action.state.value.verified)
    }

  @Test
  fun staleCatalogRequestIsNeitherOfferedNorApproved() =
    runTest {
      val staleCatalogStates: List<Pair<String, (Gateway) -> Unit>> =
        listOf(
          "missing current request" to { it.catalogPending = false },
          "different current request" to { it.catalogRequestId = "different-request" },
          "disconnected phone" to { it.catalogConnected = false },
        )
      val failures = mutableListOf<String>()
      for (afterPresentation in listOf(false, true)) {
        for ((name, changeCatalog) in staleCatalogStates) {
          val gateway = Gateway()
          val action = GatewayNodeApproval()
          gateway.pendingIncludesNotifications = false
          gateway.notificationsEffective = false
          if (afterPresentation) {
            action.refresh(gateway.context(), gateway.nodes())
            assertEquals(
              "phone-request",
              action.state.value.pending
                ?.requestId,
            )
          }
          changeCatalog(gateway)
          val phase = if (afterPresentation) "before approval" else "before presentation"
          if (!afterPresentation) {
            action.refresh(gateway.context(), gateway.nodes())
            if (action.state.value.pending != null) failures.add("$name $phase was offered")
          }
          gateway.beforeRequest = { method ->
            if (method == "node.pair.approve") gateway.cameraEffective = true
          }

          action.approve("phone-request")

          if (gateway.approvedRequests.isNotEmpty()) failures.add("$name $phase was approved")
          if (action.state.value.verified) failures.add("$name $phase was verified")
        }
      }
      assertEquals(emptyList<String>(), failures)
    }

  @Test
  fun oldApprovedSnapshotAndSuccessfulWriteDoNotApproveMissingCamera() =
    runTest {
      val gateway = Gateway()
      val action = GatewayNodeApproval()
      gateway.approved = true
      action.refresh(gateway.context(), gateway.nodes())
      assertFalse(action.state.value.verified)
      assertNull(action.state.value.pending)

      gateway.approved = false
      action.refresh(gateway.context(), gateway.nodes())
      assertNotNull(action.state.value.pending)

      action.approve("phone-request")

      assertEquals(listOf("phone-request"), gateway.approvedRequests)
      assertFalse(action.state.value.verified)
      assertNotNull(action.state.value.errorText)
    }

  @Test
  fun refreshKeepsTheEntireConfirmedSurfaceUntilItBecomesEffective() =
    runTest {
      for (changeContext in listOf("none", "gateway", "declaration")) {
        val gateway = Gateway()
        val action = GatewayNodeApproval()
        gateway.cameraEffective = true
        action.refresh(gateway.context(), gateway.nodes())
        gateway.beforeRequest = { method ->
          if (method == "node.pair.approve") gateway.notificationsEffective = false
        }

        action.approve("phone-request")

        assertFalse(action.state.value.verified)
        val verificationError = action.state.value.errorText
        assertNotNull(verificationError)
        action.refresh(gateway.context(), gateway.nodes())
        assertFalse("A refresh must still require the confirmed Notifications surface", action.state.value.verified)
        assertEquals(verificationError, action.state.value.errorText)

        action.invalidate()
        val reconnectedContext =
          when (changeContext) {
            "gateway" -> {
              gateway.context(endpointStableId = "different-gateway")
            }

            "declaration" -> {
              gateway.context(
                desired = GatewayNodeApprovalSurface(setOf("camera"), setOf("camera.snap"), mapOf("camera" to true)),
              )
            }

            else -> {
              gateway.context()
            }
          }
        action.refresh(reconnectedContext, gateway.nodes())
        assertEquals(
          "The confirmed Notifications requirement must survive reconnection only for the same gateway and declaration ($changeContext)",
          changeContext != "none",
          action.state.value.verified,
        )

        gateway.notificationsEffective = true
        action.refresh(reconnectedContext, gateway.nodes())
        assertTrue(action.state.value.verified)
        assertNull(action.state.value.errorText)
        assertEquals(listOf("phone-request"), gateway.approvedRequests)
      }
    }

  @Test
  fun lostWriteResponseIsReconciledWithoutAnotherApproval() =
    runTest {
      val gateway = Gateway()
      val action = GatewayNodeApproval()
      gateway.writeError = GatewayRequestOutcomeUnknown("connection lost")
      gateway.cameraEffective = true
      action.refresh(gateway.context(), gateway.nodes())

      action.approve("phone-request")

      assertEquals(listOf("phone-request"), gateway.approvedRequests)
      assertTrue(action.state.value.verified)
      assertNull(action.state.value.errorText)
    }

  @Test
  fun rejectedApprovalKeepsRecoveryVisible() =
    runTest {
      val gateway = Gateway()
      val action = GatewayNodeApproval()
      gateway.writeError = GatewayRequestRejected(GatewaySession.ErrorShape("INVALID_REQUEST", "missing scope: operator.admin"))
      action.refresh(gateway.context(), gateway.nodes())

      action.approve("phone-request")
      action.refresh(gateway.context(), gateway.nodes())

      assertFalse(action.state.value.verified)
      assertNotNull(action.state.value.errorText)
      assertNotNull(action.state.value.pending)
    }

  @Test
  fun currentConnectionAndSurfaceAreRequiredAtWriteEnqueue() =
    runTest {
      for (changeConnection in listOf(false, true)) {
        val gateway = Gateway()
        val action = GatewayNodeApproval()
        action.refresh(gateway.context(), gateway.nodes())
        gateway.beforeRequest = { method ->
          if (method == "node.pair.approve") {
            if (changeConnection) gateway.connectionCurrent = false else gateway.surfaceCurrent = false
          }
        }

        action.approve("phone-request")

        assertTrue(gateway.approvedRequests.isEmpty())
        assertFalse(action.state.value.verified)
      }
    }

  @Test
  fun missingAuthorityOrMethodNeverOffersAnApproval() =
    runTest {
      val cases =
        listOf(
          listOf("operator.read") to Gateway.methods,
          listOf("operator.pairing") to Gateway.methods,
          listOf("operator.admin") to setOf("node.pair.list", "node.list"),
        )
      for ((scopes, methods) in cases) {
        val gateway = Gateway()
        val action = GatewayNodeApproval()
        action.refresh(gateway.context(scopes, methods), gateway.nodes())
        action.approve("phone-request")
        assertNull(action.state.value.pending)
        assertTrue(gateway.approvedRequests.isEmpty())
        assertFalse(action.state.value.verified)
      }
    }

  @Test
  fun invalidationRetiresAnOutstandingApprovalRead() =
    runTest {
      val gateway = Gateway()
      val action = GatewayNodeApproval()
      action.refresh(gateway.context(), gateway.nodes())
      val pending = CompletableDeferred<Unit>()
      gateway.beforeRequest = { method -> if (method == "node.pair.list") pending.await() }
      val approval = async { action.approve("phone-request") }
      runCurrent()
      action.invalidate()
      pending.complete(Unit)
      approval.await()
      assertTrue(gateway.approvedRequests.isEmpty())
      assertEquals(GatewayNodeApprovalActionState(), action.state.value)
    }

  private class Gateway {
    companion object {
      val methods = setOf("node.pair.list", "node.pair.approve", "node.list")
    }

    val requests = mutableListOf<String>()
    val approvedRequests = mutableListOf<String>()
    var requestId = "phone-request"
    var approved = false
    private var pendingConsumed = false
    var cameraEffective = false
    var notificationsEffective = true
    var pendingIncludesNotifications = true
    var catalogPending = true
    var catalogRequestId: String? = null
    var catalogConnected = true
    var connectionCurrent = true
    var surfaceCurrent = true
    var writeError: Exception? = null
    var beforeRequest: suspend (String) -> Unit = {}

    fun context(
      scopes: List<String> = listOf("operator.admin"),
      methods: Set<String> = Gateway.methods,
      endpointStableId: String = "test-gateway",
      desired: GatewayNodeApprovalSurface =
        GatewayNodeApprovalSurface(
          setOf("camera", "notifications"),
          setOf("camera.snap", "notifications.list"),
          mapOf("camera" to true),
        ),
    ): GatewayNodeApprovalContext {
      val lease =
        GatewaySession.RequestLease(
          endpointStableId = endpointStableId,
          isCurrentImpl = { connectionCurrent },
          advertisedMethods = methods,
        ) { method, params, _, withEnqueue ->
          beforeRequest(method)
          if (!connectionCurrent) throw GatewayRequestNotEnqueued("connection replaced")
          withEnqueue { requests.add(method) }
          when (method) {
            "node.pair.list" -> {
              if (pendingConsumed) """{"pending":[]}""" else """{"pending":[${pending("other", "other-request")},${pending("phone", requestId)}]}"""
            }

            "node.pair.approve" -> {
              val id =
                Json
                  .parseToJsonElement(requireNotNull(params))
                  .jsonObject
                  .getValue("requestId")
                  .jsonPrimitive.content
              approvedRequests.add(id)
              if (writeError !is GatewayRequestRejected) {
                approved = true
                pendingConsumed = true
              }
              writeError?.let { throw it }
              """{"requestId":"$id","node":{"nodeId":"phone"}}"""
            }

            "node.list" -> {
              nodes().toString()
            }

            else -> {
              error("Unexpected method $method")
            }
          }
        }
      return GatewayNodeApprovalContext(
        lease = lease,
        selfNodeId = "phone",
        scopes = scopes,
        desired = desired,
        commitIfCurrent = { block ->
          if (surfaceCurrent) {
            block()
            true
          } else {
            false
          }
        },
      )
    }

    private fun pending(
      nodeId: String,
      requestId: String,
    ): String {
      val caps = if (pendingIncludesNotifications) """["camera","notifications"]""" else """["camera"]"""
      val commands = if (pendingIncludesNotifications) """["camera.snap","notifications.list"]""" else """["camera.snap"]"""
      return """{"nodeId":"$nodeId","requestId":"$requestId","caps":$caps,"commands":$commands,"permissions":{"camera":true},"requiredApproveScopes":["operator.pairing","operator.write"]}"""
    }

    fun nodes(): JsonObject {
      val approvalState = if (approved || !catalogPending) "approved" else "pending-reapproval"
      val pendingRequestId = if (approved || !catalogPending) JsonNull else JsonPrimitive(catalogRequestId ?: requestId)
      val caps = JsonArray(listOfNotNull(if (cameraEffective) JsonPrimitive("camera") else null, if (notificationsEffective) JsonPrimitive("notifications") else null))
      val commands = JsonArray(listOfNotNull(if (cameraEffective) JsonPrimitive("camera.snap") else null, if (notificationsEffective) JsonPrimitive("notifications.list") else null))
      return Json
        .parseToJsonElement(
          """{"nodes":[{"nodeId":"phone","approvalState":"$approvalState","pendingRequestId":$pendingRequestId,"connected":$catalogConnected,"caps":$caps,"commands":$commands,"permissions":{"camera":$cameraEffective}}]}""",
        ).jsonObject
    }
  }
}
