package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class SessionsScreenGroupOwnerTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun groupConfirmationCannotCrossGatewayBeforeRecompositionOrAfterRestoration() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("group-owner-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val originalGateway = AndroidScreenshotFixture.gatewayId
    val replacementGateway = "group-owner-replacement"
    for (gateway in listOf(originalGateway, replacementGateway)) {
      prefs.gatewayRegistry.upsert(GatewayRegistryEntry(gateway, GatewayRegistryEntryKind.MANUAL, gateway))
    }
    prefs.gatewayRegistry.setActive(originalGateway)
    val group = "Owner-bound group"
    prefs.setSessionCustomGroups(listOf(group))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    var replaceGatewayWhenDisposed = false
    try {
      drainWithMainLooper { runtime.chat.sessions.first { it.isNotEmpty() } }
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("group-owner", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      val restoration = StateRestorationTester(composeRule)
      restoration.setContent {
        if (mounted.value) {
          DisposableEffect(Unit) {
            onDispose {
              if (replaceGatewayWhenDisposed) prefs.gatewayRegistry.setActive(replacementGateway)
            }
          }
          ClawDesignTheme(dark = true) {
            SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {})
          }
        }
      }
      for ((action, title) in listOf("Rename" to "Rename group", "Delete" to "Delete group?")) {
        fun openDialog() {
          composeRule.onNodeWithText(group).performScrollTo().performSemanticsAction(SemanticsActions.OnLongClick) { it() }
          composeRule.onNodeWithText("$action group…").performClick()
          composeRule.onNodeWithText(title).assertIsDisplayed()
        }

        composeRule.runOnIdle { prefs.gatewayRegistry.setActive(originalGateway) }
        openDialog()
        if (action == "Rename") composeRule.onNode(hasSetTextAction() and hasAnyAncestor(isDialog())).performTextReplacement("Renamed group")
        val confirm =
          requireNotNull(
            composeRule
              .onNodeWithText(action)
              .fetchSemanticsNode()
              .config[SemanticsActions.OnClick]
              .action,
          )
        composeRule.runOnIdle {
          prefs.gatewayRegistry.setActive(replacementGateway)
          // Invoke the real registered button before recomposition can retire its dialog.
          confirm()
        }
        composeRule.runOnIdle { assertEquals("Stale $action must not change app-global groups", listOf(group), prefs.sessionCustomGroups.value) }
        composeRule.onNodeWithText(title).assertDoesNotExist()

        composeRule.runOnIdle { prefs.gatewayRegistry.setActive(originalGateway) }
        openDialog()
        restoration.emulateSavedInstanceStateRestore()
        composeRule.onNodeWithText(title).assertIsDisplayed()
        // Change the owner between saving the old dialog and restoring its composition.
        replaceGatewayWhenDisposed = true
        restoration.emulateSavedInstanceStateRestore()
        replaceGatewayWhenDisposed = false
        composeRule.onNodeWithText(title).assertDoesNotExist()
        composeRule.runOnIdle { assertEquals(listOf(group), prefs.sessionCustomGroups.value) }
      }
    } finally {
      replaceGatewayWhenDisposed = false
      composeRule.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        closeNodeRuntimeTestFixture(runtime)
      }
    }
  }
}
