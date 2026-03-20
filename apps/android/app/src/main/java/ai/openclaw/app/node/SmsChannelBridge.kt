package ai.openclaw.app.node

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Singleton bridge between the SMS BroadcastReceiver (which has no access to
 * the gateway session) and the NodeRuntime event sink.
 */
object SmsChannelBridge {
    private const val MAX_SMS_BODY_CHARS = 4000

    @Volatile
    private var eventSink: ((event: String, payloadJson: String?) -> Unit)? = null

    fun setEventSink(sink: ((event: String, payloadJson: String?) -> Unit)?) {
        eventSink = sink
    }

    fun onSmsReceived(address: String, body: String, timestampMs: Long) {
        val payload = JsonObject(
            mapOf(
                "from" to JsonPrimitive(address),
                "body" to JsonPrimitive(body.take(MAX_SMS_BODY_CHARS)),
                "timestampMs" to JsonPrimitive(timestampMs),
            )
        ).toString()
        eventSink?.invoke("sms.received", payload)
    }
}
