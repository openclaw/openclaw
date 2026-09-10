package ai.openclaw.wear

import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.GatewayBootstrapHandoff
import ai.openclaw.app.gateway.GatewayCredentialStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayRegistryStore
import ai.openclaw.app.ui.decodeGatewaySetupCode
import ai.openclaw.app.ui.parseGatewayEndpoint
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

internal data class WearGatewaySetup(
  val endpoint: GatewayEndpoint,
  val bootstrapToken: String,
)

internal fun parseWearGatewaySetup(raw: String): WearGatewaySetup {
  require(raw.length <= 16_384) { "Setup code is too large." }
  val code = requireNotNull(decodeGatewaySetupCode(raw)) { "Enter a limited Gateway setup code." }
  require(code.token == null && code.password == null && !code.bootstrapToken.isNullOrBlank()) {
    "Use a limited setup code, not a phone token or password."
  }
  val bootstrapToken = requireNotNull(code.bootstrapToken)
  val endpoint = requireNotNull(parseGatewayEndpoint(code.url)) { "The setup code has an invalid or insecure Gateway URL." }
  return WearGatewaySetup(
    GatewayEndpoint.manual(endpoint.host, endpoint.port, endpoint.tls, endpoint.contextPath),
    bootstrapToken,
  )
}

/** Same encrypted formats as Android, owned exclusively by this watch's application sandbox. */
@Suppress("DEPRECATION")
internal class WearGatewayStore(
  private val prefs: SharedPreferences,
) : GatewayCredentialStore {
  private val lock = Any()
  private val revisions = mutableMapOf<String, Long>()
  val registry = GatewayRegistryStore(this)

  override fun getString(key: String): String? = synchronized(lock) { prefs.getString(key, null) }

  override fun putString(
    key: String,
    value: String,
  ) {
    synchronized(lock) { prefs.edit { putString(key, value) } }
  }

  override fun putStringSynchronously(
    key: String,
    value: String,
  ): Boolean = commitSecureStrings(mapOf(key to value))

  override fun remove(key: String) {
    check(commitSecureStrings(mapOf(key to null))) { "Could not remove watch credentials." }
  }

  // A failed SharedPreferences commit may already have changed its memory cache.
  // Restore that cache so failed bootstrap retirement cannot become reconnect authority.
  @Suppress("UseKtx")
  override fun commitSecureStrings(values: Map<String, String?>): Boolean =
    synchronized(lock) {
      val previous = values.keys.associateWith { prefs.getString(it, null) }

      fun editor(entries: Map<String, String?>): SharedPreferences.Editor =
        prefs.edit().also { edit ->
          entries.forEach { (key, value) -> if (value == null) edit.remove(key) else edit.putString(key, value) }
        }
      val committed = runCatching { editor(values).commit() }.getOrDefault(false)
      if (!committed) {
        editor(previous).apply()
      } else {
        // Advance handoff fences before releasing the credential lock or publishing registry state.
        values.keys.filter { it.startsWith("gateway.credentials.") }.forEach { key ->
          revisions[key] = (revisions[key] ?: 0L) + 1L
        }
      }
      committed
    }

  fun bootstrap(stableId: String): String? {
    val raw = getString("gateway.credentials.$stableId") ?: return null
    val value = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
    return (value?.get("bootstrapToken") as? JsonPrimitive)?.contentOrNull
  }

  fun replace(
    setup: WearGatewaySetup,
    deviceId: String,
  ) {
    val id = setup.endpoint.stableId
    check(
      registry.upsertAndSetActive(
        setup.endpoint.registryEntry(),
        DeviceAuthStore.removalEdits(id, deviceId, listOf("node", "operator")) +
          ("gateway.credentials.$id" to credentials(setup.bootstrapToken)),
      ),
    ) {
      "Could not save watch credentials and Gateway selection."
    }
  }

  fun handoff(
    stableId: String,
    token: String,
  ): GatewayBootstrapHandoff =
    synchronized(lock) {
      val key = "gateway.credentials.$stableId"
      val revision = revisions[key]
      GatewayBootstrapHandoff(allowStoredTokenRecovery = false) {
        synchronized(lock) {
          revisions[key] == revision &&
            bootstrap(stableId) == token &&
            commitSecureStrings(mapOf(key to credentials(null)))
        }
      }
    }

  fun forget(
    stableId: String,
    deviceId: String,
  ) {
    val id = stableId.trim()
    check(
      registry.remove(
        id,
        DeviceAuthStore.removalEdits(id, deviceId, listOf("node", "operator")) +
          mapOf("gateway.credentials.$id" to null, "gateway.tls.$id" to null),
      ),
    ) {
      "Could not remove the saved Gateway. Try Forget again."
    }
  }

  private fun credentials(token: String?): String =
    buildJsonObject {
      if (token != null) put("bootstrapToken", token)
    }.toString()

  companion object {
    fun create(context: Context): WearGatewayStore {
      val key = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
      return WearGatewayStore(
        EncryptedSharedPreferences.create(
          context,
          "openclaw.node.secure",
          key,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ),
      )
    }
  }
}

internal fun GatewayRegistryEntry.endpoint(): GatewayEndpoint = GatewayEndpoint.manual(requireNotNull(host), requireNotNull(port), tls, contextPath)

private fun GatewayEndpoint.registryEntry(): GatewayRegistryEntry = GatewayRegistryEntry(stableId, GatewayRegistryEntryKind.MANUAL, name, host, port, tlsEnabled, contextPath = contextPath)
