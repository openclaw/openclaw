package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
enum class GatewayRegistryEntryKind {
  @SerialName("manual")
  MANUAL,

  @SerialName("discovered")
  DISCOVERED,
}

@Serializable
data class GatewayRegistryEntry(
  val stableId: String,
  val kind: GatewayRegistryEntryKind,
  val name: String,
  val host: String? = null,
  val port: Int? = null,
  val tls: Boolean = true,
  val lastConnectedAtMs: Long = 0L,
)

@Serializable
internal data class PersistedGatewayRegistry(
  val version: Int = 1,
  val activeStableId: String? = null,
  val entries: List<GatewayRegistryEntry> = emptyList(),
)

class GatewayRegistryStore(
  private val prefs: SecurePrefs,
  private val onActiveChanged: ((String?) -> Unit)? = null,
) {
  companion object {
    internal const val STORAGE_KEY = "gateway.registry"
  }

  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
  private val mutationLock = Any()
  private val initial = decode(prefs.getString(STORAGE_KEY))
  private val _entries = MutableStateFlow(initial.entries.sortedForStorage())
  val entries: StateFlow<List<GatewayRegistryEntry>> = _entries.asStateFlow()
  private val _activeStableId = MutableStateFlow(initial.activeStableId)
  val activeStableId: StateFlow<String?> = _activeStableId.asStateFlow()

  fun upsert(entry: GatewayRegistryEntry): Unit =
    synchronized(mutationLock) {
      val stableId = entry.stableId.trim()
      require(stableId.isNotEmpty()) { "Gateway stable id cannot be empty" }
      val existing = _entries.value.firstOrNull { it.stableId == stableId }
      val normalized =
        entry.copy(
          stableId = stableId,
          name = entry.name.trim().ifEmpty { stableId },
          host = entry.host?.trim()?.takeIf { it.isNotEmpty() },
          lastConnectedAtMs =
            if (entry.lastConnectedAtMs == 0L) {
              existing?.lastConnectedAtMs ?: 0L
            } else {
              entry.lastConnectedAtMs
            },
        )
      _entries.value = (_entries.value.filterNot { it.stableId == stableId } + normalized).sortedForStorage()
      persist()
    }

  fun setActive(stableId: String?): Unit =
    synchronized(mutationLock) {
      val normalized = stableId?.trim()?.takeIf { it.isNotEmpty() }
      require(normalized == null || _entries.value.any { it.stableId == normalized }) {
        "Active gateway must exist in the registry"
      }
      _activeStableId.value = normalized
      persist()
      onActiveChanged?.invoke(normalized)
    }

  fun markConnected(
    stableId: String,
    atMs: Long,
  ): Unit =
    synchronized(mutationLock) {
      val existing = _entries.value.firstOrNull { it.stableId == stableId } ?: return
      upsert(existing.copy(lastConnectedAtMs = atMs))
    }

  fun remove(stableId: String): Unit =
    synchronized(mutationLock) {
      val normalized = stableId.trim()
      _entries.value = _entries.value.filterNot { it.stableId == normalized }
      if (_activeStableId.value == normalized) {
        _activeStableId.value = null
        onActiveChanged?.invoke(null)
      }
      persist()
    }

  fun activeEntry(): GatewayRegistryEntry? =
    synchronized(mutationLock) {
      val activeId = _activeStableId.value ?: return@synchronized null
      _entries.value.firstOrNull { it.stableId == activeId }
    }

  internal fun storedActiveStableId(): String? = decode(prefs.getString(STORAGE_KEY)).activeStableId

  private fun persist() {
    val registry =
      PersistedGatewayRegistry(
        activeStableId = _activeStableId.value,
        entries = _entries.value.sortedForStorage(),
      )
    prefs.putString(STORAGE_KEY, json.encodeToString(registry))
  }

  private fun decode(raw: String?): PersistedGatewayRegistry =
    raw
      ?.let { runCatching { json.decodeFromString<PersistedGatewayRegistry>(it) }.getOrNull() }
      ?.takeIf { it.version == 1 }
      ?: PersistedGatewayRegistry()
}

internal fun List<GatewayRegistryEntry>.sortedForStorage(): List<GatewayRegistryEntry> = sortedWith(compareBy<GatewayRegistryEntry>({ it.name.lowercase() }, { it.stableId }))
