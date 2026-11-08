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
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Opt-in proof against an isolated built Gateway and its same-identity replacement fixture. */
@RunWith(AndroidJUnit4::class)
class GatewaySessionPairingRecoveryNativeTest {
  @Test
  fun obsoleteNodeSocketAutomaticallyRecoversWithoutReplayingItsRejectedEvent() =
    runBlocking<Unit> {
      val instrumentation = InstrumentationRegistry.getInstrumentation()
      val args = InstrumentationRegistry.getArguments()
      assumeTrue("Requires the isolated pairing recovery host fixture", args.getString("pairingRecoveryProof") == "true")
      // This fixture exports a synthetic identity to its loopback host. Never run on a user's phone.
      check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "A dedicated emulator is required" }
      assertEquals(args.getString("candidateSha"), BuildConfig.GIT_COMMIT)
      val token = requireNotNull(args.getString("fixtureToken"))
      val controlPort = requireNotNull(args.getString("controlPort")).toInt()
      val gatewayPort = requireNotNull(args.getString("gatewayPort")).toInt()
      val control = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()

      fun post(
        path: String,
        body: JsonObject = JsonObject(emptyMap()),
      ): JsonObject {
        val request =
          Request
            .Builder()
            .url("http://10.0.2.2:$controlPort$path")
            .header("Authorization", "Bearer $token")
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        return control.newCall(request).execute().use { response ->
          val result = Json.parseToJsonElement(requireNotNull(response.body).string()).jsonObject
          check(response.isSuccessful && result["ok"]?.jsonPrimitive?.content == "true") { "Fixture $path failed: $result" }
          result
        }
      }

      val context = instrumentation.targetContext
      val identityStore = DeviceIdentityStore(context)
      val identity = identityStore.loadOrCreate()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
      val ready = Channel<GatewaySession.RequestLease>(Channel.UNLIMITED)
      val original = AtomicReference<GatewaySession.RequestLease>()
      val disconnected = CompletableDeferred<JsonObject>()
      val clients = ConcurrentLinkedQueue<OkHttpClient>()
      lateinit var session: GatewaySession
      session =
        GatewaySession(
          scope = scope,
          identityStore = identityStore,
          deviceAuthStore = DeviceAuthStore(SecurePrefs(context)),
          onConnected = {},
          onDisconnected = { reason ->
            original.get()?.let { lease ->
              disconnected.complete(
                buildJsonObject {
                  put("ready", session.isReady())
                  put("oldLeaseCurrent", lease.isCurrent())
                  put("reason", reason)
                },
              )
            }
          },
          onEvent = { _, _ -> },
          webSocketFactory = { client, request, listener ->
            clients.add(client)
            client.newWebSocket(request, listener)
          },
        )
      try {
        post(
          "/identity",
          buildJsonObject {
            put("deviceId", identity.deviceId)
            put("publicKeyRawBase64", identity.publicKeyRawBase64)
            put("privateKeyPkcs8Base64", identity.privateKeyPkcs8Base64)
          },
        )
        session.connect(
          endpoint = GatewayEndpoint.manual("10.0.2.2", gatewayPort, tlsEnabled = false),
          token = token,
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
              client = GatewayClientInfo("openclaw-android", "Android pairing recovery native proof", "test", "android", "node", "pairing-recovery-android", "android", "test"),
            ),
          onReady = { ready.trySend(requireNotNull(session.captureRequestLease())) },
        )
        original.set(withTimeout(30_000) { ready.receive() })
        post("/ready")
        post("/replace")
        val rejected =
          session.sendNodeEventDetailedForEndpoint(
            null,
            "node.host.stats",
            """{"cpuCount":4,"memoryTotalBytes":8192,"memoryFreeBytes":1024}""",
          )
        assertFalse(rejected.ok)
        assertEquals("UNAVAILABLE", rejected.error?.code)
        assertEquals("PAIRING_CHANGED", rejected.error?.details?.code)
        post("/check-rejected")
        val withdrawal = withTimeout(15_000) { disconnected.await() }
        assertEquals(JsonPrimitive(false), withdrawal["ready"])
        assertEquals(JsonPrimitive(false), withdrawal["oldLeaseCurrent"])
        // No reconnect(), network-change signal, or second connect() call is made.
        val replacement = withTimeout(30_000) { ready.receive() }
        assertFalse(original.get().isCurrent())
        assertTrue(replacement.isCurrent())
        assertTrue(session.isReady())
        val fresh =
          session.sendNodeEventDetailedForEndpoint(
            null,
            "node.host.stats",
            """{"cpuCount":4,"memoryTotalBytes":8192,"memoryFreeBytes":6144}""",
          )
        assertTrue(fresh.ok)
        post("/check-recovered")
        val observations =
          buildJsonObject {
            put("candidateSha", BuildConfig.GIT_COMMIT)
            put("sdk", Build.VERSION.SDK_INT)
            put("hardware", Build.HARDWARE)
            put("disconnect", withdrawal)
            put("oldLeaseCurrentAfterRecovery", original.get().isCurrent())
            put("replacementLeaseCurrent", replacement.isCurrent())
            put("freshEventAccepted", fresh.ok)
          }
        instrumentation.sendStatus(0, Bundle().apply { putString("stream", "PAIRING_RECOVERY_NATIVE $observations\n") })
        post(
          "/finish",
          buildJsonObject {
            put("passed", true)
            put("observations", observations)
          },
        )
      } catch (failure: Throwable) {
        runCatching {
          post(
            "/finish",
            buildJsonObject {
              put("passed", false)
              put("error", failure.javaClass.simpleName)
            },
          )
        }
        throw failure
      } finally {
        try {
          withTimeout(5_000) { session.disconnectAndJoin() }
        } finally {
          scope.cancel()
          (clients.toList() + control).forEach { client ->
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
          }
        }
      }
    }
}
