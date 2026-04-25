package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

private const val DEFAULT_TIMEOUT_MS = 30_000
private const val MAX_BODY_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB cap

internal data class HttpRequest(
  val url: String,
  val method: String = "GET",
  val headers: Map<String, String> = emptyMap(),
  val body: String? = null,
  val timeoutMs: Int = DEFAULT_TIMEOUT_MS,
)

class HttpHandler(
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val urlFactory: (String) -> URL = ::URL,
) {
  fun handleHttpRequest(paramsJson: String?): GatewaySession.InvokeResult {
    val request =
      parseHttpRequest(paramsJson)
        ?: return GatewaySession.InvokeResult.error(
          code = "INVALID_REQUEST",
          message = "INVALID_REQUEST: expected JSON object with url (string)",
        )

    val validated = validateUrl(request.url)
      ?: return GatewaySession.InvokeResult.error(
        code = "INVALID_REQUEST",
        message = "INVALID_REQUEST: url must be a valid http or https URL",
      )

    return executeHttpRequest(validated, request)
  }

  private fun validateUrl(url: String): URL? {
    return try {
      val parsed = urlFactory(url)
      if (parsed.protocol !in listOf("http", "https")) return null
      parsed
    } catch (_: Throwable) {
      null
    }
  }

  private fun executeHttpRequest(url: URL, request: HttpRequest): GatewaySession.InvokeResult {
    val connection = try {
      url.openConnection() as HttpURLConnection
    } catch (err: Throwable) {
      return GatewaySession.InvokeResult.error(
        code = "CONNECTION_ERROR",
        message = "CONNECTION_ERROR: ${err.message ?: "failed to open connection"}",
      )
    }

    return try {
      connection.requestMethod = request.method.uppercase()
      connection.connectTimeout = request.timeoutMs
      connection.readTimeout = request.timeoutMs
      connection.instanceFollowRedirects = true
      connection.doInput = true

      // Set headers
      for ((key, value) in request.headers) {
        connection.setRequestProperty(key, value)
      }

      // Default Content-Type if not set and body is present
      if (request.body != null && request.headers.keys.none { it.equals("Content-Type", ignoreCase = true) }) {
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
      }

      // Write body if present
      if (request.body != null && request.method in listOf("POST", "PUT", "PATCH", "DELETE")) {
        connection.doOutput = true
        connection.outputStream.use { stream ->
          val bytes = request.body.toByteArray(Charsets.UTF_8)
          stream.write(bytes)
        }
      }

      val responseCode = connection.responseCode
      val responseMessage = connection.responseMessage ?: ""

      // Read response headers
      val responseHeaders = buildJsonObject {
        connection.headerFields.forEach { (key, values) ->
          if (key != null) {
            put(key, values.joinToString(", "))
          }
        }
      }

      // Read response body (truncated to MAX_BODY_SIZE_BYTES)
      // Throws on stream errors — outer catch handles them as REQUEST_FAILED
      val responseBody = readResponseBody(connection, responseCode)

      val result = buildJsonObject {
        put("ok", responseCode in 200..299)
        put("status", responseCode)
        put("statusText", responseMessage)
        put("headers", responseHeaders)
        if (responseBody != null) {
          put("body", responseBody)
        }
      }

      GatewaySession.InvokeResult.ok(result.toString())
    } catch (err: java.net.UnknownHostException) {
      GatewaySession.InvokeResult.error(
        code = "DNS_ERROR",
        message = "DNS_ERROR: unknown host — ${url.host}",
      )
    } catch (err: java.net.SocketTimeoutException) {
      GatewaySession.InvokeResult.error(
        code = "TIMEOUT",
        message = "TIMEOUT: request timed out after ${request.timeoutMs}ms",
      )
    } catch (err: java.net.ProtocolException) {
      GatewaySession.InvokeResult.error(
        code = "PROTOCOL_ERROR",
        message = "PROTOCOL_ERROR: ${err.message}",
      )
    } catch (err: Throwable) {
      GatewaySession.InvokeResult.error(
        code = "REQUEST_FAILED",
        message = "REQUEST_FAILED: ${err.message ?: "unknown error"}",
      )
    } finally {
      connection.disconnect()
    }
  }

  /**
   * Reads the response body up to MAX_BODY_SIZE_BYTES.
   * @throws IOException on stream read failures — caught by outer handler as REQUEST_FAILED.
   */
  @Throws(java.io.IOException::class)
  private fun readResponseBody(connection: HttpURLConnection, responseCode: Int): String? {
    val inputStream = if (responseCode >= 400) connection.errorStream else connection.inputStream
    if (inputStream == null) return null
    return inputStream.use { stream ->
      val buffer = ByteArray(MAX_BODY_SIZE_BYTES)
      var offset = 0
      while (offset < MAX_BODY_SIZE_BYTES) {
        val n = stream.read(buffer, offset, MAX_BODY_SIZE_BYTES - offset)
        if (n == -1) break
        offset += n
      }
      if (offset > 0) String(buffer, 0, offset, Charsets.UTF_8) else null
    }
  }

  private fun parseHttpRequest(paramsJson: String?): HttpRequest? {
    val obj = parseParamsObject(paramsJson) ?: return null

    val urlRaw = (obj["url"] as? JsonPrimitive)?.contentOrNull?.trim() ?: return null
    if (urlRaw.isEmpty()) return null

    val methodRaw = (obj["method"] as? JsonPrimitive)?.contentOrNull?.trim()?.uppercase() ?: "GET"
    if (methodRaw !in listOf("GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS")) {
      return null
    }

    val headersObj = obj["headers"] as? JsonObject
    val headers = mutableMapOf<String, String>()
    if (headersObj != null) {
      for (entry in headersObj.entries) {
        val value = (entry.value as? JsonPrimitive)?.contentOrNull?.trim() ?: ""
        if (entry.key.isNotEmpty()) {
          headers[entry.key] = value
        }
      }
    }

    val body = (obj["body"] as? JsonPrimitive)?.contentOrNull

    val timeoutRaw = (obj["timeout"] as? JsonPrimitive)?.contentOrNull
    val timeout = timeoutRaw?.toIntOrNull()?.coerceIn(1, 120_000) ?: DEFAULT_TIMEOUT_MS

    return HttpRequest(
      url = urlRaw,
      method = methodRaw,
      headers = headers,
      body = body,
      timeoutMs = timeout,
    )
  }

  private fun parseParamsObject(paramsJson: String?): JsonObject? {
    if (paramsJson.isNullOrBlank()) return null
    return try {
      Json.parseToJsonElement(paramsJson).asObjectOrNull()
    } catch (_: Throwable) {
      null
    }
  }
}
