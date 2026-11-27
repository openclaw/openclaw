package ai.openclaw.releasevalidation

import ai.openclaw.wear.shared.WearProtocol
import android.net.LocalServerSocket
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Process
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.BufferedInputStream
import java.io.EOFException
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/** Only androidTest compiles this adapter. Protocol bytes still belong to the production owners. */
internal class LocalWearTransport(
  private val role: String,
  private val nodeId: String,
  private val peerNodeId: String,
  socketName: String,
  private val receive: suspend (String, String, ByteArray) -> Unit,
  private val restore: () -> Unit,
) : AutoCloseable {
  private val server = LocalServerSocket(socketName)
  private val closed = AtomicBoolean()
  private val failure = AtomicReference<Throwable?>()
  private val finished = CountDownLatch(1)
  private val continuation = Semaphore(0)
  private val sockets = ConcurrentHashMap.newKeySet<LocalSocket>()
  private val inbound = ConcurrentHashMap<String, AtomicInteger>()
  private val outbound = ConcurrentHashMap<String, AtomicInteger>()
  private val attemptedOutbound = ConcurrentHashMap<String, AtomicInteger>()
  private val peerRequests = ConcurrentHashMap<String, AtomicInteger>()
  private val discoveredPeer = AtomicInteger()
  private val lastSocketFailure = AtomicReference<String?>()
  private val handlers = Executors.newFixedThreadPool(4) { work -> Thread(work, "release-wear-http").apply { isDaemon = true } }
  private var acceptThread: Thread? = null

  fun start(): LocalWearTransport {
    check(acceptThread == null)
    acceptThread =
      thread(name = "release-wear-accept", isDaemon = true) {
        try {
          while (!closed.get()) {
            val socket = server.accept()
            sockets.add(socket)
            handlers.execute { handle(socket) }
          }
        } catch (error: Exception) {
          if (!closed.get()) recordFailure(error)
        }
      }
    return this
  }

  suspend fun reachablePeerNodeId(): String? =
    withContext(Dispatchers.IO) {
      try {
        val response = requestPeer("GET", "/health")
        peerNodeId
          .takeIf {
            response.status == 200 &&
              Json
                .parseToJsonElement(response.body.toString(Charsets.UTF_8))
                .jsonObject["nodeId"]
                ?.jsonPrimitive
                ?.content == peerNodeId
          }?.also { discoveredPeer.incrementAndGet() }
      } catch (_: java.io.IOException) {
        null
      }
    }

  suspend fun send(
    targetNodeId: String,
    path: String,
    bytes: ByteArray,
  ): Unit =
    withContext(Dispatchers.IO) {
      check(targetNodeId == peerNodeId) { "Unexpected release transport peer" }
      check(path.startsWith('/') && path.none { it == '\r' || it == '\n' })
      check(bytes.size <= WearProtocol.MAX_MESSAGE_BYTES)
      attemptedOutbound.computeIfAbsent(path) { AtomicInteger() }.incrementAndGet()
      val response = requestPeer("POST", "/message", path, bytes)
      check(response.status == 204) { "Release transport peer rejected message (${response.status})" }
      outbound.computeIfAbsent(path) { AtomicInteger() }.incrementAndGet()
    }

  fun awaitContinue(timeoutMillis: Long = 600_000) {
    checkHealthy()
    check(continuation.tryAcquire(timeoutMillis, TimeUnit.MILLISECONDS)) { "Release transport did not receive /continue" }
    checkHealthy()
  }

  fun awaitFinish(timeoutMillis: Long = 600_000) {
    check(finished.await(timeoutMillis, TimeUnit.MILLISECONDS)) { "Release transport did not receive /finish" }
    checkHealthy()
  }

  fun checkHealthy() {
    failure.get()?.let { throw AssertionError("Release transport failed", it) }
  }

  fun diagnostics(): String = health().toString()

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    try {
      server.close()
      sockets.forEach { socket -> socket.close() }
      handlers.shutdownNow()
      acceptThread?.join(2_000)
    } finally {
      restore()
    }
  }

  private fun handle(socket: LocalSocket) {
    try {
      socket.use {
        socket.soTimeout = 15_000
        val input = BufferedInputStream(socket.inputStream)
        val requestLine = readLine(input).split(' ')
        check(requestLine.size == 3)
        val headers = readHeaders(input)
        val length = headers["content-length"]?.toInt() ?: 0
        check(length in 0..WearProtocol.MAX_MESSAGE_BYTES)
        val body = readBody(input, length)
        when (requestLine[0] to requestLine[1]) {
          "GET" to "/health" -> {
            writeResponse(socket.outputStream, 200, health().toString().toByteArray())
          }

          "POST" to "/finish" -> {
            writeResponse(socket.outputStream, 204)
            finished.countDown()
          }

          "POST" to "/continue" -> {
            writeResponse(socket.outputStream, 204)
            continuation.release()
          }

          "POST" to "/message" -> {
            check(headers["x-openclaw-source"] == peerNodeId) { "Unexpected inbound release transport peer" }
            val path = checkNotNull(headers["x-openclaw-path"])
            runBlocking { receive(peerNodeId, path, body) }
            inbound.computeIfAbsent(path) { AtomicInteger() }.incrementAndGet()
            writeResponse(socket.outputStream, 204)
          }

          else -> {
            error("Unknown release transport endpoint")
          }
        }
      }
    } catch (error: Exception) {
      if (!closed.get()) recordFailure(error)
    } finally {
      sockets.remove(socket)
    }
  }

  private fun health(): JsonObject =
    buildJsonObject {
      put("role", role)
      put("nodeId", nodeId)
      put("pid", Process.myPid())
      put("healthy", failure.get() == null)
      put("inbound", JsonObject(inbound.mapValues { JsonPrimitive(it.value.get()) }))
      put("outbound", JsonObject(outbound.mapValues { JsonPrimitive(it.value.get()) }))
      put("attemptedOutbound", JsonObject(attemptedOutbound.mapValues { JsonPrimitive(it.value.get()) }))
      put("peerRequests", JsonObject(peerRequests.mapValues { JsonPrimitive(it.value.get()) }))
      put("discoveredPeer", discoveredPeer.get())
      lastSocketFailure.get()?.let { put("lastSocketFailure", it) }
    }

  private fun recordFailure(error: Throwable) {
    failure.compareAndSet(null, error)
    finished.countDown()
    continuation.release()
  }

  private fun requestPeer(
    method: String,
    endpoint: String,
    path: String? = null,
    body: ByteArray = byteArrayOf(),
  ): HttpResponse {
    peerRequests.computeIfAbsent("$method $endpoint") { AtomicInteger() }.incrementAndGet()
    return try {
      LocalSocket().use { socket ->
        socket.connect(LocalSocketAddress("openclaw-release-peer", LocalSocketAddress.Namespace.ABSTRACT))
        socket.soTimeout = 15_000
        val headers =
          buildString {
            append("$method $endpoint HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: ${body.size}\r\n")
            if (path != null) append("X-OpenClaw-Source: $nodeId\r\nX-OpenClaw-Path: $path\r\n")
            append("\r\n")
          }
        socket.outputStream.write(headers.toByteArray(Charsets.US_ASCII))
        socket.outputStream.write(body)
        socket.outputStream.flush()
        val input = BufferedInputStream(socket.inputStream)
        val status = readLine(input).split(' ')[1].toInt()
        val responseHeaders = readHeaders(input)
        HttpResponse(status, readBody(input, checkNotNull(responseHeaders["content-length"]).toInt()))
      }
    } catch (error: java.io.IOException) {
      // Only socket IO errors enter this field; protocol bodies and owner exceptions do not.
      lastSocketFailure.set("${error.javaClass.simpleName}: ${error.message.orEmpty().take(256)}")
      throw error
    }
  }

  private data class HttpResponse(
    val status: Int,
    val body: ByteArray,
  )

  private fun readHeaders(input: InputStream): Map<String, String> =
    buildMap {
      while (true) {
        val line = readLine(input)
        if (line.isEmpty()) break
        val separator = line.indexOf(':')
        check(separator > 0)
        put(line.substring(0, separator).lowercase(), line.substring(separator + 1).trim())
      }
    }

  private fun readLine(input: InputStream): String =
    buildString {
      while (true) {
        val value = input.read()
        if (value < 0) throw EOFException("Release transport HTTP stream ended")
        if (value == '\n'.code) break
        if (value != '\r'.code) append(value.toChar())
        check(length <= 4_096)
      }
    }

  private fun readBody(
    input: InputStream,
    length: Int,
  ): ByteArray {
    check(length in 0..WearProtocol.MAX_MESSAGE_BYTES)
    val bytes = ByteArray(length)
    var offset = 0
    while (offset < length) {
      val read = input.read(bytes, offset, length - offset)
      if (read < 0) throw EOFException("Release transport HTTP body ended")
      offset += read
    }
    return bytes
  }

  private fun writeResponse(
    output: OutputStream,
    status: Int,
    body: ByteArray = byteArrayOf(),
  ) {
    output.write("HTTP/1.1 $status OK\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
    output.write(body)
    output.flush()
  }
}
