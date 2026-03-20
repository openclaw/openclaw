package ai.openclaw.app.node

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

/**
 * Receives incoming SMS messages and forwards them to the gateway via [SmsChannelBridge].
 *
 * Registered in AndroidManifest.xml with the SMS_RECEIVED action and BROADCAST_SMS permission.
 */
class SmsBroadcastReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        // Group message parts by originating address (multi-part SMS)
        val grouped = mutableMapOf<String, StringBuilder>()
        val timestamps = mutableMapOf<String, Long>()

        for (smsMessage in messages) {
            val address = smsMessage.originatingAddress ?: continue
            val body = smsMessage.messageBody ?: continue
            grouped.getOrPut(address) { StringBuilder() }.append(body)
            if (smsMessage.timestampMillis > (timestamps[address] ?: 0L)) {
                timestamps[address] = smsMessage.timestampMillis
            }
        }

        for ((address, body) in grouped) {
            SmsChannelBridge.onSmsReceived(
                address = address,
                body = body.toString(),
                timestampMs = timestamps[address] ?: System.currentTimeMillis(),
            )
        }
    }
}
