package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayMethod
import ai.openclaw.app.gateway.GatewayRequestDefinitiveFailure
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import android.util.Log
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

internal enum class ProviderAuthLoginKind {
  OAuth,
  DeviceCode,
  Secret,
}

internal data class ProviderAuthLoginOption(
  val id: String,
  val label: String,
  val hint: String?,
  val kind: ProviderAuthLoginKind,
  val featured: Boolean,
  val groupId: String,
  val groupLabel: String,
)

internal data class ProviderAuthSetupOption(
  val id: String,
  val label: String,
  val hint: String?,
  val groupId: String,
  val groupLabel: String,
)

internal data class ProviderAuthProvider(
  val id: String,
  val displayName: String,
  val loginOptions: List<ProviderAuthLoginOption>,
  val apiKeySupported: Boolean,
  val ready: Boolean,
  val setupOptions: List<ProviderAuthSetupOption> = emptyList(),
) {
  val canSignIn: Boolean
    get() = apiKeySupported || loginOptions.isNotEmpty()
}

internal data class ProviderAuthGroup(
  val id: String,
  val displayName: String,
  val providers: List<ProviderAuthProvider>,
)

internal data class ProviderConnectionProbeTarget(
  val label: String,
  val status: String,
  val profileId: String? = null,
  val latencyMs: Long? = null,
  val error: String? = null,
)

internal data class ProviderConnectionProbe(
  val provider: String,
  val status: String,
  val latencyMs: Long?,
  val error: String?,
  val results: List<ProviderConnectionProbeTarget>,
)

internal data class ProviderAuthState(
  val authStatus: JsonObject? = null,
  val wizard: JsonObject? = null,
  val signInActive: Boolean = false,
  val activeLoginKind: ProviderAuthLoginKind? = null,
  val busy: Boolean = false,
  val cancelling: Boolean = false,
  val errorText: NativeText? = null,
  val noticeText: NativeText? = null,
  val apiKeySaveRevision: Long = 0L,
  val connectedProviderId: String? = null,
  val actionProviderId: String? = null,
  val probeResult: ProviderConnectionProbe? = null,
  val warningText: String? = null,
) {
  val providers: List<ProviderAuthProvider>
    get() {
      if (authStatus?.get("unavailable") != null) return emptyList()
      val statuses = (authStatus?.get("providers") as? JsonArray).orEmpty().map { it.jsonObject }
      val capabilities =
        (authStatus?.get("providerCapabilities") as? JsonArray)
          .orEmpty()
          .map { it.jsonObject }
          .associateBy { it.getValue("provider").jsonPrimitive.content }
      val providerIds = capabilities.keys + statuses.map { (it["authProvider"] ?: it.getValue("provider")).jsonPrimitive.content }
      return providerIds
        .map { id ->
          val capability = capabilities[id]
          val status =
            statuses.firstOrNull { it["provider"]?.jsonPrimitive?.content == id }
              ?: statuses.firstOrNull { it["authProvider"]?.jsonPrimitive?.content == id }
          val rawOptions = (capability?.get("loginOptions") as? JsonArray).orEmpty().map { it.jsonObject }
          val displayName =
            status
              ?.get("displayName")
              ?.jsonPrimitive
              ?.content
              ?.takeUnless { it == id }
              ?: rawOptions.firstNotNullOfOrNull { it["groupLabel"]?.jsonPrimitive?.content }
              ?: providerDisplayName(id)
          ProviderAuthProvider(
            id = id,
            displayName = displayName,
            loginOptions =
              rawOptions
                .mapNotNull { option ->
                  val kind =
                    when (option["kind"]?.jsonPrimitive?.content) {
                      "oauth" -> ProviderAuthLoginKind.OAuth
                      "device-code" -> ProviderAuthLoginKind.DeviceCode
                      "secret" -> ProviderAuthLoginKind.Secret
                      else -> return@mapNotNull null
                    }
                  ProviderAuthLoginOption(
                    id = option.getValue("id").jsonPrimitive.content,
                    label = option.getValue("label").jsonPrimitive.content,
                    hint = option["hint"]?.jsonPrimitive?.content,
                    kind = kind,
                    featured = option["featured"]?.jsonPrimitive?.booleanOrNull == true,
                    groupId = option["groupId"]?.jsonPrimitive?.content ?: id,
                    groupLabel = option["groupLabel"]?.jsonPrimitive?.content ?: displayName,
                  )
                }.distinctBy { it.id },
            apiKeySupported =
              capability?.get("apiKeySupported")?.jsonPrimitive?.booleanOrNull == true &&
                capability["quickApiKeySetup"]?.jsonPrimitive?.booleanOrNull == true,
            ready = status?.get("status")?.jsonPrimitive?.content in setOf("ok", "static", "expiring"),
            setupOptions =
              (capability?.get("setupOptions") as? JsonArray).orEmpty().map { entry ->
                val option = entry.jsonObject
                ProviderAuthSetupOption(
                  id = option.getValue("id").jsonPrimitive.content,
                  label = option.getValue("label").jsonPrimitive.content,
                  hint = option["hint"]?.jsonPrimitive?.content,
                  groupId = option["groupId"]?.jsonPrimitive?.content ?: id,
                  groupLabel = option["groupLabel"]?.jsonPrimitive?.content ?: displayName,
                )
              },
          )
        }.sortedBy { it.displayName.lowercase() }
    }

  val apiKeyProviders: List<String>
    get() = providers.filter { it.apiKeySupported }.map { it.id }

  val providerGroups: List<ProviderAuthGroup>
    get() =
      providers
        .flatMap { provider ->
          val groups =
            (provider.loginOptions.map { it.groupId to it.groupLabel } + provider.setupOptions.map { it.groupId to it.groupLabel })
              .distinctBy { it.first }
              .ifEmpty { listOf(provider.id to provider.displayName) }
          groups.map { (id, label) ->
            Triple(
              id,
              label,
              provider.copy(
                loginOptions = provider.loginOptions.filter { it.groupId == id },
                setupOptions = provider.setupOptions.filter { it.groupId == id },
              ),
            )
          }
        }.groupBy { it.first }
        .map { (id, entries) ->
          ProviderAuthGroup(id, entries.first().second, entries.map { it.third })
        }.sortedBy { it.displayName.lowercase() }
}

