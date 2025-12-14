package com.steipete.clawdis.node.bridge

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.ServerSocket

class BridgeSessionTest {
  @Test
  fun requestReturnsPayloadJson() = runBlocking {
    val serverSocket = ServerSocket(0)
    val port = serverSocket.localPort

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val connected = CompletableDeferred<Unit>()

    val session =
      BridgeSession(
        scope = scope,
        onConnected = { _, _ -> connected.complete(Unit) },
        onDisconnected = { /* ignore */ },
        onEvent = { _, _ -> /* ignore */ },
        onInvoke = { BridgeSession.InvokeResult.ok(null) },
      )

    val server =
      async(Dispatchers.IO) {
        serverSocket.use { ss ->
          val sock = ss.accept()
          sock.use { s ->
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
            val writer = BufferedWriter(OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8))

            val hello = reader.readLine()
            assertTrue(hello.contains("\"type\":\"hello\""))
            writer.write("""{"type":"hello-ok","serverName":"Test Bridge"}""")
            writer.write("\n")
            writer.flush()

            val req = reader.readLine()
            assertTrue(req.contains("\"type\":\"req\""))
            val id = extractJsonString(req, "id")
            writer.write("""{"type":"res","id":"$id","ok":true,"payloadJSON":"{\"value\":123}"}""")
            writer.write("\n")
            writer.flush()
          }
        }
      }

    session.connect(
      endpoint = BridgeEndpoint.manual(host = "127.0.0.1", port = port),
      hello =
        BridgeSession.Hello(
          nodeId = "node-1",
          displayName = "Android Node",
          token = null,
          platform = "Android",
          version = "test",
        ),
    )

    connected.await()
    val payload = session.request(method = "health", paramsJson = null)
    assertEquals("""{"value":123}""", payload)
    server.await()

    session.disconnect()
    scope.cancel()
  }

  @Test
  fun requestThrowsOnErrorResponse() = runBlocking {
    val serverSocket = ServerSocket(0)
    val port = serverSocket.localPort

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val connected = CompletableDeferred<Unit>()

    val session =
      BridgeSession(
        scope = scope,
        onConnected = { _, _ -> connected.complete(Unit) },
        onDisconnected = { /* ignore */ },
        onEvent = { _, _ -> /* ignore */ },
        onInvoke = { BridgeSession.InvokeResult.ok(null) },
      )

    val server =
      async(Dispatchers.IO) {
        serverSocket.use { ss ->
          val sock = ss.accept()
          sock.use { s ->
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
            val writer = BufferedWriter(OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8))

            reader.readLine() // hello
            writer.write("""{"type":"hello-ok","serverName":"Test Bridge"}""")
            writer.write("\n")
            writer.flush()

            val req = reader.readLine()
            val id = extractJsonString(req, "id")
            writer.write(
              """{"type":"res","id":"$id","ok":false,"error":{"code":"FORBIDDEN","message":"nope"}}""",
            )
            writer.write("\n")
            writer.flush()
          }
        }
      }

    session.connect(
      endpoint = BridgeEndpoint.manual(host = "127.0.0.1", port = port),
      hello =
        BridgeSession.Hello(
          nodeId = "node-1",
          displayName = "Android Node",
          token = null,
          platform = "Android",
          version = "test",
        ),
    )
    connected.await()

    try {
      session.request(method = "chat.history", paramsJson = """{"sessionKey":"main"}""")
      throw AssertionError("expected request() to throw")
    } catch (e: IllegalStateException) {
      assertTrue(e.message?.contains("FORBIDDEN: nope") == true)
    }
    server.await()

    session.disconnect()
    scope.cancel()
  }

  @Test
  fun invokeResReturnsErrorWhenHandlerThrows() = runBlocking {
    val serverSocket = ServerSocket(0)
    val port = serverSocket.localPort

    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val connected = CompletableDeferred<Unit>()

    val session =
      BridgeSession(
        scope = scope,
        onConnected = { _, _ -> connected.complete(Unit) },
        onDisconnected = { /* ignore */ },
        onEvent = { _, _ -> /* ignore */ },
        onInvoke = { throw IllegalStateException("FOO_BAR: boom") },
      )

    val invokeResLine = CompletableDeferred<String>()
    val server =
      async(Dispatchers.IO) {
        serverSocket.use { ss ->
          val sock = ss.accept()
          sock.use { s ->
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
            val writer = BufferedWriter(OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8))

            reader.readLine() // hello
            writer.write("""{"type":"hello-ok","serverName":"Test Bridge"}""")
            writer.write("\n")
            writer.flush()

            // Ask the node to invoke something; handler will throw.
            writer.write("""{"type":"invoke","id":"i1","command":"screen.snapshot","paramsJSON":null}""")
            writer.write("\n")
            writer.flush()

            val res = reader.readLine()
            invokeResLine.complete(res)
          }
        }
      }

    session.connect(
      endpoint = BridgeEndpoint.manual(host = "127.0.0.1", port = port),
      hello =
        BridgeSession.Hello(
          nodeId = "node-1",
          displayName = "Android Node",
          token = null,
          platform = "Android",
          version = "test",
        ),
    )
    connected.await()

    // Give the reader loop time to process.
    val line = invokeResLine.await()
    assertTrue(line.contains("\"type\":\"invoke-res\""))
    assertTrue(line.contains("\"ok\":false"))
    assertTrue(line.contains("\"code\":\"FOO_BAR\""))
    assertTrue(line.contains("\"message\":\"boom\""))
    server.await()

    session.disconnect()
    scope.cancel()
  }
}

private fun extractJsonString(raw: String, key: String): String {
  val needle = "\"$key\":\""
  val start = raw.indexOf(needle)
  if (start < 0) throw IllegalArgumentException("missing key $key in $raw")
  val from = start + needle.length
  val end = raw.indexOf('"', from)
  if (end < 0) throw IllegalArgumentException("unterminated string for $key in $raw")
  return raw.substring(from, end)
}
