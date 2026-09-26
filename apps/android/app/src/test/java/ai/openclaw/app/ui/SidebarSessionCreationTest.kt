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
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
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
              sessions = listOf(session),
              activeSessionKey = session.key,
              activeDestination = null,
              connection = GatewayConnectionDisplay(connected.value, "Connected", null),
              visible = true,
              showCloseButton = true,
              onClose = {},
              onDragActiveChange = {},
              onNewSession = { roots++ },
              onNewChildSession = { parent = it },
              onSelectAgent = {},
              onSelectSession = {},
              onSelectCatalogSession = {},
              onCreateCatalogSession = {},
              onSelectDestination = {},
            )
          }
        }
      }
      composeRule
        .onNodeWithText("New independent session")
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      composeRule.onNodeWithText("Pinned").performClick()
      composeRule
        .onNodeWithText("New child")
        .assertIsDisplayed()
        .assertIsEnabled()
        .performClick()
      assertEquals(1, roots)
      assertEquals(session.key, parent)
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
      composeRule.onNodeWithText("New independent session").assertIsNotEnabled()
      composeRule.onNodeWithText("New child").assertIsNotEnabled()
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
