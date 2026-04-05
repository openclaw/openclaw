package ai.openclaw.app

import android.content.Intent

const val actionAskOpenClaw = "ai.openclaw.app.action.ASK_OPENCLAW"
const val extraAssistantPrompt = "prompt"
internal const val maxAssistantPromptChars = 2_000

enum class HomeDestination {
  Connect,
  Chat,
  Voice,
  Screen,
  Settings,
}

data class AssistantLaunchRequest(
  val source: String,
  val prompt: String?,
  val autoSend: Boolean,
)

internal fun sanitizeAssistantPrompt(prompt: String?): String? {
  return prompt?.trim()?.take(maxAssistantPromptChars)?.ifEmpty { null }
}

internal fun assistantLaunchFingerprint(request: AssistantLaunchRequest): String {
  return listOf(request.source, request.autoSend.toString(), request.prompt.orEmpty()).joinToString("\n")
}

internal fun assistantLaunchFingerprint(intent: Intent?): String? {
  return parseAssistantLaunchIntent(intent)?.let(::assistantLaunchFingerprint)
}

internal fun isRestoredAssistantLaunch(
  intent: Intent?,
  restoredFingerprint: String?,
): Boolean {
  val fingerprint = assistantLaunchFingerprint(intent) ?: return false
  return fingerprint == restoredFingerprint
}

fun parseAssistantLaunchIntent(intent: Intent?): AssistantLaunchRequest? {
  val action = intent?.action ?: return null
  return when (action) {
    Intent.ACTION_ASSIST ->
      AssistantLaunchRequest(
        source = "assist",
        prompt = null,
        autoSend = false,
      )

    actionAskOpenClaw -> {
      val prompt = sanitizeAssistantPrompt(intent.getStringExtra(extraAssistantPrompt))
      AssistantLaunchRequest(
        source = "app_action",
        prompt = prompt,
        autoSend = prompt != null,
      )
    }

    else -> null
  }
}
