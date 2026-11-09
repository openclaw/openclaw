package ai.openclaw.releasevalidation

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.StaleObjectException
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import java.io.File

/** Native UI operations shared by the two release-only instrumentation APKs. */
internal class ReleaseValidationUi(
  private val instrumentation: Instrumentation,
) {
  val device: UiDevice = UiDevice.getInstance(instrumentation)
  private val context = instrumentation.targetContext
  private val automation = instrumentation.uiAutomation
  private val candidatePackage = context.packageName

  init {
    automation.serviceInfo =
      automation.serviceInfo.apply {
        flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      }
  }

  fun launch(activityClass: String) {
    context.startActivity(
      Intent().setClassName(candidatePackage, activityClass).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    assertTrue(
      "Normal launcher did not foreground the candidate",
      device.wait(Condition<UiDevice, Boolean> { device.currentPackageName == candidatePackage }, 30_000),
    )
  }

  fun requireObject(
    selector: BySelector,
    label: String,
    timeoutMillis: Long = 30_000,
  ): UiObject2 = checkNotNull(device.wait(Until.findObject(selector), timeoutMillis)) { label }

  fun clickText(text: String) {
    assertTrue("Native action was rejected: $text", nativeClick(By.pkg(candidatePackage).text(text), "Native action was not available: $text"))
  }

  private fun nativeClick(
    selector: BySelector,
    label: String,
  ): Boolean {
    val action = AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK
    val target =
      checkNotNull(
        device.wait(
          Condition<UiDevice, AccessibilityNodeInfo?> {
            // A screen heading and its drawer destination can expose the same text.
            device
              .findObjects(selector)
              .asSequence()
              .mapNotNull { match ->
                try {
                  val node = match.accessibilityNodeInfo
                  generateSequence(node) { it.parent }
                    .take(8)
                    .firstOrNull {
                      it.isVisibleToUser && it.isEnabled && (it.actionList.contains(action) || it.isSelected)
                    }
                } catch (_: StaleObjectException) {
                  // Reacquire replaced nodes within the existing deadline, before issuing any action.
                  null
                }
              }.firstOrNull()
          },
          30_000,
        ),
      ) { "$label: native tap target was not exposed" }
    if (target.actionList.contains(action)) return target.performAction(action.id)
    // Compose omits click actions for selected tabs; only those need a native tap.
    val bounds = Rect().also(target::getBoundsInScreen)
    check(!bounds.isEmpty) { "$label: selected tab bounds were empty" }
    return device.click(bounds.centerX(), bounds.centerY())
  }

  fun swipe(forward: Boolean) {
    val x = device.displayWidth / 2
    val high = device.displayHeight * 30 / 100
    val low = device.displayHeight * 78 / 100
    assertTrue(device.swipe(x, if (forward) low else high, x, if (forward) high else low, 16))
    device.waitForIdle(500)
  }

  fun reveal(
    selector: BySelector,
    label: String,
    attempts: Int = 36,
  ): UiObject2 {
    repeat(attempts) { index ->
      try {
        device.findObject(selector)?.let { node ->
          if (node.visibleBounds.height() > 8 && node.visibleCenter.y in device.displayHeight / 8..device.displayHeight * 7 / 8) return node
        }
      } catch (_: StaleObjectException) {
        // Read-only viewport observations can disappear during Compose layout.
      }
      // Follow the product's latest-message control before searching the viewport.
      val latest = device.findObject(By.pkg(candidatePackage).desc("Jump to latest")) ?: device.findObject(By.pkg(candidatePackage).text("New ↓"))
      if (latest != null && index == 0) {
        latest.click()
        device.waitForIdle(500)
      } else {
        swipe(forward = index < 6 || index >= 22)
      }
    }
    return requireObject(selector, label, 5_000)
  }

  fun clickRevealed(
    selector: BySelector,
    label: String,
  ) {
    reveal(selector, label)
    assertTrue("$label: native click was rejected", nativeClick(selector, label))
  }

  fun reply(marker: String): UiObject2 = reveal(By.pkg(candidatePackage).text(marker), "Candidate assistant reply was not visible: $marker")

  fun capture(name: String) {
    val directory = File(checkNotNull(context.getExternalFilesDir(null)), "release-validation").apply { mkdirs() }
    assertTrue("Could not capture synthetic release UI", device.takeScreenshot(File(directory, "$name.png")))
  }

  fun ready(phase: String) {
    instrumentation.sendStatus(0, Bundle().apply { putString("stream", "OPENCLAW_ANDROID_PHASE_READY $phase\n") })
  }

  fun phoneSend(marker: String) {
    val field = requireObject(By.pkg(candidatePackage).clazz("android.widget.EditText"), "Chat composer was not available")
    field.click()
    field.text = prompt(marker)
    assertTrue("Native phone Send was rejected", nativeClick(By.pkg(candidatePackage).desc("Send").enabled(true), "Native phone Send was not enabled"))
    if (imeBounds() != null) device.pressBack()
    reply(marker)
    assertTrue("Phone reply must settle its native run control", device.wait(Until.gone(By.pkg(candidatePackage).desc("Stop")), 30_000))
  }

  fun verifyPhoneDraft(
    previousReply: String,
    screenshotName: String,
    longReply: Boolean = false,
  ) {
    if (longReply) phoneLongReplyEdge(tail = true) else reply(previousReply)
    val field = requireObject(By.pkg(candidatePackage).clazz("android.widget.EditText"), "Chat composer was not available")
    val draft = "Synthetic release draft\nSecond draft line"
    field.click()
    field.text = draft
    val keyboard = checkNotNull(device.wait(Condition<UiDevice, Rect?> { imeBounds() }, 10_000)) { "Real phone keyboard did not open" }
    if (longReply) phoneLongReplyEdge(tail = true)
    val transcriptSelector = if (longReply) By.pkg(candidatePackage).textContains(previousReply) else By.pkg(candidatePackage).text(previousReply)
    val reply = requireObject(transcriptSelector, "Transcript disappeared with the keyboard open")
    assertTrue("Transcript must remain above the keyboard", reply.visibleBounds.bottom <= keyboard.top)
    capture(screenshotName)
    device.pressBack()
    assertTrue("Back must dismiss the keyboard", device.wait(Condition<UiDevice, Boolean> { imeBounds() == null }, 5_000))
    assertEquals("Dismissing the keyboard must preserve the multiline draft", draft, field.text)
    field.text = ""
  }

  fun wearSend(marker: String) {
    val typeSelector = By.pkg(candidatePackage).text("Type").enabled(true)
    reveal(typeSelector, "Native Wear Type action was not reachable")
    captureWearType("before", marker)
    // Wear rows transform while scrolling; invoke the actual advertised UI click without stale hit coordinates.
    val clicked = nativeClick(typeSelector, "Native Wear Type action was not available")
    captureWearType("after", marker, clicked)
    assertTrue("Native Wear Type click was rejected", clicked)
    requireObject(By.pkg("com.google.android.wearable.sysui").desc("Keyboard input"), "Wear keyboard choice was not available", 10_000).click()
    val editorId = "com.google.android.inputmethod.latin:id/remote_ime_input"
    val editor = checkNotNull(device.wait(Condition<UiDevice, AccessibilityNodeInfo?> { findNode(editorId) }, 10_000)) { "Native Gboard editor was not available" }
    assertTrue("Native Gboard keyboard did not render", device.wait(Condition<UiDevice, Boolean> { imeBounds() != null }, 10_000))
    val text = prompt(marker)
    assertTrue(
      "Gboard rejected native text input",
      editor.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }),
    )
    assertTrue(
      "Native editor did not retain the complete synthetic prompt",
      device.wait(Condition<UiDevice, Boolean> { findNode(editorId)?.text?.toString() == text }, 5_000),
    )
    val send = device.findObject(By.pkg("com.google.android.inputmethod.latin").desc("Send")) ?: device.findObject(By.pkg("com.google.android.inputmethod.latin").text("Send"))
    if (send != null) {
      send.click()
    } else {
      // Gboard may expose the actual IME Send action on its editor instead of a key node.
      val currentEditor = checkNotNull(findNode(editorId))
      val action = AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER
      assertTrue("Gboard did not expose native Send", currentEditor.actionList.contains(action))
      assertTrue("Native IME Send was rejected", currentEditor.performAction(action.id))
    }
    assertTrue(
      "Native Wear input did not return to the candidate",
      device.wait(
        Condition<UiDevice, Boolean> {
          device.findObject(By.pkg("com.google.android.wearable.sysui").text("Send"))?.click()
          device.hasObject(By.pkg(candidatePackage))
        },
        10_000,
      ),
    )
  }

  fun refreshWear() {
    val retry = By.pkg(candidatePackage).text("Retry").enabled(true)
    if (device.hasObject(retry)) {
      assertTrue("Native Wear Retry was rejected", nativeClick(retry, "Native Wear Retry was not available"))
      return
    }
    // The retained conversation has its Refresh action on the native Controls page.
    seekWearPage("CONTROLS", forward = true)
    clickRevealed(By.pkg(candidatePackage).text("Refresh").enabled(true), "Native Wear Refresh was not reachable")
  }

  private fun seekWearPage(
    expected: String,
    forward: Boolean,
  ) {
    repeat(6) {
      // Headers scroll with their pages; Voice also has its own nested horizontal pager.
      for (scroll in 0..12) {
        val header =
          listOf("CHAT", "CONTROLS", "PULSE").firstOrNull { label ->
            device.hasObject(By.pkg(candidatePackage).text(label))
          }
        if (header != null) {
          if (header == expected) return
          break
        }
        if (!device.hasObject(By.pkg(candidatePackage).scrollable(true))) break
        swipe(forward = false)
      }
      horizontalSwipe(forward)
    }
    error("Native Wear $expected page was not reachable")
  }

  fun phoneLongReplyEdge(tail: Boolean) {
    val sentinel = if (tail) "TRAILING SENTINEL" else "HEAD SENTINEL"
    repeat(100) {
      val composer = device.findObject(By.pkg(candidatePackage).clazz("android.widget.EditText"))
      val nodes = device.findObjects(By.pkg(candidatePackage).textContains(sentinel)).map { it.accessibilityNodeInfo }
      val composerTop = checkNotNull(composer) { "Long reply lost its native composer" }.visibleBounds.top
      val visibleEdge = nodes.any { node -> visibleCharacters(node, sentinel, composerTop) }
      if (visibleEdge) return
      swipe(forward = tail)
    }
    error("The rendered ${if (tail) "tail" else "head"} of the long phone reply was not reachable")
  }

  fun readerDiagnostics(): JSONObject {
    val composer = device.findObject(By.pkg(candidatePackage).clazz("android.widget.EditText"))
    val sentinels = JSONObject()
    for (sentinel in listOf("HEAD SENTINEL", "TRAILING SENTINEL")) {
      val nodes = JSONArray()
      for (node in device.findObjects(By.pkg(candidatePackage).textContains(sentinel)).map { it.accessibilityNodeInfo }) {
        val index = node.text?.toString()?.indexOf(sentinel) ?: -1
        val key = AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY
        val arguments =
          Bundle().apply {
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, index)
            putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, sentinel.length)
          }
        val refreshed = index >= 0 && key in node.availableExtraData && node.refreshWithExtraData(key, arguments)
        val boxes = if (refreshed && Build.VERSION.SDK_INT >= 33) node.extras.getParcelableArray(key, RectF::class.java) else null
        val ancestors = JSONArray()
        for (ancestor in generateSequence(node.parent) { it.parent }.take(32)) {
          ancestors.put(
            JSONObject()
              .put("class", ancestor.className?.toString())
              .put("resource", ancestor.viewIdResourceName)
              .put("scrollable", ancestor.isScrollable)
              .put("visible", ancestor.isVisibleToUser)
              .put("bounds", Rect().also(ancestor::getBoundsInScreen).flattenToString()),
          )
        }
        nodes.put(
          JSONObject()
            .put("package", node.packageName?.toString())
            .put("class", node.className?.toString())
            .put("textLength", node.text?.length ?: 0)
            .put("sentinelIndex", index)
            .put("visible", node.isVisibleToUser)
            .put("bounds", Rect().also(node::getBoundsInScreen).flattenToString())
            .put("availableExtraData", JSONArray(node.availableExtraData))
            .put("characterRefresh", refreshed)
            .put("characterBoxes", boxes?.let { JSONArray(it.map { box -> box?.let { rect -> JSONArray(listOf(rect.left, rect.top, rect.right, rect.bottom)) } ?: JSONObject.NULL }) } ?: JSONObject.NULL)
            .put("ancestors", ancestors),
        )
      }
      sentinels.put(sentinel, nodes)
    }
    return JSONObject()
      .put("activePackage", device.currentPackageName)
      .put("displayWidth", device.displayWidth)
      .put("displayHeight", device.displayHeight)
      .put("round", context.resources.configuration.isScreenRound)
      .put("composerBounds", composer?.visibleBounds?.flattenToString() ?: JSONObject.NULL)
      .put("imeBounds", imeBounds()?.flattenToString() ?: JSONObject.NULL)
      .put("sentinels", sentinels)
  }

  private fun visibleCharacters(
    node: AccessibilityNodeInfo,
    sentinel: String,
    bottomLimit: Int,
  ): Boolean {
    if (node.packageName?.toString() != candidatePackage || !node.isVisibleToUser) return false
    val index = node.text?.toString()?.indexOf(sentinel) ?: -1
    val key = AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY
    if (index < 0 || key !in node.availableExtraData) return false
    val arguments =
      Bundle().apply {
        putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_START_INDEX, index)
        putInt(AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_ARG_LENGTH, sentinel.length)
      }
    if (!node.refreshWithExtraData(key, arguments)) return false
    val boxes =
      if (Build.VERSION.SDK_INT >= 33) {
        node.extras.getParcelableArray(key, RectF::class.java)
      } else {
        error("Release reader character proof requires Android 33 or newer")
      }
    if (boxes == null || boxes.size != sentinel.length) return false
    val scrollable = generateSequence(node.parent) { it.parent }.take(32).firstOrNull { it.isScrollable } ?: return false
    val viewport = Rect().also(scrollable::getBoundsInScreen)
    val bottom = minOf(viewport.bottom, bottomLimit) - 8
    val round = context.resources.configuration.isScreenRound
    val centerX = device.displayWidth / 2f
    val centerY = device.displayHeight / 2f
    val radius = minOf(device.displayWidth, device.displayHeight) / 2f - 8
    // Compose clips whole-node bounds. Character extras leave offscreen glyphs null instead.
    return sentinel.indices.filter { !sentinel[it].isWhitespace() }.all { position ->
      val box = boxes[position]
      if (box == null || box.isEmpty) return@all false
      val inViewport = box.top >= viewport.top + 8 && box.bottom <= bottom && box.left >= viewport.left && box.right <= viewport.right
      val inDisplay =
        !round ||
          listOf(box.left to box.top, box.right to box.top, box.left to box.bottom, box.right to box.bottom).all { (x, y) ->
            val dx = x - centerX
            val dy = y - centerY
            dx * dx + dy * dy <= radius * radius
          }
      inViewport && inDisplay
    }
  }

  private fun captureWearType(
    moment: String,
    expectedMarker: String,
    clickAccepted: Boolean? = null,
  ) {
    val directory = File(context.filesDir, "release-validation-failure").apply { mkdirs() }
    val windows = JSONArray()
    for (window in automation.windows) {
      val root = window.root
      val nodes = JSONArray()
      var count = 0

      fun visit(node: AccessibilityNodeInfo) {
        if (++count > 1_000) return
        val bounds = Rect().also(node::getBoundsInScreen)
        nodes.put(
          JSONObject()
            .put("package", node.packageName?.toString())
            .put("resource", node.viewIdResourceName)
            .put("class", node.className?.toString())
            .put("text", safeWearLabel(node.text?.toString(), expectedMarker))
            .put("description", safeWearLabel(node.contentDescription?.toString(), expectedMarker))
            .put("clickable", node.isClickable)
            .put("enabled", node.isEnabled)
            .put("visible", node.isVisibleToUser)
            .put("bounds", bounds.flattenToString()),
        )
        repeat(node.childCount) { index -> node.getChild(index)?.let(::visit) }
      }
      root?.let(::visit)
      windows.put(
        JSONObject()
          .put("type", window.type)
          .put("active", window.isActive)
          .put("focused", window.isFocused)
          .put("nodes", nodes),
      )
    }
    File(directory, "wear-type-$moment.json").writeText(
      JSONObject()
        .put("moment", moment)
        .put("marker", expectedMarker)
        .put("clickAccepted", clickAccepted ?: JSONObject.NULL)
        .put("elapsedMillis", SystemClock.elapsedRealtime())
        .put("windows", windows)
        .toString(2),
    )
    val screenshot = automation.takeScreenshot()
    if (screenshot != null) {
      File(directory, "wear-type-$moment.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
      screenshot.recycle()
    }
  }

  private fun safeWearLabel(
    label: String?,
    expectedMarker: String,
  ): String? {
    if (label == null) return null
    val controls = setOf("Type", "Talk", "Ready", "Sending", "Agent working", "Keyboard input", "Keyboard", "Voice input", "Send", "Message", "Close", "Retry", "New ↓", "AGENT", "YOU", "Read full reply")
    if (label in controls || label == expectedMarker || label == prompt(expectedMarker)) return label
    val priorMarkers = listOf("PHONE_FIRST", "PHONE_SECOND", "WEAR_FIRST", "WEAR_SECOND", "WEAR_RELAUNCH", "PHONE_RELAUNCH", "PHONE_RESTART")
    return label.takeIf { candidate -> priorMarkers.any { candidate == marker(it) || candidate == prompt(marker(it)) } }
  }

  fun wearLongReplyEdge(tail: Boolean) {
    val sentinel = if (tail) "TRAILING SENTINEL" else "HEAD SENTINEL"
    val nextPart = By.pkg(candidatePackage).text("Next part").enabled(true)
    repeat(100) {
      val nodes =
        try {
          device.findObjects(By.pkg(candidatePackage).textContains(sentinel)).map { it.accessibilityNodeInfo }
        } catch (_: StaleObjectException) {
          // Opening or scrolling the reader can replace a matched Compose node; reacquire before acting.
          return@repeat
        }
      if (nodes.any { visibleCharacters(it, sentinel, device.displayHeight) }) return
      val textNode = nodes.firstOrNull { AccessibilityNodeInfo.EXTRA_DATA_TEXT_CHARACTER_LOCATION_KEY in it.availableExtraData }
      if (textNode != null && centerWearReaderNode(textNode)) {
        return@repeat
      }
      if (tail && device.hasObject(nextPart)) {
        assertTrue("Native Wear reader Next part was rejected", nativeClick(nextPart, "Native Wear reader Next part was not available"))
        device.waitForIdle(500)
      } else {
        swipe(forward = tail)
      }
    }
    error("The rendered ${if (tail) "tail" else "head"} of the full Wear reply was not reachable through native scrolling and pagination")
  }

  private fun centerWearReaderNode(node: AccessibilityNodeInfo): Boolean {
    val bounds = Rect().also(node::getBoundsInScreen)
    val center = device.displayHeight / 2
    val distance = (bounds.centerY() - center).coerceIn(-device.displayHeight / 6, device.displayHeight / 6)
    if (bounds.isEmpty || distance == 0) return false
    // Transforming rows shrink at the viewport edges; move the actual paragraph into the reading area.
    val x = device.displayWidth / 2
    assertTrue("Native Wear reader centering gesture was rejected", device.swipe(x, center, x, center - distance, 32))
    device.waitForIdle(500)
    return true
  }

  private fun horizontalSwipe(forward: Boolean) {
    val left = device.displayWidth * 18 / 100
    val right = device.displayWidth * 82 / 100
    val y = device.displayHeight / 2
    assertTrue(device.swipe(if (forward) right else left, y, if (forward) left else right, y, 20))
    device.waitForIdle(500)
  }

  private fun imeBounds(): Rect? =
    automation.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD && it.root?.isVisibleToUser == true }?.let { window ->
      Rect().also(window::getBoundsInScreen)
    }

  private fun findNode(resourceId: String): AccessibilityNodeInfo? =
    automation.windows
      .asSequence()
      .mapNotNull { it.root }
      .flatMap { it.findAccessibilityNodeInfosByViewId(resourceId).asSequence() }
      .firstOrNull()

  companion object {
    fun marker(name: String): String = "OPENCLAW_E2E_ANDROID_$name"

    fun prompt(marker: String): String = "This is Android release validation. Reply with exactly: $marker"
  }
}