/** One agent on one physical connection. Replace and close this owner when either changes. */
internal class ProviderAuthController(
  private val scope: CoroutineScope,
  private val lease: GatewaySession.RequestLease,
  private val agentId: String,
  private val json: Json,
  private val isCurrent: () -> Boolean = { true },
  private val onAuthChanged: suspend () -> Unit,
) {
  private val _state = MutableStateFlow(ProviderAuthState())
  val state: StateFlow<ProviderAuthState> = _state.asStateFlow()

  @Volatile private var closed = false

  @Volatile private var sessionId: String? = null

  @Volatile private var cancelRequested = false

  @Volatile private var signInProviderId: String? = null

  fun refresh(refresh: Boolean = false) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null) return
    runRequest(null) {
      if (!refresh) {
        readAuthStatus()
        return@runRequest
      }
      request(
        GatewayMethod.ModelsAuthRefresh.rawValue,
        buildJsonObject {
          put("agentId", agentId)
          put("operation", "update")
        },
      )
      publish { it.copy(noticeText = nativeText("Sign-ins refreshed.")) }
      refreshPublishedAuthStatus()
    }
  }

  fun start(authChoice: String) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null) return
    val provider = state.value.providers.firstOrNull { it.loginOptions.any { option -> option.id == authChoice } } ?: return
    val option = provider.loginOptions.first { it.id == authChoice }
    val id = UUID.randomUUID().toString()
    sessionId = id
    signInProviderId = provider.id
    cancelRequested = false
    publish { it.copy(wizard = null, signInActive = true, activeLoginKind = option.kind, noticeText = null, connectedProviderId = null) }
    runRequest(id) {
      val started =
        try {
          request(
            GatewayMethod.ModelsAuthLogin.rawValue,
            buildJsonObject {
              put("sessionId", id)
              put("agentId", agentId)
              put("authChoice", authChoice)
            },
          )
        } catch (err: GatewayRequestDefinitiveFailure) {
          if (sessionId == id) sessionId = null
          publish { it.copy(signInActive = false, activeLoginKind = null) }
          throw err
        }
      if (closed) {
        closeWizard(id)
      } else if (sessionId == id && cancelRequested) {
        val result = closeWizard(id)
        if (result != null) finish(id, terminalResult(result))
      } else if (sessionId == id) {
        advance(id, started)
      }
    }
  }

  fun setApiKey(
    provider: String,
    apiKey: String,
  ) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null || provider !in state.value.apiKeyProviders) return
    if (apiKey.isBlank()) {
      publish { it.copy(errorText = nativeText("Enter an API key.")) }
      return
    }
    publish { it.copy(noticeText = null, connectedProviderId = null) }
    runRequest(null) {
      val result =
        request(
          GatewayMethod.ModelsAuthSetApiKey.rawValue,
          buildJsonObject {
            put("provider", provider)
            put("apiKey", apiKey)
            put("agentId", agentId)
          },
        )
      publish {
        it.copy(
          wizard = null,
          apiKeySaveRevision = it.apiKeySaveRevision + 1,
          noticeText =
            if (result["warning"] != null) nativeText("API key saved. Tap Refresh in this dialog to apply it.") else nativeText("API key saved"),
        )
      }
      refreshPublishedAuthStatus()
      if (result["warning"] == null) publishConnectedProvider(provider)
    }
  }

  fun probe(provider: String) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null || provider.isBlank()) return
    publish { it.copy(actionProviderId = provider, probeResult = null, noticeText = null, warningText = null) }
    runRequest(null, nativeText("Could not test the connection. Check the Gateway connection and try again.")) {
      val result =
        request(
          GatewayMethod.ModelsProbe.rawValue,
          buildJsonObject {
            put("provider", provider)
            put("agentId", agentId)
          },
        )
      val probe =
        ProviderConnectionProbe(
          provider = result.getValue("provider").jsonPrimitive.content,
          status = result.getValue("status").jsonPrimitive.content,
          latencyMs = result["latencyMs"]?.jsonPrimitive?.longOrNull,
          error = result["error"]?.jsonPrimitive?.content,
          results =
            result.getValue("results").jsonArray.map { item ->
              val target = item.jsonObject
              ProviderConnectionProbeTarget(
                label = target.getValue("label").jsonPrimitive.content,
                status = target.getValue("status").jsonPrimitive.content,
                profileId = target["profileId"]?.jsonPrimitive?.content,
                latencyMs = target["latencyMs"]?.jsonPrimitive?.longOrNull,
                error = target["error"]?.jsonPrimitive?.content,
              )
            },
        )
      publish { it.copy(probeResult = probe) }
    }
  }

  fun removeApiKey(provider: String) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null || provider.isBlank()) return
    publish { it.copy(actionProviderId = provider, probeResult = null, noticeText = null, warningText = null) }
    runRequest(null, nativeText("Could not remove the API key. Refresh to check its status before trying again.")) {
      val result =
        request(
          GatewayMethod.ModelsAuthLogout.rawValue,
          buildJsonObject {
            put("provider", provider)
            put("agentId", agentId)
            put("credentialType", "api_key")
          },
        )
      publish { it.copy(noticeText = nativeText("API key removed."), warningText = result["warning"]?.jsonPrimitive?.content) }
      try {
        refreshPublishedAuthStatus()
      } catch (err: CancellationException) {
        throw err
      } catch (_: Exception) {
        publish { it.copy(errorText = nativeText("API key removed, but provider status could not refresh. Tap Refresh to check it.")) }
      }
    }
  }

  fun answer(value: JsonElement? = null) {
    val id = sessionId ?: return
    if (closed || state.value.busy || state.value.cancelling) return
    val step =
      state.value.wizard
        ?.get("step")
        ?.jsonObject ?: return
    runRequest(id) {
      advance(
        id,
        next(
          id,
          buildJsonObject {
            put("stepId", step.getValue("id"))
            value?.let { put("value", it) }
          },
        ),
      )
    }
  }

  fun cancel() {
    val id = sessionId ?: return
    if (closed || state.value.cancelling) return
    cancelRequested = true
    publish { it.copy(cancelling = true) }
    scope.launch {
      try {
        // Closing input waits for protected credential writes to settle before acknowledging cancellation.
        val result = closeWizard(id)
        if (sessionId == id && result != null) {
          finish(id, terminalResult(result))
        } else if (sessionId == id && !state.value.busy) {
          sessionId = null
          publish { it.copy(signInActive = false, errorText = nativeText("This sign-in session has ended. Refresh and start again.")) }
        }
      } catch (err: CancellationException) {
        throw err
      } catch (_: Exception) {
        publish { it.copy(errorText = nativeText("Could not cancel sign-in. Check the connection and try again.")) }
      } finally {
        publish { it.copy(cancelling = false) }
      }
    }
  }

  fun close() {
    if (closed) return
    closed = true
    val id = sessionId ?: return
    scope.launch {
      try {
        closeWizard(id)
      } catch (err: CancellationException) {
        throw err
      } catch (_: Exception) {
        Log.w("ProviderAuth", "Could not close provider sign-in; connection teardown also closes the session.")
      }
    }
  }

  private fun runRequest(
    id: String?,
    failureText: NativeText = nativeText("Could not complete the sign-in request. Check the connection and try again."),
    block: suspend () -> Unit,
  ) {
    publish { it.copy(busy = true, errorText = null) }
    scope.launch {
      try {
        block()
      } catch (err: CancellationException) {
        throw err
      } catch (err: Exception) {
        if (err is GatewayRequestRejected && err.gatewayError.details?.code == "WIZARD_NOT_FOUND" && sessionId != id) return@launch
        if (sessionId == id || sessionId == null) {
          publish {
            it.copy(errorText = failureText)
          }
        }
      } finally {
        if (sessionId == id || sessionId == null) publish { it.copy(busy = false) }
      }
    }
  }

  private suspend fun advance(
    id: String,
    first: JsonObject,
  ) {
    var result = first
    while (!closed && sessionId == id && lease.isCurrent()) {
      if (result.getValue("done").jsonPrimitive.boolean) {
        finish(id, result)
        return
      }
      publish { it.copy(wizard = result, errorText = resultError(result)) }
      val step = result["step"]?.jsonObject
      if (step != null && step["executor"]?.jsonPrimitive?.content != "gateway") return
      // Only the server's gateway-executed progress advances without an answer.
      result = next(id)
    }
  }

  private suspend fun finish(
    id: String,
    result: JsonObject,
  ) {
    if (closed || sessionId != id) return
    val provider = signInProviderId
    sessionId = null
    signInProviderId = null
    publish {
      it.copy(
        wizard = result,
        signInActive = false,
        activeLoginKind = null,
        errorText = resultError(result),
        noticeText = if (result["status"]?.jsonPrimitive?.content == "done") null else it.noticeText,
      )
    }
    // Native login already publishes credential changes, including writes before a terminal error.
    refreshPublishedAuthStatus()
    if (!cancelRequested && result["status"]?.jsonPrimitive?.content == "done" && result["error"] == null && provider != null) {
      publishConnectedProvider(provider)
    }
  }

  private fun publishConnectedProvider(provider: String) {
    publish { current ->
      if (current.providers.any { it.id == provider && it.ready }) {
        current.copy(connectedProviderId = provider)
      } else if (current.errorText == null) {
        current.copy(noticeText = nativeText("Sign-in saved. Refresh to check the connection."))
      } else {
        current
      }
    }
  }

  private suspend fun refreshPublishedAuthStatus() {
    try {
      readAuthStatus()
    } finally {
      if (!closed && isCurrent() && lease.isCurrent()) onAuthChanged()
    }
  }

  private suspend fun readAuthStatus() {
    val result =
      request(
        GatewayMethod.ModelsAuthStatus.rawValue,
        buildJsonObject {
          put("agentId", agentId)
        },
      )
    publish {
      it.copy(
        authStatus = result,
        errorText =
          if (result["unavailable"] != null) nativeText("Sign-in status is unavailable. Refresh after setup finishes.") else it.errorText,
      )
    }
  }

  private suspend fun next(
    id: String,
    answer: JsonObject? = null,
  ): JsonObject =
    request(
      GatewayMethod.WizardNext.rawValue,
      buildJsonObject {
        put("sessionId", id)
        answer?.let { put("answer", it) }
      },
    )

  private suspend fun closeWizard(id: String): JsonObject? =
    try {
      request(
        GatewayMethod.WizardCancel.rawValue,
        buildJsonObject {
          put("sessionId", id)
          put("closeInput", true)
        },
        cleanup = true,
      )
    } catch (err: GatewayRequestRejected) {
      if (err.gatewayError.details?.code != "WIZARD_NOT_FOUND") throw err
      null
    }

  private suspend fun request(
    method: String,
    params: JsonObject,
    cleanup: Boolean = false,
  ): JsonObject {
    val timeoutMs =
      when (method) {
        GatewayMethod.ModelsAuthStatus.rawValue -> 15_000L

        // Match the shared browser client's non-streaming deadline; expiry never cancels a server-side write.
        GatewayMethod.ModelsProbe.rawValue, GatewayMethod.ModelsAuthLogout.rawValue -> 30_000L

        // Native auth sessions expire after 25 minutes; leave time for terminal teardown.
        else -> 26 * 60_000L
      }
    val response =
      lease.request(method, params.toString(), timeoutMs) { enqueue ->
        if ((!cleanup && (closed || !isCurrent())) || !lease.isCurrent()) throw GatewayRequestNotEnqueued("Provider sign-in scope changed")
        enqueue()
      }
    return json.parseToJsonElement(response).jsonObject
  }

  private fun publish(update: (ProviderAuthState) -> ProviderAuthState) {
    lease.commitIfCurrent { if (!closed && isCurrent()) _state.update(update) }
  }

  private fun resultError(result: JsonObject): NativeText? =
    if (result["error"] != null && result["status"]?.jsonPrimitive?.content != "cancelled") {
      nativeText("Sign-in could not finish. Review the sign-in step and try again.")
    } else {
      null
    }

  private fun terminalResult(result: JsonObject): JsonObject =
    buildJsonObject {
      put("done", true)
      result.forEach { (key, value) -> put(key, value) }
    }
}
