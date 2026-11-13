package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.ClipboardManager
import android.content.Context
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w400dp-h800dp-mdpi")
class SessionActionsTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun stationaryHoldOpensActionsButDragAndCancellationDoNot() {
    var clicks = 0
    var menus = 0
    val drags = mutableListOf<Int>()
    val active = mutableListOf<Boolean>()
    composeRule.setContent {
      ClawDesignTheme {
        SidebarSessionRow(
          session = ChatSessionEntry(key = "agent:main:gesture", updatedAtMs = null, label = "Gesture thread"),
          selected = true,
          palette = sidebarPalette(ClawTheme.colors),
          onClick = { clicks++ },
          onLongClick = { menus++ },
          onDragCommit = { drags += it },
          onDragActiveChange = { active += it },
        )
      }
    }
    val row = composeRule.onNodeWithText("Gesture thread").assertIsSelected()
    row.performClick()
    row.performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      up()
    }
    composeRule.runOnIdle {
      assertEquals(1, clicks)
      assertEquals(1, menus)
      assertEquals(emptyList<Int>(), drags)
      assertEquals(listOf(true, false), active)
    }
    for (distance in listOf(-64f, 64f)) {
      row.performTouchInput {
        down(center)
        moveTo(center, delayMillis = 700)
        moveTo(center + Offset(0f, distance), delayMillis = 100)
        up()
      }
    }
    // A drag that returns to its origin must not become a context-menu opening.
    row.performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      moveTo(center + Offset(40f, 0f), delayMillis = 100)
      moveTo(center, delayMillis = 100)
      up()
    }
    row.performTouchInput {
      down(center)
      moveTo(center, delayMillis = 700)
      cancel()
    }
    composeRule.runOnIdle {
      assertEquals(listOf(-1, 1), drags)
      assertEquals(1, menus)
      assertEquals(1, clicks)
      assertEquals(false, active.last())
    }
    row.performSemanticsAction(SemanticsActions.OnLongClick) { it() }
    composeRule.runOnIdle { assertEquals(2, menus) }
  }

  @Test
  fun identicalTitlesCopyTheirOwnKeyAndRenameCancelKeepsSelection() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("session-actions-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    prefs.gatewayRegistry.upsert(GatewayRegistryEntry(AndroidScreenshotFixture.gatewayId, GatewayRegistryEntryKind.MANUAL, "Fixture gateway"))
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val previousRuntime = app.peekRuntime()
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val threadsVisible = mutableStateOf(false)
    val previousScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("session-actions", it) }
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    val keys = listOf("agent:main:first", "agent:other:second")
    var selections = 0
    try {
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme {
            if (threadsVisible.value) {
              SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = { selections++ })
            } else {
              Column {
                keys.forEach { key ->
                  val session = ChatSessionEntry(key = key, updatedAtMs = null, label = "Same title")
                  SessionRowActions(model, session) { onLongClick ->
                    SidebarSessionRow(
                      session = session,
                      selected = false,
                      palette = sidebarPalette(ClawTheme.colors),
                      onClick = { selections++ },
                      onLongClick = onLongClick,
                    )
                  }
                }
              }
            }
          }
        }
      }
      for ((index, key) in keys.withIndex()) {
        composeRule.onAllNodesWithText("Same title")[index].performTouchInput {
          down(center)
          moveTo(center, delayMillis = 700)
          up()
        }
        composeRule.onNodeWithText("Copy session reference").assertIsDisplayed().performClick()
        composeRule.runOnIdle {
          assertEquals(
            key,
            app
              .getSystemService(ClipboardManager::class.java)
              .primaryClip!!
              .getItemAt(0)
              .text
              .toString(),
          )
          assertEquals("Session reference copied", ShadowToast.getTextOfLatestToast())
        }
      }
      composeRule.onAllNodesWithText("Same title")[0].performSemanticsAction(SemanticsActions.OnLongClick) { it() }
      composeRule.onNodeWithText("Rename…").performClick()
      val editor = composeRule.onNode(hasSetTextAction() and hasAnyAncestor(isDialog()))
      editor.assertTextEquals("Same title").performTextReplacement("Proposed title")
      composeRule.onNodeWithText("Cancel").performClick()
      composeRule.onNodeWithText("Rename thread").assertDoesNotExist()
      composeRule.runOnIdle { threadsVisible.value = true }
      composeRule.onNodeWithText(AndroidScreenshotFixture.primarySessionTitle).performSemanticsAction(SemanticsActions.OnLongClick) { it() }
      composeRule.onNodeWithText("Copy session reference").performClick()
      composeRule.runOnIdle {
        assertEquals(
          AndroidScreenshotFixture.mainSessionKey,
          app
            .getSystemService(ClipboardManager::class.java)
            .primaryClip!!
            .getItemAt(0)
            .text
            .toString(),
        )
      }
      composeRule.onNodeWithText(AndroidScreenshotFixture.primarySessionTitle).performSemanticsAction(SemanticsActions.OnLongClick) { it() }
      composeRule.onNodeWithText("Rename…").performClick()
      composeRule.onNodeWithText("Rename thread").assertIsDisplayed()
      composeRule.onNodeWithText("Cancel").performClick()
      composeRule.runOnIdle { assertEquals(0, selections) }
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      models.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
      }
    }
  }
}
