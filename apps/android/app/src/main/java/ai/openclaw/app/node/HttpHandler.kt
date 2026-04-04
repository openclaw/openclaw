package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putAll
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

private const val DEFAULT_TIMEOUT_MS = 30_000
private const val MAX_BODY_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB cap

internal data class HttpRequest(
  val url: String,
  val method: String = "GET",
  val headers: Map<String, String> = emptyMap(),
  val body: String? = null,
  val timeoutMs: Int = DEFAULT_TIMEOUT_MS,
)

internal class HttpHandler(
  private val json: Json = Json { ignoreUnknownKeys = true },
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
      val parsed = URL(url)
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
      val responseBody = try {
        val inputStream = if (responseCode >= 400) connection.errorStream else connection.inputStream
        if (inputStream != null) {
          inputStream.bufferedReader(Charsets.UTF_8).use { reader ->
            reader.readText(MAX_BODY_SIZE_BYTES)
          }
        } else {
          null
        }
      } catch (_: Throwable) {
        null
      }

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

  private fun parseHttpRequest(paramsJson: String?): HttpRequest? {
    val obj = parseParamsObject(paramsJson) ?: return null

    val urlRaw = (obj["url"] as? JsonPrimitive)?.contentOrNull?.trim() ?: return null
    if (urlRaw.isEmpty()) return null

    val methodRaw = (obj["method"] as? JsonPrimitive)?.contentOrNull?.trim()?.uppercase() ?: "GET"
    if (methodRaw !in listOf("GET", "POST", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS")) {
      return null
    }

    val headers =
      (obj["headers"] as? JsonObject)?.entries?.associate { (k, v) ->
        k to (v as? JsonPrimitive)?.contentOrNull?.trim() ?: ""
      } ?: emptyMap()

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
