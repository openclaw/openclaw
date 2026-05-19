package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier

@Composable
fun RootScreen(viewModel: MainViewModel) {
  val onboardingCompleted by viewModel.onboardingCompleted.collectAsState()

  if (!onboardingCompleted) {
    V2OnboardingFlow(viewModel = viewModel, modifier = Modifier.fillMaxSize())
    return
  }

  V2ShellScreen(viewModel = viewModel, modifier = Modifier.fillMaxSize())
}
