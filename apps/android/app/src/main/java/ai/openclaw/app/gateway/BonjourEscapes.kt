package ai.openclaw.app.gateway

import ai.openclaw.mobile.core.BonjourEscapePolicy
import ai.openclaw.mobile.core.BonjourEscapes as SharedBonjourEscapes

/**
 * Decoder for Bonjour DNS-SD service names returned with decimal byte escapes.
 */
object BonjourEscapes {
  /** Decodes Bonjour DNS-SD decimal escapes while preserving ordinary UTF-8. */
  fun decode(input: String): String = SharedBonjourEscapes.decode(input, BonjourEscapePolicy.UTF8_BYTES)
}
