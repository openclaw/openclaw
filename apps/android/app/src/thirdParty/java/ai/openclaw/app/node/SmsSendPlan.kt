package ai.openclaw.app.node

internal data class SmsSendPlan(
  val parts: List<String>,
) {
  val useMultipart: Boolean get() = parts.size > 1
}

internal fun buildSmsSendPlan(
  message: String,
  divider: (String) -> List<String>,
): SmsSendPlan {
  val parts =
    try {
      divider(message)
    } catch (_: SecurityException) {
      // Some carriers make the app-side EMS probe require READ_PHONE_STATE.
      splitSmsWithoutCarrierLookup(message)
    }
  return SmsSendPlan(parts.ifEmpty { listOf(message) })
}

private const val GSM_BASIC =
  "@£\$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
    "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
private const val GSM_EXTENSION = "\u000c^{}\\[~]|€"

private fun splitSmsWithoutCarrierLookup(message: String): List<String> {
  val gsm = message.all { it in GSM_BASIC || it in GSM_EXTENSION }
  val units = if (gsm) message.sumOf { if (it in GSM_EXTENSION) 2 else 1 } else message.length
  if (units <= if (gsm) 160 else 70) return listOf(message)

  // The telephony service may replace the UDH with a four-character non-EMS page marker.
  // 153 septets fit either path; UCS-2 needs 66 units (not the usual 67) to leave room.
  val limit = if (gsm) 153 else 66
  val parts = mutableListOf<String>()
  var start = 0
  while (start < message.length) {
    var end = start
    var used = 0
    while (end < message.length) {
      val width = if (gsm && message[end] in GSM_EXTENSION) 2 else 1
      if (used + width > limit) break
      used += width
      end += 1
    }
    if (end < message.length && message[end - 1].isHighSurrogate() && message[end].isLowSurrogate()) end -= 1
    parts.add(message.substring(start, end))
    start = end
  }
  return parts
}
