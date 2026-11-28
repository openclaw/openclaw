package ai.openclaw.app.gateway

import com.sun.jna.Library
import com.sun.jna.Native
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.util.Base64

internal interface CloudflareSodiumLibrary : Library {
  fun sodium_init(): Int

  fun sodium_version_string(): String

  fun crypto_box_keypair(
    publicKey: ByteArray,
    secretKey: ByteArray,
  ): Int

  fun crypto_box_open_easy(
    message: ByteArray,
    ciphertext: ByteArray,
    length: Long,
    nonce: ByteArray,
    peer: ByteArray,
    secret: ByteArray,
  ): Int
}

/** The binding calls libsodium's high-level NaCl box API; no mobile-specific crypto implementation. */
internal object CloudflareAccessBox {
  private val library: CloudflareSodiumLibrary by lazy {
    Native.load("sodium", CloudflareSodiumLibrary::class.java).also {
      if (it.sodium_init() < 0) throw CloudflareAccessException(CloudflareAccessException.Kind.LoginFailed)
    }
  }

  fun version(): String = library.sodium_version_string()

  suspend fun <T> withEphemeralKey(block: suspend (publicKey: String, secretKey: ByteArray) -> T): T {
    val publicKey = ByteArray(32)
    val secretKey = ByteArray(32)
    try {
      if (library.crypto_box_keypair(publicKey, secretKey) != 0) invalid()
      return block(Base64.getUrlEncoder().encodeToString(publicKey), secretKey)
    } catch (_: LinkageError) {
      throw CloudflareAccessException(CloudflareAccessException.Kind.LoginFailed)
    } finally {
      secretKey.fill(0)
    }
  }

  fun appToken(
    body: ByteArray,
    peerHeader: String,
    secretKey: ByteArray,
  ): String {
    if (body.size > CloudflareAccessClient.maximumResponseBytes || peerHeader.length != 44 || secretKey.size != 32) invalid()
    val encoded = body.decodeToString(throwOnInvalidSequence = true)
    val envelope = decode(encoded, url = false)
    val peer = decode(peerHeader, url = true)
    if (envelope.size < 40 || peer.size != 32) invalid()
    val nonce = envelope.copyOfRange(0, 24)
    val ciphertext = envelope.copyOfRange(24, envelope.size)
    val message = ByteArray(ciphertext.size - 16)
    try {
      if (library.crypto_box_open_easy(message, ciphertext, ciphertext.size.toLong(), nonce, peer, secretKey) != 0) invalid()
      val token =
        (Json.parseToJsonElement(message.decodeToString(throwOnInvalidSequence = true)).jsonObject["app_token"] as? JsonPrimitive)
          ?.takeIf(JsonPrimitive::isString)
          ?.content
      return token?.takeIf { it.isNotEmpty() && it.length <= 32768 } ?: invalid()
    } catch (_: LinkageError) {
      throw CloudflareAccessException(CloudflareAccessException.Kind.LoginFailed)
    } catch (_: IllegalArgumentException) {
      invalid()
    } finally {
      message.fill(0)
    }
  }

  private fun decode(
    value: String,
    url: Boolean,
  ): ByteArray {
    try {
      val bytes = (if (url) Base64.getUrlDecoder() else Base64.getDecoder()).decode(value)
      if ((if (url) Base64.getUrlEncoder() else Base64.getEncoder()).encodeToString(bytes) != value) invalid()
      return bytes
    } catch (_: IllegalArgumentException) {
      invalid()
    }
  }

  private fun invalid(): Nothing = throw CloudflareAccessException(CloudflareAccessException.Kind.LoginFailed)
}

internal class CloudflareAccessTransfer(
  private val request: suspend (Request, Int, Long) -> CloudflareAccessClient.Reply = CloudflareAccessClient::send,
) {
  suspend fun signIn(
    application: CloudflareAccessApplication,
    openBrowser: suspend (String) -> Unit,
  ): CloudflareAccessSession =
    withTimeoutOrNull(300_000) {
      CloudflareAccessBox.withEphemeralKey { publicKey, secretKey ->
        openBrowser(browserUrl(application, publicKey))
        val url = "https://login.cloudflareaccess.org/transfer/".toHttpUrl().newBuilder().addPathSegment(publicKey).build()
        repeat(10) {
          kotlin.coroutines.coroutineContext.ensureActive()
          val response =
            request(
              Request
                .Builder()
                .url(url)
                .header("User-Agent", CloudflareAccessClient.userAgent)
                .build(),
              CloudflareAccessClient.maximumResponseBytes,
              60,
            )
          if (response.code in 300..399 || response.code >= 500) throw CloudflareAccessException(CloudflareAccessException.Kind.LoginFailed)
          if (response.code == 200 && response.body.isNotEmpty()) {
            val peer = response.headers["service-public-key"] ?: throw CloudflareAccessException(CloudflareAccessException.Kind.LoginFailed)
            val token = CloudflareAccessBox.appToken(response.body, peer, secretKey)
            return@withEphemeralKey CloudflareAccessClient(request).verifiedSession(token, application)
          }
          delay(1000)
        }
        throw CloudflareAccessException(CloudflareAccessException.Kind.TimedOut)
      }
    } ?: throw CloudflareAccessException(CloudflareAccessException.Kind.TimedOut)

  companion object {
    fun browserUrl(
      application: CloudflareAccessApplication,
      publicKey: String,
    ): String {
      val redirect =
        application.origin.uri
          .toString()
          .toHttpUrl()
          .newBuilder()
          .addQueryParameter("token", publicKey)
          .addQueryParameter("aud", application.audience)
          .build()
      return redirect
        .newBuilder()
        .encodedPath("/cdn-cgi/access/cli")
        .addQueryParameter("redirect_url", redirect.toString())
        .addQueryParameter("send_org_token", "true")
        .addQueryParameter("edge_token_transfer", "true")
        .addQueryParameter("close_interstitial", "true")
        .build()
        .toString()
    }
  }
}
