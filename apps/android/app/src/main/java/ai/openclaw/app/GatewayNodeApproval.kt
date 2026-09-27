package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.gateway.normalizeGatewayApprovalRequestId
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject

data class GatewayPendingNodeApproval(
  val requestId: String,
  val capabilities: List<String>,
  val commands: List<String>,
)

data class GatewayNodeApprovalActionState(
  val pending: GatewayPendingNodeApproval? = null,
  val approving: Boolean = false,
  val errorText: NativeText? = null,
  val verified: Boolean = false,
)

internal data class GatewayNodeApprovalSurface(
  val capabilities: Set<String>,
  val commands: Set<String>,
  val permissions: Map<String, Boolean>,
) {
  fun contains(other: GatewayNodeApprovalSurface): Boolean =
    capabilities.containsAll(other.capabilities) &&
      commands.containsAll(other.commands) &&
      other.permissions.all { (key, allowed) -> !allowed || permissions[key] == true }

  // These are the configurable node surfaces on Android's onboarding page.
  // Other commands may be withheld by Gateway policy or its protocol version.
  fun onboardingSurface(): GatewayNodeApprovalSurface =
    copy(
      capabilities = capabilities.filterTo(mutableSetOf()) { it in setOf("camera", "location", "sms") },
      commands = commands.filterTo(mutableSetOf()) { it.substringBefore('.') in setOf("camera", "location", "sms") },
    )
}

internal class GatewayNodeApprovalContext(
  val lease: GatewaySession.RequestLease,
  val selfNodeId: String,
  val scopes: List<String>,
  val desired: GatewayNodeApprovalSurface,
  // Called under the physical connection owner, before this action owner's lock.
  val commitIfCurrent: (() -> Unit) -> Boolean,
)

/** Owns the phone's explicit node approval action; Gateway pairing remains authoritative. */
internal class GatewayNodeApproval {
  private val lock = Any()
  private var generation = 0L
  private var pendingContext: GatewayNodeApprovalContext? = null
  private var confirmedApproval: ConfirmedApproval? = null
  private val mutableState = MutableStateFlow(GatewayNodeApprovalActionState())
  val state = mutableState.asStateFlow()

  fun invalidate() {
    synchronized(lock) {
      generation += 1
      pendingContext = null
      // An unfinished confirmation survives transport replacement, scoped by refresh to its target.
      mutableState.value = GatewayNodeApprovalActionState()
    }
  }

