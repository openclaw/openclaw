package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers.ClassParameter
import java.io.IOException
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Hold only the factory return; the real OkHttp socket and callbacks keep running. */
@Implements(value = OkHttpClient::class, isInAndroidSdk = false)
class HeldWebSocketFactory {
  @RealObject
  private lateinit var client: OkHttpClient

  @Implementation
  fun newWebSocket(
    request: Request,
    listener: WebSocketListener,
  ): WebSocket {
    val socket: WebSocket =
      Shadow.directlyOn(
        client,
        OkHttpClient::class.java,
        "newWebSocket",
        ClassParameter.from(Request::class.java, request),
        ClassParameter.from(WebSocketListener::class.java, listener),
      )
    entered.countDown()
    // The test owns release; a competing timeout can strand the unpublished socket.
    try {
      release.await()
    } catch (error: InterruptedException) {
      socket.cancel()
      Thread.currentThread().interrupt()
      throw error
    }
    return socket
  }

  companion object {
    var entered = CountDownLatch(1)
    var release = CountDownLatch(1)
  }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], instrumentedPackages = ["okhttp3"], shadows = [HeldWebSocketFactory::class])
class GatewaySocketPublicationTest {
  @Test
  fun earlyOpenCallbackCannotSendBeforeTheSocketIsPublished() = verifyPublication(disconnectBeforeReturn = false)

  @Test
  fun disconnectWhileTheFactoryReturnsDoesNotPublishTheConnection() = verifyPublication(disconnectBeforeReturn = true)

  @Test
  fun cancellationDuringFactoryRetainsTransportOwnership() = verifyFactoryRetirement(terminalBeforeReturn = false)

  @Test
  fun terminalCallbackBeforeFactoryReturnCannotFinishOrRepublishTransport() = verifyFactoryRetirement(terminalBeforeReturn = true)

  @Test
  fun throwingFactoryReleasesItsCreationReservation() =
    runBlocking {
      val scheduler = TestCoroutineScheduler()
      val sessionJob = SupervisorJob()
      val failure = CompletableDeferred<String>()
      val calls = AtomicInteger()
      val session =
        createFactorySession(
          sessionJob,
          scheduler,
          onDisconnected = { if (it.contains("factory failed")) failure.complete(it) },
          factory = { _, _, _ ->
            calls.incrementAndGet()
            throw IllegalStateException("factory failed")
          },
        )
      try {
        connectFactorySession(session)
        withTimeout(5_000) { failure.await() }
        assertFalse(session.isReady())
        assertEquals(1, calls.get())
      } finally {
        val cleanup =
          async(Dispatchers.Default) {
            session.disconnectAndJoin()
            sessionJob.cancelAndJoin()
          }
        withTimeout(5_000) {
          while (!cleanup.isCompleted) {
            scheduler.runCurrent()
            delay(1)
          }
          cleanup.await()
        }
      }
    }

