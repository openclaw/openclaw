package ai.openclaw.app.gateway

import android.util.Log
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
  val contextPath: String = "",
)

@Serializable
data class PersistedGatewayRegistry(
  val version: Int = 1,
  val activeStableId: String? = null,
  val connectedStableIds: List<String>? = null,
  val entries: List<GatewayRegistryEntry> = emptyList(),
)

@Serializable
private data class PersistedGatewayRegistryVersion(
  val version: Int,
)

class GatewayRegistryStore(
  private val prefs: GatewayCredentialStore,
  private val onActiveChanged: ((String?) -> Unit)? = null,
) {
  companion object {
    const val STORAGE_KEY = "gateway.registry"
  }

  private val json =
    Json {
      ignoreUnknownKeys = true
      encodeDefaults = true
    }
  private val mutationLock = Any()
  private val initialRaw = prefs.getString(STORAGE_KEY)
  private val initialDecode = decode(initialRaw)
  private val initial = initialDecode.registry
  private val mutationsAllowed = initialRaw == null || initialDecode.canRewrite
  private val _entries = MutableStateFlow(initial.entries.sortedForStorage())
  val entries: StateFlow<List<GatewayRegistryEntry>> = _entries.asStateFlow()
  private val _activeStableId = MutableStateFlow(initial.activeStableId)
  val activeStableId: StateFlow<String?> = _activeStableId.asStateFlow()
  private val _connectedStableIds = MutableStateFlow(initial.connectedStableIds.orEmpty())
  val connectedStableIds: StateFlow<List<String>> = _connectedStableIds.asStateFlow()

  init {
    if (initialDecode.canRewrite && initialRaw != encodedRegistry()) persist()
  }

  fun upsert(entry: GatewayRegistryEntry): Unit =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized
      _entries.value = entriesWith(entry)
      persist()
    }

  /** Registration, selection and app-owned credential edits share one durable commit. */
  fun upsertAndSetActive(
    entry: GatewayRegistryEntry,
    credentialEdits: Map<String, String?> = emptyMap(),
  ): Boolean =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized false
      val stableId = entry.stableId.trim()
      commitAndPublish(
        entriesWith(entry),
        stableId,
        (_connectedStableIds.value + stableId).distinct(),
        credentialEdits,
        notifyActive = true,
      )
    }

  fun setActive(stableId: String?): Boolean =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized false
      val normalized = stableId?.trim()?.takeIf { it.isNotEmpty() }
      require(normalized == null || _entries.value.any { it.stableId == normalized }) {
        "Active gateway must exist in the registry"
      }
      val nextConnected =
        if (normalized != null) (_connectedStableIds.value + normalized).distinct() else _connectedStableIds.value
      commitAndPublish(_entries.value, normalized, nextConnected, notifyActive = true)
    }

  fun setConnectionEnabled(
    stableId: String,
    enabled: Boolean,
  ): Unit =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized
      val normalized = stableId.trim()
      require(_entries.value.any { it.stableId == normalized }) {
        "Connected gateway must exist in the registry"
      }
      _connectedStableIds.value =
        if (enabled) {
          (_connectedStableIds.value + normalized).distinct()
        } else {
          _connectedStableIds.value.filterNot { it == normalized }
        }
      persist()
    }

  fun connectedEntries(): List<GatewayRegistryEntry> =
    synchronized(mutationLock) {
      _connectedStableIds.value.mapNotNull { connectedId ->
        _entries.value.firstOrNull { it.stableId == connectedId }
      }
    }

  fun markConnected(
    stableId: String,
    atMs: Long,
  ): Unit =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized
      val existing = _entries.value.firstOrNull { it.stableId == stableId } ?: return
      upsert(existing.copy(lastConnectedAtMs = atMs))
    }

  fun remove(
    stableId: String,
    credentialEdits: Map<String, String?> = emptyMap(),
  ): Boolean =
    synchronized(mutationLock) {
      if (!mutationsAllowed) return@synchronized false
      val normalized = stableId.trim()
      val nextEntries = _entries.value.filterNot { it.stableId == normalized }
      val previousActiveStableId = _activeStableId.value
      val nextActiveStableId = previousActiveStableId?.takeUnless { it == normalized }
      val nextConnectedStableIds = _connectedStableIds.value.filterNot { it == normalized }
      commitAndPublish(
        nextEntries,
        nextActiveStableId,
        nextConnectedStableIds,
        credentialEdits,
        notifyActive = previousActiveStableId != nextActiveStableId,
      )
    }

  fun activeEntry(): GatewayRegistryEntry? =
    synchronized(mutationLock) {
      val activeId = _activeStableId.value ?: return@synchronized null
      _entries.value.firstOrNull { it.stableId == activeId }
    }

  fun storedActiveStableId(): String? = decode(prefs.getString(STORAGE_KEY)).registry.activeStableId

  private fun persist() {
    if (!mutationsAllowed) return
    prefs.putString(STORAGE_KEY, encodedRegistry())
  }

  private fun entriesWith(entry: GatewayRegistryEntry): List<GatewayRegistryEntry> {
    val stableId = entry.stableId.trim()
    require(stableId.isNotEmpty()) { "Gateway stable id cannot be empty" }
    val existing = _entries.value.firstOrNull { it.stableId == stableId }
    val normalized =
      entry.copy(
        stableId = stableId,
        name = entry.name.trim().ifEmpty { stableId },
        host = entry.host?.trim()?.takeIf { it.isNotEmpty() },
        contextPath = normalizeGatewayContextPath(entry.contextPath),
        lastConnectedAtMs = entry.lastConnectedAtMs.takeUnless { it == 0L } ?: existing?.lastConnectedAtMs ?: 0L,
      )
    return (_entries.value.filterNot { it.stableId == stableId } + normalized).sortedForStorage()
  }

  private fun commitAndPublish(
    entries: List<GatewayRegistryEntry>,
    activeStableId: String?,
    connectedStableIds: List<String>,
    credentialEdits: Map<String, String?> = emptyMap(),
    notifyActive: Boolean,
  ): Boolean {
    require(STORAGE_KEY !in credentialEdits) { "Credential edits cannot replace the gateway registry" }
    if (!prefs.commitSecureStrings(
        credentialEdits + (STORAGE_KEY to encodedRegistry(entries, activeStableId, connectedStableIds)),
      )
    ) {
      return false
    }
    // Registry lock precedes the credential lock. Publish only after commit; an observer
    // failure cannot turn durable success into an apparent rollback or recovery cancellation.
    _entries.value = entries
    _activeStableId.value = activeStableId
    _connectedStableIds.value = connectedStableIds
    if (notifyActive) {
      runCatching { onActiveChanged?.invoke(activeStableId) }
        .onFailure { Log.e("GatewayRegistry", "Active-gateway observer failed after durable commit", it) }
    }
    return true
  }

  private fun encodedRegistry(
    entries: List<GatewayRegistryEntry> = _entries.value,
    activeStableId: String? = _activeStableId.value,
    connectedStableIds: List<String> = _connectedStableIds.value,
  ): String =
    json.encodeToString(
      PersistedGatewayRegistry(
        activeStableId = activeStableId,
        connectedStableIds =
          connectedStableIds
            .distinct()
            .filter { connectedId -> entries.any { it.stableId == connectedId } },
        entries = entries.sortedForStorage(),
      ),
    )

  private data class DecodedRegistry(
    val registry: PersistedGatewayRegistry,
    val canRewrite: Boolean,
  )

  private fun decode(rawValue: String?): DecodedRegistry {
    val raw = rawValue ?: return DecodedRegistry(PersistedGatewayRegistry(), canRewrite = false)
    val version =
      runCatching { json.decodeFromString<PersistedGatewayRegistryVersion>(raw) }
        .getOrNull()
        ?.version
        ?.takeIf { it in 1..2 }
        ?: return DecodedRegistry(PersistedGatewayRegistry(), canRewrite = false)
    val decoded =
      runCatching { json.decodeFromString<PersistedGatewayRegistry>(raw) }.getOrNull()
        ?: return DecodedRegistry(PersistedGatewayRegistry(), canRewrite = false)
    val entries = decoded.entries.sortedForStorage()
    val active = decoded.activeStableId?.takeIf { activeId -> entries.any { it.stableId == activeId } }
    val connected =
      (decoded.connectedStableIds ?: if (version == 1) listOfNotNull(active) else emptyList())
        .distinct()
        .filter { connectedId -> entries.any { it.stableId == connectedId } }
    return DecodedRegistry(
      registry =
        PersistedGatewayRegistry(
          version = 1,
          activeStableId = active,
          connectedStableIds = connected,
          entries = entries,
        ),
      canRewrite = true,
    )
  }
}

internal fun List<GatewayRegistryEntry>.sortedForStorage(): List<GatewayRegistryEntry> = sortedWith(compareBy<GatewayRegistryEntry>({ it.name.lowercase() }, { it.stableId }))
