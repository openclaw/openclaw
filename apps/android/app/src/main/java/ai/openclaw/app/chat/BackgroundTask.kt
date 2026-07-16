package ai.openclaw.app.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant

data class BackgroundTask(
  val id: String,
  val taskId: String,
  val status: String,
  val runtime: String,
  val title: String?,
  val agentId: String?,
  val childSessionKey: String?,
  val createdAtMs: Long?,
  val updatedAtMs: Long?,
  val startedAtMs: Long?,
  val endedAtMs: Long?,
  val progress: String?,
  val terminal: String?,
  val error: String?,
  val prompt: String?,
) {
  val isActive: Boolean
    get() = status == "queued" || status == "running"

  val displayTitle: String
    get() = title?.trim()?.takeIf { it.isNotEmpty() } ?: taskId

  val statusLabel: String
    get() =
      when (status) {
        "completed" -> "Completed"
        "queued" -> "Queued"
        "running" -> "Running"
        else -> "Failed"
      }

  val output: String?
    get() {
      val candidates =
        if (status == "failed" || status == "timed_out") {
          listOf(error, terminal, progress)
        } else {
          listOf(terminal, error, progress)
        }
      return candidates.firstOrNull { !it.isNullOrBlank() }
    }

  val activityAtMs: Long
    get() = updatedAtMs ?: endedAtMs ?: startedAtMs ?: createdAtMs ?: 0L
}

internal fun parseBackgroundTasks(
  json: Json,
  payload: String,
): List<BackgroundTask> {
  val root = json.parseToJsonElement(payload).jsonObject
  return root["tasks"]?.jsonArray?.mapNotNull(::parseBackgroundTask).orEmpty()
}

internal fun parseBackgroundTask(element: JsonElement): BackgroundTask? {
  val objectValue = element as? JsonObject ?: return null

  fun string(key: String): String? = objectValue[key]?.jsonPrimitive?.contentOrNull

  val id = string("id")?.takeIf { it.isNotBlank() } ?: return null
  val taskId = string("taskId")?.takeIf { it.isNotBlank() } ?: id
  return BackgroundTask(
    id = id,
    taskId = taskId,
    status = string("status") ?: "running",
    runtime = string("runtime") ?: "background",
    title = string("title"),
    agentId = string("agentId"),
    childSessionKey = string("childSessionKey"),
    createdAtMs = objectValue["createdAt"]?.let(::parseTaskTimestampMs),
    updatedAtMs = objectValue["updatedAt"]?.let(::parseTaskTimestampMs),
    startedAtMs = objectValue["startedAt"]?.let(::parseTaskTimestampMs),
    endedAtMs = objectValue["endedAt"]?.let(::parseTaskTimestampMs),
    progress = string("progressSummary"),
    terminal = string("terminalSummary"),
    error = string("error"),
    prompt = string("prompt"),
  )
}

internal fun mergeBackgroundTasks(vararg groups: List<BackgroundTask>): List<BackgroundTask> =
  groups
    .flatMap { it }
    .groupBy { it.id }
    .mapValues { (_, snapshots) ->
      snapshots.maxWith(compareBy<BackgroundTask> { it.activityAtMs }.thenBy { !it.isActive })
    }.values
    .sortedWith(compareByDescending<BackgroundTask> { it.isActive }.thenByDescending { it.activityAtMs })

private fun parseTaskTimestampMs(element: JsonElement): Long? {
  val primitive = element.jsonPrimitive
  primitive.doubleOrNull?.let { return it.toLong() }
  return primitive.contentOrNull?.let { raw -> runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull() }
}
