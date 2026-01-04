package com.clawdis.android.node

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SmsManager as AndroidSmsManager
import androidx.core.content.ContextCompat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Sends SMS messages via the Android SMS API.
 * Requires SEND_SMS permission to be granted.
 */
class SmsManager(private val context: Context) {

    private val json = Json { ignoreUnknownKeys = true }

    data class SendResult(
        val ok: Boolean,
        val to: String,
        val message: String?,
        val error: String? = null
    ) {
        val payloadJson: String
            get() = if (ok) {
                """{"ok":true,"to":"$to"}"""
            } else {
                """{"ok":false,"to":"$to","error":"${error?.replace("\"", "\\\"")}"}"""
            }
    }

    fun hasSmsPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.SEND_SMS
        ) == PackageManager.PERMISSION_GRANTED
    }

    /**
     * Send an SMS message.
     * 
     * @param paramsJson JSON with "to" (phone number) and "message" (text) fields
     * @return SendResult indicating success or failure
     */
    fun send(paramsJson: String?): SendResult {
        if (!hasSmsPermission()) {
            return SendResult(
                ok = false,
                to = "",
                message = null,
                error = "SMS_PERMISSION_REQUIRED: SEND_SMS permission not granted"
            )
        }

        val params = paramsJson?.trim().orEmpty()
        if (params.isEmpty()) {
            return SendResult(
                ok = false,
                to = "",
                message = null,
                error = "INVALID_REQUEST: paramsJSON required"
            )
        }

        val obj = try {
            json.parseToJsonElement(params) as? JsonObject
        } catch (e: Throwable) {
            null
        }

        if (obj == null) {
            return SendResult(
                ok = false,
                to = "",
                message = null,
                error = "INVALID_REQUEST: expected JSON object"
            )
        }

        val to = (obj["to"] as? JsonPrimitive)?.content?.trim().orEmpty()
        val message = (obj["message"] as? JsonPrimitive)?.content.orEmpty()

        if (to.isEmpty()) {
            return SendResult(
                ok = false,
                to = "",
                message = message,
                error = "INVALID_REQUEST: 'to' phone number required"
            )
        }

        if (message.isEmpty()) {
            return SendResult(
                ok = false,
                to = to,
                message = null,
                error = "INVALID_REQUEST: 'message' text required"
            )
        }

        return try {
            val smsManager = context.getSystemService(AndroidSmsManager::class.java)
                ?: throw IllegalStateException("SMS_UNAVAILABLE: SmsManager not available")

            // Handle long messages by splitting into parts
            if (message.length > 160) {
                val parts = smsManager.divideMessage(message)
                smsManager.sendMultipartTextMessage(
                    to,           // destination
                    null,         // service center (null = default)
                    parts,        // message parts
                    null,         // sent intents
                    null          // delivery intents
                )
            } else {
                smsManager.sendTextMessage(
                    to,           // destination
                    null,         // service center (null = default)
                    message,      // message
                    null,         // sent intent
                    null          // delivery intent
                )
            }

            SendResult(ok = true, to = to, message = message)
        } catch (e: SecurityException) {
            SendResult(
                ok = false,
                to = to,
                message = message,
                error = "SMS_PERMISSION_REQUIRED: ${e.message}"
            )
        } catch (e: Throwable) {
            SendResult(
                ok = false,
                to = to,
                message = message,
                error = "SMS_SEND_FAILED: ${e.message ?: "unknown error"}"
            )
        }
    }
}