  private fun verifyFactoryRetirement(terminalBeforeReturn: Boolean) =
    runBlocking {
      val scheduler = TestCoroutineScheduler()
      val sessionJob = SupervisorJob()
      val created = CompletableDeferred<UnpublishedSocket>()
      val release = CountDownLatch(1)
      val connected = AtomicBoolean()
      val session =
        createFactorySession(
          sessionJob,
          scheduler,
          onConnected = { connected.set(true) },
          factory = { _, request, listener ->
            val socket = UnpublishedSocket(request, listener)
            created.complete(socket)
            if (terminalBeforeReturn) listener.onFailure(socket, IOException("early failure"), null)
            release.await()
            socket
          },
        )
      var socket: UnpublishedSocket? = null
      try {
        connectFactorySession(session)
        val createdSocket = withTimeout(5_000) { created.await() }
        socket = createdSocket
        val connection = readField<Any>(session, "currentConnection")
        val closed = readField<CompletableDeferred<Unit>>(connection, "closedDeferred")
        if (terminalBeforeReturn) {
          withTimeout(5_000) {
            while (!readField<Boolean>(connection, "transportFinished")) {
              scheduler.runCurrent()
              delay(1)
            }
          }
        }
        session.disconnect()
        assertFalse("The factory still owns a transport even though no socket is published", closed.isCompleted)
        val cleanup = async(Dispatchers.Default) { session.disconnectAndJoin() }
        assertFalse(cleanup.isCompleted)
        release.countDown()
        if (!terminalBeforeReturn) {
          withTimeout(5_000) { createdSocket.cancelled.await() }
          assertFalse("Cancellation alone is not a terminal callback", closed.isCompleted)
          assertFalse(cleanup.isCompleted)
          createdSocket.listener.onFailure(createdSocket, IOException("cancelled"), null)
        }
        withTimeout(5_000) {
          while (!cleanup.isCompleted) {
            scheduler.runCurrent()
            delay(1)
          }
          cleanup.await()
        }
        assertTrue(closed.isCompleted)
        assertEquals(null, readField<WebSocket?>(connection, "socket"))
        assertFalse(connected.get())
        assertFalse(session.isReady())
        assertEquals(0, createdSocket.sends.get())
      } finally {
        release.countDown()
        socket?.let { it.listener.onFailure(it, IOException("test cleanup"), null) }
        val cleanup =
          async(Dispatchers.Default) {
            session.disconnectAndJoin()
            sessionJob.cancelAndJoin()
          }
        withTimeout(5_000) {
          while (!cleanup.isCompleted) {
            scheduler.runCurrent()
            delay(1)
          }
          cleanup.await()
        }
      }
    }

  private class UnpublishedSocket(
    private val request: Request,
    val listener: WebSocketListener,
  ) : WebSocket {
    val cancelled = CompletableDeferred<Unit>()
    val sends = AtomicInteger()

    override fun request(): Request = request

    override fun queueSize(): Long = 0

    override fun send(text: String): Boolean = false.also { sends.incrementAndGet() }

    override fun send(bytes: ByteString): Boolean = false.also { sends.incrementAndGet() }

    override fun close(
      code: Int,
      reason: String?,
    ): Boolean = false

    override fun cancel() {
      cancelled.complete(Unit)
    }
  }

  private fun createFactorySession(
    job: Job,
    scheduler: TestCoroutineScheduler,
    onConnected: () -> Unit = {},
    onDisconnected: (String) -> Unit = {},
    factory: (OkHttpClient, Request, WebSocketListener) -> WebSocket,
  ): GatewaySession {
    val app = RuntimeEnvironment.getApplication()
    return GatewaySession(
      scope = CoroutineScope(job + StandardTestDispatcher(scheduler)),
      identityStore = testDeviceIdentityStore(app),
      deviceAuthStore = DeviceAuthStore(SecurePrefs(app, app.getSharedPreferences("factory-retirement", 0))),
      onConnected = { onConnected() },
      onDisconnected = onDisconnected,
      onEvent = { _, _ -> },
      webSocketFactory = factory,
    )
  }

  private fun connectFactorySession(session: GatewaySession) {
    session.connect(
      endpoint = GatewayEndpoint.manual("127.0.0.1", 9),
      token = "test-token",
      bootstrapToken = null,
      password = null,
      options =
        GatewayConnectOptions(
          role = "operator",
          scopes = listOf("operator.read"),
          caps = emptyList(),
          commands = emptyList(),
          permissions = emptyMap(),
          client = GatewayClientInfo("openclaw-android", "Test", "1.0.0-test", "android", "ui", "factory-retirement", "android", "test"),
        ),
    )
  }

  @Suppress("UNCHECKED_CAST")
  private fun <T> readField(
    instance: Any,
    name: String,
  ): T =
    instance.javaClass
      .getDeclaredField(name)
      .apply { isAccessible = true }
      .get(instance) as T

