package ai.openclaw.app.node

import ai.openclaw.app.PermissionRequester
import ai.openclaw.app.hasPermission
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Telephony
import androidx.core.net.toUri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import android.telephony.SmsManager as AndroidSmsManager

class SmsManager(
  private val context: Context,
) {
  @Volatile private var permissionRequester: PermissionRequester? = null

  internal data class QueryMetadata(
    val mmsRequested: Boolean,
    val mmsEligible: Boolean,
    val mmsAttempted: Boolean,
    val mmsIncluded: Boolean,
  )

  internal sealed interface ParseResult {
    data class Ok(
      val to: String,
      val message: String,
    ) : ParseResult

    data class Error(
      val error: String,
      val to: String = "",
    ) : ParseResult
  }

  internal data class QueryParams(
    val startTime: Long? = null,
    val endTime: Long? = null,
    val contactName: String? = null,
    val phoneNumber: String? = null,
    val keyword: String? = null,
    val type: Int? = null,
    val isRead: Boolean? = null,
    val includeMms: Boolean = false,
    val conversationReview: Boolean = false,
    val limit: Int = DEFAULT_SMS_LIMIT,
    val offset: Int = 0,
  )

  internal sealed interface QueryParseResult {
    data class Ok(
      val params: QueryParams,
    ) : QueryParseResult

    data class Error(
      val error: String,
    ) : QueryParseResult
  }

  internal data class SendPlan(
    val parts: List<String>,
    val useMultipart: Boolean,
  )

  internal class MixedByPhoneCandidates(
    private val maxCandidates: Int,
    private val reviewMode: Boolean,
  ) {
    private val messages = linkedMapOf<String, SmsMessage>()

    fun add(
      identityKey: String,
      message: SmsMessage,
    ) {
      if (!reviewMode) {
        if (maxCandidates <= 0) return
        // Bounded replacement joins the end of a tie; review retains first-insertion order.
        messages.remove(identityKey)
      }
      messages[identityKey] = message
      if (!reviewMode && messages.size > maxCandidates) {
        messages.entries
          .sortedWith { left, right -> compareByPhoneCandidateOrder(left.value, right.value) }
          .drop(maxCandidates)
          .forEach { messages.remove(it.key) }
      }
    }

    fun page(params: QueryParams): List<SmsMessage> =
      messages.values
        .sortedWith(::compareByPhoneCandidateOrder)
        .drop(params.offset)
        .take(params.limit)
  }

  companion object {
    private const val DEFAULT_SMS_LIMIT = 25
    internal const val MAX_MIXED_BY_PHONE_CANDIDATE_WINDOW = 500
    private const val MMS_SMS_BY_PHONE_BASE = "content://mms-sms/messages/byphone"
    private const val MMS_CONTENT_BASE = "content://mms"
    private const val MMS_PART_URI = "content://mms/part"
    private val PHONE_FORMATTING_REGEX = Regex("""[\s\-()]""")

    internal fun parseParams(
      paramsJson: String?,
    ): ParseResult {
      val params = paramsJson?.trim().orEmpty()
      if (params.isEmpty()) {
        return ParseResult.Error(error = "INVALID_REQUEST: paramsJSON required")
      }

      val obj = parseJsonParamsObject(params) ?: return ParseResult.Error(error = "INVALID_REQUEST: expected JSON object")

      val to = (obj["to"] as? JsonPrimitive)?.content?.trim().orEmpty()
      val message = (obj["message"] as? JsonPrimitive)?.content.orEmpty()

      if (to.isEmpty()) {
        return ParseResult.Error(
          error = "INVALID_REQUEST: 'to' phone number required",
        )
      }

      if (message.isEmpty()) {
        return ParseResult.Error(
          error = "INVALID_REQUEST: 'message' text required",
          to = to,
        )
      }

      return ParseResult.Ok(to = to, message = message)
    }

    internal fun parseQueryParams(
      paramsJson: String?,
    ): QueryParseResult {
      val params = paramsJson?.trim().orEmpty()
      if (params.isEmpty()) {
        return QueryParseResult.Ok(QueryParams())
      }

      val obj = parseJsonParamsObject(params) ?: return QueryParseResult.Error("INVALID_REQUEST: expected JSON object")

      val startTime = (obj["startTime"] as? JsonPrimitive)?.content?.toLongOrNull()
      val endTime = (obj["endTime"] as? JsonPrimitive)?.content?.toLongOrNull()
      if (startTime != null && endTime != null && startTime > endTime) {
        return QueryParseResult.Error("INVALID_REQUEST: startTime must be less than or equal to endTime")
      }

      return QueryParseResult.Ok(
        QueryParams(
          startTime = startTime,
          endTime = endTime,
          contactName = (obj["contactName"] as? JsonPrimitive)?.content?.trim(),
          phoneNumber = (obj["phoneNumber"] as? JsonPrimitive)?.content?.trim(),
          keyword = (obj["keyword"] as? JsonPrimitive)?.content?.trim(),
          type = (obj["type"] as? JsonPrimitive)?.content?.toIntOrNull(),
          isRead = (obj["isRead"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull(),
          includeMms = (obj["includeMms"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false,
          conversationReview = (obj["conversationReview"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false,
          limit = ((obj["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_SMS_LIMIT).coerceIn(1, 200),
          offset = ((obj["offset"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0).coerceAtLeast(0),
        ),
      )
    }

    private fun normalizePhoneNumber(phone: String): String = phone.replace(PHONE_FORMATTING_REGEX, "")

    internal fun normalizePhoneNumberOrNull(phone: String?): String? {
      val normalized = phone?.let(::normalizePhoneNumber)?.trim().orEmpty()
      return normalized.takeIf { toByPhoneLookupNumber(it).isNotEmpty() }
    }

    internal fun sanitizeContactPhoneNumberOrNull(phone: String?): String? {
      val normalized = normalizePhoneNumberOrNull(phone) ?: return null
      return normalized.takeUnless(::hasSqlLikeWildcard)
    }

    internal fun shouldPromptForContactNameSearchPermission(
      contactName: String?,
      phoneNumber: String?,
      hasReadContactsPermission: Boolean,
    ): Boolean = !contactName.isNullOrEmpty() && phoneNumber.isNullOrEmpty() && !hasReadContactsPermission

    internal fun mapMmsMsgBoxToSearchType(msgBox: Int?): Int? = msgBox?.takeIf { it in 1..6 }

    internal fun buildContactNameLikeSelection(): String = "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ? ESCAPE '\\'"

    internal fun buildContactNameLikeArg(contactName: String): String = "%${escapeSqlLikeLiteral(contactName)}%"

    internal fun buildKeywordLikeSelection(): String = "${Telephony.Sms.BODY} LIKE ? ESCAPE '\\'"

    internal fun buildKeywordLikeArg(keyword: String): String = "%${escapeSqlLikeLiteral(keyword)}%"

    internal fun buildMixedByPhoneProjection(): Array<String> =
      arrayOf(
        "_id",
        "thread_id",
        "transport_type",
        "address",
        "date",
        "date_sent",
        "read",
        "type",
        "body",
        "status",
      )

    internal fun hasSqlLikeWildcard(value: String): Boolean = value.contains('%') || value.contains('_')

    internal fun isExplicitPhoneInputInvalid(
      rawPhone: String?,
      normalizedPhone: String?,
    ): Boolean = !rawPhone.isNullOrBlank() && (normalizedPhone == null || hasSqlLikeWildcard(normalizedPhone))

    internal fun resolveMixedByPhoneRowStatus(
      transportType: String?,
      smsStatus: Int?,
    ): Int = if (transportType.equals("mms", ignoreCase = true)) -1 else (smsStatus ?: 0)

    internal fun resolveMixedByPhoneRowAddress(
      providerAddress: String?,
      phoneNumber: String,
      mmsAddress: String? = null,
    ): String = normalizePhoneNumberOrNull(mmsAddress) ?: normalizePhoneNumberOrNull(providerAddress) ?: phoneNumber

    internal fun selectPreferredMmsAddress(
      addressRows: List<Pair<String?, Int?>>,
      lookupNumber: String,
    ): String? {
      val lookupDigits = toByPhoneLookupNumber(lookupNumber)
      val normalizedRows =
        addressRows.mapNotNull { (address, type) ->
          val normalized = normalizePhoneNumberOrNull(address) ?: return@mapNotNull null
          Triple(normalized, toByPhoneLookupNumber(normalized), type)
        }

      fun firstPreferred(vararg types: Int): String? =
        normalizedRows
          .firstOrNull { row ->
            (types.isEmpty() || types.contains(row.third ?: -1)) && row.second != lookupDigits
          }?.first

      return firstPreferred(137)
        ?: firstPreferred(151, 130, 129)
        ?: firstPreferred()
        ?: normalizedRows.firstOrNull()?.first
    }

    internal fun shouldUseConversationReviewByPhoneMode(
      params: QueryParams,
      resolvedPhoneNumbers: List<String> = emptyList(),
    ): Boolean {
      val hasExplicitPhoneNumber = !params.phoneNumber.isNullOrEmpty()
      val hasSingleResolvedPhoneNumber = resolvedPhoneNumbers.size == 1
      return params.conversationReview && params.includeMms && (hasExplicitPhoneNumber || hasSingleResolvedPhoneNumber)
    }

    internal fun effectiveSearchParams(
      params: QueryParams,
      resolvedPhoneNumbers: List<String> = emptyList(),
    ): QueryParams {
      if (!shouldUseConversationReviewByPhoneMode(params, resolvedPhoneNumbers)) return params
      val reviewLimit = maxOf(params.limit, 25)
      return params.copy(limit = reviewLimit)
    }

    internal fun resolveSearchParams(
      params: QueryParams,
      normalizedPhoneNumber: String?,
      resolvedPhoneNumbers: List<String> = emptyList(),
    ): QueryParams {
      val effectivePhoneNumber = normalizedPhoneNumber ?: resolvedPhoneNumbers.singleOrNull()
      val normalizedParams = params.copy(phoneNumber = effectivePhoneNumber)
      return effectiveSearchParams(normalizedParams, resolvedPhoneNumbers)
    }

    internal fun toByPhoneLookupNumber(phone: String): String = phone.filter { it.isDigit() }

    internal fun normalizeProviderDateMillis(rawDate: Long): Long = if (rawDate in 1..99_999_999_999L) rawDate * 1000L else rawDate

    internal fun canonicalizeMixedPathPhoneFilters(phoneNumbers: List<String>): List<String> =
      phoneNumbers
        .map(::toByPhoneLookupNumber)
        .filter { it.isNotBlank() }
        .distinct()

    internal fun requestedMixedByPhoneCandidateWindow(params: QueryParams): Long = params.offset.toLong() + params.limit.toLong()

    internal fun exceedsMixedByPhoneCandidateWindow(
      params: QueryParams,
      allPhoneNumbers: List<String>,
    ): Boolean =
      params.includeMms &&
        allPhoneNumbers.size == 1 &&
        requestedMixedByPhoneCandidateWindow(params) > MAX_MIXED_BY_PHONE_CANDIDATE_WINDOW

    internal fun mixedByPhoneWindowError(): String = "INVALID_REQUEST: includeMms offset+limit exceeds supported window ($MAX_MIXED_BY_PHONE_CANDIDATE_WINDOW)"

    internal fun isMmsTransportRow(message: SmsMessage): Boolean = message.transportType.equals("mms", ignoreCase = true)

    internal fun shouldHydrateMmsByPhoneRow(
      transportType: String?,
      body: String?,
      type: Int,
    ): Boolean = transportType.equals("mms", ignoreCase = true) && (body.isNullOrBlank() || type == 0)

    internal fun buildQueryMetadata(
      params: QueryParams,
      allPhoneNumbers: List<String>,
      messages: List<SmsMessage>,
    ): QueryMetadata {
      val mmsRequested = params.includeMms
      val mmsEligible = mmsRequested && allPhoneNumbers.size == 1
      return QueryMetadata(
        mmsRequested = mmsRequested,
        mmsEligible = mmsEligible,
        mmsAttempted = mmsEligible,
        mmsIncluded = mmsEligible && messages.any(::isMmsTransportRow),
      )
    }

    internal fun compareByPhoneCandidateOrder(
      left: SmsMessage,
      right: SmsMessage,
    ): Int =
      when {
        left.date != right.date -> right.date.compareTo(left.date)
        left.id != right.id -> right.id.compareTo(left.id)
        else -> 0
      }

    internal fun buildMixedRowIdentity(
      rowId: Long,
      transportType: String?,
    ): String = "${transportType?.ifBlank { "unknown" } ?: "unknown"}:$rowId"

    internal fun buildSendPlan(
      message: String,
      divider: (String) -> List<String>,
    ): SendPlan {
      val parts = divider(message).ifEmpty { listOf(message) }
      return SendPlan(parts = parts, useMultipart = parts.size > 1)
    }

    internal fun buildPayloadJson(
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
      return Json.encodeToString(JsonObject.serializer(), JsonObject(payload))
    }

    internal fun buildQueryPayloadJson(
      ok: Boolean,
      messages: List<SmsMessage>,
      error: String? = null,
      queryMetadata: QueryMetadata? = null,
    ): String {
      val payload =
        mutableMapOf<String, JsonElement>(
          "ok" to JsonPrimitive(ok),
          "count" to JsonPrimitive(messages.size),
          "messages" to Json.encodeToJsonElement(messages),
        )
      queryMetadata?.let {
        payload["mmsRequested"] = JsonPrimitive(it.mmsRequested)
        payload["mmsEligible"] = JsonPrimitive(it.mmsEligible)
        payload["mmsAttempted"] = JsonPrimitive(it.mmsAttempted)
        payload["mmsIncluded"] = JsonPrimitive(it.mmsIncluded)
      }
      if (!ok && error != null) {
        payload["error"] = JsonPrimitive(error)
      }
      return Json.encodeToString(JsonObject.serializer(), JsonObject(payload))
    }
  }

  fun hasSmsPermission(): Boolean = context.hasPermission(Manifest.permission.SEND_SMS)

  fun hasReadSmsPermission(): Boolean = context.hasPermission(Manifest.permission.READ_SMS)

  fun hasReadContactsPermission(): Boolean = context.hasPermission(Manifest.permission.READ_CONTACTS)

  fun canSendSms(): Boolean = hasSmsPermission() && hasTelephonyFeature()

  fun canReadSms(): Boolean = hasReadSmsPermission() && hasTelephonyFeature()

  fun hasTelephonyFeature(): Boolean = context.packageManager?.hasSystemFeature(PackageManager.FEATURE_TELEPHONY) == true

  fun attachPermissionRequester(requester: PermissionRequester) {
    permissionRequester = requester
  }

  suspend fun send(paramsJson: String?): SmsResult {
    if (!hasTelephonyFeature()) {
      return sendResult(
        error = "SMS_UNAVAILABLE: telephony not available",
      )
    }

    if (!ensurePermission(Manifest.permission.SEND_SMS)) {
      return sendResult(
        error = "SMS_PERMISSION_REQUIRED: grant SMS permission",
      )
    }

    val params =
      when (val result = parseParams(paramsJson)) {
        is ParseResult.Ok -> result
        is ParseResult.Error -> return sendResult(error = result.error, to = result.to)
      }

    return try {
      val smsManager =
        context.getSystemService(AndroidSmsManager::class.java)
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

      sendResult(to = params.to)
    } catch (e: SecurityException) {
      sendResult(
        error = "SMS_PERMISSION_REQUIRED: ${e.message}",
        to = params.to,
      )
    } catch (e: Throwable) {
      sendResult(
        error = "SMS_SEND_FAILED: ${e.message ?: "unknown error"}",
        to = params.to,
      )
    }
  }

  suspend fun search(paramsJson: String?): SmsResult =
    withContext(Dispatchers.IO) {
      if (!hasTelephonyFeature()) {
        return@withContext queryResult(error = "SMS_UNAVAILABLE: telephony not available")
      }

      if (!ensurePermission(Manifest.permission.READ_SMS)) {
        return@withContext queryResult(error = "SMS_PERMISSION_REQUIRED: grant READ_SMS permission")
      }

      val parsedParams =
        when (val result = parseQueryParams(paramsJson)) {
          is QueryParseResult.Ok -> result.params
          is QueryParseResult.Error -> return@withContext queryResult(error = result.error)
        }
      val normalizedPhoneNumber = normalizePhoneNumberOrNull(parsedParams.phoneNumber)
      if (isExplicitPhoneInputInvalid(parsedParams.phoneNumber, normalizedPhoneNumber)) {
        val error =
          if (normalizedPhoneNumber != null && hasSqlLikeWildcard(normalizedPhoneNumber)) {
            "INVALID_REQUEST: phoneNumber must not contain SQL LIKE wildcard characters"
          } else {
            "INVALID_REQUEST: phoneNumber must contain at least one digit"
          }
        return@withContext queryResult(error = error)
      }
      val normalizedParams = resolveSearchParams(parsedParams, normalizedPhoneNumber)

      return@withContext try {
        val contactsPermissionGranted = hasReadContactsPermission()
        val shouldPromptForContactsPermission =
          shouldPromptForContactNameSearchPermission(
            contactName = normalizedParams.contactName,
            phoneNumber = normalizedParams.phoneNumber,
            hasReadContactsPermission = contactsPermissionGranted,
          )
        val phoneNumbers =
          if (!normalizedParams.contactName.isNullOrEmpty()) {
            if (contactsPermissionGranted || (shouldPromptForContactsPermission && ensurePermission(Manifest.permission.READ_CONTACTS))) {
              getPhoneNumbersFromContactName(normalizedParams.contactName)
            } else if (shouldPromptForContactsPermission) {
              return@withContext queryResult(error = "CONTACTS_PERMISSION_REQUIRED: grant READ_CONTACTS permission")
            } else {
              emptyList()
            }
          } else {
            emptyList()
          }
        val params = resolveSearchParams(parsedParams, normalizedPhoneNumber, phoneNumbers)

        val allPhoneNumbers = (phoneNumbers + listOfNotNull(params.phoneNumber)).distinct()
        val mixedPathPhoneFilters = canonicalizeMixedPathPhoneFilters(allPhoneNumbers)

        if (exceedsMixedByPhoneCandidateWindow(params, mixedPathPhoneFilters)) {
          val error = mixedByPhoneWindowError()
          return@withContext queryResult(error = error)
        }

        if (!params.contactName.isNullOrEmpty() && phoneNumbers.isEmpty() && params.phoneNumber.isNullOrEmpty()) {
          val queryMetadata = buildQueryMetadata(params, mixedPathPhoneFilters, emptyList())
          return@withContext queryResult(emptyList(), queryMetadata)
        }

        // MMS provider behavior stays opt-in and requires one canonical phone filter.
        val messages =
          if (params.includeMms && mixedPathPhoneFilters.size == 1) {
            querySmsMmsMessagesByPhone(mixedPathPhoneFilters.single(), params)
          } else {
            querySmsMessages(params, allPhoneNumbers)
          }
        val queryMetadata = buildQueryMetadata(params, mixedPathPhoneFilters, messages)
        queryResult(messages, queryMetadata)
      } catch (e: SecurityException) {
        queryResult(error = "SMS_PERMISSION_REQUIRED: ${e.message}")
      } catch (e: Throwable) {
        queryResult(error = "SMS_QUERY_FAILED: ${e.message ?: "unknown error"}")
      }
    }

  private suspend fun ensurePermission(permission: String): Boolean {
    if (context.hasPermission(permission)) return true
    val requester = permissionRequester ?: return false
    return requester.requestIfMissing(listOf(permission))[permission] == true
  }

  private fun sendResult(
    error: String? = null,
    to: String = "",
  ): SmsResult =
    SmsResult(
      ok = error == null,
      error = error,
      payloadJson = buildPayloadJson(ok = error == null, to = to, error = error),
    )

  private fun queryResult(
    messages: List<SmsMessage> = emptyList(),
    queryMetadata: QueryMetadata? = null,
    error: String? = null,
  ): SmsResult =
    SmsResult(
      ok = error == null,
      error = error,
      payloadJson = buildQueryPayloadJson(ok = error == null, messages = messages, error = error, queryMetadata = queryMetadata),
    )

  private fun getPhoneNumbersFromContactName(contactName: String): List<String> {
    val phoneNumbers = mutableListOf<String>()
    val selection = buildContactNameLikeSelection()
    val selectionArgs = arrayOf(buildContactNameLikeArg(contactName))

    val cursor =
      context.contentResolver.query(
        ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
        arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
        selection,
        selectionArgs,
        null,
      )

    cursor?.use {
      val numberIndex = it.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
      while (it.moveToNext()) {
        val number = it.getString(numberIndex)
        sanitizeContactPhoneNumberOrNull(number)?.let(phoneNumbers::add)
      }
    }

    return phoneNumbers
  }

  private fun querySmsMessages(
    params: QueryParams,
    allPhoneNumbers: List<String>,
  ): List<SmsMessage> {
    val messages = mutableListOf<SmsMessage>()

    val selections = mutableListOf<String>()
    val selectionArgs = mutableListOf<String>()

    if (params.startTime != null) {
      selections.add("${Telephony.Sms.DATE} >= ?")
      selectionArgs.add(params.startTime.toString())
    }
    if (params.endTime != null) {
      selections.add("${Telephony.Sms.DATE} <= ?")
      selectionArgs.add(params.endTime.toString())
    }

    if (allPhoneNumbers.isNotEmpty()) {
      val addressSelection =
        allPhoneNumbers.joinToString(" OR ") {
          "${Telephony.Sms.ADDRESS} LIKE ?"
        }
      selections.add("($addressSelection)")
      allPhoneNumbers.forEach {
        selectionArgs.add("%$it%")
      }
    }

    if (!params.keyword.isNullOrEmpty()) {
      selections.add(buildKeywordLikeSelection())
      selectionArgs.add(buildKeywordLikeArg(params.keyword))
    }

    if (params.type != null) {
      selections.add("${Telephony.Sms.TYPE} = ?")
      selectionArgs.add(params.type.toString())
    }

    if (params.isRead != null) {
      selections.add("${Telephony.Sms.READ} = ?")
      selectionArgs.add(if (params.isRead) "1" else "0")
    }

    // Android SMS providers still honor LIMIT/OFFSET through sortOrder on this path.
    // Keep the bounded interpolation here because parseQueryParams already clamps both values.
    val sortOrder = "${Telephony.Sms.DATE} DESC LIMIT ${params.limit} OFFSET ${params.offset}"
    val cursor =
      context.contentResolver.query(
        Telephony.Sms.CONTENT_URI,
        arrayOf(
          Telephony.Sms._ID,
          Telephony.Sms.THREAD_ID,
          Telephony.Sms.ADDRESS,
          Telephony.Sms.PERSON,
          Telephony.Sms.DATE,
          Telephony.Sms.DATE_SENT,
          Telephony.Sms.READ,
          Telephony.Sms.TYPE,
          Telephony.Sms.BODY,
          Telephony.Sms.STATUS,
        ),
        selections.takeIf { it.isNotEmpty() }?.joinToString(" AND "),
        selectionArgs.takeIf { it.isNotEmpty() }?.toTypedArray(),
        sortOrder,
      )

    cursor?.use {
      val idIndex = it.getColumnIndex(Telephony.Sms._ID)
      val threadIdIndex = it.getColumnIndex(Telephony.Sms.THREAD_ID)
      val addressIndex = it.getColumnIndex(Telephony.Sms.ADDRESS)
      val personIndex = it.getColumnIndex(Telephony.Sms.PERSON)
      val dateIndex = it.getColumnIndex(Telephony.Sms.DATE)
      val dateSentIndex = it.getColumnIndex(Telephony.Sms.DATE_SENT)
      val readIndex = it.getColumnIndex(Telephony.Sms.READ)
      val typeIndex = it.getColumnIndex(Telephony.Sms.TYPE)
      val bodyIndex = it.getColumnIndex(Telephony.Sms.BODY)
      val statusIndex = it.getColumnIndex(Telephony.Sms.STATUS)

      while (it.moveToNext() && messages.size < params.limit) {
        val message =
          SmsMessage(
            id = it.getLong(idIndex),
            threadId = it.getLong(threadIdIndex),
            address = it.getString(addressIndex),
            person = it.getString(personIndex),
            date = it.getLong(dateIndex),
            dateSent = it.getLong(dateSentIndex),
            read = it.getInt(readIndex) == 1,
            type = it.getInt(typeIndex),
            body = it.getString(bodyIndex),
            status = it.getInt(statusIndex),
          )
        messages.add(message)
      }
    }

    return messages
  }

  private fun querySmsMmsMessagesByPhone(
    phoneNumber: String,
    params: QueryParams,
  ): List<SmsMessage> {
    val uri = "$MMS_SMS_BY_PHONE_BASE/${Uri.encode(phoneNumber)}".toUri()
    val projection = buildMixedByPhoneProjection()

    val candidates = MixedByPhoneCandidates(params.offset + params.limit, shouldUseConversationReviewByPhoneMode(params))
    val cursor = context.contentResolver.query(uri, projection, null, null, "date DESC")
    cursor?.use {
      val idIndex = it.getColumnIndex("_id")
      val threadIdIndex = it.getColumnIndex("thread_id")
      val transportTypeIndex = it.getColumnIndex("transport_type")
      val addressIndex = it.getColumnIndex("address")
      val dateIndex = it.getColumnIndex("date")
      val dateSentIndex = it.getColumnIndex("date_sent")
      val readIndex = it.getColumnIndex("read")
      val typeIndex = it.getColumnIndex("type")
      val bodyIndex = it.getColumnIndex("body")
      val statusIndex = it.getColumnIndex("status")

      while (it.moveToNext()) {
        val id = if (idIndex >= 0 && !it.isNull(idIndex)) it.getLong(idIndex) else continue
        val rawDate = if (dateIndex >= 0 && !it.isNull(dateIndex)) it.getLong(dateIndex) else 0L
        val dateMs = normalizeProviderDateMillis(rawDate)

        if (params.startTime != null && dateMs < params.startTime) continue
        if (params.endTime != null && dateMs > params.endTime) continue

        val threadId = if (threadIdIndex >= 0 && !it.isNull(threadIdIndex)) it.getLong(threadIdIndex) else 0L
        val transportType = if (transportTypeIndex >= 0 && !it.isNull(transportTypeIndex)) it.getString(transportTypeIndex) else null
        val providerAddress = if (addressIndex >= 0 && !it.isNull(addressIndex)) it.getString(addressIndex) else null
        val mmsAddress = if (transportType.equals("mms", ignoreCase = true)) getMmsAddress(id, phoneNumber) else null
        val address = resolveMixedByPhoneRowAddress(providerAddress, phoneNumber, mmsAddress)
        var read = if (readIndex >= 0 && !it.isNull(readIndex)) it.getInt(readIndex) == 1 else true
        var type = if (typeIndex >= 0 && !it.isNull(typeIndex)) it.getInt(typeIndex) else 0
        var body = if (bodyIndex >= 0 && !it.isNull(bodyIndex)) it.getString(bodyIndex) else null
        val smsStatus = if (statusIndex >= 0 && !it.isNull(statusIndex)) it.getInt(statusIndex) else null

        // Only MMS transport rows are allowed to hydrate from MMS storage.
        if (shouldHydrateMmsByPhoneRow(transportType, body, type)) {
          body = body?.takeIf { msg -> msg.isNotBlank() } ?: getMmsTextBody(id)
          val mmsMeta = getMmsMeta(id)
          if (type == 0) {
            type = mmsMeta.first ?: type
          }
          if (readIndex < 0 || it.isNull(readIndex)) {
            read = mmsMeta.second ?: read
          }
        }

        val dateSentRaw = if (dateSentIndex >= 0 && !it.isNull(dateSentIndex)) it.getLong(dateSentIndex) else 0L
        val dateSentMs = normalizeProviderDateMillis(dateSentRaw)

        if (!params.keyword.isNullOrEmpty()) {
          val keyword = params.keyword
          if (body.isNullOrEmpty() || !body.contains(keyword, ignoreCase = true)) {
            continue
          }
        }
        if (params.type != null && type != params.type) continue
        if (params.isRead != null && read != params.isRead) continue

        val message =
          SmsMessage(
            id = id,
            threadId = threadId,
            address = address,
            person = null,
            date = dateMs,
            dateSent = dateSentMs,
            read = read,
            type = type,
            body = body,
            status = resolveMixedByPhoneRowStatus(transportType, smsStatus),
            transportType = transportType,
          )
        val identityKey = buildMixedRowIdentity(id, transportType)
        candidates.add(identityKey, message)
      }
    }

    return candidates.page(params)
  }

  private fun getMmsTextBody(messageId: Long): String? {
    val cursor =
      context.contentResolver.query(
        MMS_PART_URI.toUri(),
        arrayOf("text", "ct"),
        "mid=?",
        arrayOf(messageId.toString()),
        null,
      )

    cursor?.use {
      val textIndex = it.getColumnIndex("text")
      val ctIndex = it.getColumnIndex("ct")
      while (it.moveToNext()) {
        val contentType = if (ctIndex >= 0 && !it.isNull(ctIndex)) it.getString(ctIndex) else null
        if (contentType != null && contentType != "text/plain") continue
        val text = if (textIndex >= 0 && !it.isNull(textIndex)) it.getString(textIndex) else null
        if (!text.isNullOrBlank()) return text
      }
    }

    return null
  }

  private fun getMmsMeta(messageId: Long): Pair<Int?, Boolean?> {
    val cursor =
      context.contentResolver.query(
        "$MMS_CONTENT_BASE/$messageId".toUri(),
        arrayOf("msg_box", "read"),
        null,
        null,
        null,
      )

    cursor?.use {
      if (it.moveToFirst()) {
        val msgBoxIndex = it.getColumnIndex("msg_box")
        val readIndex = it.getColumnIndex("read")
        val msgBox = if (msgBoxIndex >= 0 && !it.isNull(msgBoxIndex)) it.getInt(msgBoxIndex) else null
        val mappedType = mapMmsMsgBoxToSearchType(msgBox)
        val read = if (readIndex >= 0 && !it.isNull(readIndex)) it.getInt(readIndex) == 1 else null
        return mappedType to read
      }
    }

    return null to null
  }

  private fun getMmsAddress(
    messageId: Long,
    phoneNumber: String,
  ): String? {
    val cursor =
      context.contentResolver.query(
        "$MMS_CONTENT_BASE/$messageId/addr".toUri(),
        arrayOf("address", "type"),
        null,
        null,
        null,
      )

    cursor?.use {
      val addressIndex = it.getColumnIndex("address")
      val typeIndex = it.getColumnIndex("type")
      val addressRows = mutableListOf<Pair<String?, Int?>>()
      while (it.moveToNext()) {
        val address = if (addressIndex >= 0 && !it.isNull(addressIndex)) it.getString(addressIndex) else null
        val type = if (typeIndex >= 0 && !it.isNull(typeIndex)) it.getInt(typeIndex) else null
        addressRows.add(address to type)
      }
      return selectPreferredMmsAddress(addressRows, phoneNumber)
    }

    return null
  }
}
