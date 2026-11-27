package ai.openclaw.app.ui.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.PermissionRequester
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.lifecycle.SavedStateHandle
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatRealtimeTalkTest {
  @get:Rule val composeRule = createComposeRule()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private var originalRuntime: NodeRuntime? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    prefs = SecurePrefs(app, app.getSharedPreferences("chat-realtime-talk-test", Context.MODE_PRIVATE))
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
  }

  @After
  fun tearDown() {
    bindNodeRuntimeTestFixture(app, originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
  }

  @Test
  fun talkTapAfterPermanentMicrophoneDenialOffersAndroidSettings() {
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    val requester = PermissionRequester(app)
    composeRule.runOnUiThread {
      // After "Don't ask again", Android answers the request immediately without showing a prompt.
      requester.attach(activity) { permissions, requestCode ->
        requester.onRequestPermissionsResult(requestCode, permissions, IntArray(permissions.size) { PackageManager.PERMISSION_DENIED })
      }
      requester.activate(activity)
      model.attachRuntimeUi(activity, requester)
    }
    var startTalk: () -> Unit = {}
    composeRule.setContent { startTalk = rememberChatRealtimeTalkLauncher(model) }

    composeRule.runOnIdle { startTalk() }
    // PermissionRequester shows its dialogs from the main looper, which Compose's clock does not drive.
    composeRule.waitUntil(timeoutMillis = 5_000) {
      ShadowLooper.idleMainLooper()
      ShadowDialog.getLatestDialog()?.isShowing == true
    }

    val dialog = checkNotNull(ShadowDialog.getLatestDialog())
    val title = checkNotNull(dialog.findViewById<TextView>(androidx.appcompat.R.id.alertTitle))
    assertEquals("Enable permission in Settings", title.text.toString())
  }
}
