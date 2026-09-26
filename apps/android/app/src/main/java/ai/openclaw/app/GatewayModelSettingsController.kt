package ai.openclaw.app

import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.chat.toWireJson
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

internal data class GatewayModelDefaults(
  val primary: String = "",
  val fallbacks: List<String> = emptyList(),
  val utilityModel: String? = null,
  val decisionModel: String? = null,
  val thinkingLevel: String? = null,
  val fastMode: ChatFastMode? = null,
)

internal data class GatewayModelSettingsState(
  val defaults: GatewayModelDefaults? = null,
  val nativeAgentFlags: Map<String, Boolean> = emptyMap(),
  val loading: Boolean = false,
  val saving: Boolean = false,
  val errorText: NativeText? = null,
  val warningText: NativeText? = null,
  val noticeText: NativeText? = null,
) {
  val busy: Boolean get() = loading || saving
}

internal class GatewayModelSettingsController(
  private val scope: CoroutineScope,
  private val lease: GatewaySession.RequestLease,
  private val json: Json,
  private val isCurrent: () -> Boolean,
  private val canMutate: () -> Boolean,
  private val onConfigChanged: () -> Unit,
) {
  private val _state = MutableStateFlow(GatewayModelSettingsState())
  val state: StateFlow<GatewayModelSettingsState> = _state.asStateFlow()

  @Volatile private var closed = false

  fun refresh() {
    if (!begin(saving = false)) return
    scope.launch {
      try {
        readConfig()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Exception) {
        publish { it.copy(errorText = errorText(err, nativeText("Could not load model settings. Refresh to try again."))) }
      } finally {
        publish { it.copy(loading = false) }
      }
    }
  }

  fun setPrimaryModel(ref: String) {
    if (ref.isBlank()) return
    mutate(replaceFallbacks = true) { defaults ->
      defaultsPatch("model", modelValue(ref, defaults.fallbacks.filterNot { it == ref }))
    }
  }

  fun setFallbackModel(ref: String?) {
    mutate(replaceFallbacks = true) { defaults ->
      if (defaults.primary.isBlank()) throw SettingsUnavailable(nativeText("Choose a primary model before changing its fallback."))
      val fallbacks = if (ref.isNullOrEmpty()) emptyList() else listOf(ref) + defaults.fallbacks.drop(1).filterNot { it == ref }
      defaultsPatch("model", modelValue(defaults.primary, fallbacks))
    }
  }

  fun setUtilityModel(ref: String?) = mutate { defaultsPatch("utilityModel", ref?.let(::JsonPrimitive) ?: JsonNull) }

  fun setDecisionModel(ref: String?) = mutate { defaultsPatch("decisionModel", ref?.let(::JsonPrimitive) ?: JsonNull) }

  fun setThinkingLevel(level: String?) = mutate { defaultsPatch("thinkingDefault", level?.let(::JsonPrimitive) ?: JsonNull) }

  fun setFastMode(mode: ChatFastMode?) = mutate { defaultsPatch("fastModeDefault", mode?.toWireJson() ?: JsonNull) }

  fun setInstalledAgentEnabled(
    id: String,
    enabled: Boolean,
  ) {
    if (id.isBlank()) return
    mutate {
      buildJsonObject {
        put(
          "plugins",
          buildJsonObject {
            put(
              "entries",
              buildJsonObject {
                put(
                  "acpx",
                  buildJsonObject {
                    put(
                      "config",
                      buildJsonObject {
                        put("nativeAgents", buildJsonObject { put(id, enabled) })
                      },
                    )
                  },
                )
              },
            )
          },
        )
      }
    }
  }

  fun close() {
    closed = true
  }

  private fun mutate(
    replaceFallbacks: Boolean = false,
    patch: (GatewayModelDefaults) -> JsonObject,
  ) {
    if (!canMutate()) {
      publish { it.copy(errorText = nativeText("Administrator access is required to change model settings.")) }
      return
    }
    if (!begin(saving = true)) return
    scope.launch {
      var submitted = false
      var acknowledged = false
      try {
        val before = readConfig()
        val raw = patch(checkNotNull(state.value.defaults))
        val receipt =
          request(
            "config.patch",
            buildJsonObject {
              put("baseHash", before.hash)
              put("raw", raw.toString())
              if (replaceFallbacks) put("replacePaths", JsonArray(listOf(JsonPrimitive("agents.defaults.model.fallbacks"))))
            },
            write = true,
          ) { submitted = true }
        check((receipt["ok"] as? JsonPrimitive)?.booleanOrNull == true) { "The Gateway did not acknowledge the settings change." }
        acknowledged = true
        if ((receipt["noop"] as? JsonPrimitive)?.booleanOrNull == true) {
          adopt(before)
        } else {
          val config = receipt["config"].asObjectOrNull()
          val hash = receipt.nonBlankString("hash")
          if (config != null && hash != null) adopt(ConfigSnapshot(config, hash))
        }
        publish { it.copy(noticeText = nativeText("Model settings saved.")) }
        if (current()) onConfigChanged()
        readConfig()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Exception) {
        if (acknowledged) {
          publish { it.copy(warningText = nativeText("Settings were saved, but could not be refreshed. Refresh to confirm the current configuration.")) }
        } else {
          publish {
            it.copy(errorText = errorText(err, if (submitted) nativeText("The save outcome is unknown. Review the refreshed configuration before trying again.") else nativeText("Could not save model settings. Refresh and try again.")))
          }
          if (submitted && current()) {
            try {
              readConfig()
            } catch (cancelled: CancellationException) {
              throw cancelled
            } catch (_: Exception) {
              publish { it.copy(warningText = nativeText("Could not refresh the configuration. Reconnect and refresh before trying another change.")) }
            }
          }
        }
      } finally {
        publish { it.copy(saving = false) }
      }
    }
  }

  private data class ConfigSnapshot(
    val config: JsonObject,
    val hash: String,
  )

  private class SettingsUnavailable(
    val text: NativeText,
  ) : IllegalStateException()

  private suspend fun readConfig(): ConfigSnapshot {
    val response = request("config.get", JsonObject(emptyMap()))
    if ((response["valid"] as? JsonPrimitive)?.booleanOrNull == false) {
      throw SettingsUnavailable(nativeText("The Gateway configuration is invalid. Repair it before changing model settings."))
    }
    val config = response["sourceConfig"].asObjectOrNull() ?: response["resolved"].asObjectOrNull() ?: response["config"].asObjectOrNull()
    val hash = response.nonBlankString("hash")
    if (config == null || hash == null) {
      throw SettingsUnavailable(nativeText("The Gateway returned no editable configuration revision. Refresh and try again."))
    }
    val snapshot = ConfigSnapshot(config, hash)
    adopt(snapshot)
    response["writeError"].asObjectOrNull().nonBlankString("message")?.let { throw SettingsUnavailable(verbatimText(it)) }
    return snapshot
  }

  private fun adopt(snapshot: ConfigSnapshot) {
    val defaults =
      snapshot.config["agents"]
        .asObjectOrNull()
        ?.get("defaults")
        .asObjectOrNull()
    val model = defaults?.get("model")
    val modelObject = model.asObjectOrNull()
    val flags =
      snapshot.config["plugins"]
        .asObjectOrNull()
        ?.get("entries")
        .asObjectOrNull()
        ?.get("acpx")
        .asObjectOrNull()
        ?.get("config")
        .asObjectOrNull()
        ?.get("nativeAgents")
        .asObjectOrNull()
    publish {
      it.copy(
        defaults =
          GatewayModelDefaults(
            primary = model.asStringOrNull() ?: modelObject?.get("primary").asStringOrNull().orEmpty(),
            fallbacks = (modelObject?.get("fallbacks") as? JsonArray)?.mapNotNull { fallback -> fallback.asStringOrNull() }.orEmpty(),
            utilityModel = defaults?.get("utilityModel").asStringOrNull(),
            decisionModel = defaults?.get("decisionModel").asStringOrNull(),
            thinkingLevel = defaults?.get("thinkingDefault").asStringOrNull(),
            fastMode = ChatFastMode.fromWireValue(defaults?.get("fastModeDefault").asStringOrNull()),
          ),
        nativeAgentFlags = flags?.mapNotNull { (key, value) -> (value as? JsonPrimitive)?.booleanOrNull?.let { enabled -> key to enabled } }?.toMap().orEmpty(),
      )
    }
  }

  private fun begin(saving: Boolean): Boolean {
    var started = false
    lease.commitIfCurrent {
      while (!closed && isCurrent()) {
        val previous = _state.value
        if (previous.busy) break
        if (_state.compareAndSet(previous, previous.copy(loading = !saving, saving = saving, errorText = null, warningText = null, noticeText = null))) {
          started = true
          break
        }
      }
    }
    return started
  }

  private suspend fun request(
    method: String,
    params: JsonObject,
    write: Boolean = false,
    onSubmitted: () -> Unit = {},
  ): JsonObject {
    val response =
      lease.request(method, params.toString(), 30_000) { enqueue ->
        if (!current()) throw GatewayRequestNotEnqueued("Model settings connection changed")
        if (write && !canMutate()) throw GatewayRequestNotEnqueued("Administrator access is required to change model settings.")
        enqueue()
        onSubmitted()
      }
    if (!current()) throw CancellationException("Model settings connection changed")
    return json.parseToJsonElement(response).jsonObject
  }

  private fun current(): Boolean = !closed && isCurrent() && lease.isCurrent()

  private fun publish(update: (GatewayModelSettingsState) -> GatewayModelSettingsState) {
    lease.commitIfCurrent { if (!closed && isCurrent()) _state.update(update) }
  }

  private fun defaultsPatch(
    key: String,
    value: JsonElement,
  ): JsonObject =
    buildJsonObject {
      put("agents", buildJsonObject { put("defaults", buildJsonObject { put(key, value) }) })
    }

  private fun modelValue(
    primary: String,
    fallbacks: List<String>,
  ): JsonElement =
    if (fallbacks.isEmpty()) {
      JsonPrimitive(primary)
    } else {
      buildJsonObject {
        put("primary", primary)
        put("fallbacks", JsonArray(fallbacks.map(::JsonPrimitive)))
      }
    }

  private fun errorText(
    err: Exception,
    fallback: NativeText,
  ): NativeText =
    when (err) {
      is GatewayRequestRejected -> verbatimText(err.gatewayError.message)
      is GatewayRequestNotEnqueued -> verbatimText(err.message.orEmpty())
      is SettingsUnavailable -> err.text
      else -> fallback
    }
}
