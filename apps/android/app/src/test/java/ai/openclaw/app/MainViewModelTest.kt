package ai.openclaw.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainViewModelTest {
  @Test
  fun setForegroundDoesNotStartRuntimeBeforeOnboardingCompletes() {
    val app = appContext()
    app.prefs.setOnboardingCompleted(false)
    val viewModel = MainViewModel(app)

    viewModel.setForeground(true)

    assertFalse(viewModel.runtimeInitialized.value)
    assertNull(app.peekRuntime())
  }

  @Test
  fun setForegroundDoesNotStartRuntimeWhileActivityIsStopped() {
    val app = appContext()
    app.prefs.setOnboardingCompleted(true)
    val viewModel = MainViewModel(app)

    viewModel.setForeground(false)

    assertFalse(viewModel.runtimeInitialized.value)
    assertNull(app.peekRuntime())
  }

  @Test
  fun foregroundStartupRequiresForegroundAndCompletedOnboarding() {
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = false,
        onboardingCompleted = true,
      ),
    )
    assertFalse(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = false,
      ),
    )
    assertTrue(
      shouldStartRuntimeOnForeground(
        foreground = true,
        onboardingCompleted = true,
      ),
    )
  }

  private fun appContext(): NodeApp = RuntimeEnvironment.getApplication() as NodeApp
}
