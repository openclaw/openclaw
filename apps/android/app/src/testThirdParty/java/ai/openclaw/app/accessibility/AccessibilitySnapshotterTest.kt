package ai.openclaw.app.accessibility

import android.graphics.Rect
import android.text.InputType
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowAccessibilityNodeInfo

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [SnapshotNodeShadow::class])
class AccessibilitySnapshotterTest {
  @Test
  fun observableServiceInstanceTracksTheLiveInstance() {
    val state = ObservableServiceInstance<Any>()
    val first = Any()
    val second = Any()

    assertEquals(AccessibilityServiceConnection<Any>(instance = null, generation = 0), state.connection.value)
    assertFalse(state.isConnected.value)

    state.connect(first)
    assertTrue(state.connection.value.instance === first)
    assertEquals(1L, state.connection.value.generation)
    assertTrue(state.isConnected.value)

    state.connect(second)
    state.disconnect(first)
    assertTrue(state.connection.value.instance === second)
    assertEquals(2L, state.connection.value.generation)
    assertTrue(state.isConnected.value)

    state.disconnect(second)
    assertEquals(null, state.connection.value.instance)
    assertEquals(2L, state.connection.value.generation)
    assertFalse(state.isConnected.value)
  }

  @Test
  fun normalizerCapsSnapshotsAtMaximumNodeCountAndRecyclesDiscardedNodes() {
    val children = List(MAX_NODES + 5) { index -> snapshotNode(text = "node-$index") }
    val root = snapshotNode(boundsInScreen = Rect(), children = children)

    val result = AccessibilityTreeNormalizer.normalize(root)

    assertEquals(MAX_NODES, result.nodes.size)
    assertEquals("n0", result.nodes.first().ref)
    assertEquals("n${MAX_NODES - 1}", result.nodes.last().ref)
    assertTrue(root.snapshotShadow.recycled)
    assertTrue(children.takeLast(5).all { it.snapshotShadow.recycled })
    assertFalse(children.take(MAX_NODES).any { it.snapshotShadow.recycled })

    result.retainedNodes.values.forEach { it.snapshotShadow.recycle() }
    assertTrue(children.all { it.snapshotShadow.recycled })
  }

  @Test
  fun normalizerDoesNotWalkBelowMaximumDepth() {
    var root = snapshotNode(text = "deepest")
    repeat(MAX_DEPTH + 2) { depth ->
      root = snapshotNode(text = "depth-$depth", children = listOf(root))
    }

    val result = AccessibilityTreeNormalizer.normalize(root)

    assertEquals(MAX_DEPTH + 1, result.nodes.size)
    result.retainedNodes.values.forEach { it.snapshotShadow.recycle() }
  }

  @Test
  fun passwordTextIsRedactedAndLongTextIsBounded() {
    assertTrue(shouldRedactText(isPassword = true, isEditable = false, inputType = 0))
    assertTrue(
      shouldRedactText(
        isPassword = false,
        isEditable = true,
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
      ),
    )
    assertFalse(
      shouldRedactText(
        isPassword = false,
        isEditable = true,
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_NORMAL,
      ),
    )
    assertEquals("[redacted]", normalizeNodeText("hunter2", sensitive = true))

    val truncated = normalizeNodeText("x".repeat(MAX_TEXT_PER_NODE + 10), sensitive = false)
    assertEquals(MAX_TEXT_PER_NODE, truncated?.length)
    assertTrue(truncated?.endsWith("…") == true)
  }

  @Test
  fun actionNamesUseStableVocabularyAndOrdering() {
    val actions =
      stableActionNames(
        listOf(
          AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD,
          AccessibilityNodeInfo.ACTION_SET_TEXT,
          AccessibilityNodeInfo.ACTION_CLICK,
          AccessibilityNodeInfo.ACTION_COPY,
          AccessibilityNodeInfo.ACTION_FOCUS,
        ),
      )

    assertEquals(listOf("activate", "set_text", "scroll_backward", "focus"), actions)
  }

  @Test
  fun wrongSnapshotOrMissingRefIsStaleAndReplacementReleasesOldNodes() {
    val released = mutableListOf<String>()
    val store = SnapshotGenerationStore<String>(released::add)
    store.replace(
      snapshotId = "snapshot-1",
      packageName = "example.one",
      uiEpoch = 11,
      connectionGeneration = 21,
      values = mapOf("n0" to "first"),
    )

    assertEquals(null, store.resolve("wrong-snapshot", "n0"))
    assertEquals(null, store.resolve("snapshot-1", "missing"))
    assertEquals("first", store.resolve("snapshot-1", "n0"))

    store.replace(
      snapshotId = "snapshot-2",
      packageName = "example.two",
      uiEpoch = 12,
      connectionGeneration = 22,
      values = emptyMap(),
    )
    assertEquals(listOf("first"), released)
    assertEquals("example.two", store.packageName)
    assertEquals(12L, store.uiEpoch)
    assertEquals(22L, store.connectionGeneration)
  }

