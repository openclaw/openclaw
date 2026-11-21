package ai.openclaw.app.gateway

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.SecurePrefs
import android.os.Build
import android.os.Bundle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Request
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Opt-in Android/OkHttp wire proof against the isolated synthetic overload peer. */
@RunWith(AndroidJUnit4::class)
class GatewaySessionInboundRecoveryNativeTest {
  @Test
  fun overloadedSocketSettlesAcceptedResponseAndRecoversWithoutReplay() =
    runBlocking<Unit> {
      val args = InstrumentationRegistry.getArguments()
      assumeTrue(args.getString("inboundRecoveryProof") == "true")
      check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "A dedicated emulator is required" }
      assertEquals(args.getString("candidateSha"), BuildConfig.GIT_COMMIT)
      val port = requireNotNull(args.getString("fixturePort")).toInt()
      val control = OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()

      fun fixture(path: String) =
        control.newCall(Request.Builder().url("http://10.0.2.2:$port$path").build()).execute().use { response ->
          check(response.isSuccessful) { "Fixture $path failed" }
          Json.parseToJsonElement(requireNotNull(response.body).string()).jsonObject
        }

      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val context = instrumentation.targetContext
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val blockStarted = CountDownLatch(1)
      val releaseBlock = CountDownLatch(1)
      val disconnected = CompletableDeferred<String>()
      val ready = Channel<GatewaySession.RequestLease>(Channel.UNLIMITED)
      val retiredEvents = AtomicInteger()
      val clients = ConcurrentLinkedQueue<OkHttpClient>()
      lateinit var session: GatewaySession
      session =
        GatewaySession(
          scope = scope,
          identityStore = DeviceIdentityStore(context),
          deviceAuthStore = DeviceAuthStore(SecurePrefs(context)),
          onConnected = {},
          onDisconnected = { reason -> if (reason.contains("inbound")) disconnected.complete(reason) },
          onEvent = { event, _ ->
            if (event == "proof.block") {
              blockStarted.countDown()
              check(releaseBlock.await(30, TimeUnit.SECONDS)) { "Proof handler was never released" }
            } else if (event == "proof.queued") {
              retiredEvents.incrementAndGet()
            }
          },
          webSocketFactory = { client, request, listener ->
            clients.add(client)
            client.newWebSocket(request, listener)
          },
        )
      try {
        session.connect(
          endpoint = GatewayEndpoint.manual("10.0.2.2", port, tlsEnabled = false),
          token = "synthetic-native-proof-token",
          bootstrapToken = null,
          password = null,
          tls = null,
          options =
            GatewayConnectOptions(
              role = "node",
              scopes = emptyList(),
              caps = emptyList(),
              commands = emptyList(),
              permissions = emptyMap(),
              client = GatewayClientInfo("openclaw-android", "Android inbound recovery proof", "test", "android", "node", "inbound-proof", "android", "test"),
            ),
          onReady = { ready.trySend(requireNotNull(session.captureRequestLease())) },
        )
        val oldLease = withTimeout(15_000) { ready.receive() }
        fixture("/block")
        assertTrue(blockStarted.await(10, TimeUnit.SECONDS))
        val accepted = scope.async { session.request("health", "{}", 15_000) }
        fixture("/pending")
        fixture("/overflow")
        val close = fixture("/closed")["closes"]!!.jsonArray.single().jsonObject
        assertEquals("1013", close["code"]!!.jsonPrimitive.content)
        assertTrue(close["reason"]!!.jsonPrimitive.content.contains("inbound"))
        assertFalse(session.isReady())
        assertFalse(oldLease.isCurrent())
        assertFalse(accepted.isCompleted)
        assertFalse(disconnected.isCompleted)
        releaseBlock.countDown()
        assertEquals(
          "1",
          Json
            .parseToJsonElement(withTimeout(10_000) { accepted.await() })
            .jsonObject["connection"]!!
            .jsonPrimitive.content,
        )
        withTimeout(10_000) { disconnected.await() }
        // No manual reconnect or network-change signal. The replacement gets its own budgets.
        val replacement = withTimeout(15_000) { ready.receive() }
        assertTrue(replacement.isCurrent())
        assertFalse(oldLease.isCurrent())
        repeat(300) {
          assertEquals(
            "2",
            Json
              .parseToJsonElement(session.request("health", "{}", 5_000))
              .jsonObject["connection"]!!
              .jsonPrimitive.content,
          )
        }
        assertEquals(0, retiredEvents.get())
        val status = fixture("/status")
        assertEquals("2", status["connections"]!!.jsonPrimitive.content)
        assertEquals(1, status["closes"]!!.jsonArray.size)
        assertEquals(301, status["requests"]!!.jsonArray.count { it.jsonObject["method"]!!.jsonPrimitive.content == "health" })
        fixture("/finish")
        instrumentation.sendStatus(
          0,
          Bundle().apply { putString("stream", "INBOUND_RECOVERY_NATIVE passed: close1013, accepted response settled, automatic reconnect, 300 replacement RPCs, no replay\n") },
        )
      } finally {
        releaseBlock.countDown()
        try {
          withTimeout(5_000) { session.disconnectAndJoin() }
        } finally {
          scope.cancel()
          (clients.toList() + control).forEach {
            it.dispatcher.executorService.shutdown()
            it.connectionPool.evictAll()
          }
        }
      }
    }
}
