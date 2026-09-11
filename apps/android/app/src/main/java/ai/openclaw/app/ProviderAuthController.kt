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
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

internal data class ProviderAuthState(
  val authStatus: JsonObject? = null,
  val wizard: JsonObject? = null,
  val signInActive: Boolean = false,
  val busy: Boolean = false,
  val cancelling: Boolean = false,
  val errorText: NativeText? = null,
  val noticeText: NativeText? = null,
  val apiKeySaveRevision: Long = 0L,
) {
  val apiKeyProviders: List<String>
    get() =
      (authStatus?.get("providerCapabilities") as? JsonArray)
        .orEmpty()
        .map { it.jsonObject }
        .filter { it["apiKeySupported"]?.jsonPrimitive?.booleanOrNull == true && it["quickApiKeySetup"]?.jsonPrimitive?.booleanOrNull == true }
        .map { it.getValue("provider").jsonPrimitive.content }

  val loginOptions: List<JsonObject>
    get() =
      (authStatus?.get("providerCapabilities") as? JsonArray)
        .orEmpty()
        .flatMap { (it.jsonObject["loginOptions"] as? JsonArray).orEmpty() }
        .map { it.jsonObject }
        .distinctBy { it.getValue("id").jsonPrimitive.content }
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

  fun refresh(refresh: Boolean = false) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null) return
    runRequest(null) { readAuthStatus(refresh) }
  }

  fun start(authChoice: String) {
    if (closed || state.value.busy || state.value.cancelling || sessionId != null) return
    if (state.value.loginOptions.none { it.getValue("id").jsonPrimitive.content == authChoice }) return
    val id = UUID.randomUUID().toString()
    sessionId = id
    cancelRequested = false
    publish { it.copy(wizard = null, signInActive = true, noticeText = null) }
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
          publish { it.copy(signInActive = false) }
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
    publish { it.copy(noticeText = null) }
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
            if (result["warning"] != null) nativeText("API key saved. Restart the Gateway to apply it.") else nativeText("API key saved"),
        )
      }
      try {
        readAuthStatus(false)
      } finally {
        if (!closed && isCurrent() && lease.isCurrent()) onAuthChanged()
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
            it.copy(errorText = nativeText("Could not complete the sign-in request. Check the connection and try again."))
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
    sessionId = null
    publish {
      it.copy(
        wizard = result,
        signInActive = false,
        errorText = resultError(result),
        noticeText = if (result["status"]?.jsonPrimitive?.content == "done") null else it.noticeText,
      )
    }
    // Native login already publishes credential changes, including writes before a terminal error.
    try {
      readAuthStatus(false)
    } finally {
      if (!closed && isCurrent() && lease.isCurrent()) onAuthChanged()
    }
  }

  private suspend fun readAuthStatus(refresh: Boolean) {
    val result =
      request(
        GatewayMethod.ModelsAuthStatus.rawValue,
        buildJsonObject {
          put("agentId", agentId)
          if (refresh) put("refresh", true)
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
    // Native auth sessions expire after 25 minutes; leave time for terminal teardown.
    val timeoutMs = if (method == "models.authStatus") 15_000L else 26 * 60_000L
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

  private fun resultError(result: JsonObject): NativeText? = if (result["error"] != null) nativeText("Sign-in could not finish. Review the sign-in step and try again.") else null

  private fun terminalResult(result: JsonObject): JsonObject =
    buildJsonObject {
      put("done", true)
      result.forEach { (key, value) -> put(key, value) }
    }
}
