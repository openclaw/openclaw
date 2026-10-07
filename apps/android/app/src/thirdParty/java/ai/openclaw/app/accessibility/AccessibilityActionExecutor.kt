package ai.openclaw.app.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

private const val GESTURE_RESULT_TIMEOUT_MS = 10_000L

sealed interface MobileUiAction {
  sealed interface NodeAction : MobileUiAction {
    val ref: String
  }

  data class Activate(
    override val ref: String,
  ) : NodeAction

  data class SetText(
    override val ref: String,
    val text: String,
  ) : NodeAction

  data class Scroll(
    override val ref: String,
    val direction: ScrollDirection,
  ) : NodeAction

  data class Tap(
    val x: Int,
    val y: Int,
  ) : MobileUiAction

  data class Swipe(
    val x1: Int,
    val y1: Int,
    val x2: Int,
    val y2: Int,
    val durationMs: Long,
  ) : MobileUiAction

  data class GlobalAction(
    val name: GlobalActionName,
  ) : MobileUiAction

  data class Wait(
    val ms: Long,
  ) : MobileUiAction
}

enum class ScrollDirection(
  val actionId: Int,
  val actionName: String,
) {
  Forward(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD, "scroll_forward"),
  Backward(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD, "scroll_backward"),
}

enum class GlobalActionName(
  val actionId: Int,
) {
  Back(AccessibilityService.GLOBAL_ACTION_BACK),
  Home(AccessibilityService.GLOBAL_ACTION_HOME),
  Recents(AccessibilityService.GLOBAL_ACTION_RECENTS),
  Notifications(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS),
}

enum class ActionOutcomeCode(
  val value: String,
) {
  Completed("completed"),
  AcceptedButUnverified("accepted_but_unverified"),
  TargetStale("target_stale"),
  TargetNotFound("target_not_found"),
  ActionNotSupported("action_not_supported"),
  ActionRejected("action_rejected"),
  GestureCancelled("gesture_cancelled"),
  PackageChanged("package_changed"),
  ServiceDisabled("service_disabled"),
  SecureContent("secure_content"),
  TimedOutOutcomeUnknown("timed_out_outcome_unknown"),
}

data class ActionResult(
  val code: ActionOutcomeCode,
  val message: String? = null,
)

internal class AccessibilityServiceDisabledException(
  message: String = "Accessibility service is disabled",
) : IllegalStateException(message)

