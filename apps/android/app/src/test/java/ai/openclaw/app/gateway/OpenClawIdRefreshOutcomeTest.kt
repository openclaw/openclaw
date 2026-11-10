package ai.openclaw.app.gateway

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/** Controller.refresh -> real Discovery HTTP decoding/signing -> verifier -> durable store. */
class OpenClawIdRefreshOutcomeTest {
  private val vectors = OpenClawIdCanonical.json.parseToJsonElement(requireNotNull(javaClass.getResource("/openclaw-id-statements.json")).readText()).jsonObject
  private val now = System.currentTimeMillis() / 1_000
  private val statements = vectors.getValue("valid").jsonArray.map { it.jsonObject.getValue("statement").jsonObject }
  private val binding = statements.first { it["type"] == JsonPrimitive("ServerBinding") }
  private val snapshot = statements.first { it["type"] == JsonPrimitive("MembershipSnapshot") }

  private fun key(name: String) =
    vectors
      .getValue("keys")
      .jsonObject
      .getValue(name)
      .jsonObject
      .getValue("seed_hex")
      .jsonPrimitive.content

  private fun response(
    seq: Int,
    admitted: Boolean = true,
    claimedBinding: Int = 1,
  ): JsonObject {
    val seed = OpenClawIdEnrollmentCrypto.unhex(key("gateway"))
    val body =
      JsonObject(
        snapshot.getValue("body").jsonObject +
          mapOf(
            "seq" to JsonPrimitive(seq),
            "issued_at" to JsonPrimitive(now),
            "binding_seq" to JsonPrimitive(claimedBinding),
          ) + if (admitted) emptyMap() else mapOf("node_peer_keys" to JsonArray(emptyList())),
      )
    val signed =
      try {
        OpenClawIdEnrollmentSigner(seed).use { it.statement("MembershipSnapshot", body) }
      } finally {
        seed.fill(0)
      }
    return JsonObject(
      mapOf(
        "descriptor" to JsonObject(mapOf("v" to JsonPrimitive(1), "claw_id" to binding.getValue("body").jsonObject.getValue("claw_id"), "transport" to JsonPrimitive("iroh"), "relay_url" to JsonPrimitive("https://relay.example.test/"), "root_pub" to vectors.getValue("kit").jsonObject.getValue("root_pub"), "binding" to binding, "published_at" to JsonPrimitive(now))),
        "snapshot" to signed,
      ),
    )
  }

  private class Fixture(
    val memory: MutableMap<String, String>,
    val store: OpenClawIdNodeStore,
    val id: String,
  )

  private fun fixture(): Fixture {
    val memory = mutableMapOf<String, String>()
    val store = reopen(memory)
    val link =
      vectors
        .getValue("node_invite")
        .jsonObject
        .getValue("link")
        .jsonPrimitive.content
    val enrollment = OpenClawIdEnrollment.parse(link, "https://discovery.example.test")
    val target =
      try {
        store.prepare(enrollment)
      } finally {
        enrollment.close()
      }
    // Import the synthetic fixture node's W, so the signed snapshot admits this exact store owner.
    val storageKey = memory.keys.single()
    val record = OpenClawIdCanonical.json.parseToJsonElement(memory.getValue(storageKey)).jsonObject
    val seed = OpenClawIdEnrollmentCrypto.unhex(key("node"))
    try {
      memory[storageKey] = JsonObject(record + ("seed" to JsonPrimitive(OpenClawIdEnrollmentCrypto.base64(seed)))).toString()
    } finally {
      seed.fill(0)
    }
    assertNotNull(store.assess(target.stableId, response(2), now).second.target)
    return Fixture(memory, store, target.stableId)
  }

  private fun reopen(memory: MutableMap<String, String>) =
    OpenClawIdNodeStore(memory::get) { key, value ->
      if (value == null) memory.remove(key) else memory[key] = value
      true
    }

  // Only HTTP I/O is fixed. Controller decisions, JSON decoding, signature verification and the
  // state owner all run as in production; no callback supplies an assessment or removal verdict.
  private fun discovery(reply: (okhttp3.Request) -> Response) =
    OpenClawIdDiscovery(
      OkHttpClient.Builder().addInterceptor(Interceptor { chain -> reply(chain.request()) }).build(),
    )

  private fun http(
    request: okhttp3.Request,
    status: Int,
    body: String,
  ) = Response
    .Builder()
    .request(request)
    .protocol(Protocol.HTTP_1_1)
    .code(status)
    .message("fixture")
    .body(body.toResponseBody("application/json".toMediaType()))
    .build()

  @Test fun unsignedHttpAndNetworkFailuresNeverRemoveOrRewriteRetainedTrust() =
    runTest {
      val fixture = fixture()
      val before = fixture.memory.toMap()
      for (status in listOf(403, 404, 500, 503, 0)) {
        val controller =
          OpenClawIdNodeController(
            this,
            fixture.store,
            discovery { request ->
              assertEquals("GET", request.method)
              assertEquals("/v1/claws/${fixture.store.target(fixture.id)!!.pin.clawId}/node/descriptor", request.url.encodedPath)
              assertNotNull(request.header("OpenClaw-Signature"))
              if (status == 0) throw IOException("offline")
              http(request, status, "{\"error\":{\"code\":\"unavailable\"}}")
            },
          )
        val failure = runCatching { controller.refresh(fixture.id) }.exceptionOrNull()
        assertTrue(failure is OpenClawIdDiscoveryFailure)
        assertEquals(status, (failure as OpenClawIdDiscoveryFailure).status)
        assertEquals(before, fixture.memory)
        assertEquals(fixture.store.target(fixture.id)!!.trust, reopen(fixture.memory).target(fixture.id)!!.trust)
      }
    }

  @Test fun verifiedRemovalPersistsBeforeThrowAndBlocksReplayAfterReopen() =
    runTest {
      val fixture = fixture()
      var body = response(3, admitted = false)
      val client = discovery { http(it, 200, body.toString()) }
      val failure = runCatching { OpenClawIdNodeController(this, fixture.store, client).refresh(fixture.id) }.exceptionOrNull()
      assertTrue(failure is OpenClawIdRemovedException)
      val reopened = reopen(fixture.memory)
      assertEquals(3L, reopened.target(fixture.id)!!.trust!!.snapshotSeq)
      assertEquals(1L, reopened.target(fixture.id)!!.trust!!.bindingSeq)
      body = response(2)
      val replay = runCatching { OpenClawIdNodeController(this, reopened, client).refresh(fixture.id) }.exceptionOrNull()
      assertTrue(replay is IllegalStateException)
      assertEquals("node_evidence_refused", replay?.message)
      assertEquals(3L, reopened.target(fixture.id)!!.trust!!.snapshotSeq)
      body = response(4)
      assertNotNull(OpenClawIdNodeController(this, reopened, client).refresh(fixture.id))
      assertEquals(4L, reopened.target(fixture.id)!!.trust!!.snapshotSeq)
    }

  @Test fun snapshotAheadIsRefusedWithoutPoisoningTheStore() =
    runTest {
      val fixture = fixture()
      val before = fixture.memory.toMap()
      val controller = OpenClawIdNodeController(this, fixture.store, discovery { http(it, 200, response(50, claimedBinding = 9).toString()) })
      val failure = runCatching { controller.refresh(fixture.id) }.exceptionOrNull()
      assertEquals("node_evidence_refused", failure?.message)
      assertEquals(before, fixture.memory)
    }
}