  @Test
  fun executorRejectsAnActionFromTheWrongSnapshotGeneration() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val executor = AccessibilityActionExecutor(connectionProvider = { testConnection(service) })
      val observed = executor.observe()

      val result = executor.act("${observed.id}-stale", MobileUiAction.Wait(0))

      assertEquals(ActionOutcomeCode.TargetStale, result.code)
      executor.close()
      service.onDestroy()
    }

  @Test
  fun platformNodeFieldsArePreservedAndSensitiveTextIsRedacted() {
    val sensitiveNode =
      snapshotNode(
        text = "secret text",
        contentDescription = "secret description",
        viewId = "example:id/password",
        password = true,
      ).apply {
        className = "android.widget.EditText"
        isClickable = true
        isEditable = true
        isScrollable = true
        isEnabled = false
        isFocused = true
        addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_TEXT)
        addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_FOCUS)
      }

    val result = AccessibilityTreeNormalizer.normalize(sensitiveNode)

    assertEquals("[redacted]", result.nodes.single().text)
    assertEquals("[redacted]", result.nodes.single().contentDescription)
    assertEquals("example:id/password", result.nodes.single().viewId)
    assertEquals("text_field", result.nodes.single().role)
    assertEquals(Rect(0, 0, 10, 10), result.nodes.single().boundsInScreen)
    assertTrue(result.nodes.single().clickable)
    assertTrue(result.nodes.single().editable)
    assertTrue(result.nodes.single().scrollable)
    assertFalse(result.nodes.single().enabled)
    assertTrue(result.nodes.single().focused)
    assertEquals(listOf("set_text", "focus"), result.nodes.single().actions)
    result.retainedNodes.values.forEach { it.snapshotShadow.recycle() }
  }

  @Test
  fun normalizerDoesNotFetchBeyondTraversalBudget() {
    val children = List(MAX_VISITED_NODES * 2) { index -> snapshotNode(text = "wide-$index") }
    val root = snapshotNode(boundsInScreen = Rect(), children = children)

    val result = AccessibilityTreeNormalizer.normalize(root)

    assertEquals(MAX_NODES, result.nodes.size)
    assertEquals(MAX_VISITED_NODES - 1, root.snapshotShadow.childRequests)
    result.retainedNodes.values.forEach { it.snapshotShadow.recycle() }
    assertTrue(root.snapshotShadow.recycled)
    assertTrue(children.take(MAX_VISITED_NODES - 1).all { it.snapshotShadow.recycled })
    assertFalse(children.drop(MAX_VISITED_NODES - 1).any { it.snapshotShadow.recycled })
  }

  @Test
  fun coordinateGestureFailsClosedWhenPackageIdentityIsMissingOrChanged() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val cases =
        listOf(
          null to "example.current",
          "example.expected" to null,
          "example.expected" to "example.current",
        )

      cases.forEachIndexed { index, (expectedPackage, currentPackage) ->
        val executor =
          AccessibilityActionExecutor(
            connectionProvider = { testConnection(service) },
            captureSnapshot = { fakeCapture("snapshot-$index", expectedPackage) },
            foregroundPackageProvider = { currentPackage },
            uiEpochProvider = { 20 },
          )
        val observed = executor.observe()

        val result = executor.act(observed.id, MobileUiAction.Tap(10, 20))

        assertEquals(ActionOutcomeCode.PackageChanged, result.code)
        executor.close()
      }
      service.onDestroy()
    }

  @Test
  fun coordinateGestureIsStaleAfterUiEpochAdvances() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val executor =
        AccessibilityActionExecutor(
          connectionProvider = { testConnection(service) },
          captureSnapshot = { fakeCapture("epoch-snapshot", "example.package") },
          foregroundPackageProvider = { "example.package" },
        )
      val observed = executor.observe()
      val capturedEpoch = OpenClawAccessibilityService.uiEpoch

      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_VIEW_FOCUSED)
      assertEquals(capturedEpoch, OpenClawAccessibilityService.uiEpoch)
      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED)
      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_WINDOWS_CHANGED)
      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_VIEW_SCROLLED)
      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED)
      sendAccessibilityEvent(service, AccessibilityEvent.TYPE_VIEW_TEXT_SELECTION_CHANGED)
      assertEquals(capturedEpoch + 6, OpenClawAccessibilityService.uiEpoch)
      val result = executor.act(observed.id, MobileUiAction.Tap(10, 20))

      assertEquals(ActionOutcomeCode.TargetStale, result.code)
      assertEquals("UI changed since observe; re-observe before coordinate actions", result.message)
      executor.close()
      service.onDestroy()
    }

  @Test
  fun actionIsStaleAfterAccessibilityServiceReconnects() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      var connectionGeneration = 70L
      val executor =
        AccessibilityActionExecutor(
          connectionProvider = { testConnection(service, connectionGeneration) },
          captureSnapshot = { fakeCapture("connection-snapshot", "example.package") },
          foregroundPackageProvider = { "example.package" },
          uiEpochProvider = { 80 },
        )
      val observed = executor.observe()
      connectionGeneration += 1

      val result = executor.act(observed.id, MobileUiAction.Tap(10, 20))

      assertEquals(ActionOutcomeCode.TargetStale, result.code)
      assertEquals("Accessibility service reconnected; re-observe before acting", result.message)
      executor.close()
      service.onDestroy()
    }

  @Test
  @Suppress("DEPRECATION")
  fun observeCannotPublishAGenerationAfterExecutorCloses() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val node = AccessibilityNodeInfo.obtain()
      lateinit var executor: AccessibilityActionExecutor
      executor =
        AccessibilityActionExecutor(
          connectionProvider = { testConnection(service, generation = 100) },
          captureSnapshot = {
            executor.close()
            fakeCapture(
              id = "closed-snapshot",
              packageName = "example.package",
              nodesByRef = mapOf("n0" to node),
            )
          },
          foregroundPackageProvider = { "example.package" },
          uiEpochProvider = { 90 },
        )

      val error = assertThrows(AccessibilityServiceDisabledException::class.java) { executor.observe() }
      val result = executor.act("closed-snapshot", MobileUiAction.GlobalAction(GlobalActionName.Home))

      assertEquals("Accessibility executor closed during observe", error.message)
      assertEquals(ActionOutcomeCode.ServiceDisabled, result.code)
      service.onDestroy()
    }

  @Test
  fun nodeActionFailsClosedWhenPackageIdentityIsMissingOrChanged() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val cases =
        listOf(
          null to "example.current",
          "example.expected" to null,
          "example.expected" to "example.current",
        )

      cases.forEachIndexed { index, (expectedPackage, currentPackage) ->
        val executor =
          AccessibilityActionExecutor(
            connectionProvider = { testConnection(service) },
            captureSnapshot = { fakeCapture("node-snapshot-$index", expectedPackage) },
            foregroundPackageProvider = { currentPackage },
            uiEpochProvider = { 40 },
          )
        val observed = executor.observe()

        val result = executor.act(observed.id, MobileUiAction.Activate("n0"))

        assertEquals(ActionOutcomeCode.PackageChanged, result.code)
        executor.close()
      }
      service.onDestroy()
    }

  @Test
  @Suppress("DEPRECATION")
  fun nodeActionUsesNodeFreshnessInsteadOfUiEpoch() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val node = AccessibilityNodeInfo.obtain()
      var uiEpoch = 50L
      val executor =
        AccessibilityActionExecutor(
          connectionProvider = { testConnection(service) },
          captureSnapshot = {
            fakeCapture(
              id = "node-epoch-snapshot",
              packageName = "example.package",
              nodesByRef = mapOf("n0" to node),
            )
          },
          foregroundPackageProvider = { "example.package" },
          uiEpochProvider = { uiEpoch },
        )
      val observed = executor.observe()
      uiEpoch += 1

      val result = executor.act(observed.id, MobileUiAction.Activate("n0"))

      assertTrue(
        result.code == ActionOutcomeCode.TargetNotFound ||
          result.code == ActionOutcomeCode.ActionNotSupported,
      )
      assertFalse(result.message?.contains("UI changed since observe") == true)
      executor.close()
      service.onDestroy()
    }

  @Test
  @Suppress("DEPRECATION")
  fun setTextChecksSecureContentAfterTheFinalNodeRefresh() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val node =
        AccessibilityNodeInfo.obtain().apply {
          isEditable = true
          isPassword = true
          addAction(AccessibilityNodeInfo.ACTION_SET_TEXT)
        }
      val shadowNode = shadowOf(node).apply { setRefreshReturnValue(true) }
      val executor =
        AccessibilityActionExecutor(
          connectionProvider = { testConnection(service) },
          captureSnapshot = {
            fakeCapture(
              id = "secure-text-snapshot",
              packageName = "example.package",
              nodesByRef = mapOf("n0" to node),
            )
          },
          foregroundPackageProvider = { "example.package" },
          uiEpochProvider = { 60 },
        )
      val observed = executor.observe()

      val result = executor.act(observed.id, MobileUiAction.SetText("n0", "must not be sent"))

      assertEquals(ActionOutcomeCode.SecureContent, result.code)
      assertTrue(shadowNode.performedActions.isEmpty())
      executor.close()
      service.onDestroy()
    }

  @Test
  fun devUiEnablesNodeActionsOnlyForMatchingKnownPackages() {
    assertFalse(canRunNodeActions(snapshotPackageName = null, foregroundPackageName = "example"))
    assertFalse(canRunNodeActions(snapshotPackageName = "example", foregroundPackageName = null))
    assertFalse(canRunNodeActions(snapshotPackageName = "example", foregroundPackageName = "other"))
    assertTrue(canRunNodeActions(snapshotPackageName = "example", foregroundPackageName = "example"))
  }

  @Test
  fun globalActionDoesNotRequirePackageIdentity() =
    runTest {
      val service = Robolectric.buildService(OpenClawAccessibilityService::class.java).create().get()
      val executor =
        AccessibilityActionExecutor(
          connectionProvider = { testConnection(service) },
          foregroundPackageProvider = { error("Global actions must not query the foreground package") },
          uiEpochProvider = { error("Global actions must not query the UI epoch") },
        )

      val result = executor.act("no-snapshot", MobileUiAction.GlobalAction(GlobalActionName.Home))

      assertTrue(result.code == ActionOutcomeCode.Completed || result.code == ActionOutcomeCode.ActionRejected)
      executor.close()
      service.onDestroy()
    }
}

