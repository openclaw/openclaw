package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The credential actually accepted by the current physical native connection. */
internal sealed interface NativeControlUiCredential {
  val value: String

  data class Token(
    override val value: String,
  ) : NativeControlUiCredential

  data class Password(
    override val value: String,
  ) : NativeControlUiCredential

  data class DeviceToken(
    override val value: String,
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
  val payload =
    DeviceAuthPayload.buildV3(
      deviceId = identity.deviceId,
      clientId = client.id,
      clientMode = client.mode,
      role = "operator",
      scopes = scopes,
      signedAtMs = signedAt,
      token = if (credential is NativeControlUiCredential.Password) null else credential.value,
      nonce = nonce,
      platform = client.platform,
      deviceFamily = client.deviceFamily,
    )
  val signature = checkNotNull(identityStore.signPayload(payload, identity)) { "Native device signing unavailable" }
  val publicKey = checkNotNull(identityStore.publicKeyBase64Url(identity)) { "Native device identity unavailable" }
  return buildJsonObject {
    put("client", client.toJsonObject())
    put("scopes", JsonArray(scopes.map(::JsonPrimitive)))
    put(
      "auth",
      buildJsonObject {
        val field =
          when (credential) {
            is NativeControlUiCredential.Token -> "token"
            is NativeControlUiCredential.Password -> "password"
            is NativeControlUiCredential.DeviceToken -> "deviceToken"
          }
        put(field, credential.value)
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
