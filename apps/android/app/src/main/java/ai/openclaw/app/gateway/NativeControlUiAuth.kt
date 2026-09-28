package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The credential actually accepted by the current physical native connection. */
internal sealed interface NativeControlUiCredential {
  data object None : NativeControlUiCredential

  data class Token(
    val value: String,
  ) : NativeControlUiCredential

  data class Password(
    val value: String,
  ) : NativeControlUiCredential

  data class DeviceToken(
    val value: String,
  ) : NativeControlUiCredential
}

/** Encodes one native-owned connect proof; the caller must hold the current operator lease. */
internal fun buildNativeControlUiConnectAuth(
  identityStore: DeviceIdentityStore,
  client: GatewayClientInfo,
  scopes: List<String>,
  credential: NativeControlUiCredential,
  nonce: String,
  signedAt: Long,
): JsonObject {
  require(nonce.isNotBlank() && nonce.length <= 1024 && !nonce.contains('|')) { "Invalid gateway challenge" }
  require(signedAt > 0) { "Invalid gateway challenge time" }
  val identity = identityStore.loadOrCreate()
  val signatureToken =
    when (credential) {
      is NativeControlUiCredential.Token -> credential.value
      is NativeControlUiCredential.DeviceToken -> credential.value
      is NativeControlUiCredential.Password, NativeControlUiCredential.None -> null
    }
  val payload =
    DeviceAuthPayload.buildV3(
      deviceId = identity.deviceId,
      clientId = client.id,
      clientMode = client.mode,
      role = "operator",
      scopes = scopes,
      signedAtMs = signedAt,
      token = signatureToken,
      nonce = nonce,
      platform = client.platform,
      deviceFamily = client.deviceFamily,
    )
  val signature = checkNotNull(identityStore.signPayload(payload, identity)) { "Native device signing unavailable" }
  val publicKey = checkNotNull(identityStore.publicKeyBase64Url(identity)) { "Native device identity unavailable" }
  return buildJsonObject {
    put(
      "client",
      buildJsonObject {
        put("id", client.id)
        put("mode", client.mode)
        put("platform", client.platform)
        put("version", client.version)
        client.deviceFamily?.let { put("deviceFamily", it) }
        client.instanceId?.let { put("instanceId", it) }
        client.displayName?.let { put("displayName", it) }
        client.modelIdentifier?.let { put("modelIdentifier", it) }
      },
    )
    put("scopes", JsonArray(scopes.map(::JsonPrimitive)))
    put(
      "auth",
      buildJsonObject {
        when (credential) {
          is NativeControlUiCredential.Token -> put("token", credential.value)
          is NativeControlUiCredential.Password -> put("password", credential.value)
          is NativeControlUiCredential.DeviceToken -> put("deviceToken", credential.value)
          NativeControlUiCredential.None -> Unit
        }
      },
    )
    put(
      "device",
      buildJsonObject {
        put("id", identity.deviceId)
        put("publicKey", publicKey)
        put("signature", signature)
        put("signedAt", signedAt)
        put("nonce", nonce)
      },
    )
  }
}
