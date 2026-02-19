package ai.openclaw.android.node

import ai.openclaw.android.PermissionRequester
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Telephony
import android.telephony.SmsManager as AndroidSmsManager
import androidx.core.content.ContextCompat
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject

/**
 * Sends and reads SMS messages via Android APIs.
 * Requires SEND_SMS permission for send, READ_SMS permission for read.
 */
class SmsManager(private val context: Context) {

    private val json = JsonConfig
    @Volatile private var permissionRequester: PermissionRequester? = null

    data class SendResult(
        val ok: Boolean,
        val to: String,
        val message: String?,
        val error: String? = null,
        val payloadJson: String,
    )

    data class ReadResult(
        val ok: Boolean,
        val error: String? = null,
        val payloadJson: String,
    )

    internal data class ParsedParams(
        val to: String,
        val message: String,
    )

    internal data class ReadParams(
        val limit: Int,
        val sinceMs: Long?,
    )

    internal data class SmsItem(
        val id: Long,
        val threadId: Long,
        val address: String?,
        val body: String?,
        val dateMs: Long,
        val read: Boolean,
        val type: Int,
    )

    internal sealed class ParseResult {
        data class Ok(val params: ParsedParams) : ParseResult()
        data class Error(
            val error: String,
            val to: String = "",
            val message: String? = null,
        ) : ParseResult()
    }

    internal data class SendPlan(
        val parts: List<String>,
        val useMultipart: Boolean,
    )

    companion object {
        internal val JsonConfig = Json { ignoreUnknownKeys = true }

        internal fun parseParams(paramsJson: String?, json: Json = JsonConfig): ParseResult {
            val params = paramsJson?.trim().orEmpty()
            if (params.isEmpty()) {
                return ParseResult.Error(error = "INVALID_REQUEST: paramsJSON required")
            }

            val obj = try {
                json.parseToJsonElement(params).jsonObject
            } catch (_: Throwable) {
                null
            }

            if (obj == null) {
                return ParseResult.Error(error = "INVALID_REQUEST: expected JSON object")
            }

            val to = (obj["to"] as? JsonPrimitive)?.content?.trim().orEmpty()
            val message = (obj["message"] as? JsonPrimitive)?.content.orEmpty()

            if (to.isEmpty()) {
                return ParseResult.Error(
                    error = "INVALID_REQUEST: 'to' phone number required",
                    message = message,
                )
            }

            if (message.isEmpty()) {
                return ParseResult.Error(
                    error = "INVALID_REQUEST: 'message' text required",
                    to = to,
                )
            }

            return ParseResult.Ok(ParsedParams(to = to, message = message))
        }

        internal fun parseReadParams(paramsJson: String?, json: Json = JsonConfig): ReadParams {
            val obj =
                try {
                    paramsJson?.trim()?.takeIf { it.isNotEmpty() }?.let { json.parseToJsonElement(it).jsonObject }
                } catch (_: Throwable) {
                    null
                }

            val rawLimit = (obj?.get("limit") as? JsonPrimitive)?.content?.toIntOrNull() ?: 20
            val limit = rawLimit.coerceIn(1, 200)
            val sinceMs = (obj?.get("sinceMs") as? JsonPrimitive)?.content?.toLongOrNull()
            return ReadParams(limit = limit, sinceMs = sinceMs)
        }

        internal fun buildSendPlan(
            message: String,
            divider: (String) -> List<String>,
        ): SendPlan {
            val parts = divider(message).ifEmpty { listOf(message) }
            return SendPlan(parts = parts, useMultipart = parts.size > 1)
        }

        internal fun buildSendPayloadJson(
            json: Json = JsonConfig,
            ok: Boolean,
            to: String,
            error: String?,
        ): String {
            val payload =
                mutableMapOf<String, JsonElement>(
                    "ok" to JsonPrimitive(ok),
                    "to" to JsonPrimitive(to),
                )
            if (!ok) {
                payload["error"] = JsonPrimitive(error ?: "SMS_SEND_FAILED")
            }
            return json.encodeToString(JsonObject.serializer(), JsonObject(payload))
        }

        internal fun buildReadPayloadJson(
            json: Json = JsonConfig,
            messages: List<SmsItem>,
        ): String {
            val payload =
                buildJsonObject {
                    put("ok", JsonPrimitive(true))
                    put("count", JsonPrimitive(messages.size))
                    put(
                        "messages",
                        JsonArray(
                            messages.map { msg ->
                                buildJsonObject {
                                    put("id", JsonPrimitive(msg.id))
                                    put("threadId", JsonPrimitive(msg.threadId))
                                    msg.address?.let { put("address", JsonPrimitive(it)) }
                                    msg.body?.let { put("body", JsonPrimitive(it)) }
                                    put("dateMs", JsonPrimitive(msg.dateMs))
                                    put("read", JsonPrimitive(msg.read))
                                    put("type", JsonPrimitive(msg.type))
                                }
                            },
                        ),
                    )
                }
            return json.encodeToString(JsonObject.serializer(), payload)
        }

        internal fun buildReadErrorPayloadJson(json: Json = JsonConfig, error: String): String {
            val payload =
                buildJsonObject {
                    put("ok", JsonPrimitive(false))
                    put("error", JsonPrimitive(error))
                }
            return json.encodeToString(JsonObject.serializer(), payload)
        }
    }

