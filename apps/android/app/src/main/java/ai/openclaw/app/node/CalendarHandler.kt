package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.hasPermission
import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.provider.CalendarContract
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.TimeZone

private const val DEFAULT_CALENDAR_LIMIT = 50

internal data class CalendarEventsRequest(
  val startMs: Long,
  val endMs: Long,
  val limit: Int,
)

internal data class CalendarAddRequest(
  val title: String,
  val startMs: Long,
  val endMs: Long,
  val isAllDay: Boolean,
  val timeZoneId: String,
  val location: String?,
  val notes: String?,
  val calendarId: Long?,
  val calendarTitle: String?,
)

/** Null defaults keep absent optional fields out of the serialized payload. */
@Serializable
internal data class CalendarEventRecord(
  val identifier: String,
  val title: String,
  val startISO: String,
  val endISO: String,
  val isAllDay: Boolean,
  val location: String? = null,
  val calendarTitle: String? = null,
)

internal interface CalendarDataSource {
  fun hasReadPermission(): Boolean

  fun hasWritePermission(): Boolean

  fun events(request: CalendarEventsRequest): List<CalendarEventRecord>

  fun add(request: CalendarAddRequest): CalendarEventRecord
}

private class SystemCalendarDataSource(
  private val context: Context,
) : CalendarDataSource {
  override fun hasReadPermission(): Boolean = context.hasPermission(Manifest.permission.READ_CALENDAR)

  override fun hasWritePermission(): Boolean = context.hasPermission(Manifest.permission.WRITE_CALENDAR)

  override fun events(request: CalendarEventsRequest): List<CalendarEventRecord> {
    val resolver = context.contentResolver
    val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
    // Instances expands recurring events inside the requested time window.
    ContentUris.appendId(builder, request.startMs)
    ContentUris.appendId(builder, request.endMs)
    val projection = eventProjection(instances = true)
    val sortOrder = "${CalendarContract.Instances.BEGIN} ASC LIMIT ${request.limit}"
    resolver.query(builder.build(), projection, null, null, sortOrder).use { cursor ->
      if (cursor == null) return emptyList()
      val out = mutableListOf<CalendarEventRecord>()
      while (cursor.moveToNext() && out.size < request.limit) {
        out += cursor.toCalendarEventRecord()
      }
      return out
    }
  }

  override fun add(request: CalendarAddRequest): CalendarEventRecord {
    val resolver = context.contentResolver
    val resolvedCalendarId = resolveCalendarId(resolver, request.calendarId, request.calendarTitle)
    val values =
      ContentValues().apply {
        put(CalendarContract.Events.CALENDAR_ID, resolvedCalendarId)
        put(CalendarContract.Events.TITLE, request.title)
        put(CalendarContract.Events.DTSTART, request.startMs)
        put(CalendarContract.Events.DTEND, request.endMs)
        put(CalendarContract.Events.ALL_DAY, if (request.isAllDay) 1 else 0)
        put(CalendarContract.Events.EVENT_TIMEZONE, request.timeZoneId)
        request.location?.let { put(CalendarContract.Events.EVENT_LOCATION, it) }
        request.notes?.let { put(CalendarContract.Events.DESCRIPTION, it) }
      }
    val eventId =
      resolver.insert(CalendarContract.Events.CONTENT_URI, values)?.lastPathSegment?.toLongOrNull()
        ?: throw IllegalStateException("calendar insert failed")
    return loadEventById(resolver, eventId)
      ?: throw IllegalStateException("calendar insert failed")
  }

  private fun resolveCalendarId(
    resolver: ContentResolver,
    calendarId: Long?,
    calendarTitle: String?,
  ): Long {
    if (calendarId != null) {
      // Explicit id wins over title/default selection and must already exist.
      if (findCalendarId(resolver, "${CalendarContract.Calendars._ID}=?", arrayOf(calendarId.toString())) != null) return calendarId
      throw IllegalArgumentException("CALENDAR_NOT_FOUND: no calendar id $calendarId")
    }
    if (!calendarTitle.isNullOrEmpty()) {
      // Title lookup is exact to avoid adding events to a similarly named calendar.
      findCalendarId(
        resolver,
        "${CalendarContract.Calendars.CALENDAR_DISPLAY_NAME}=?",
        arrayOf(calendarTitle),
        "${CalendarContract.Calendars.IS_PRIMARY} DESC",
      )?.let { return it }
      throw IllegalArgumentException("CALENDAR_NOT_FOUND: no calendar named $calendarTitle")
    }
    findCalendarId(
      resolver,
      "${CalendarContract.Calendars.VISIBLE}=1 AND " +
        "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR}",
      // Prefer Android's primary visible calendar, then lowest id for deterministic fallback.
      sortOrder = "${CalendarContract.Calendars.IS_PRIMARY} DESC, ${CalendarContract.Calendars._ID} ASC",
    )?.let { return it }
    throw IllegalArgumentException("CALENDAR_NOT_FOUND: no default calendar")
  }

  private fun findCalendarId(
    resolver: ContentResolver,
    selection: String,
    selectionArgs: Array<String>? = null,
    sortOrder: String? = null,
  ): Long? {
    resolver
      .query(
        CalendarContract.Calendars.CONTENT_URI,
        arrayOf(CalendarContract.Calendars._ID),
        selection,
        selectionArgs,
        sortOrder,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        return cursor.getLong(0)
      }
  }

  private fun loadEventById(
    resolver: ContentResolver,
    eventId: Long,
  ): CalendarEventRecord? {
    val projection = eventProjection(instances = false)
    resolver
      .query(
        CalendarContract.Events.CONTENT_URI,
        projection,
        "${CalendarContract.Events._ID}=?",
        arrayOf(eventId.toString()),
        null,
      ).use { cursor ->
        if (cursor == null || !cursor.moveToFirst()) return null
        return cursor.toCalendarEventRecord()
      }
  }

  // Instances and Events queries project the same seven fields in this order.
  private fun eventProjection(instances: Boolean): Array<String> =
    arrayOf(
      if (instances) CalendarContract.Instances.EVENT_ID else CalendarContract.Events._ID,
      CalendarContract.Events.TITLE,
      if (instances) CalendarContract.Instances.BEGIN else CalendarContract.Events.DTSTART,
      if (instances) CalendarContract.Instances.END else CalendarContract.Events.DTEND,
      CalendarContract.Events.ALL_DAY,
      CalendarContract.Events.EVENT_LOCATION,
      CalendarContract.Events.CALENDAR_DISPLAY_NAME,
    )

  private fun Cursor.toCalendarEventRecord(): CalendarEventRecord =
    CalendarEventRecord(
      identifier = getLong(0).toString(),
      title = getString(1)?.trim().orEmpty().ifEmpty { "(untitled)" },
      startISO = Instant.ofEpochMilli(getLong(2)).toString(),
      endISO = Instant.ofEpochMilli(getLong(3)).toString(),
      isAllDay = getInt(4) == 1,
      location = getString(5)?.trim()?.ifEmpty { null },
      calendarTitle = getString(6)?.trim()?.ifEmpty { null },
    )
}

