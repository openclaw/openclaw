package com.steipete.clawdis.node.bridge

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.ServerSocket

class BridgePairingClientTest {
  @Test
  fun helloOkReturnsExistingToken() = runBlocking {
    val serverSocket = ServerSocket(0)
    val port = serverSocket.localPort

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
          }
        }
      }

    val client = BridgePairingClient()
    val res =
      client.pairAndHello(
        endpoint = BridgeEndpoint.manual(host = "127.0.0.1", port = port),
        hello =
          BridgePairingClient.Hello(
            nodeId = "node-1",
            displayName = "Android Node",
            token = "token-123",
            platform = "Android",
            version = "test",
          ),
      )
    assertTrue(res.ok)
    assertEquals("token-123", res.token)
    server.await()
  }

  @Test
  fun notPairedTriggersPairRequestAndReturnsToken() = runBlocking {
    val serverSocket = ServerSocket(0)
    val port = serverSocket.localPort

    val server =
      async(Dispatchers.IO) {
        serverSocket.use { ss ->
          val sock = ss.accept()
          sock.use { s ->
            val reader = BufferedReader(InputStreamReader(s.getInputStream(), Charsets.UTF_8))
            val writer = BufferedWriter(OutputStreamWriter(s.getOutputStream(), Charsets.UTF_8))

            reader.readLine() // hello
            writer.write("""{"type":"error","code":"NOT_PAIRED","message":"not paired"}""")
            writer.write("\n")
            writer.flush()

            val pairReq = reader.readLine()
            assertTrue(pairReq.contains("\"type\":\"pair-request\""))
            writer.write("""{"type":"pair-ok","token":"new-token"}""")
            writer.write("\n")
            writer.flush()
          }
        }
      }

    val client = BridgePairingClient()
    val res =
      client.pairAndHello(
        endpoint = BridgeEndpoint.manual(host = "127.0.0.1", port = port),
        hello =
          BridgePairingClient.Hello(
            nodeId = "node-1",
            displayName = "Android Node",
            token = null,
            platform = "Android",
            version = "test",
          ),
      )
    assertTrue(res.ok)
    assertEquals("new-token", res.token)
    server.await()
  }
}

