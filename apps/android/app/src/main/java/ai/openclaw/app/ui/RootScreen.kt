package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeText
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.filterNotNull

/** Chooses onboarding or the authenticated app shell from persisted app state. */
@Composable
fun RootScreen(viewModel: MainViewModel) {
  val onboardingCompleted by viewModel.onboardingCompleted.collectAsState()
  val features = rememberWindowDisplayFeatures()
  val lifecycleOwner = LocalLifecycleOwner.current
  LaunchedEffect(viewModel, lifecycleOwner) {
    lifecycleOwner.repeatOnLifecycle(Lifecycle.State.RESUMED) {
      viewModel.pendingAssistantTalkStart.filterNotNull().collect { request ->
        if (!viewModel.onboardingCompleted.value && viewModel.consumeAssistantTalkStart(request)) {
          viewModel.showTalkSetupMessage(nativeText("Gateway not connected"))
        }
      }
    }
  }

  if (!onboardingCompleted) {
    FoldAwareContent(
      features = features,
      modifier = Modifier.background(MaterialTheme.colorScheme.background),
    ) {
      OnboardingFlow(viewModel = viewModel, modifier = Modifier.fillMaxSize())
    }
  } else {
    ShellScreen(viewModel = viewModel, modifier = Modifier.fillMaxSize(), features = features)
  }
}