    fun hasSmsPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.SEND_SMS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun hasSmsReadPermission(): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_SMS,
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun canSendSms(): Boolean {
        return hasSmsPermission() && hasTelephonyFeature()
    }

    fun hasTelephonyFeature(): Boolean {
        return context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true
    }

    fun attachPermissionRequester(requester: PermissionRequester) {
        permissionRequester = requester
    }

    /**
     * Send an SMS message.
     *
     * @param paramsJson JSON with "to" (phone number) and "message" (text) fields
     * @return SendResult indicating success or failure
     */
    suspend fun send(paramsJson: String?): SendResult {
        if (!hasTelephonyFeature()) {
            return errorResult(
                error = "SMS_UNAVAILABLE: telephony not available",
            )
        }

        if (!ensureSmsPermission()) {
            return errorResult(
                error = "SMS_PERMISSION_REQUIRED: grant SMS permission",
            )
        }

        val parseResult = parseParams(paramsJson, json)
        if (parseResult is ParseResult.Error) {
            return errorResult(
                error = parseResult.error,
                to = parseResult.to,
                message = parseResult.message,
            )
        }
        val params = (parseResult as ParseResult.Ok).params

        return try {
            val smsManager = context.getSystemService(AndroidSmsManager::class.java)
                ?: throw IllegalStateException("SMS_UNAVAILABLE: SmsManager not available")

            val plan = buildSendPlan(params.message) { smsManager.divideMessage(it) }
            if (plan.useMultipart) {
                smsManager.sendMultipartTextMessage(
                    params.to,
                    null,
                    ArrayList(plan.parts),
                    null,
                    null,
                )
            } else {
                smsManager.sendTextMessage(
                    params.to,
                    null,
                    params.message,
                    null,
                    null,
                )
            }

            okResult(to = params.to, message = params.message)
        } catch (e: SecurityException) {
            errorResult(
                error = "SMS_PERMISSION_REQUIRED: ${e.message}",
                to = params.to,
                message = params.message,
            )
        } catch (e: Throwable) {
            errorResult(
                error = "SMS_SEND_FAILED: ${e.message ?: "unknown error"}",
                to = params.to,
                message = params.message,
            )
        }
    }

