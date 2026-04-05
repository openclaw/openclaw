package ai.openclaw.app

import androidx.lifecycle.SavedStateHandle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainViewModelTest {
  @Test
  fun restoresPendingAssistantAutoSendFromSavedStateHandle() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val state = SavedStateHandle()
    val viewModel = MainViewModel(app, state)

    viewModel.handleAssistantLaunch(
      AssistantLaunchRequest(
        source = "app_action",
        prompt = "summarize my unread mail",
        autoSend = true,
      ),
    )

    val restored = MainViewModel(app, state)

    assertEquals(HomeDestination.Chat, restored.requestedHomeDestination.value)
    assertEquals("summarize my unread mail", restored.pendingAssistantAutoSend.value)
    assertNull(restored.chatDraft.value)
  }
}