class CalendarHandler internal constructor(
  appContext: Context,
  private val dataSource: CalendarDataSource = SystemCalendarDataSource(appContext),
) {
  fun handleCalendarEvents(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasReadPermission()) {
      return nodeInvokeError("CALENDAR_PERMISSION_REQUIRED", "grant Calendar permission")
    }
    val request =
      parseEventsRequest(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")
    return nodeInvokeJson("CALENDAR_UNAVAILABLE", "calendar query failed") {
      Json.encodeToString(mapOf("events" to dataSource.events(request)))
    }
  }

  fun handleCalendarAdd(paramsJson: String?): GatewaySession.InvokeResult {
    if (!dataSource.hasWritePermission()) {
      return nodeInvokeError("CALENDAR_PERMISSION_REQUIRED", "grant Calendar permission")
    }
    val request =
      parseAddRequest(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")
    if (request.title.isEmpty()) {
      return nodeInvokeError("CALENDAR_INVALID", "title required")
    }
    if (request.endMs <= request.startMs) {
      return nodeInvokeError("CALENDAR_INVALID", "endISO must be after startISO")
    }
    return try {
      val event = dataSource.add(request)
      GatewaySession.InvokeResult.ok(Json.encodeToString(mapOf("event" to event)))
    } catch (err: IllegalArgumentException) {
      val msg = err.message ?: "CALENDAR_INVALID: invalid request"
      val code = if (msg.startsWith("CALENDAR_NOT_FOUND")) "CALENDAR_NOT_FOUND" else "CALENDAR_INVALID"
      GatewaySession.InvokeResult.error(code = code, message = msg)
    } catch (err: Throwable) {
      nodeInvokeError("CALENDAR_UNAVAILABLE", err.message ?: "calendar add failed")
    }
  }

  private fun parseEventsRequest(paramsJson: String?): CalendarEventsRequest? {
    val params = if (paramsJson.isNullOrBlank()) null else parseJsonParamsObject(paramsJson) ?: return null
    val start = parseISO(parseJsonString(params, "startISO"))
    val end = parseISO(parseJsonString(params, "endISO"))
    val resolvedStart = start ?: Instant.now()
    val resolvedEnd = end ?: resolvedStart.plus(7, ChronoUnit.DAYS)
    // Keep model-driven calendar reads bounded.
    val limit = (parseJsonInt(params, "limit") ?: DEFAULT_CALENDAR_LIMIT).coerceIn(1, 500)
    return CalendarEventsRequest(
      startMs = resolvedStart.toEpochMilli(),
      endMs = resolvedEnd.toEpochMilli(),
      limit = limit,
    )
  }

  private fun parseAddRequest(paramsJson: String?): CalendarAddRequest? {
    val params = parseJsonParamsObject(paramsJson) ?: return null
    var start =
      parseISO((params["startISO"] as? JsonPrimitive)?.content)
        ?: return null
    var end =
      parseISO((params["endISO"] as? JsonPrimitive)?.content)
        ?: return null
    val isAllDay = (params["isAllDay"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: false
    if (isAllDay && end > start) {
      start = start.truncatedTo(ChronoUnit.DAYS)
      end = maxOf(end.truncatedTo(ChronoUnit.DAYS), start.plus(1, ChronoUnit.DAYS))
    }
    return CalendarAddRequest(
      title = parseJsonString(params, "title")?.trim().orEmpty(),
      startMs = start.toEpochMilli(),
      endMs = end.toEpochMilli(),
      isAllDay = isAllDay,
      timeZoneId = if (isAllDay) "UTC" else TimeZone.getDefault().id,
      location = parseJsonString(params, "location")?.trim()?.ifEmpty { null },
      notes = parseJsonString(params, "notes")?.trim()?.ifEmpty { null },
      calendarId = (params["calendarId"] as? JsonPrimitive)?.content?.toLongOrNull(),
      calendarTitle = parseJsonString(params, "calendarTitle")?.trim()?.ifEmpty { null },
    )
  }

  private fun parseISO(raw: String?): Instant? {
    val value = raw?.trim().orEmpty()
    if (value.isEmpty()) return null
    // Gateway calendar payloads use UTC ISO-8601 instants for unambiguous Android storage.
    return try {
      Instant.parse(value)
    } catch (_: Throwable) {
      null
    }
  }
}
