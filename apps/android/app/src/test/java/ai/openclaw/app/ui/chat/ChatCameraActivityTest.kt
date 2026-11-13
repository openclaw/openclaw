package ai.openclaw.app.ui.chat

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import androidx.camera.lifecycle.ProcessCameraProvider
import com.google.common.util.concurrent.ListenableFuture
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.io.File
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executor

@RunWith(RobolectricTestRunner::class)
@Config(
  sdk = [34],
  qualifiers = "w360dp-h800dp-port",
  application = Application::class,
  instrumentedPackages = ["androidx.camera.lifecycle"],
  shadows = [PendingChatCameraProvider::class],
)
class ChatCameraActivityTest {
  @Test
  fun configurationChangesKeepCaptureOpenUntilTheActivityStops() {
    val app = RuntimeEnvironment.getApplication()
    val captureId = UUID.randomUUID().toString()
    val directory = File(app.cacheDir, "chat-camera/$captureId")
    assertTrue(directory.mkdirs())
    val intent = Intent(app, ChatCameraActivity::class.java).putExtra(ChatCameraActivity.EXTRA_CAPTURE_ID, captureId)
    val controller =
      Robolectric
        .buildActivity(ChatCameraActivity::class.java, intent)
        .create()
        .start()
        .resume()
    val activity = controller.get()
    try {
      assertFalse(activity.isFinishing)
      val configuration = Configuration(activity.resources.configuration)
      configuration.orientation = Configuration.ORIENTATION_LANDSCAPE
      configuration.screenWidthDp = 800
      configuration.screenHeightDp = 360
      controller.configurationChange(configuration)
      assertSame(activity, controller.get())
      assertFalse(activity.isFinishing)

      configuration.screenWidthDp = 600
      configuration.smallestScreenWidthDp = 360
      controller.configurationChange(configuration)
      assertSame(activity, controller.get())
      assertFalse(activity.isFinishing)

      configuration.uiMode = Configuration.UI_MODE_TYPE_NORMAL or Configuration.UI_MODE_NIGHT_YES
      controller.configurationChange(configuration)
      assertSame(activity, controller.get())
      assertFalse(activity.isFinishing)

      controller.pause().stop()
      assertTrue(activity.isFinishing)
    } finally {
      controller.destroy()
      directory.deleteRecursively()
    }
  }
}

/** Hold only camera hardware initialization; Android dispatches the real Activity lifecycle. */
@Implements(className = "androidx.camera.lifecycle.ProcessCameraProvider\$Companion", isInAndroidSdk = false)
class PendingChatCameraProvider {
  @Implementation
  fun getInstance(
    @Suppress("UNUSED_PARAMETER") context: Context,
  ): ListenableFuture<ProcessCameraProvider> =
    object : CompletableFuture<ProcessCameraProvider>(), ListenableFuture<ProcessCameraProvider> {
      override fun addListener(
        listener: Runnable,
        executor: Executor,
      ) {
        thenRunAsync(listener, executor)
      }
    }
}
