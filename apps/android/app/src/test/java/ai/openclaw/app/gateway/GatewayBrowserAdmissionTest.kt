package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBrowserAdmissionTest {
  @Test fun operatorPairingRequirementIsNativeAdmissionWithoutNodeApproval() =
    runBlocking {
      val harness = Harness(pairing = true)
      try {
        harness.connect()
        assertEquals("NOT_PAIRED", withTimeout(5_000) { harness.failure.await() }.code)
        assertTrue(harness.accepted)
        assertEquals(1, harness.accepts.get())
        assertEquals(1, harness.connects.get())
      } finally {
        harness.close()
      }
    }

  @Test fun cookieEpochChangeBeforeNativeResponseCannotAcceptOrSaveAuthority() =
    runBlocking {
      val gate = CompletableDeferred<Unit>()
      val harness = Harness(replyGate = gate)
      try {
        harness.connect()
        withTimeout(5_000) { harness.sent.await() }
        harness.cookie = "session=synthetic-other-principal"
        gate.complete(Unit)
        assertEquals("disconnected", withTimeout(5_000) { harness.terminal.await() })
        assertFalse(harness.accepted)
        assertEquals(0, harness.accepts.get())
        val device =
          harness.params
            .await()["device"]!!
            .jsonObject["id"]!!
            .jsonPrimitive.content
        assertNull(harness.store.loadEntry(harness.endpoint.stableId + ".browser." + harness.profile, device, "operator"))
      } finally {
        harness.close()
      }
    }

  @Test fun acceptedRoleGrantPrecedesReadyAndSurvivesSameEpochCookieRotation() =
    runBlocking {
      val first = Harness()
      try {
        first.connect()
        assertEquals("ready", withTimeout(5_000) { first.terminal.await() })
        val original = first.params.await()
        val device = original["device"]!!.jsonObject["id"]!!.jsonPrimitive.content
        assertNotNull(first.store.loadEntry(first.endpoint.stableId + ".browser." + first.profile, device, "operator"))
        first.session.disconnectAndJoin()
        val resumed = Harness(store = first.store, profile = first.profile, initiallyAccepted = true)
        try {
          resumed.cookie = "session=synthetic-rotated-same-principal"
          resumed.connect(token = null)
          assertEquals("ready", withTimeout(5_000) { resumed.terminal.await() })
          val params = resumed.params.await()
          assertEquals(device, params["device"]!!.jsonObject["id"]!!.jsonPrimitive.content)
          assertEquals("synthetic-issued-operator", params["auth"]!!.jsonObject["token"]!!.jsonPrimitive.content)
        } finally {
          resumed.close()
        }
        val replacement = Harness(store = first.store, profile = "synthetic-new-account-epoch")
        try {
          replacement.cookie = "session=synthetic-new-account"
          replacement.connect(token = null)
          assertEquals("ready", withTimeout(5_000) { replacement.terminal.await() })
          assertNull(
            replacement.params
              .await()["auth"]
              ?.jsonObject
              ?.get("token"),
          )
          assertNull(
            replacement.params
              .await()["auth"]
              ?.jsonObject
              ?.get("deviceToken"),
          )
        } finally {
          replacement.close()
        }
      } finally {
        first.close()
      }
    }

  @Test fun cookiePresenceAndUpgradeAloneAreNotLoginProof() =
    runBlocking {
      val harness = Harness(unauthorized = true)
      try {
        harness.connect()
        assertEquals("AUTH_UNAUTHORIZED", withTimeout(5_000) { harness.failure.await() }.code)
        assertFalse(harness.accepted)
        assertEquals(0, harness.accepts.get())
      } finally {
        harness.close()
      }
    }

  @Test fun nodeAdmissionCannotActivateTheBrowserOperatorLogin() =
    runBlocking {
      val harness = Harness(role = "node")
      try {
        harness.connect()
        assertEquals("ready", withTimeout(5_000) { harness.terminal.await() })
        assertFalse(harness.accepted)
        assertEquals(0, harness.accepts.get())
      } finally {
        harness.close()
      }
    }

  private class Harness(
    val store: DeviceAuthStore = DeviceAuthStore(SecurePrefs(RuntimeEnvironment.getApplication(), RuntimeEnvironment.getApplication().getSharedPreferences("browser-admission-${UUID.randomUUID()}", Context.MODE_PRIVATE))),
    val profile: String = "synthetic-profile",
    private val pairing: Boolean = false,
    private val role: String = "operator",
    private val unauthorized: Boolean = false,
    private val replyGate: CompletableDeferred<Unit>? = null,
    initiallyAccepted: Boolean = false,
  ) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val endpoint = GatewayEndpoint.manual("gateway.example.test", 443, tlsEnabled = true)
    val terminal = CompletableDeferred<String>()
    val failure = CompletableDeferred<GatewaySession.ErrorShape>()
    val params = CompletableDeferred<JsonObject>()
    val sent = CompletableDeferred<Unit>()
    val accepts = AtomicInteger()
    val connects = AtomicInteger()

    @Volatile var cookie = "session=synthetic-principal"

    @Volatile var accepted = initiallyAccepted

    @Volatile private var live = true
    private val operatorAccepted = CompletableDeferred<Boolean>().also { if (initiallyAccepted) it.complete(true) }
    private val authorization =
      PendingBrowserAuthorization(
        target = "https://gateway.example.test/".toHttpUrl(),
        profileName = profile,
        current = { live },
        accepted = { accepted },
        cookieHeader = { cookie },
        receiveCookies = { _, _ -> },
        acceptOperator = { current ->
          if (!current()) {
            false
          } else {
            if (!accepted) accepts.incrementAndGet()
            accepted = true
            operatorAccepted.complete(true)
            true
          }
        },
      )
    val session =
      GatewaySession(
        scope = scope,
        identityStore = testDeviceIdentityStore(RuntimeEnvironment.getApplication()),
        deviceAuthStore = store,
        onConnected = {
          if (role == "operator") check(accepted)
          terminal.complete("ready")
        },
        onDisconnected = { if (sent.isCompleted) terminal.complete("disconnected") },
        onConnectFailure = { error, _ ->
          failure.complete(error)
          terminal.complete(if (error.code == "NOT_PAIRED") "pairing" else "refused")
        },
        onEvent = { _, _ -> },
        ingressAuthorizationProvider = { authorization },
        webSocketFactory = { _: OkHttpClient, request: Request, listener: WebSocketListener ->
          val socket = Socket(request, listener)
          scope.launch {
            listener.onOpen(
              socket,
              Response
                .Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(101)
                .message("Switching Protocols")
                .build(),
            )
            listener.onMessage(socket, """{"type":"event","event":"connect.challenge","payload":{"nonce":"synthetic","ts":1700000000123}}""")
          }
          socket
        },
      )

    fun connect(token: String? = "synthetic-shared") {
      session.connect(endpoint, token, null, null, GatewayConnectOptions(role = role, scopes = listOf("operator.read"), caps = emptyList(), commands = emptyList(), permissions = emptyMap(), client = GatewayClientInfo("openclaw-android-test", "Android Test", "1.0", "android", "ui", "synthetic", "android", "test"), userAgent = "synthetic-user-agent"), GatewayTlsParams(expectedFingerprint = "aa".repeat(32)))
    }

    suspend fun close() {
      live = false
      session.disconnectAndJoin()
      scope.cancel()
    }

    private inner class Socket(
      private val req: Request,
      private val listener: WebSocketListener,
    ) : WebSocket {
      override fun request(): Request = req

      override fun queueSize(): Long = 0

      override fun send(text: String): Boolean {
        val message = Json.parseToJsonElement(text).jsonObject
        if (message["method"]?.jsonPrimitive?.content == "connect") {
          connects.incrementAndGet()
          params.complete(message["params"]!!.jsonObject)
          sent.complete(Unit)
          val id = message["id"]!!.jsonPrimitive.content
          scope.launch {
            replyGate?.await()
            val response =
              when {
                pairing -> """{"type":"res","id":"$id","ok":false,"error":{"code":"NOT_PAIRED","message":"pairing required","details":{"code":"PAIRING_REQUIRED","requestId":"synthetic-pending"}}}"""
                unauthorized -> """{"type":"res","id":"$id","ok":false,"error":{"code":"AUTH_UNAUTHORIZED","message":"synthetic refusal"}}"""
                else -> """{"type":"res","id":"$id","ok":true,"payload":{"auth":{"role":"$role","deviceToken":"synthetic-issued-operator","scopes":["operator.read"]},"features":{"methods":[]},"snapshot":{}}}"""
              }
            listener.onMessage(this@Socket, response)
          }
        }
        return true
      }

      override fun send(bytes: ByteString): Boolean = true

      override fun close(
        code: Int,
        reason: String?,
      ): Boolean {
        listener.onClosed(this, code, reason.orEmpty())
        return true
      }

      override fun cancel() {
        listener.onFailure(this, java.io.IOException("cancelled"), null)
      }
    }
  }
}
