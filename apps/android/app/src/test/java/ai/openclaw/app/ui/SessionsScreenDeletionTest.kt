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
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SessionsScreenDeletionTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun confirmationExplainsRetentionAndOnlyDeletesAfterConfirmation() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val prefs = SecurePrefs(app, app.getSharedPreferences("delete-retention-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.gatewayRegistry.upsert(GatewayRegistryEntry(AndroidScreenshotFixture.gatewayId, GatewayRegistryEntryKind.MANUAL, "Synthetic Gateway"))
    prefs.gatewayRegistry.setActive(AndroidScreenshotFixture.gatewayId)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val originalScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val deletes = ConcurrentLinkedQueue<JsonObject>()
    val deleted = AtomicBoolean(false)
    try {
      drainWithMainLooper { runtime.chat.sessions.first { it.isNotEmpty() } }
      val original = ReflectionHelpers.getField<suspend (String, String?) -> String>(runtime.chat, "requestGateway")
      val request: suspend (String, String?) -> String = { method, params ->
        when (method) {
          "sessions.list" -> {
            if (deleted.get()) """{"sessions":[]}""" else """{"sessions":[{"key":"agent:main:research-notes","agentId":"main","sessionId":"synthetic-research-notes","label":"Research notes","archived":true,"updatedAt":1700000000000}]}"""
          }

          "sessions.delete" -> {
            deletes.add(Json.parseToJsonElement(requireNotNull(params)).jsonObject)
            deleted.set(true)
            """{"deleted":true}"""
          }

          else -> {
            original(method, params)
          }
        }
      }
      val scopedRequest: suspend (String, String, String?) -> String = { _, method, params -> request(method, params) }
      ReflectionHelpers.setField(runtime.chat, "requestGateway", request)
      ReflectionHelpers.setField(runtime.chat, "requestGatewayForGateway", scopedRequest)
      val model = MainViewModel(app, prefs, SavedStateHandle())
      models.put("delete-retention", model)
      ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef").value = runtime
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      composeRule.setContent {
        if (mounted.value) {
          ClawDesignTheme(dark = false) {
            SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {})
          }
        }
      }
      composeRule.onNodeWithText("Archived").performClick()
      composeRule.waitUntil(10_000) { model.chatSessions.value.any { it.label == "Research notes" } }

      fun openConfirmation() {
        composeRule.onNodeWithText("Research notes").performScrollTo().performSemanticsAction(SemanticsActions.OnLongClick) { it() }
        composeRule.onNodeWithText("Delete…").performClick()
        composeRule.onNodeWithText("Delete thread?").assertIsDisplayed()
      }
      openConfirmation()
      System.getenv("OPENCLAW_ACTION_PROMISE_PROOF_DIR")?.let { directory ->
        File(directory).mkdirs()
        File(directory, "delete-confirmation.png").outputStream().use {
          assertTrue(
            composeRule
              .onNode(isDialog())
              .captureToImage()
              .asAndroidBitmap()
              .compress(Bitmap.CompressFormat.PNG, 100, it),
          )
        }
      }
      composeRule.onNodeWithText("Regular transcripts are archived; incognito transcripts are deleted without an archive.", substring = true).assertIsDisplayed()
      assertTrue(deletes.isEmpty())
      composeRule.onNodeWithText("Cancel").performClick()
      composeRule.onNode(isDialog()).assertDoesNotExist()
      assertTrue(deletes.isEmpty())
      composeRule.onNodeWithText("Research notes").assertIsDisplayed()
      openConfirmation()
      composeRule.onNodeWithText("Delete").performClick()
      composeRule.waitUntil(10_000) { deletes.size == 1 && model.chatSessions.value.none { it.key == "agent:main:research-notes" } }
      assertTrue(model.chatSessions.value.any { it.key == AndroidScreenshotFixture.mainSessionKey })
      composeRule.onNodeWithText("Research notes").assertDoesNotExist()
      assertEquals(
        Json.parseToJsonElement("""{"key":"agent:main:research-notes","agentId":"main","deleteTranscript":true,"archivedOnly":true}""").jsonObject,
        deletes.single(),
      )
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      try {
        models.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
        }
      }
    }
  }
}
