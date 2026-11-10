package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.OpenClawIdCanonical
import ai.openclaw.app.gateway.OpenClawIdConnection
import ai.openclaw.app.gateway.OpenClawIdDiscovery
import ai.openclaw.app.gateway.OpenClawIdEndpoint
import ai.openclaw.app.gateway.OpenClawIdEnrollmentCrypto
import ai.openclaw.app.gateway.OpenClawIdEnrollmentSigner
import ai.openclaw.app.gateway.OpenClawIdNodeController
import ai.openclaw.app.gateway.OpenClawIdNodeStore
import ai.openclaw.app.gateway.OpenClawIdRelayStatus
import android.content.Context
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.QueueDispatcher
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast
import org.robolectric.util.ReflectionHelpers
import java.net.InetAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Real enrollment, signed Discovery decoding, persisted admission, and UI/runtime switch owners. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OpenClawIdEnrollmentHandoffTest {
  private val viewModels = ViewModelStore()
  private val descriptorRequested = CompletableDeferred<Unit>()
  private val releaseApproval = CountDownLatch(1)
  private val nativeDial = CompletableDeferred<String>()
  private val nativeBinds = AtomicInteger()
  private val alphaServer = MockWebServer()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var controller: OpenClawIdNodeController
  private lateinit var discoveryClient: OkHttpClient
  private lateinit var alpha: GatewayEndpoint
  private var originalRuntime: NodeRuntime? = null
  private val vectors = OpenClawIdCanonical.json.parseToJsonElement(requireNotNull(javaClass.getResource("/openclaw-id-statements.json")).readText()).jsonObject
  private val link =
    vectors
      .getValue("node_invite")
      .jsonObject
      .getValue("link")
      .jsonPrimitive.content
  private val origin = "https://discovery.example.test"
  private var redemptionPeer: String? = null
  private var approvedDescriptor: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    prefs = SecurePrefs(app, app.getSharedPreferences("enrollment-handoff", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime =
      NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture, openClawIdEndpointFactory = { _, _ ->
        nativeBinds.incrementAndGet()
        object : OpenClawIdEndpoint {
          override suspend fun connect(serverKey: String): OpenClawIdConnection {
            nativeDial.complete(serverKey)
            awaitCancellation()
          }

          override fun relayStatus() = OpenClawIdRelayStatus(connected = true, admissionDenied = false)

          override suspend fun shutdown() = Unit
        }
      })
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    viewModels.put("enrollment", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    (alphaServer.dispatcher as QueueDispatcher).setFailFast(MockResponse().setResponseCode(503))
    alphaServer.start(InetAddress.getByName("127.0.0.1"), 0)
    alpha = GatewayEndpoint.manual("127.0.0.1", alphaServer.port, false)
    prefs.gatewayRegistry.upsert(gatewayRegistryEntry(alpha, null))
    runtime.prepareForGatewaySetup()
    drainWithMainLooper {
      withTimeout(5_000) {
        runtime.switchToGateway(alpha.stableId)
        runtime.gatewayConnectionHandoff.first { !it.pending && it.focusedStableId == alpha.stableId }
      }
    }
    controller = ReflectionHelpers.getField(runtime, "openClawIdController")
    val discovery = ReflectionHelpers.getField<OpenClawIdDiscovery>(controller, "discovery")
    // Replace only HTTP I/O: do not manufacture an assessment, admission callback, or saved target.
    discoveryClient =
      OkHttpClient
        .Builder()
        .addInterceptor { chain ->
          val request = chain.request()
          assertEquals("discovery.example.test", request.url.host)
          val body =
            if (request.method == "POST") {
              assertTrue(request.url.encodedPath.endsWith("/mailbox/node"))
              val bytes = Buffer().also { requireNotNull(request.body).writeTo(it) }.readUtf8()
              redemptionPeer =
                OpenClawIdCanonical.json
                  .parseToJsonElement(bytes)
                  .jsonObject
                  .getValue("payload")
                  .jsonObject
                  .getValue("redemption")
                  .jsonObject
                  .getValue("body")
                  .jsonObject
                  .getValue("peer_key")
                  .jsonPrimitive.content
              approvedDescriptor = descriptorFor(requireNotNull(redemptionPeer))
              "{}"
            } else {
              assertEquals("GET", request.method)
              assertTrue(request.url.encodedPath.endsWith("/node/descriptor"))
              descriptorRequested.complete(Unit)
              check(releaseApproval.await(5, TimeUnit.SECONDS)) { "Approval fixture was not released" }
              requireNotNull(approvedDescriptor)
            }
          Response
            .Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(200)
            .message("OK")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()
        }.build()
    ReflectionHelpers.setField(discovery, "client", discoveryClient)
  }

  @After
  fun tearDown() {
    releaseApproval.countDown()
    viewModels.clear()
    closeNodeRuntimeTestFixture(runtime)
    bindNodeRuntimeTestFixture(app, originalRuntime)
    discoveryClient.dispatcher.executorService.shutdown()
    assertTrue(discoveryClient.dispatcher.executorService.awaitTermination(5, TimeUnit.SECONDS))
    discoveryClient.connectionPool.evictAll()
    alphaServer.shutdown()
    NodeForegroundService.resume(app, startNow = false)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
  }

  @Test fun approvalDefersSwitchForAnImportStartedWhileWaiting() = assertDeferredHandoff(PendingWork.Import)

  @Test fun approvalDefersSwitchForASendStartedWhileWaiting() = assertDeferredHandoff(PendingWork.Send)

  @Test fun approvalDefersSwitchForAudioStartedWhileWaiting() = assertDeferredHandoff(PendingWork.Audio)

  private enum class PendingWork { Import, Send, Audio }

  private fun assertDeferredHandoff(work: PendingWork) {
    val enrollment = beginWaitingForApproval()
    val owner = model.captureChatShareOwner()
    model.chatComposerState.textDrafts[owner] = "Keep this conversation"
    val finishWork: () -> Unit =
      when (work) {
        PendingWork.Import -> {
          val media = requireNotNull(model.chatComposerState.beginMediaAcquisition(owner))
          val importing = requireNotNull(model.chatComposerState.beginMediaImport(owner, media, model.mainSessionKey.value))
          val finish = { model.chatComposerState.cancelMediaImport(importing) }
          finish
        }

        PendingWork.Send -> {
          val send = requireNotNull(model.chatComposerState.beginSend(owner).request)
          val finish = {
            model.chatComposerState.completeSend(send, false)
            model.acknowledgeChatComposerSendAdmission(owner, send.commandId)
          }
          finish
        }

        PendingWork.Audio -> {
          assertTrue(runtime.tryAcquireVoiceNoteMic())
          runtime::releaseVoiceNoteMic
        }
      }
    val saved =
      try {
        approveAndJoin(enrollment)
        assertNull(runtime.openClawIdEnrollment.value.error)
        assertTrue(runtime.openClawIdEnrollment.value.admitted)
        assertUnchangedFocus()
        assertEquals(owner, model.captureChatShareOwner())
        assertEquals(if (work == PendingWork.Send) "" else "Keep this conversation", model.chatComposerState.textDrafts[owner])
        assertTrue(if (work == PendingWork.Audio) runtime.hasActiveGatewaySwitchAudio() else model.chatComposerState.hasPendingGatewaySwitchWork(owner))
        assertTrue(ShadowToast.getTextOfLatestToast().contains(if (work == PendingWork.Audio) "Finish recording" else "Finish importing"))
        val saved =
          prefs.gatewayRegistry.entries.value
            .single { it.kind == GatewayRegistryEntryKind.OPENCLAW_ID_NODE }
        assertFalse(saved.stableId in prefs.gatewayRegistry.connectedStableIds.value)
        // Reopen from SecurePrefs bytes: declined switching must not lose admitted W or its target.
        val reopened = OpenClawIdNodeStore(prefs::getString) { key, value -> prefs.commitSecureStrings(mapOf(key to value)) }
        assertTrue(requireNotNull(reopened.target(saved.stableId)).admitted)
        val seed = reopened.seed(saved.stableId)
        try {
          OpenClawIdEnrollmentSigner(seed).use { assertEquals(redemptionPeer, it.peerKey) }
        } finally {
          seed.fill(0)
        }
        saved
      } finally {
        finishWork()
      }
    assertEquals("Keep this conversation", model.chatComposerState.textDrafts[owner])
    model.switchGatewayFromSidebar(saved.stableId)
    awaitHandoff(saved.stableId)
  }

  @Test
  fun approvalHandsOffThroughTheQuickSwitchOwnerWhenIdle() {
    approveAndJoin(beginWaitingForApproval())
    assertNull(runtime.openClawIdEnrollment.value.error)
    assertTrue(runtime.openClawIdEnrollment.value.admitted)
    val saved =
      prefs.gatewayRegistry.entries.value
        .single { it.kind == GatewayRegistryEntryKind.OPENCLAW_ID_NODE }
    awaitHandoff(saved.stableId)
  }

  @Test
  fun cancellationWhileWaitingDoesNotRegisterOrSwitch() {
    val enrollment = beginWaitingForApproval()
    model.cancelOpenClawIdEnrollment()
    approveAndJoin(enrollment)
    assertUnchangedFocus()
    assertFalse(runtime.openClawIdEnrollment.value.admitted)
    assertFalse(
      prefs.gatewayRegistry.entries.value
        .any { it.kind == GatewayRegistryEntryKind.OPENCLAW_ID_NODE },
    )
  }

  @Test
  fun clearingTheViewModelRetiresThePendingHandoff() {
    val enrollment = beginWaitingForApproval()
    viewModels.clear()
    approveAndJoin(enrollment)
    assertUnchangedFocus()
    assertFalse(
      prefs.gatewayRegistry.entries.value
        .any { it.kind == GatewayRegistryEntryKind.OPENCLAW_ID_NODE },
    )
  }

  @Test
  fun stoppingTheServiceWhileWaitingCannotBeUndoneByApproval() {
    val enrollment = beginWaitingForApproval()
    model.disconnect()
    approveAndJoin(enrollment)
    assertFalse(app.nodeServiceStartAllowed)
    assertEquals(alpha.stableId, prefs.gatewayRegistry.activeStableId.value)
    assertEquals(0, nativeBinds.get())
    assertFalse(
      prefs.gatewayRegistry.entries.value
        .any { it.kind == GatewayRegistryEntryKind.OPENCLAW_ID_NODE },
    )
  }

  private fun beginWaitingForApproval(): Job {
    model.beginOpenClawIdEnrollment(link, origin)
    val enrollment = requireNotNull(ReflectionHelpers.getField<Job?>(controller, "enrollmentJob"))
    drainWithMainLooper { withTimeout(5_000) { descriptorRequested.await() } }
    assertTrue(runtime.openClawIdEnrollment.value.waiting)
    assertNotNull(runtime.openClawIdEnrollment.value.verificationCode)
    assertUnchangedFocus()
    return enrollment
  }

  private fun approveAndJoin(enrollment: Job) {
    releaseApproval.countDown()
    drainWithMainLooper { withTimeout(5_000) { enrollment.join() } }
  }

  private fun assertUnchangedFocus() {
    assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
    assertFalse(runtime.gatewayConnectionHandoff.value.pending)
    assertEquals(alpha.stableId, prefs.gatewayRegistry.activeStableId.value)
    assertEquals(0, nativeBinds.get())
  }

  private fun awaitHandoff(stableId: String) {
    drainWithMainLooper {
      withTimeout(5_000) {
        runtime.gatewayConnectionHandoff.first { !it.pending && it.focusedStableId == stableId }
        assertEquals(
          statement("ServerBinding")
            .getValue("body")
            .jsonObject
            .getValue("k_srv")
            .jsonPrimitive.content,
          nativeDial.await(),
        )
      }
    }
    assertEquals(stableId, prefs.gatewayRegistry.activeStableId.value)
    assertEquals(1, nativeBinds.get())
  }

  private fun statement(type: String): JsonObject =
    vectors
      .getValue("valid")
      .jsonArray
      .map { it.jsonObject.getValue("statement").jsonObject }
      .first { it.getValue("type") == JsonPrimitive(type) }

  private fun descriptorFor(peerKey: String): String {
    val now = System.currentTimeMillis() / 1_000
    val binding = statement("ServerBinding")
    val gatewaySeed =
      OpenClawIdEnrollmentCrypto.unhex(
        vectors
          .getValue("keys")
          .jsonObject
          .getValue("gateway")
          .jsonObject
          .getValue("seed_hex")
          .jsonPrimitive.content,
      )
    val snapshot =
      OpenClawIdEnrollmentSigner(gatewaySeed).use {
        it.statement(
          "MembershipSnapshot",
          JsonObject(statement("MembershipSnapshot").getValue("body").jsonObject + mapOf("issued_at" to JsonPrimitive(now), "node_peer_keys" to JsonArray(listOf(JsonPrimitive(peerKey))))),
        )
      }
    gatewaySeed.fill(0)
    return JsonObject(
      mapOf(
        "descriptor" to JsonObject(mapOf("v" to JsonPrimitive(1), "claw_id" to binding.getValue("body").jsonObject.getValue("claw_id"), "transport" to JsonPrimitive("iroh"), "relay_url" to JsonPrimitive("https://relay.example.test/"), "root_pub" to vectors.getValue("kit").jsonObject.getValue("root_pub"), "binding" to binding, "published_at" to JsonPrimitive(now))),
        "snapshot" to snapshot,
      ),
    ).toString()
  }
}
