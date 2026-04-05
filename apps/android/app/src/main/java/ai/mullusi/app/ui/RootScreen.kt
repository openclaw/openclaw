package ai.mullusi.app.ui

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import ai.mullusi.app.MainViewModel

@Composable
fun RootScreen(viewModel: MainViewModel) {
  val onboardingCompleted by viewModel.onboardingCompleted.collectAsState()

  if (!onboardingCompleted) {
    OnboardingFlow(viewModel = viewModel, modifier = Modifier.fillMaxSize())
    return
  }

  PostOnboardingTabs(viewModel = viewModel, modifier = Modifier.fillMaxSize())
}