class AccessibilityActionExecutor internal constructor(
  private val connectionProvider: () -> AccessibilityServiceConnection<OpenClawAccessibilityService> = {
    OpenClawAccessibilityService.connection.value
  },
  private val captureSnapshot: (OpenClawAccessibilityService) -> AccessibilitySnapshotCapture =
    AccessibilitySnapshotter()::capture,
  private val foregroundPackageProvider: (OpenClawAccessibilityService) -> String? =
    OpenClawAccessibilityService::foregroundPackageName,
  private val uiEpochProvider: () -> Long = { OpenClawAccessibilityService.uiEpoch },
) : AutoCloseable {
  private val generationLock = Any()
  private var closed = false
  private val generation =
    SnapshotGenerationStore<AccessibilityNodeInfo> { node ->
      @Suppress("DEPRECATION")
      node.recycle()
    }

  fun observe(): MobileUiSnapshot {
    synchronized(generationLock) {
      if (closed) throw AccessibilityServiceDisabledException("Accessibility executor is closed")
    }
    val capturedConnection = connectionProvider()
    val service = capturedConnection.instance
    if (service == null) {
      synchronized(generationLock) { generation.clear() }
      throw AccessibilityServiceDisabledException()
    }
    val capturedUiEpoch = uiEpochProvider()
    val capturedConnectionGeneration = capturedConnection.generation
    val capture = captureSnapshot(service)
    synchronized(generationLock) {
      val currentConnection = connectionProvider()
      val connectionChanged =
        currentConnection.instance !== service || currentConnection.generation != capturedConnectionGeneration
      if (closed || connectionChanged) {
        generation.clear()
        recycleCapture(capture)
        val message = if (closed) "Accessibility executor closed during observe" else "Accessibility service changed during observe"
        throw AccessibilityServiceDisabledException(message)
      }
      generation.replace(
        snapshotId = capture.snapshot.id,
        packageName = capture.snapshot.packageName,
        uiEpoch = capturedUiEpoch,
        connectionGeneration = capturedConnectionGeneration,
        values = capture.nodesByRef,
      )
    }
    return capture.snapshot
  }

  suspend fun act(
    snapshotId: String,
    action: MobileUiAction,
  ): ActionResult {
    val currentConnection = connectionProvider()
    val service = currentConnection.instance
    if (service == null) {
      synchronized(generationLock) { generation.clear() }
      return ActionResult(ActionOutcomeCode.ServiceDisabled, "Accessibility service is not connected")
    }
    synchronized(generationLock) {
      if (closed) {
        return ActionResult(ActionOutcomeCode.ServiceDisabled, "Accessibility executor is closed")
      }
    }
    if (action is MobileUiAction.GlobalAction) {
      return performGlobalAction(service, action.name)
    }
    synchronized(generationLock) {
      if (closed) {
        return ActionResult(ActionOutcomeCode.ServiceDisabled, "Accessibility executor is closed")
      }
      if (!generation.matches(snapshotId)) {
        return ActionResult(ActionOutcomeCode.TargetStale, "Observe again before acting")
      }
      if (currentConnection.generation != generation.connectionGeneration) {
        return ActionResult(ActionOutcomeCode.TargetStale, "Accessibility service reconnected; re-observe before acting")
      }

      when (action) {
        is MobileUiAction.Tap,
        is MobileUiAction.Swipe,
        -> actionPreflight(service, coordinates = true)?.let { return it }

        // Node actions use per-node refresh() for freshness; UI epoch gates only blind coordinates.
        // Do not add an epoch check here: unrelated changes/app switches would break valid act flows.
        is MobileUiAction.NodeAction -> actionPreflight(service, coordinates = false)?.let { return it }

        is MobileUiAction.Wait -> Unit
      }
    }

    return when (action) {
      is MobileUiAction.NodeAction -> {
        synchronized(generationLock) { performNodeAction(snapshotId, action) }
      }

      is MobileUiAction.Tap -> {
        val gesture =
          runCatching { tapGesture(action.x, action.y) }
            .getOrElse { return ActionResult(ActionOutcomeCode.ActionRejected, "Invalid tap gesture") }
        dispatchGesture(service, gesture)
      }

      is MobileUiAction.Swipe -> {
        if (action.durationMs <= 0) {
          ActionResult(ActionOutcomeCode.ActionRejected, "Swipe duration must be positive")
        } else {
          val gesture =
            runCatching { swipeGesture(action) }
              .getOrElse { return ActionResult(ActionOutcomeCode.ActionRejected, "Invalid swipe gesture") }
          dispatchGesture(service, gesture)
        }
      }

      is MobileUiAction.Wait -> {
        if (action.ms < 0) {
          ActionResult(ActionOutcomeCode.ActionRejected, "Wait duration cannot be negative")
        } else {
          delay(action.ms)
          ActionResult(ActionOutcomeCode.Completed)
        }
      }
    }
  }

  override fun close() {
    synchronized(generationLock) {
      if (closed) return
      closed = true
      generation.clear()
    }
  }

  @Suppress("DEPRECATION")
  private fun recycleCapture(capture: AccessibilitySnapshotCapture) {
    capture.nodesByRef.values.forEach(AccessibilityNodeInfo::recycle)
  }

  private fun actionPreflight(
    service: OpenClawAccessibilityService,
    coordinates: Boolean,
  ): ActionResult? {
    val expectedPackage = generation.packageName
    val currentPackage = foregroundPackageProvider(service)
    if (expectedPackage == null || currentPackage == null || expectedPackage != currentPackage) {
      return ActionResult(
        ActionOutcomeCode.PackageChanged,
        if (coordinates) {
          "Active package cannot be verified against the snapshot; re-observe before coordinate actions"
        } else {
          "Active package cannot be verified against the snapshot; re-observe before node actions"
        },
      )
    }
    if (coordinates && uiEpochProvider() > generation.uiEpoch) {
      return ActionResult(
        ActionOutcomeCode.TargetStale,
        "UI changed since observe; re-observe before coordinate actions",
      )
    }
    return null
  }

  private fun performNodeAction(
    snapshotId: String,
    action: MobileUiAction.NodeAction,
  ): ActionResult {
    val (actionId, actionName) =
      when (action) {
        is MobileUiAction.Activate -> AccessibilityNodeInfo.ACTION_CLICK to "activate"
        is MobileUiAction.SetText -> AccessibilityNodeInfo.ACTION_SET_TEXT to "set_text"
        is MobileUiAction.Scroll -> action.direction.actionId to action.direction.actionName
      }
    val arguments =
      (action as? MobileUiAction.SetText)?.let {
        Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, it.text) }
      }
    val ref = action.ref
    val node =
      generation.resolve(snapshotId, ref)
        ?: return ActionResult(ActionOutcomeCode.TargetStale, "Node $ref is not in the current snapshot")
    if (!runCatching { node.refresh() }.getOrDefault(false)) {
      return ActionResult(ActionOutcomeCode.TargetNotFound, "Node $ref is no longer available")
    }
    if (actionId == AccessibilityNodeInfo.ACTION_SET_TEXT && shouldRedactText(node.isPassword, node.isEditable, node.inputType)) {
      return ActionResult(ActionOutcomeCode.SecureContent, "Text entry into password fields is refused")
    }
    if (node.actionList.none { it.id == actionId }) {
      return ActionResult(ActionOutcomeCode.ActionNotSupported, "Node $ref does not advertise $actionName")
    }
    val accepted = runCatching { node.performAction(actionId, arguments) }.getOrDefault(false)
    return if (accepted) {
      ActionResult(ActionOutcomeCode.AcceptedButUnverified)
    } else {
      ActionResult(ActionOutcomeCode.ActionRejected, "Android rejected $actionName for node $ref")
    }
  }

  private suspend fun dispatchGesture(
    service: OpenClawAccessibilityService,
    gesture: GestureDescription,
  ): ActionResult =
    withTimeoutOrNull(GESTURE_RESULT_TIMEOUT_MS) {
      suspendCancellableCoroutine { continuation ->
        val callback =
          object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
              if (continuation.isActive) continuation.resume(ActionResult(ActionOutcomeCode.Completed))
            }

            override fun onCancelled(gestureDescription: GestureDescription?) {
              if (continuation.isActive) {
                continuation.resume(ActionResult(ActionOutcomeCode.GestureCancelled))
              }
            }
          }
        val accepted = runCatching { service.dispatchGesture(gesture, callback, null) }.getOrDefault(false)
        if (!accepted && continuation.isActive) {
          continuation.resume(ActionResult(ActionOutcomeCode.ActionRejected, "Android rejected the gesture"))
        }
      }
    } ?: ActionResult(
      ActionOutcomeCode.TimedOutOutcomeUnknown,
      "Gesture callback did not arrive within $GESTURE_RESULT_TIMEOUT_MS ms",
    )

  private fun performGlobalAction(
    service: OpenClawAccessibilityService,
    name: GlobalActionName,
  ): ActionResult =
    if (runCatching { service.performGlobalAction(name.actionId) }.getOrDefault(false)) {
      ActionResult(ActionOutcomeCode.Completed)
    } else {
      ActionResult(ActionOutcomeCode.ActionRejected, "Android rejected global action ${name.name.lowercase()}")
    }
}