    /**
     * Read recent SMS messages.
     * paramsJson optional: {"limit":20, "sinceMs":1739870000000}
     */
    suspend fun read(paramsJson: String?): ReadResult {
        if (!hasTelephonyFeature()) {
            return readErrorResult("SMS_UNAVAILABLE: telephony not available")
        }
        if (!ensureSmsReadPermission()) {
            return readErrorResult("SMS_READ_PERMISSION_REQUIRED: grant SMS read permission")
        }

        val params = parseReadParams(paramsJson, json)
        return try {
            val uri = Telephony.Sms.CONTENT_URI
            val projection = arrayOf(
                Telephony.Sms._ID,
                Telephony.Sms.THREAD_ID,
                Telephony.Sms.ADDRESS,
                Telephony.Sms.BODY,
                Telephony.Sms.DATE,
                Telephony.Sms.READ,
                Telephony.Sms.TYPE,
            )
            val selection = if (params.sinceMs != null) "${Telephony.Sms.DATE} >= ?" else null
            val selectionArgs = if (params.sinceMs != null) arrayOf(params.sinceMs.toString()) else null
            val sortOrder = "${Telephony.Sms.DATE} DESC LIMIT ${params.limit}"

            val messages = mutableListOf<SmsItem>()
            context.contentResolver.query(uri, projection, selection, selectionArgs, sortOrder)?.use { c ->
                val idIdx = c.getColumnIndexOrThrow(Telephony.Sms._ID)
                val threadIdx = c.getColumnIndexOrThrow(Telephony.Sms.THREAD_ID)
                val addrIdx = c.getColumnIndexOrThrow(Telephony.Sms.ADDRESS)
                val bodyIdx = c.getColumnIndexOrThrow(Telephony.Sms.BODY)
                val dateIdx = c.getColumnIndexOrThrow(Telephony.Sms.DATE)
                val readIdx = c.getColumnIndexOrThrow(Telephony.Sms.READ)
                val typeIdx = c.getColumnIndexOrThrow(Telephony.Sms.TYPE)

                while (c.moveToNext()) {
                    messages += SmsItem(
                        id = c.getLong(idIdx),
                        threadId = c.getLong(threadIdx),
                        address = c.getString(addrIdx),
                        body = c.getString(bodyIdx),
                        dateMs = c.getLong(dateIdx),
                        read = c.getInt(readIdx) != 0,
                        type = c.getInt(typeIdx),
                    )
                }
            }

            ReadResult(ok = true, error = null, payloadJson = buildReadPayloadJson(json, messages))
        } catch (e: SecurityException) {
            readErrorResult("SMS_READ_PERMISSION_REQUIRED: ${e.message}")
        } catch (e: Throwable) {
            readErrorResult("SMS_READ_FAILED: ${e.message ?: "unknown error"}")
        }
    }

    private suspend fun ensureSmsPermission(): Boolean {
        if (hasSmsPermission()) return true
        val requester = permissionRequester ?: return false
        val results = requester.requestIfMissing(listOf(Manifest.permission.SEND_SMS))
        return results[Manifest.permission.SEND_SMS] == true
    }

    private suspend fun ensureSmsReadPermission(): Boolean {
        if (hasSmsReadPermission()) return true
        val requester = permissionRequester ?: return false
        val results = requester.requestIfMissing(listOf(Manifest.permission.READ_SMS))
        return results[Manifest.permission.READ_SMS] == true
    }

    private fun okResult(to: String, message: String): SendResult {
        return SendResult(
            ok = true,
            to = to,
            message = message,
            error = null,
            payloadJson = buildSendPayloadJson(json = json, ok = true, to = to, error = null),
        )
    }

    private fun errorResult(error: String, to: String = "", message: String? = null): SendResult {
        return SendResult(
            ok = false,
            to = to,
            message = message,
            error = error,
            payloadJson = buildSendPayloadJson(json = json, ok = false, to = to, error = error),
        )
    }

    private fun readErrorResult(error: String): ReadResult {
        return ReadResult(
            ok = false,
            error = error,
            payloadJson = buildReadErrorPayloadJson(json = json, error = error),
        )
    }
}