  suspend fun refresh(
    context: GatewayNodeApprovalContext,
    nodes: JsonObject,
  ) {
    val (epoch, confirmed) =
      synchronized(lock) {
        if (mutableState.value.approving) return
        ++generation to confirmedApproval?.takeIf { it.matches(context) }
      }
    try {
      val verified =
        verifiedSurface(nodes, context, context.desired.onboardingSurface()) &&
          (confirmed == null || verifiedSurface(nodes, context, confirmed.surface))
      val pending = if (!verified && canManage(context)) readPending(context, epoch, nodes) else null
      publish(context, epoch) {
        confirmedApproval = confirmed?.takeUnless { verified }
        pendingContext = context
        mutableState.value =
          GatewayNodeApprovalActionState(
            pending = pending?.summary,
            verified = verified,
            errorText =
              if (verified) {
                null
              } else {
                mutableState.value.errorText
                  ?: if (confirmed != null) nativeText("Could not verify phone access. Check approval again.") else null
              },
          )
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Exception) {
      publish(context, epoch) {
        pendingContext = null
        mutableState.value = GatewayNodeApprovalActionState(errorText = nativeText("Could not check phone access. Try again."))
      }
    }
  }

  suspend fun approve(expectedRequestId: String) {
    val claimed =
      synchronized(lock) {
        val context = pendingContext ?: return
        if (mutableState.value.approving || mutableState.value.pending?.requestId != expectedRequestId) return
        mutableState.value = mutableState.value.copy(approving = true, errorText = null, verified = false)
        context to ++generation
      }
    val (context, epoch) = claimed
    try {
      val pending = readPending(context, epoch)
      if (pending == null || pending.summary.requestId != expectedRequestId) {
        publish(context, epoch) {
          mutableState.value =
            GatewayNodeApprovalActionState(
              pending = pending?.summary,
              errorText = nativeText("Phone access changed. Review the request and try again."),
            )
        }
        return
      }
      // Refreshes must preserve the full access the user confirmed, even if policy changes during approval.
      publish(context, epoch) {
        confirmedApproval = ConfirmedApproval(context.lease.endpointStableId, context.selfNodeId, context.desired, pending.surface)
      }
      var failure: NativeText? = null
      try {
        request(context, epoch, "node.pair.approve", buildJsonObject { put("requestId", JsonPrimitive(expectedRequestId)) })
      } catch (err: CancellationException) {
        throw err
      } catch (err: GatewayRequestRejected) {
        failure = verbatimText(err.gatewayError.message)
      } catch (_: Exception) {
        // A lost response may follow a committed approval. Read the owner before offering another write.
      }
      val nodes = request(context, epoch, "node.list")
      val verified =
        verifiedSurface(nodes, context, pending.surface) &&
          verifiedSurface(nodes, context, context.desired.onboardingSurface())
      publish(context, epoch) {
        if (verified) confirmedApproval = null
        mutableState.value =
          GatewayNodeApprovalActionState(
            verified = verified,
            errorText = if (verified) null else failure ?: nativeText("Could not verify phone access. Check approval again."),
          )
        pendingContext = null
      }
    } catch (err: CancellationException) {
      throw err
    } catch (_: Exception) {
      publish(context, epoch) {
        mutableState.value = GatewayNodeApprovalActionState(errorText = nativeText("Could not verify phone access. Check approval again."))
        pendingContext = null
      }
    } finally {
      synchronized(lock) {
        if (generation == epoch) mutableState.value = mutableState.value.copy(approving = false)
      }
    }
  }

  private data class Pending(
    val summary: GatewayPendingNodeApproval,
    val surface: GatewayNodeApprovalSurface,
  )

  private data class ConfirmedApproval(
    val gatewayId: String,
    val selfNodeId: String,
    val desired: GatewayNodeApprovalSurface,
    val surface: GatewayNodeApprovalSurface,
  ) {
    fun matches(context: GatewayNodeApprovalContext): Boolean = gatewayId == context.lease.endpointStableId && selfNodeId == context.selfNodeId && desired == context.desired
  }

  private suspend fun readPending(
    context: GatewayNodeApprovalContext,
    epoch: Long,
    nodes: JsonObject? = null,
  ): Pending? {
    if (!canManage(context)) return null
    val root = request(context, epoch, "node.pair.list")
    val pending =
      (root["pending"] as? JsonArray)
        ?.mapNotNull { it.asObjectOrNull() }
        ?.singleOrNull { it["nodeId"].asStringOrNull() == context.selfNodeId } ?: return null
    val requestId = normalizeGatewayApprovalRequestId(pending["requestId"].asStringOrNull()) ?: return null
    val surface = parseSurface(pending) ?: return null
    val requiredScopes = (pending["requiredApproveScopes"] as? JsonArray)?.mapNotNull { it.asStringOrNull() }
    val allowed =
      "operator.admin" in context.scopes ||
        (requiredScopes != null && requiredScopes.isNotEmpty() && requiredScopes.all { it in context.scopes })
    if (!allowed || !context.desired.contains(surface) || !surface.contains(context.desired.onboardingSurface())) return null
    // Pairing storage can retain an older request after a rate-limited reconnect.
    // The catalog identifies the request matching the connected phone's declaration.
    val node = selfNode(nodes ?: request(context, epoch, "node.list"), context) ?: return null
    if (
      (node["connected"] as? JsonPrimitive)?.booleanOrNull != true ||
      node["approvalState"].asStringOrNull() !in setOf("pending-approval", "pending-reapproval") ||
      normalizeGatewayApprovalRequestId(node["pendingRequestId"].asStringOrNull()) != requestId
    ) {
      return null
    }
    return Pending(GatewayPendingNodeApproval(requestId, surface.capabilities.sorted(), surface.commands.sorted()), surface)
  }

  private fun canManage(context: GatewayNodeApprovalContext): Boolean =
    ("operator.admin" in context.scopes || "operator.pairing" in context.scopes) &&
      context.lease.supportsMethod("node.pair.list") && context.lease.supportsMethod("node.pair.approve")

  private fun verifiedSurface(
    nodes: JsonObject,
    context: GatewayNodeApprovalContext,
    required: GatewayNodeApprovalSurface,
  ): Boolean {
    val node = selfNode(nodes, context) ?: return false
    return node["approvalState"].asStringOrNull() == "approved" &&
      (node["connected"] as? JsonPrimitive)?.booleanOrNull == true &&
      parseSurface(node)?.contains(required) == true
  }

  private fun selfNode(
    nodes: JsonObject,
    context: GatewayNodeApprovalContext,
  ): JsonObject? =
    (nodes["nodes"] as? JsonArray)
      ?.mapNotNull { it.asObjectOrNull() }
      ?.singleOrNull { it["nodeId"].asStringOrNull() == context.selfNodeId }

  private suspend fun request(
    context: GatewayNodeApprovalContext,
    epoch: Long,
    method: String,
    params: JsonObject = buildJsonObject {},
  ): JsonObject {
    val response =
      context.lease.request(method, params.toString()) { enqueue ->
        if (!context.commitIfCurrent {
            synchronized(lock) {
              if (generation != epoch) throw GatewayRequestNotEnqueued("Phone approval changed")
              enqueue()
            }
          }
        ) {
          throw GatewayRequestNotEnqueued("Phone connection changed")
        }
      }
    var current = false
    publish(context, epoch) { current = true }
    if (!current) throw CancellationException("Phone connection changed")
    return Json.parseToJsonElement(response).asObjectOrNull() ?: error("Invalid $method response")
  }

  private fun publish(
    context: GatewayNodeApprovalContext,
    epoch: Long,
    block: () -> Unit,
  ) {
    context.lease.commitIfCurrent {
      context.commitIfCurrent {
        synchronized(lock) {
          if (generation == epoch) block()
        }
      }
    }
  }

  private fun parseSurface(node: JsonObject): GatewayNodeApprovalSurface? {
    val caps = node["caps"] as? JsonArray ?: return null
    val commands = node["commands"] as? JsonArray ?: return null
    val permissions = node["permissions"] as? JsonObject ?: return null
    return GatewayNodeApprovalSurface(
      capabilities = caps.mapNotNull { it.asStringOrNull() }.toSet(),
      commands = commands.mapNotNull { it.asStringOrNull() }.toSet(),
      permissions = permissions.mapValues { (_, value) -> (value as? JsonPrimitive)?.booleanOrNull ?: false },
    )
  }
}
