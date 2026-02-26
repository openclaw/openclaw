package ai.openclaw.android.gateway

data class ParsedInvokeError(
  val code: String,
  val message: String,
  val hadExplicitCode: Boolean,
) {
  val prefixedMessage: String
    get() = "$code: $message"
}

fun parseInvokeErrorMessage(raw: String): ParsedInvokeError {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) {
    return ParsedInvokeError(code = "UNAVAILABLE", message = "error", hadExplicitCode = false)
  }

  val parts = trimmed.split(":", limit = 2)
  if (parts.size == 2) {
    val code = parts[0].trim()
    val rest = parts[1].trim()
    if (code.isNotEmpty() && code.all { it.isUpperCase() || it == '_' }) {
      return ParsedInvokeError(
        code = code,
        message = rest.ifEmpty { trimmed },
        hadExplicitCode = true,
      )
    }
  }
  return ParsedInvokeError(code = "UNAVAILABLE", message = trimmed, hadExplicitCode = false)
}

fun parseInvokeErrorFromThrowable(
  err: Throwable,
  fallbackMessage: String = "error",
): ParsedInvokeError {
  val raw = err.message?.trim().takeIf { !it.isNullOrEmpty() } ?: fallbackMessage
  return parseInvokeErrorMessage(raw)
}
