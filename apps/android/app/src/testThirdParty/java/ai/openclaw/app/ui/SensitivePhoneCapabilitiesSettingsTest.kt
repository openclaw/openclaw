package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceTextScale
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.accessibility.AccessibilityComponentController
import ai.openclaw.app.accessibility.AccessibilityDevActivity
import ai.openclaw.app.accessibility.OpenClawAccessibilityService
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.provider.Settings
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SensitivePhoneCapabilitiesSettingsTest {
  @get:Rule val composeRule = createComposeRule()
  private val store = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var activity: Activity
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    originalRuntime = app.peekRuntime()
    prefs = SecurePrefs(app, app.getSharedPreferences("disclosure-text-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(true)
    prefs.setAccessibilityControlEnabled(false)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { store.put("disclosure", it) }
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
    model.setAppearanceTextScale(AppearanceTextScale.Largest)
    AccessibilityComponentController(app).setEnabled(false)
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    try {
      composeRule.runOnIdle { mounted.value = false }
    } finally {
      try {
        store.clear()
      } finally {
        bindNodeRuntimeTestFixture(app, originalRuntime)
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
          AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        }
      }
    }
  }

  @Test
  fun disclosureUsesTheSelectedTextSizeForEverySlot() {
    showSettings()
    composeRule.onNodeWithText("Control other apps").performClick()
    composeRule.onNodeWithText("Allow control of other apps?").assertIsDisplayed()
    capture()
    for (label in listOf(
      "Allow control of other apps?",
      "Enabling lets OpenClaw observe and control other apps' screens when armed. Android accessibility access is required.",
      "Enable and Open Settings",
      "Not Now",
    )) {
      val layouts = mutableListOf<TextLayoutResult>()
      composeRule
        .onNodeWithText(label, useUnmergedTree = true)
        .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      assertEquals(
        label,
        1.4f,
        layouts
          .single()
          .layoutInput.density.fontScale,
        0.001f,
      )
    }
  }

  @Test
  fun textScalingDoesNotBypassConsentOrChangeSettingsNavigation() {
    showSettings()
    composeRule.onNodeWithText("Control other apps").performClick()
    assertFalse(prefs.accessibilityControlEnabled.value)
    assertComponentsEnabled(false)
    assertNull(shadowOf(activity).nextStartedActivity)
    composeRule.onNodeWithText("Not Now").performClick()
    composeRule.onNodeWithText("Allow control of other apps?").assertDoesNotExist()
    assertFalse(prefs.accessibilityControlEnabled.value)
    assertComponentsEnabled(false)
    assertNull(shadowOf(activity).nextStartedActivity)
    composeRule.onNodeWithText("Control other apps").performClick()
    composeRule.onNodeWithText("Enable and Open Settings").performClick()
    assertTrue(prefs.accessibilityControlEnabled.value)
    assertComponentsEnabled(true)
    assertEquals(Settings.ACTION_ACCESSIBILITY_SETTINGS, shadowOf(activity).nextStartedActivity?.action)
    assertNull(shadowOf(activity).nextStartedActivity)
    composeRule.onNodeWithText("Control other apps").performClick()
    assertFalse(prefs.accessibilityControlEnabled.value)
    assertComponentsEnabled(false)
    composeRule.onNodeWithText("Allow control of other apps?").assertDoesNotExist()
  }

  private fun showSettings() {
    composeRule.setContent {
      if (mounted.value) {
        activity = requireNotNull(LocalActivity.current)
        val scale by model.appearanceTextScale.collectAsState()
        OpenClawTheme(textScale = scale) {
          ClawDesignTheme {
            FlavorPhoneCapabilitiesSettings(model)
          }
        }
      }
    }
  }

  private fun assertComponentsEnabled(enabled: Boolean) {
    val expected = if (enabled) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
    for (component in listOf(
      ComponentName(app, OpenClawAccessibilityService::class.java),
      ComponentName(app, AccessibilityDevActivity::class.java),
    )) {
      assertEquals(expected, app.packageManager.getComponentEnabledSetting(component))
    }
  }

  private fun capture() {
    val directory = System.getenv("OPENCLAW_DISCLOSURE_TEXT_PROOF_DIR") ?: return
    val target = File(directory, "disclosure-140.png")
    check(!target.exists())
    requireNotNull(target.parentFile).mkdirs()
    val bitmap = composeRule.onNode(isDialog()).captureToImage().asAndroidBitmap()
    target.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }
}
