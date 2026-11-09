package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.voice.audioInputDeviceKey
import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Looper
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.isSelectable
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder
import org.robolectric.shadows.ShadowAudioManager
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class AudioInputSelectionTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var audioManager: ShadowAudioManager
  private var previousRuntime: NodeRuntime? = null

  // Dispose the screen's device observer before closing its real runtime.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
            } finally {
              try {
                if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
              } finally {
                if (::audioManager.isInitialized) audioManager.setInputDevices(emptyList())
                if (::app.isInitialized) {
                  bindNodeRuntimeTestFixture(app, previousRuntime)
                  clearPlainPreferences()
                }
              }
            }
          }
        },
      ).around(composeRule)

  @Test
  fun microphoneChoicesExposeSelectionAndPersistBothDirections() {
    createFixture()
    val device = usbMicrophone()
    audioManager.setInputDevices(listOf(device))
    showVoiceSettings()

    val automatic = composeRule.onNodeWithText(nativeString("Automatic"))
    val usb = composeRule.onNodeWithText(nativeString("USB microphone"))
    automatic.performScrollTo()
    automatic.assertIsSelected()
    automatic.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
    usb.assertIsNotSelected()
    usb.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
    val group = SemanticsMatcher.keyIsDefined(SemanticsProperties.SelectableGroup)
    composeRule.onAllNodes(group).assertCountEquals(1)
    val groupedChoices = composeRule.onAllNodes(isSelectable() and hasAnyAncestor(group))
    groupedChoices.assertCountEquals(2)
    automatic.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.ContentDescription))

    usb.performScrollTo()
    usb.performClick()
    composeRule.waitForIdle()
    usb.assertIsSelected()
    automatic.assertIsNotSelected()
    assertEquals(audioInputDeviceKey(device), prefs.preferredAudioInputDevice.value)

    automatic.performScrollTo()
    automatic.performClick()
    composeRule.waitForIdle()
    automatic.assertIsSelected()
    usb.assertIsNotSelected()
    assertNull(prefs.preferredAudioInputDevice.value)
  }

  @Test
  fun unavailablePreferenceExposesFallbackAndBecomesSelectedWhenConnected() {
    createFixture()
    val device = usbMicrophone()
    val key = audioInputDeviceKey(device)
    prefs.setPreferredAudioInputDevice(key)
    showVoiceSettings()

    val unavailable = composeRule.onNodeWithText(nativeString("Unavailable"))
    unavailable.performScrollTo()
    unavailable.assertIsNotSelected()
    unavailable.assertIsNotEnabled()
    unavailable.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
    val automatic = composeRule.onNodeWithText(nativeString("Automatic"))
    automatic.assertIsSelected()
    unavailable.performClick()
    composeRule.waitForIdle()
    assertEquals(key, prefs.preferredAudioInputDevice.value)

    composeRule.runOnIdle { audioManager.addInputDevice(device, true) }
    shadowOf(Looper.getMainLooper()).idle()
    composeRule.waitForIdle()

    unavailable.assertDoesNotExist()
    val usb = composeRule.onNodeWithText(nativeString("USB microphone"))
    usb.performScrollTo()
    usb.assertIsEnabled()
    usb.assertIsSelected()
    automatic.assertIsNotSelected()
    assertEquals(key, prefs.preferredAudioInputDevice.value)
  }

  private fun createFixture() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    clearPlainPreferences()
    prefs = SecurePrefs(app, app.getSharedPreferences("audio-selection-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setSpeakerEnabled(false)
    prefs.setVoiceWakeEnabled(false)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    audioManager = shadowOf(app.getSystemService(AudioManager::class.java))
    audioManager.setInputDevices(emptyList())
  }

  private fun showVoiceSettings() {
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("voice", model)
    composeRule.setContent {
      ClawDesignTheme {
        SettingsDetailScreen(viewModel = model, route = SettingsRoute.Voice, onBack = {})
      }
    }
    composeRule.waitForIdle()
  }

  private fun usbMicrophone(): AudioDeviceInfo =
    AudioDeviceInfoBuilder
      .newBuilder()
      .setType(AudioDeviceInfo.TYPE_USB_DEVICE)
      .build()

  private fun clearPlainPreferences() {
    app
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }
}
