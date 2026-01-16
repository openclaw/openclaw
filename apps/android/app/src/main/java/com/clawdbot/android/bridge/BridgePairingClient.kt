package com.clawdbot.android.bridge

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetSocketAddress

class BridgePairingClient {
  private val json = Json { ignoreUnknownKeys = true }

  data class Hello(
    val nodeId: String,
    val displayName: String?,
    val token: String?,
    val platform: String?,
    val version: String?,
    val deviceFamily: String?,
    val modelIdentifier: String?,
    val caps: List<String>?,
    val commands: List<String>?,
  )

  data class PairResult(val ok: Boolean, val token: String?, val error: String? = null)

  suspend fun pairAndHello(
    endpoint: BridgeEndpoint,
    hello: Hello,
    tls: BridgeTlsParams? = null,
    onTlsFingerprint: ((String) -> Unit)? = null,
  ): PairResult =
    withContext(Dispatchers.IO) {
      if (tls != null) {
        try {
          return@withContext pairAndHelloWithTls(endpoint, hello, tls, onTlsFingerprint)
        } catch (e: Exception) {
          if (tls.required) throw e
        }
      }
      pairAndHelloWithTls(endpoint, hello, null, null)
    }

  private fun pairAndHelloWithTls(
    endpoint: BridgeEndpoint,
    hello: Hello,
    tls: BridgeTlsParams?,
    onTlsFingerprint: ((String) -> Unit)?,
  ): PairResult {
    val socket =
      createBridgeSocket(tls) { fingerprint ->
        onTlsFingerprint?.invoke(fingerprint)
      }
    socket.tcpNoDelay = true
    try {
      socket.connect(InetSocketAddress(endpoint.host, endpoint.port), 8_000)
      socket.soTimeout = 60_000
      startTlsHandshakeIfNeeded(socket)

      val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
      val writer = BufferedWriter(OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8))

      fun send(line: String) {
        writer.write(line)
        writer.write("\n")
        writer.flush()
      }

      fun sendJson(obj: JsonObject) = send(obj.toString())

      sendJson(
        buildJsonObject {
          put("type", JsonPrimitive("hello"))
          put("nodeId", JsonPrimitive(hello.nodeId))
          hello.displayName?.let { put("displayName", JsonPrimitive(it)) }
          hello.token?.let { put("token", JsonPrimitive(it)) }
          hello.platform?.let { put("platform", JsonPrimitive(it)) }
          hello.version?.let { put("version", JsonPrimitive(it)) }
          hello.deviceFamily?.let { put("deviceFamily", JsonPrimitive(it)) }
          hello.modelIdentifier?.let { put("modelIdentifier", JsonPrimitive(it)) }
          hello.caps?.let { put("caps", JsonArray(it.map(::JsonPrimitive))) }
          hello.commands?.let { put("commands", JsonArray(it.map(::JsonPrimitive))) }
        },
      )

      val firstObj = json.parseToJsonElement(reader.readLine()).asObjectOrNull()
        ?: return PairResult(ok = false, token = null, error = "unexpected bridge response")
      return when (firstObj["type"].asStringOrNull()) {
        "hello-ok" -> PairResult(ok = true, token = hello.token)
        "error" -> {
          val code = firstObj["code"].asStringOrNull() ?: "UNAVAILABLE"
          val message = firstObj["message"].asStringOrNull() ?: "pairing required"
          if (code != "NOT_PAIRED" && code != "UNAUTHORIZED") {
            return PairResult(ok = false, token = null, error = "$code: $message")
          }

          sendJson(
            buildJsonObject {
              put("type", JsonPrimitive("pair-request"))
              put("nodeId", JsonPrimitive(hello.nodeId))
              hello.displayName?.let { put("displayName", JsonPrimitive(it)) }
              hello.platform?.let { put("platform", JsonPrimitive(it)) }
              hello.version?.let { put("version", JsonPrimitive(it)) }
              hello.deviceFamily?.let { put("deviceFamily", JsonPrimitive(it)) }
              hello.modelIdentifier?.let { put("modelIdentifier", JsonPrimitive(it)) }
              hello.caps?.let { put("caps", JsonArray(it.map(::JsonPrimitive))) }
              hello.commands?.let { put("commands", JsonArray(it.map(::JsonPrimitive))) }
            },
          )

          while (true) {
            val nextLine = reader.readLine() ?: break
            val next = json.parseToJsonElement(nextLine).asObjectOrNull() ?: continue
            when (next["type"].asStringOrNull()) {
              "pair-ok" -> {
                val token = next["token"].asStringOrNull()
                return PairResult(ok = !token.isNullOrBlank(), token = token)
              }
              "error" -> {
                val c = next["code"].asStringOrNull() ?: "UNAVAILABLE"
                val m = next["message"].asStringOrNull() ?: "pairing failed"
                return PairResult(ok = false, token = null, error = "$c: $m")
              }
            }
          }
          PairResult(ok = false, token = null, error = "pairing failed")
        }
        else -> PairResult(ok = false, token = null, error = "unexpected bridge response")
      }
    } catch (e: Exception) {
      val message = e.message?.trim().orEmpty().ifEmpty { "gateway unreachable" }
      return PairResult(ok = false, token = null, error = message)
    } finally {
      try {
        socket.close()
      } catch (_: Throwable) {
        // ignore
      }
    }
  }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }
