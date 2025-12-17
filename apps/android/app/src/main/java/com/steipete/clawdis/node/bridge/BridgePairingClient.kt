package com.steipete.clawdis.node.bridge

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
import java.net.Socket

class BridgePairingClient {
  private val json = Json { ignoreUnknownKeys = true }

  data class Hello(
    val nodeId: String,
    val displayName: String?,
    val token: String?,
    val platform: String?,
    val version: String?,
    val caps: List<String>?,
  )

  data class PairResult(val ok: Boolean, val token: String?, val error: String? = null)

  suspend fun pairAndHello(endpoint: BridgeEndpoint, hello: Hello): PairResult =
    withContext(Dispatchers.IO) {
      val socket = Socket()
      socket.tcpNoDelay = true
      socket.connect(InetSocketAddress(endpoint.host, endpoint.port), 8_000)
      socket.soTimeout = 60_000

      val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
      val writer = BufferedWriter(OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8))

      fun send(line: String) {
        writer.write(line)
        writer.write("\n")
        writer.flush()
      }

      fun sendJson(obj: JsonObject) = send(obj.toString())

      try {
        sendJson(
          buildJsonObject {
            put("type", JsonPrimitive("hello"))
            put("nodeId", JsonPrimitive(hello.nodeId))
            hello.displayName?.let { put("displayName", JsonPrimitive(it)) }
            hello.token?.let { put("token", JsonPrimitive(it)) }
            hello.platform?.let { put("platform", JsonPrimitive(it)) }
            hello.version?.let { put("version", JsonPrimitive(it)) }
            hello.caps?.let { put("caps", JsonArray(it.map(::JsonPrimitive))) }
          },
        )

        val firstObj = json.parseToJsonElement(reader.readLine()).asObjectOrNull()
          ?: return@withContext PairResult(ok = false, token = null, error = "unexpected bridge response")
        when (firstObj["type"].asStringOrNull()) {
          "hello-ok" -> PairResult(ok = true, token = hello.token)
          "error" -> {
            val code = firstObj["code"].asStringOrNull() ?: "UNAVAILABLE"
            val message = firstObj["message"].asStringOrNull() ?: "pairing required"
            if (code != "NOT_PAIRED" && code != "UNAUTHORIZED") {
              return@withContext PairResult(ok = false, token = null, error = "$code: $message")
            }

            sendJson(
              buildJsonObject {
                put("type", JsonPrimitive("pair-request"))
                put("nodeId", JsonPrimitive(hello.nodeId))
                hello.displayName?.let { put("displayName", JsonPrimitive(it)) }
                hello.platform?.let { put("platform", JsonPrimitive(it)) }
                hello.version?.let { put("version", JsonPrimitive(it)) }
                hello.caps?.let { put("caps", JsonArray(it.map(::JsonPrimitive))) }
              },
            )

            while (true) {
              val nextLine = reader.readLine() ?: break
              val next = json.parseToJsonElement(nextLine).asObjectOrNull() ?: continue
              when (next["type"].asStringOrNull()) {
                "pair-ok" -> {
                  val token = next["token"].asStringOrNull()
                  return@withContext PairResult(ok = !token.isNullOrBlank(), token = token)
                }
                "error" -> {
                  val c = next["code"].asStringOrNull() ?: "UNAVAILABLE"
                  val m = next["message"].asStringOrNull() ?: "pairing failed"
                  return@withContext PairResult(ok = false, token = null, error = "$c: $m")
                }
              }
            }
            PairResult(ok = false, token = null, error = "pairing failed")
          }
          else -> PairResult(ok = false, token = null, error = "unexpected bridge response")
        }
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
