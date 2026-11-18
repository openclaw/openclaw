package ai.openclaw.app.node

import ai.openclaw.app.accessibility.AccessibilityActionExecutor
import ai.openclaw.app.accessibility.AccessibilityServiceDisabledException
import ai.openclaw.app.accessibility.ActionResult
import ai.openclaw.app.accessibility.GlobalActionName
import ai.openclaw.app.accessibility.MobileUiAction
import ai.openclaw.app.accessibility.MobileUiSnapshot
import ai.openclaw.app.accessibility.OpenClawAccessibilityService
import ai.openclaw.app.accessibility.ScrollDirection
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

internal data class MobileUiActRequest(
  val snapshotId: String,
  val action: MobileUiAction,
)

/**
 * Flavor-owned bridge from node.invoke to the Android accessibility executor.
 *
 * Observe returns `{snapshotId,capturedAtMs,package,windowTitle,nodes}`. Each node contains
 * `{ref,parentRef,role,text,contentDescription,viewId,bounds:[l,t,r,b],flags,actions}`.
 * Act accepts `{snapshotId,action:{type,...}}` and returns `{code,message}`.
 */
class MobileUiHandler {
  private val executor = AccessibilityActionExecutor()
  private val invokeMutex = Mutex()

  val isConnected: StateFlow<Boolean> = OpenClawAccessibilityService.isConnected

  suspend fun handleObserve(
    @Suppress("UNUSED_PARAMETER") paramsJson: String?,
  ): GatewaySession.InvokeResult =
    invokeMutex.withLock {
      try {
        GatewaySession.InvokeResult.ok(mobileUiSnapshotJson(executor.observe()))
      } catch (error: AccessibilityServiceDisabledException) {
        nodeInvokeError("SERVICE_DISABLED", error.message ?: "accessibility service is disabled")
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        nodeInvokeError("MOBILE_UI_OBSERVE_FAILED", error.message ?: "snapshot failed")
      }
    }

  suspend fun handleAct(paramsJson: String?): GatewaySession.InvokeResult =
    invokeMutex.withLock {
      val request =
        parseMobileUiActRequest(paramsJson)
          ?: return@withLock nodeInvokeError("INVALID_REQUEST", "expected {snapshotId,action:{type,...}}")
      try {
        GatewaySession.InvokeResult.ok(actionResultJson(executor.act(request.snapshotId, request.action)))
      } catch (error: CancellationException) {
        throw error
      } catch (error: Throwable) {
        nodeInvokeError("MOBILE_UI_ACT_FAILED", error.message ?: "action failed")
      }
    }
}

internal fun mobileUiSnapshotJson(snapshot: MobileUiSnapshot): String =
  buildJsonObject {
    put("snapshotId", snapshot.id)
    put("capturedAtMs", snapshot.capturedAtMs)
    put("package", JsonPrimitive(snapshot.packageName))
    put("windowTitle", JsonPrimitive(snapshot.windowTitle))
    putJsonArray("nodes") {
      snapshot.nodes.forEach { node ->
        addJsonObject {
          put("ref", node.ref)
          put("parentRef", node.parentRef)
          put("role", node.role)
          put("text", node.text)
          put("contentDescription", node.contentDescription)
          put("viewId", node.viewId)
          putJsonArray("bounds") {
            add(node.boundsInScreen.left)
            add(node.boundsInScreen.top)
            add(node.boundsInScreen.right)
            add(node.boundsInScreen.bottom)
          }
          putJsonObject("flags") {
            put("clickable", node.clickable)
            put("editable", node.editable)
            put("scrollable", node.scrollable)
            put("enabled", node.enabled)
            put("focused", node.focused)
          }
          putJsonArray("actions") {
            node.actions.forEach { action -> add(action) }
          }
        }
      }
    }
  }.toString()

internal fun parseMobileUiActRequest(paramsJson: String?): MobileUiActRequest? {
  val params = parseJsonParamsObject(paramsJson) ?: return null
  val snapshotId = params.requiredString("snapshotId") ?: return null
  val actionParams = params["action"] as? JsonObject ?: return null
  val type = actionParams.requiredString("type") ?: return null
  val action =
    when (type) {
      "activate" -> {
        MobileUiAction.Activate(actionParams.requiredString("ref") ?: return null)
      }

      "set_text" -> {
        MobileUiAction.SetText(
          ref = actionParams.requiredString("ref") ?: return null,
          text = actionParams.string("text") ?: return null,
        )
      }

      "scroll" -> {
        MobileUiAction.Scroll(
          ref = actionParams.requiredString("ref") ?: return null,
          direction =
            when (actionParams.requiredString("direction")) {
              "forward" -> ScrollDirection.Forward
              "backward" -> ScrollDirection.Backward
              else -> return null
            },
        )
      }

      "tap" -> {
        MobileUiAction.Tap(
          x = parseJsonInt(actionParams, "x") ?: return null,
          y = parseJsonInt(actionParams, "y") ?: return null,
        )
      }

      "swipe" -> {
        MobileUiAction.Swipe(
          x1 = parseJsonInt(actionParams, "x1") ?: return null,
          y1 = parseJsonInt(actionParams, "y1") ?: return null,
          x2 = parseJsonInt(actionParams, "x2") ?: return null,
          y2 = parseJsonInt(actionParams, "y2") ?: return null,
          durationMs = actionParams.long("durationMs") ?: return null,
        )
      }

      "global_action" -> {
        MobileUiAction.GlobalAction(
          when (actionParams.requiredString("name")) {
            "back" -> GlobalActionName.Back
            "home" -> GlobalActionName.Home
            "recents" -> GlobalActionName.Recents
            "notifications" -> GlobalActionName.Notifications
            else -> return null
          },
        )
      }

      "wait" -> {
        MobileUiAction.Wait(actionParams.long("ms") ?: return null)
      }

      else -> {
        return null
      }
    }
  return MobileUiActRequest(snapshotId = snapshotId, action = action)
}

private fun actionResultJson(result: ActionResult): String =
  buildJsonObject {
    put("code", result.code.value)
    put("message", JsonPrimitive(result.message))
  }.toString()

private fun JsonObject.string(key: String): String? =
  (this[key] as? JsonPrimitive)
    ?.takeIf { it.isString }
    ?.contentOrNull

private fun JsonObject.requiredString(key: String): String? = string(key)?.takeIf(String::isNotBlank)

private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.contentOrNull?.toLongOrNull()
