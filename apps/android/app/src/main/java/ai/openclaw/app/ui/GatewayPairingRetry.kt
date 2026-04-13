package ai.openclaw.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.delay

internal const val PAIRING_AUTO_RETRY_MS = 6_000L

internal fun shouldTriggerPairingRetry(previousPairingRequired: Boolean, pairingRequired: Boolean): Boolean {
  return pairingRequired && !previousPairingRequired
}

@Composable
internal fun PairingAutoRetryEffect(enabled: Boolean, onRetry: () -> Unit) {
  val lifecycleOwner = LocalLifecycleOwner.current
  var lifecycleStarted by
    remember(lifecycleOwner) {
      mutableStateOf(lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED))
    }
  var previousEnabled by remember { mutableStateOf(false) }
  var retryGeneration by remember { mutableIntStateOf(0) }

  DisposableEffect(lifecycleOwner) {
    val observer =
      LifecycleEventObserver { _, event ->
        lifecycleStarted = lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        if (event == Lifecycle.Event.ON_START) {
          retryGeneration += 1
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
    }
  }

  LaunchedEffect(enabled, lifecycleStarted, retryGeneration) {
    val shouldRetry = shouldTriggerPairingRetry(previousEnabled, enabled)
    if (!enabled) {
      previousEnabled = false
      return@LaunchedEffect
    }
    if (!lifecycleStarted) {
      return@LaunchedEffect
    }
    previousEnabled = enabled
    if (!shouldRetry) {
      return@LaunchedEffect
    }
    delay(PAIRING_AUTO_RETRY_MS)
    onRetry()
  }
}
