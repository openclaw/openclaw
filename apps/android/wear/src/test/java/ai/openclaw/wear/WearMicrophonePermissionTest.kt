package ai.openclaw.wear

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Looper
import android.provider.Settings
import android.speech.RecognizerIntent
import android.view.View
import android.view.ViewGroup
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.lifecycle.ViewModelProvider
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35], qualifiers = "w192dp-h192dp-round")
class WearMicrophonePermissionTest {
  @Test
  fun denialIsActionableAndSettingsReturnNeverStartsRecording() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val originalScale = Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val controller = Robolectric.buildActivity(MainActivity::class.java, Intent().putExtra(extraWearLaunchTarget, "voice"))
    try {
      controller.setup().visible()
      val activity = controller.get()
      val vm = ViewModelProvider(activity)[WearViewModel::class.java]
      (vm.talkTestField("loadJob") as? Job)?.cancel()
      @Suppress("UNCHECKED_CAST")
      val state = vm.talkTestField("mutableState") as MutableStateFlow<WearUiState>
      state.value = WearUiState(loading = false, connected = true, phoneNodeId = "phone-a", selectedSession = WearSession("agent:main:proof", "Proof", null, false, "phone-a"))
      activity.window.decorView.measure(View.MeasureSpec.makeMeasureSpec(384, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(384, View.MeasureSpec.EXACTLY))
      activity.window.decorView.layout(0, 0, 384, 384)
      idle()
      val talk = nodes(activity.window.decorView).first { it.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }?.contains("Talk") == true }
      assertTrue(talk.config[SemanticsActions.OnClick].action!!.invoke())
      idle()
      val requested = shadowOf(activity).lastRequestedPermission
      assertNotNull(requested)
      shadowOf(app.packageManager).setShouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO, true)
      completePermission(activity, requested.requestCode, false)
      idle()
      assertTrue(texts(activity.window.decorView).contains("Microphone permission required"))
      assertTrue(texts(activity.window.decorView).contains("Retry"))
      val dictate = nodes(activity.window.decorView).first { it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == "Dictate" }
      assertTrue(dictate.config[SemanticsActions.OnClick].action!!.invoke())
      idle()
      // AndroidUiDispatcher does not implement Delay: the 300 ms preview uses
      // the coroutine default executor, not Robolectric's virtual main clock.
      Thread.sleep(350L)
      idle()
      assertEquals(RecognizerIntent.ACTION_RECOGNIZE_SPEECH, shadowOf(activity).nextStartedActivity.action)
      assertFalse(state.value.realtimeCapturing)
      val thread = nodes(activity.window.decorView).first { it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == "Open thread" }
      assertTrue(thread.config[SemanticsActions.OnClick].action!!.invoke())
      idle()
      val type = nodes(activity.window.decorView).first { it.config.getOrElseNullable(SemanticsActions.OnClick) { null }?.label == "Type" }
      assertTrue(type.config[SemanticsActions.OnClick].action!!.invoke())
      assertTrue(RemoteInputIntentHelper.isActionRemoteInput(shadowOf(activity).nextStartedActivity))
      // Return to Live recovery through the Thread microphone, not a whole-page gate.
      val live = nodes(activity.window.decorView).first { it.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }?.contains("Talk") == true }
      assertTrue(live.config[SemanticsActions.OnClick].action!!.invoke())
      idle()
      val retry = nodes(activity.window.decorView).first { node -> node.config.getOrElseNullable(SemanticsProperties.Text) { null }?.any { it.text == "Retry" } == true }
      assertTrue(retry.config[SemanticsActions.OnClick].action!!.invoke())
      idle()
      shadowOf(app.packageManager).setShouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO, false)
      val repeated = shadowOf(activity).lastRequestedPermission
      completePermission(activity, repeated.requestCode, false)
      idle()
      assertTrue(texts(activity.window.decorView).contains("Open Settings"))
      assertFalse(state.value.realtimeCapturing)
      assertFalse(state.value.talkBusy)
      val settings = nodes(activity.window.decorView).first { node -> node.config.getOrElseNullable(SemanticsProperties.Text) { null }?.any { it.text == "Open Settings" } == true }
      assertTrue(settings.config[SemanticsActions.OnClick].action!!.invoke())
      assertTrue(shadowOf(activity).nextStartedActivity.action == Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
      controller.pause().stop()
      state.value = state.value.copy(selectedSession = state.value.selectedSession!!.copy(key = "agent:other:changed"))
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      // Settings grant is observed on resume; it is not a second result for the old dialog.
      controller
        .restart()
        .start()
        .resume()
        .visible()
      idle()
      assertFalse(texts(activity.window.decorView).contains("Microphone permission required"))
      assertFalse(state.value.realtimeCapturing)
      assertFalse(state.value.talkBusy)
      assertFalse(state.value.realtimeTalk.active)
      // A later permission request must not capture into a replacement context.
      shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
      val secondTalk = nodes(activity.window.decorView).first { it.config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }?.contains("Talk") == true }
      assertTrue(secondTalk.config[SemanticsActions.OnClick].action!!.invoke())
      idle()
      val late = shadowOf(activity).lastRequestedPermission
      state.value = state.value.copy(selectedSession = state.value.selectedSession!!.copy(key = "agent:third:new"))
      controller.pause().stop()
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      completePermission(activity, late.requestCode, true)
      idle()
      assertFalse(state.value.talkBusy)
      assertFalse(state.value.realtimeCapturing)
      controller
        .restart()
        .start()
        .resume()
        .visible()
    } finally {
      controller.pause().stop().destroy()
      idle()
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }

  private fun completePermission(
    activity: MainActivity,
    requestCode: Int,
    granted: Boolean,
  ) {
    // Dispatch through Activity's real permission-result branch. Calling only the
    // registry leaves mHasCurrentPermissionsRequest set, causing Retry to be rejected.
    assertEquals("android.content.pm.action.REQUEST_PERMISSIONS", shadowOf(activity).nextStartedActivity.action)
    shadowOf(activity).internalCallDispatchActivityResult(
      "@android:requestPermissions:",
      requestCode,
      Activity.RESULT_OK,
      Intent()
        .putExtra("android.content.pm.extra.REQUEST_PERMISSIONS_NAMES", arrayOf(Manifest.permission.RECORD_AUDIO))
        .putExtra("android.content.pm.extra.REQUEST_PERMISSIONS_RESULTS", intArrayOf(if (granted) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED)),
    )
  }

  private fun idle() = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))

  private fun nodes(view: View): List<SemanticsNode> {
    fun descend(node: SemanticsNode): List<SemanticsNode> = listOf(node) + node.children.flatMap(::descend)
    if (view is ViewRootForTest) {
      view.measureAndLayoutForTest()
      return descend(view.semanticsOwner.rootSemanticsNode)
    }
    return if (view is ViewGroup) (0 until view.childCount).flatMap { nodes(view.getChildAt(it)) } else emptyList()
  }

  private fun texts(view: View): List<String> =
    nodes(view).flatMap {
      it.config
        .getOrElseNullable(SemanticsProperties.Text) { null }
        .orEmpty()
        .map { text -> text.text }
    }
}
