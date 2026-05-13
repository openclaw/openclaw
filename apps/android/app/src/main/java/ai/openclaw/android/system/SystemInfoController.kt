package ai.openclaw.android.system

import ai.openclaw.android.gateway.GatewaySession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class SystemInfoController(
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val json: Json,
) {
  private val _state = MutableStateFlow(SystemInfoState())
  val state: StateFlow<SystemInfoState> = _state.asStateFlow()

  private var pollJob: Job? = null

  fun start() {
    if (pollJob != null) return
    pollJob =
      scope.launch(Dispatchers.IO) {
        while (true) {
          refresh()
          delay(15_000)
        }
      }
  }

  fun refresh() {
    scope.launch(Dispatchers.IO) { refreshNow() }
  }

  private suspend fun refreshNow() {
    val started = System.currentTimeMillis()
    _state.value = _state.value.copy(loading = true, errorText = null)
    try {
      val health = parseObject(session.request("health", null, timeoutMs = 8_000)) ?: JsonObject(emptyMap())
      val presence = parsePresence(session.request("system-presence", "{}", timeoutMs = 8_000))
      val eventLoop = health["eventLoop"]?.jsonObjectOrNull()
      val sessions = health["sessions"]?.jsonObjectOrNull()
      val channels = health["channels"]?.jsonObjectOrNull()
      val channelCount = channels?.size ?: 0
      val connectedChannels = channels?.values?.count { it.jsonObjectOrNull()?.get("connected")?.boolOrNull() == true } ?: 0
      val utilization = eventLoop?.get("utilization")?.jsonPrimitiveOrNull()?.doubleOrNull
      val cpuCoreRatio = eventLoop?.get("cpuCoreRatio")?.jsonPrimitiveOrNull()?.doubleOrNull
      val degraded = eventLoop?.get("degraded")?.boolOrNull() == true
      val reasons = eventLoop?.get("reasons")?.jsonArrayOrNull()?.mapNotNull { it.stringOrNull() }.orEmpty()

      _state.value =
        SystemInfoState(
          loading = false,
          host = presence.host,
          ip = presence.ip,
          version = presence.version,
          platform = presence.platform,
          mode = presence.mode,
          gatewayOk = health["ok"]?.boolOrNull() == true,
          latencyMs = System.currentTimeMillis() - started,
          eventLoopUtilization = utilization,
          cpuCoreRatio = cpuCoreRatio,
          degraded = degraded,
          degradedReasons = reasons,
          heartbeatSeconds = health["heartbeatSeconds"]?.jsonPrimitiveOrNull()?.content?.toLongOrNull(),
          sessionCount = sessions?.get("count")?.jsonPrimitiveOrNull()?.content?.toIntOrNull(),
          channelCount = channelCount,
          connectedChannelCount = connectedChannels,
          lastUpdatedMs = System.currentTimeMillis(),
        )
    } catch (t: Throwable) {
      _state.value = _state.value.copy(loading = false, errorText = t.message ?: "System status unavailable")
    }
  }

  private fun parseObject(raw: String): JsonObject? =
    runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()

  private fun parsePresence(raw: String): PresenceInfo {
    val array = runCatching { json.parseToJsonElement(raw).jsonArray }.getOrNull() ?: JsonArray(emptyList())
    val obj = array.firstOrNull()?.jsonObjectOrNull() ?: return PresenceInfo()
    return PresenceInfo(
      host = obj["host"].stringOrNull(),
      ip = obj["ip"].stringOrNull(),
      version = obj["version"].stringOrNull(),
      platform = obj["platform"].stringOrNull(),
      mode = obj["mode"].stringOrNull(),
    )
  }
}

data class SystemInfoState(
  val loading: Boolean = false,
  val errorText: String? = null,
  val host: String? = null,
  val ip: String? = null,
  val version: String? = null,
  val platform: String? = null,
  val mode: String? = null,
  val gatewayOk: Boolean = false,
  val latencyMs: Long? = null,
  val eventLoopUtilization: Double? = null,
  val cpuCoreRatio: Double? = null,
  val degraded: Boolean = false,
  val degradedReasons: List<String> = emptyList(),
  val heartbeatSeconds: Long? = null,
  val sessionCount: Int? = null,
  val channelCount: Int = 0,
  val connectedChannelCount: Int = 0,
  val lastUpdatedMs: Long? = null,
)

private data class PresenceInfo(
  val host: String? = null,
  val ip: String? = null,
  val version: String? = null,
  val platform: String? = null,
  val mode: String? = null,
)

private fun JsonElement?.jsonObjectOrNull(): JsonObject? = this as? JsonObject
private fun JsonElement?.jsonArrayOrNull(): JsonArray? = this as? JsonArray
private fun JsonElement?.jsonPrimitiveOrNull(): JsonPrimitive? = this as? JsonPrimitive
private fun JsonElement?.stringOrNull(): String? = jsonPrimitiveOrNull()?.content?.trim()?.takeIf { it.isNotEmpty() }
private fun JsonElement?.boolOrNull(): Boolean? = jsonPrimitiveOrNull()?.content?.toBooleanStrictOrNull()