  private fun verifyPublication(disconnectBeforeReturn: Boolean) =
    runBlocking {
      HeldWebSocketFactory.entered = CountDownLatch(1)
      HeldWebSocketFactory.release = CountDownLatch(1)
      val app = RuntimeEnvironment.getApplication()
      val scheduler = TestCoroutineScheduler()
      val sessionJob = SupervisorJob()
      val connected = CompletableDeferred<Unit>()
      val preparingHandshake = AtomicBoolean()
      val statuses = ConcurrentLinkedQueue<String>()
      val methods = ConcurrentLinkedQueue<String>()
      val store = DeviceAuthStore(SecurePrefs(app, app.getSharedPreferences("socket-publication", 0)))
      val auth =
        object : DeviceAuthTokenStore by store {
          override fun loadEntry(
            gatewayId: String,
            deviceId: String,
            role: String,
          ): DeviceAuthEntry? {
            preparingHandshake.set(true)
            return store.loadEntry(gatewayId, deviceId, role)
          }
        }
      val session =
        GatewaySession(
          scope = CoroutineScope(sessionJob + StandardTestDispatcher(scheduler)),
          identityStore = testDeviceIdentityStore(app),
          deviceAuthStore = auth,
          onConnected = { connected.complete(Unit) },
          onDisconnected = { statuses.add(it) },
          onEvent = { _, _ -> },
        )
      val server = MockWebServer()
      server.enqueue(
        MockResponse().withWebSocketUpgrade(
          object : WebSocketListener() {
            override fun onOpen(
              webSocket: WebSocket,
              response: Response,
            ) {
              webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"socket-publication","ts":1700000000123}}""")
            }

            override fun onMessage(
              webSocket: WebSocket,
              text: String,
            ) {
              val request = Json.parseToJsonElement(text).jsonObject
              methods.add(request.getValue("method").jsonPrimitive.content)
              val id = request.getValue("id").jsonPrimitive.content
              webSocket.send("""{"type":"res","id":"$id","ok":true,"payload":{"snapshot":{"sessionDefaults":{"mainSessionKey":"main"}}}}""")
            }
          },
        ),
      )
      server.start()
      try {
        session.connect(
          endpoint = GatewayEndpoint.manual("127.0.0.1", server.port),
          token = "test-token",
          bootstrapToken = null,
          password = null,
          options =
            GatewayConnectOptions(
              role = "operator",
              scopes = listOf("operator.read"),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client = GatewayClientInfo("openclaw-android", "Test", "1.0.0-test", "android", "ui", "socket-publication", "android", "test"),
            ),
        )
        withTimeout(5_000) {
          while (HeldWebSocketFactory.entered.count != 0L || !preparingHandshake.get()) {
            scheduler.runCurrent()
            delay(1)
          }
        }
        assertEquals("The handshake must run before the factory returns", 0L, HeldWebSocketFactory.entered.count)
        assertEquals(1L, HeldWebSocketFactory.release.count)
        scheduler.runCurrent()
        if (disconnectBeforeReturn) session.disconnect()
        HeldWebSocketFactory.release.countDown()
        if (disconnectBeforeReturn) {
          withTimeout(5_000) {
            while (!statuses.contains("Offline")) {
              scheduler.runCurrent()
              delay(1)
            }
          }
          assertTrue("A retired connection must not publish readiness", !connected.isCompleted)
          assertTrue("A retired connection must not send its handshake", methods.isEmpty())
        } else {
          withTimeout(5_000) {
            while (!connected.isCompleted && statuses.none { it.startsWith("Gateway error:") }) {
              scheduler.runCurrent()
              delay(1)
            }
          }
          assertTrue("The first socket must connect without a retry: $statuses", connected.isCompleted)
          assertEquals(listOf("connect"), methods.toList())
          assertEquals(1, server.requestCount)
        }
      } finally {
        HeldWebSocketFactory.release.countDown()
        val cleanup =
          async(Dispatchers.Default) {
            session.disconnectAndJoin()
            sessionJob.cancelAndJoin()
          }
        try {
          withTimeout(5_000) {
            while (!cleanup.isCompleted) {
              scheduler.runCurrent()
              delay(1)
            }
          }
          cleanup.await()
        } finally {
          server.shutdown()
        }
      }
    }
}