private fun testConnection(
  service: OpenClawAccessibilityService,
  generation: Long = 0,
): AccessibilityServiceConnection<OpenClawAccessibilityService> = AccessibilityServiceConnection(instance = service, generation = generation)

private fun fakeCapture(
  id: String,
  packageName: String?,
  nodesByRef: Map<String, AccessibilityNodeInfo> = emptyMap(),
): AccessibilitySnapshotCapture =
  AccessibilitySnapshotCapture(
    snapshot =
      MobileUiSnapshot(
        id = id,
        capturedAtMs = 0,
        packageName = packageName,
        windowTitle = null,
        nodes = emptyList(),
      ),
    nodesByRef = nodesByRef,
  )

@Suppress("DEPRECATION")
private fun sendAccessibilityEvent(
  service: OpenClawAccessibilityService,
  eventType: Int,
) {
  val event = AccessibilityEvent.obtain(eventType)
  try {
    service.onAccessibilityEvent(event)
  } finally {
    event.recycle()
  }
}

private fun snapshotNode(
  text: String? = null,
  contentDescription: String? = null,
  viewId: String? = null,
  boundsInScreen: Rect = Rect(0, 0, 10, 10),
  password: Boolean = false,
  children: List<AccessibilityNodeInfo> = emptyList(),
): AccessibilityNodeInfo =
  AccessibilityNodeInfo().apply {
    className = "android.view.View"
    this.text = text
    this.contentDescription = contentDescription
    viewIdResourceName = viewId
    setBoundsInScreen(boundsInScreen)
    isPassword = password
    isEnabled = true
    snapshotShadow.children = children
  }

private val AccessibilityNodeInfo.snapshotShadow: SnapshotNodeShadow
  get() = Shadow.extract(this)

// Only child acquisition and recycling are instrumented; node fields use Android's real accessors.
@Implements(AccessibilityNodeInfo::class)
class SnapshotNodeShadow : ShadowAccessibilityNodeInfo() {
  var children: List<AccessibilityNodeInfo> = emptyList()
  var childRequests: Int = 0
    private set
  var recycled: Boolean = false
    private set

  @Implementation
  public override fun getChildCount(): Int = children.size

  @Implementation
  public override fun getChild(index: Int): AccessibilityNodeInfo {
    childRequests += 1
    return children[index]
  }

  @Implementation
  public override fun recycle() {
    check(!recycled) { "Fake node recycled twice" }
    recycled = true
  }
}
