package ai.openclaw.wear

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.content.ContextCompat
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.ViewModelProvider
import androidx.wear.compose.navigation.SwipeDismissableNavHost
import androidx.wear.compose.navigation.composable
import androidx.wear.compose.navigation.rememberSwipeDismissableNavController
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.TimeText
import ai.openclaw.wear.R
import ai.openclaw.wear.gateway.WearReplyAction
import ai.openclaw.wear.ui.ChatScreen
import ai.openclaw.wear.ui.ChatSettingsScreen
import ai.openclaw.wear.ui.ConnectionSettingsScreen
import ai.openclaw.wear.ui.SessionPickerScreen
import ai.openclaw.wear.ui.WearTheme
import java.util.Locale

class WearMainActivity : ComponentActivity() {

  companion object {
    const val EXTRA_LAUNCH_VOICE = "LAUNCH_VOICE_INPUT"
    const val EXTRA_LAUNCH_ACTION = "LAUNCH_REPLY_ACTION"
  }

  private val autoLaunchAction = mutableStateOf<WearReplyAction?>(null)
  private lateinit var viewModel: WearViewModel
  private var voiceLauncher: androidx.activity.result.ActivityResultLauncher<Intent>? = null
  private var notificationPermissionLauncher:
    androidx.activity.result.ActivityResultLauncher<String>? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    viewModel = ViewModelProvider(this)[WearViewModel::class.java]

    voiceLauncher =
      registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val text =
          result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
        if (!text.isNullOrBlank()) {
          viewModel.sendMessage(text)
        }
      }

    notificationPermissionLauncher =
      registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    // Check if launched from complication
    autoLaunchAction.value = resolveLaunchAction(intent)
    if (autoLaunchAction.value == WearReplyAction.VOICE && launchVoiceInputImmediately()) {
      autoLaunchAction.value = null
    }

    maybeRequestNotificationPermission()

    setContent {
      WearTheme {
        val navController = rememberSwipeDismissableNavController()
        val persistedConfig by viewModel.config.collectAsState()

        AppScaffold(
          timeText = { TimeText() }
        ) {
          SwipeDismissableNavHost(
            navController = navController,
            startDestination = "chat",
          ) {
            composable("chat") {
              ChatScreen(
                viewModel = viewModel,
                onNavigateToSessions = { navController.navigate("sessions") },
                onNavigateToChatSettings = { navController.navigate("settings/chat") },
                onNavigateToConnectionSettings = { navController.navigate("settings/connection") },
                autoLaunchAction = autoLaunchAction.value,
                onLaunchActionHandled = { autoLaunchAction.value = null },
              )
            }
            composable("sessions") {
              SessionPickerScreen(
                viewModel = viewModel,
                onBack = { navController.popBackStack() },
              )
            }
            composable("settings/chat") {
              ChatSettingsScreen(
                config = persistedConfig,
                onConfigChange = { viewModel.saveChatConfig(it) },
              )
            }
            composable("settings/connection") {
              ConnectionSettingsScreen(
                config = persistedConfig,
                onConfigChange = { viewModel.saveConnectionConfig(it) },
              )
            }
          }
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    autoLaunchAction.value = resolveLaunchAction(intent)
    if (autoLaunchAction.value == WearReplyAction.VOICE && launchVoiceInputImmediately()) {
      autoLaunchAction.value = null
    }
  }

  override fun onResume() {
    super.onResume()
    (application as WearApp).onActivityVisibilityChanged(true)
  }

  override fun onPause() {
    (application as WearApp).onActivityVisibilityChanged(false)
    super.onPause()
  }

  private fun resolveLaunchAction(intent: Intent?): WearReplyAction? {
    if (intent == null) return null
    val storedAction = intent.getStringExtra(EXTRA_LAUNCH_ACTION)
    if (!storedAction.isNullOrBlank()) {
      return WearReplyAction.fromStorage(storedAction)
    }
    return if (intent.getBooleanExtra(EXTRA_LAUNCH_VOICE, false)) {
      WearReplyAction.VOICE
    } else {
      null
    }
  }

  private fun launchVoiceInputImmediately(): Boolean {
    val intent =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PROMPT, getString(R.string.wear_chat_voice_prompt))
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
      }
    val canHandle = intent.resolveActivity(packageManager) != null
    if (!canHandle) return false
    return try {
      voiceLauncher?.launch(intent)
      true
    } catch (_: ActivityNotFoundException) {
      false
    }
  }

  private fun maybeRequestNotificationPermission() {
    if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return
    if (
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      return
    }

    val prefs = getSharedPreferences("openclaw_wear_runtime", MODE_PRIVATE)
    val alreadyPrompted = prefs.getBoolean("notifications_permission_prompted", false)
    if (alreadyPrompted) return

    prefs.edit().putBoolean("notifications_permission_prompted", true).apply()
    notificationPermissionLauncher?.launch(Manifest.permission.POST_NOTIFICATIONS)
  }
}
