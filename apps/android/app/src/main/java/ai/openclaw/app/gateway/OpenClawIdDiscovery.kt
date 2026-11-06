package ai.openclaw.app.gateway

import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class OpenClawIdDiscoveryFailure(
  val status: Int,
  val retryAfterMs: Long = 0,
) : IOException("OpenClaw ID Discovery request failed")

/** The explicit deployment origin is the only HTTP destination, and redirects are never followed. */
internal class OpenClawIdDiscovery {
  private val client =
    OkHttpClient
      .Builder()
      .followRedirects(false)
      .followSslRedirects(false)
      .callTimeout(15, TimeUnit.SECONDS)
      .build()

  suspend fun call(
    origin: String,
    path: String,
    signer: OpenClawIdEnrollmentSigner,
    body: ByteArray? = null,
  ): JsonObject {
    val method = if (body == null) "GET" else "POST"
    val bytes = body ?: byteArrayOf()
    val request =
      Request
        .Builder()
        .url(origin + path)
        .header("OpenClaw-Signature", signer.requestSignature(method, path, bytes, System.currentTimeMillis() / 1_000))
        .method(method, body?.toRequestBody("application/json".toMediaType()))
        .build()
    return suspendCancellableCoroutine { continuation ->
      val call = client.newCall(request)
      continuation.invokeOnCancellation { call.cancel() }
      call.enqueue(
        object : Callback {
          override fun onFailure(
            call: Call,
            e: IOException,
          ) {
            if (continuation.isActive) continuation.resumeWithException(OpenClawIdDiscoveryFailure(0))
          }

          override fun onResponse(
            call: Call,
            response: Response,
          ) {
            try {
              val result =
                response.use {
                  val source = response.body.source()
                  if (source.request(1024L * 1024 + 1)) throw OpenClawIdDiscoveryFailure(response.code)
                  val raw = source.readByteArray()
                  val text =
                    Charsets.UTF_8
                      .newDecoder()
                      .onMalformedInput(CodingErrorAction.REPORT)
                      .decode(ByteBuffer.wrap(raw))
                      .toString()
                  val parsed = OpenClawIdCanonical.json.parseToJsonElement(text) as? JsonObject ?: throw OpenClawIdDiscoveryFailure(response.code)
                  if (!response.isSuccessful) {
                    val error = parsed["error"] as? JsonObject
                    val seconds = (error?.get("retry_after") as? JsonPrimitive)?.longOrNull ?: response.header("Retry-After")?.toLongOrNull() ?: 0
                    throw OpenClawIdDiscoveryFailure(response.code, seconds.coerceIn(0, 3600) * 1000)
                  }
                  parsed
                }
              if (continuation.isActive) continuation.resume(result)
            } catch (error: Exception) {
              if (continuation.isActive) continuation.resumeWithException(if (error is OpenClawIdDiscoveryFailure) error else OpenClawIdDiscoveryFailure(response.code))
            }
          }
        },
      )
    }
  }
}
