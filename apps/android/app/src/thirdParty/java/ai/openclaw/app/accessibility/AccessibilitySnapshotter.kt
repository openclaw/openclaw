package ai.openclaw.app.accessibility

import android.graphics.Rect
import android.text.InputType
import android.view.accessibility.AccessibilityNodeInfo
import java.util.UUID

internal const val MAX_NODES = 400
internal const val MAX_DEPTH = 40
internal const val MAX_TEXT_PER_NODE = 200

// Bounds AccessibilityNodeInfo acquisition so pathological trees cannot stall the UI thread or spike memory.
internal const val MAX_VISITED_NODES = 4_000

internal data class AccessibilitySnapshotCapture(
  val snapshot: MobileUiSnapshot,
  val nodesByRef: Map<String, AccessibilityNodeInfo>,
)

internal class AccessibilitySnapshotter {
  fun capture(service: OpenClawAccessibilityService): AccessibilitySnapshotCapture {
    val root = service.rootInActiveWindow
    val packageName = root?.packageName?.toString()
    val windowTitle = root?.readWindowTitle()
    val normalized = root?.let(AccessibilityTreeNormalizer::normalize)
    return AccessibilitySnapshotCapture(
      snapshot =
        MobileUiSnapshot(
          id = UUID.randomUUID().toString(),
          capturedAtMs = System.currentTimeMillis(),
          packageName = packageName,
          windowTitle = windowTitle,
          nodes = normalized?.nodes.orEmpty(),
        ),
      nodesByRef = normalized?.retainedNodes.orEmpty(),
    )
  }
}

internal data class NormalizedAccessibilityTree(
  val nodes: List<MobileUiNode>,
  val retainedNodes: Map<String, AccessibilityNodeInfo>,
)

internal object AccessibilityTreeNormalizer {
  private data class PendingNode(
    val node: AccessibilityNodeInfo,
    val depth: Int,
    val parentRef: String?,
  )

  fun normalize(root: AccessibilityNodeInfo): NormalizedAccessibilityTree {
    val pending = ArrayDeque<PendingNode>()
    val nodes = mutableListOf<MobileUiNode>()
    val retained = linkedMapOf<String, AccessibilityNodeInfo>()
    pending.addLast(PendingNode(root, depth = 0, parentRef = null))
    var discoveredNodeCount = 1

    var current: AccessibilityNodeInfo? = null
    try {
      while (pending.isNotEmpty()) {
        val item = pending.removeLast()
        current = item.node
        val bounds = Rect().also(current::getBoundsInScreen)
        val rawText = current.text?.toString()
        val rawDescription = current.contentDescription?.toString()
        val include =
          (bounds.width() > 0 && bounds.height() > 0) ||
            !rawText.isNullOrEmpty() ||
            !rawDescription.isNullOrEmpty() ||
            current.isClickable
        val ref = if (include) "n${nodes.size}" else item.parentRef
        val sensitive = shouldRedactText(current.isPassword, current.isEditable, current.inputType)

        if (include) {
          nodes +=
            MobileUiNode(
              ref = checkNotNull(ref),
              parentRef = item.parentRef,
              role = stableRole(current.className?.toString(), current.isClickable, current.isEditable),
              text = normalizeNodeText(rawText, sensitive),
              contentDescription = normalizeNodeText(rawDescription, sensitive),
              viewId = truncateNodeText(current.viewIdResourceName),
              boundsInScreen = bounds,
              clickable = current.isClickable,
              editable = current.isEditable,
              scrollable = current.isScrollable,
              enabled = current.isEnabled,
              focused = current.isFocused,
              actions = stableActionNames(current.actionList.map(AccessibilityNodeInfo.AccessibilityAction::getId)),
            )
        }

        val reachedNodeLimit = nodes.size >= MAX_NODES
        if (!reachedNodeLimit && item.depth < MAX_DEPTH) {
          val remainingTraversalBudget = MAX_VISITED_NODES - discoveredNodeCount
          val childSlotsToInspect = minOf(current.childCount, remainingTraversalBudget)
          for (index in childSlotsToInspect - 1 downTo 0) {
            discoveredNodeCount += 1
            current.getChild(index)?.let { child ->
              pending.addLast(PendingNode(child, depth = item.depth + 1, parentRef = ref))
            }
          }
        }

        if (include) {
          retained[checkNotNull(ref)] = current
        } else {
          recycle(current)
        }
        current = null
        if (reachedNodeLimit) break
      }
    } catch (error: Throwable) {
      current?.let(::recycle)
      retained.values.forEach(::recycle)
      pending.forEach { recycle(it.node) }
      throw error
    }

    pending.forEach { recycle(it.node) }
    return NormalizedAccessibilityTree(nodes = nodes, retainedNodes = retained)
  }

  // Android 31–32 still pool nodes; recycle became a no-op only in API 33.
  @Suppress("DEPRECATION")
  private fun recycle(node: AccessibilityNodeInfo) = node.recycle()
}

internal fun shouldRedactText(
  isPassword: Boolean,
  isEditable: Boolean,
  inputType: Int,
): Boolean {
  if (isPassword) return true
  if (!isEditable) return false

  val inputClass = inputType and InputType.TYPE_MASK_CLASS
  val variation = inputType and InputType.TYPE_MASK_VARIATION
  return when (inputClass) {
    InputType.TYPE_CLASS_TEXT -> {
      variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
        variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
    }

    InputType.TYPE_CLASS_NUMBER -> {
      variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
    }

    else -> {
      false
    }
  }
}

internal fun normalizeNodeText(
  text: String?,
  sensitive: Boolean,
): String? = if (sensitive) "[redacted]" else truncateNodeText(text)

internal fun truncateNodeText(text: String?): String? {
  if (text == null || text.length <= MAX_TEXT_PER_NODE) return text
  return text.take(MAX_TEXT_PER_NODE - 1) + "…"
}

internal fun stableActionNames(actionIds: Collection<Int>): List<String> {
  val ids = actionIds.toSet()
  return buildList {
    if (AccessibilityNodeInfo.ACTION_CLICK in ids) add("activate")
    if (AccessibilityNodeInfo.ACTION_LONG_CLICK in ids) add("long_press")
    if (AccessibilityNodeInfo.ACTION_SET_TEXT in ids) add("set_text")
    if (AccessibilityNodeInfo.ACTION_SCROLL_FORWARD in ids) add("scroll_forward")
    if (AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD in ids) add("scroll_backward")
    if (AccessibilityNodeInfo.ACTION_FOCUS in ids) add("focus")
  }
}

internal fun stableRole(
  className: String?,
  clickable: Boolean,
  editable: Boolean,
): String {
  val simpleName = className?.substringAfterLast('.')
  return when {
    editable -> "text_field"
    simpleName == "Button" || simpleName == "ImageButton" -> "button"
    simpleName == "CheckBox" -> "checkbox"
    simpleName == "Switch" || simpleName == "SwitchCompat" -> "switch"
    simpleName == "RadioButton" -> "radio"
    simpleName == "ImageView" -> "image"
    simpleName == "TextView" -> if (clickable) "button" else "text"
    simpleName == "ListView" || simpleName == "RecyclerView" -> "list"
    simpleName == "ScrollView" || simpleName == "HorizontalScrollView" -> "scroll_view"
    simpleName == "WebView" -> "web_view"
    clickable -> "button"
    else -> "node"
  }
}

@Suppress("DEPRECATION")
private fun AccessibilityNodeInfo.readWindowTitle(): String? {
  val nodeWindow = window ?: return null
  return try {
    nodeWindow.title?.toString()
  } finally {
    nodeWindow.recycle()
  }
}
