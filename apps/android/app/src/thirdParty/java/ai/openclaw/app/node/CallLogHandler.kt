package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.hasPermission
import android.Manifest
import android.content.Context
import android.provider.CallLog
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private const val DEFAULT_CALL_LOG_LIMIT = 25

@Serializable
internal data class CallLogRecord(
  val number: String?,
  val cachedName: String?,
  val date: Long,
  val duration: Long,
  val type: Int,
)

internal data class CallLogSearchRequest(
  val limit: Int,
  val offset: Int,
  val cachedName: String?,
  val number: String?,
  // Legacy exact timestamp; range queries use dateStart/dateEnd.
  val date: Long?,
  val dateStart: Long?,
  val dateEnd: Long?,
  val duration: Long?, // Seconds.
  val type: Int?,
)

internal interface CallLogDataSource {
  fun hasReadPermission(context: Context): Boolean

  fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord>
}

private object SystemCallLogDataSource : CallLogDataSource {
  override fun hasReadPermission(context: Context): Boolean = context.hasPermission(Manifest.permission.READ_CALL_LOG)

  override fun search(
    context: Context,
    request: CallLogSearchRequest,
  ): List<CallLogRecord> {
    val resolver = context.contentResolver
    val projection =
      arrayOf(
        CallLog.Calls.NUMBER,
        CallLog.Calls.CACHED_NAME,
        CallLog.Calls.DATE,
        CallLog.Calls.DURATION,
        CallLog.Calls.TYPE,
      )

    val selections = mutableListOf<String>()
    val selectionArgs = mutableListOf<String>()

    request.cachedName?.let {
      selections.add(buildCallLogCachedNameLikeSelection())
      selectionArgs.add(buildCallLogLikeArg(it))
    }

    request.number?.let {
      selections.add(buildCallLogNumberLikeSelection())
      selectionArgs.add(buildCallLogLikeArg(it))
    }

    if (request.dateStart != null) {
      selections.add("${CallLog.Calls.DATE} >= ?")
      selectionArgs.add(request.dateStart.toString())
    }
    if (request.dateEnd != null) {
      selections.add("${CallLog.Calls.DATE} <= ?")
      selectionArgs.add(request.dateEnd.toString())
    }
    if (request.dateStart == null && request.dateEnd == null && request.date != null) {
      // Compatible with the old date parameter (exact match)
      selections.add("${CallLog.Calls.DATE} = ?")
      selectionArgs.add(request.date.toString())
    }

    request.duration?.let {
      selections.add("${CallLog.Calls.DURATION} = ?")
      selectionArgs.add(it.toString())
    }

    request.type?.let {
      selections.add("${CallLog.Calls.TYPE} = ?")
      selectionArgs.add(it.toString())
    }

    val selection = if (selections.isNotEmpty()) selections.joinToString(" AND ") else null
    val selectionArgsArray = if (selectionArgs.isNotEmpty()) selectionArgs.toTypedArray() else null

    val sortOrder = "${CallLog.Calls.DATE} DESC"

    resolver
      .query(
        CallLog.Calls.CONTENT_URI,
        projection,
        selection,
        selectionArgsArray,
        sortOrder,
      ).use { cursor ->
        if (cursor == null) return emptyList()

        val numberIndex = cursor.getColumnIndex(CallLog.Calls.NUMBER)
        val cachedNameIndex = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
        val dateIndex = cursor.getColumnIndex(CallLog.Calls.DATE)
        val durationIndex = cursor.getColumnIndex(CallLog.Calls.DURATION)
        val typeIndex = cursor.getColumnIndex(CallLog.Calls.TYPE)

        if (request.offset > 0) cursor.moveToPosition(request.offset - 1)

        val out = mutableListOf<CallLogRecord>()
        while (cursor.moveToNext() && out.size < request.limit) {
          out +=
            CallLogRecord(
              number = cursor.getString(numberIndex),
              cachedName = cursor.getString(cachedNameIndex),
              date = cursor.getLong(dateIndex),
              duration = cursor.getLong(durationIndex),
              type = cursor.getInt(typeIndex),
            )
        }
        return out
      }
  }
}

internal fun buildCallLogCachedNameLikeSelection(): String = "${CallLog.Calls.CACHED_NAME} LIKE ? ESCAPE '\\'"

internal fun buildCallLogNumberLikeSelection(): String = "${CallLog.Calls.NUMBER} LIKE ? ESCAPE '\\'"

internal fun buildCallLogLikeArg(value: String): String = "%${escapeSqlLikeLiteral(value)}%"

class CallLogHandler internal constructor(
  private val appContext: Context,
  private val dataSource: CallLogDataSource = SystemCallLogDataSource,
) {
  fun handleCallLogSearch(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasReadPermission(appContext)) {
      return nodeInvokeError("CALL_LOG_PERMISSION_REQUIRED", "grant Call Log permission")
    }

    val request =
      parseSearchRequest(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")

    return try {
      val callLogs = dataSource.search(appContext, request)
      GatewaySession.InvokeResult.ok(Json.encodeToString(mapOf("callLogs" to callLogs)))
    } catch (err: Throwable) {
      nodeInvokeError("CALL_LOG_UNAVAILABLE", err.message ?: "call log query failed")
    }
  }

  private fun parseSearchRequest(paramsJson: String?): CallLogSearchRequest? {
    val params = if (paramsJson.isNullOrBlank()) JsonObject(emptyMap()) else parseJsonParamsObject(paramsJson) ?: return null

    return CallLogSearchRequest(
      limit = ((params["limit"] as? JsonPrimitive)?.content?.toIntOrNull() ?: DEFAULT_CALL_LOG_LIMIT).coerceIn(1, 200),
      offset = ((params["offset"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0).coerceAtLeast(0),
      cachedName = (params["cachedName"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() },
      number = (params["number"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() },
      date = (params["date"] as? JsonPrimitive)?.content?.toLongOrNull(),
      dateStart = (params["dateStart"] as? JsonPrimitive)?.content?.toLongOrNull(),
      dateEnd = (params["dateEnd"] as? JsonPrimitive)?.content?.toLongOrNull(),
      duration = (params["duration"] as? JsonPrimitive)?.content?.toLongOrNull(),
      type = (params["type"] as? JsonPrimitive)?.content?.toIntOrNull(),
    )
  }
}