internal class SnapshotGenerationStore<T>(
  private val release: (T) -> Unit,
) {
  var packageName: String? = null
    private set
  var uiEpoch: Long = 0
    private set
  var connectionGeneration: Long = 0
    private set
  private var snapshotId: String? = null
  private var values: Map<String, T> = emptyMap()

  fun replace(
    snapshotId: String,
    packageName: String?,
    uiEpoch: Long,
    connectionGeneration: Long,
    values: Map<String, T>,
  ) {
    clear()
    this.snapshotId = snapshotId
    this.packageName = packageName
    this.uiEpoch = uiEpoch
    this.connectionGeneration = connectionGeneration
    this.values = values
  }

  fun matches(snapshotId: String): Boolean = this.snapshotId == snapshotId

  fun resolve(
    snapshotId: String,
    ref: String,
  ): T? = if (matches(snapshotId)) values[ref] else null

  fun clear() {
    values.values.forEach(release)
    values = emptyMap()
    snapshotId = null
    packageName = null
    uiEpoch = 0
    connectionGeneration = 0
  }
}

private fun tapGesture(
  x: Int,
  y: Int,
): GestureDescription {
  val path = Path().apply { moveTo(x.toFloat(), y.toFloat()) }
  return GestureDescription
    .Builder()
    .addStroke(GestureDescription.StrokeDescription(path, 0, 1))
    .build()
}

private fun swipeGesture(action: MobileUiAction.Swipe): GestureDescription {
  val path =
    Path().apply {
      moveTo(action.x1.toFloat(), action.y1.toFloat())
      lineTo(action.x2.toFloat(), action.y2.toFloat())
    }
  return GestureDescription
    .Builder()
    .addStroke(GestureDescription.StrokeDescription(path, 0, action.durationMs))
    .build()
}
