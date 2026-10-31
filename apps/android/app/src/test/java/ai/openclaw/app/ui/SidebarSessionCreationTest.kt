package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.graphics.Bitmap
import android.os.Looper
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarSessionCreationTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun threadsDisplaysExplicitLineageAndKeepsOrdinaryNewIndependent() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("threads-placement", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.CompletedWork)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
    try {
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("threads", it) }
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      shadowOf(Looper.getMainLooper()).idle()
      val parent = ChatSessionEntry(key = "agent:main:dashboard:project", sessionId = "project", updatedAtMs = null, displayName = "Project")
      // Historical ordinary-New storage can be linked even though its row is a root.
      val ordinary = parent.copy(key = "agent:main:dashboard:ordinary", displayName = "Ordinary New", parentSessionKey = parent.key, createdVia = "operator", spawnDepth = 0)
      val child = ordinary.copy(key = "agent:main:dashboard:child", displayName = "Child")
      val grandchild = child.copy(key = "agent:main:dashboard:grandchild", displayName = "Grandchild", parentSessionKey = child.key)
      // Keep the real screen from replacing the synthetic rows with its default fixture refresh.
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_isConnected").value = false
      val entries = ReflectionHelpers.getField<MutableStateFlow<List<ChatSessionEntry>>>(runtime.chat, "presentedSessions")
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme {
            SessionsScreen(viewModel = model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {})
          }
        }
      }

      fun left(label: String): Float =
        composeRule
          .onNodeWithText(label, useUnmergedTree = true)
          .fetchSemanticsNode()
          .boundsInRoot.left

      fun capture(name: String) {
        val output = File("build/outputs/threads-placement/$name.png")
        checkNotNull(output.parentFile).mkdirs()
        output.outputStream().use {
          composeRule
            .onRoot()
            .captureToImage()
            .asAndroidBitmap()
            .compress(Bitmap.CompressFormat.PNG, 100, it)
        }
      }
      composeRule.runOnIdle {
        entries.value = listOf(parent, ordinary, child, grandchild)
      }
      composeRule.waitUntil(timeoutMillis = 5_000) {
        model.chatSessions.value.any { it.key == grandchild.key }
      }
      composeRule.waitForIdle()
      capture("diagnostic-before")
      composeRule.onNodeWithText("Grandchild").assertIsDisplayed()
      assertEquals(left("Project"), left("Child"), 0.1f)
      assertEquals(left("Project"), left("Grandchild"), 0.1f)
      capture("before-metadata")
      composeRule.runOnIdle {
        entries.value = listOf(parent, ordinary, child.copy(explicitChild = true), grandchild.copy(explicitChild = true))
      }
      composeRule.waitUntil(timeoutMillis = 5_000) {
        model.chatSessions.value.count { it.explicitChild == true } == 2
      }
      composeRule.waitForIdle()
      capture("after-metadata")
      composeRule.onNodeWithText("Grandchild").assertIsDisplayed()
      assertTrue(left("Child") > left("Project"))
      assertTrue(left("Grandchild") > left("Child"))
      assertEquals(left("Project"), left("Ordinary New"), 0.1f)
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      models.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        bindNodeRuntimeTestFixture(app, previousRuntime)
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
      }
    }
  }

  @Test
  fun rootAndSelectedChildActionsAreDistinctAndRespectConnection() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-creation", Context.MODE_PRIVATE))
    // The default screenshot scene contains an active run; creation requires an idle session.
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.CompletedWork)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val connected = mutableStateOf(true)
    val session = ChatSessionEntry(key = "agent:main:demo", sessionId = "demo", updatedAtMs = null, displayName = "Project notes", pinned = true)
    val other = session.copy(key = "agent:main:other", sessionId = "other", displayName = "Other project")
    val selected = mutableStateOf(session.key)
    var roots = 0
    var parent: String? = null
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
    try {
      bindNodeRuntimeTestFixture(app, runtime)
      ReflectionHelpers.getField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value = listOf("operator.write")
      val model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("sidebar", it) }
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals(listOf("operator.write"), model.operatorScopes.value)
      assertEquals(0, model.pendingRunCount.value)
      assertEquals(false, model.chatSessionCreating.value)
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme {
            OpenClawSidebar(
              viewModel = model,
              agents = emptyList(),
              selectedAgentId = "main",
              sessions = listOf(session, other),
              activeSessionKey = selected.value,
              activeDestination = null,
              connection = GatewayConnectionDisplay(connected.value, "Connected", null),
              visible = true,
              showCloseButton = true,
              onClose = {},
              onDragActiveChange = {},
              onNewSession = { roots++ },
              onNewChildSession = { parent = it },
              onSelectAgent = {},
              onSelectSession = { selected.value = it.key },
              onSelectCatalogSession = {},
              onCreateCatalogSession = {},
              onSelectDestination = {},
            )
          }
        }
      }
      composeRule.onNodeWithTag("sidebar-new-session").assertIsEnabled().performClick()
      assertEquals(1, roots)
      composeRule.onNodeWithText("New independent session").assertDoesNotExist()
      val creating = ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime.chat, "_isCreatingSession")
      composeRule.runOnIdle { creating.value = true }
      composeRule
        .onNodeWithTag("sidebar-new-session")
        .assertIsNotEnabled()
        .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Loading"))
      composeRule.runOnIdle { creating.value = false }
      composeRule.onNodeWithTag("sidebar-new-session").assertIsEnabled()
      composeRule.onNodeWithText("Pinned").performClick()
      composeRule.onNodeWithText("New child session").assertDoesNotExist()
      composeRule.onNodeWithTag("session-menu-${session.key}").assertExists()
      composeRule.onNodeWithText("Other project").performClick()
      composeRule.onNodeWithTag("session-menu-${session.key}").assertDoesNotExist()
      composeRule.onNodeWithTag("session-menu-${other.key}").performClick()
      val menuImage = File("build/outputs/sidebar-creation/menu-open.png")
      checkNotNull(menuImage.parentFile).mkdirs()
      menuImage.outputStream().use {
        check(
          composeRule
            .onNode(isPopup())
            .captureToImage()
            .asAndroidBitmap()
            .compress(Bitmap.CompressFormat.PNG, 100, it),
        )
      }
      composeRule
        .onNodeWithText("New child session")
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      assertEquals(other.key, parent)
      val image = File("build/outputs/sidebar-creation/after.png")
      checkNotNull(image.parentFile).mkdirs()
      image.outputStream().use {
        composeRule
          .onRoot()
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it)
      }
      composeRule.runOnIdle { connected.value = false }
      composeRule.onNodeWithTag("sidebar-new-session").assertIsNotEnabled()
      composeRule.onNodeWithTag("session-menu-${other.key}").performClick()
      composeRule.onNodeWithText("New child session").assertIsNotEnabled()
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      models.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        bindNodeRuntimeTestFixture(app, previousRuntime)
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
      }
    }
  }
}
