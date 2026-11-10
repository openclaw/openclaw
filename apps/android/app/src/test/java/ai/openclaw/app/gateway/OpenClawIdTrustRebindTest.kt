package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

// Re-bind and J5: only R-signed bindings raise binding_seq, and snapshot order is per K_gw.
class OpenClawIdTrustRebindTest {
  private val vectors = OpenClawIdCanonical.json.parseToJsonElement(requireNotNull(javaClass.getResource("/openclaw-id-statements.json")).readText()).jsonObject
  private val now = vectors.getValue("now").jsonPrimitive.content.toLong()
  private val statements = vectors.getValue("valid").jsonArray.map { it.jsonObject.getValue("statement").jsonObject }
  private val binding1 = statements.first { it["type"] == JsonPrimitive("ServerBinding") }
  private val snapshot1 = statements.first { it["type"] == JsonPrimitive("MembershipSnapshot") }
  private val pin = OpenClawIdTrustPin(body(binding1).getValue("claw_id").jsonPrimitive.content, vectors.getValue("kit").jsonObject.getValue("root_fp").jsonPrimitive.content, body(binding1).getValue("hostname").jsonPrimitive.content)
  private val nodePeer = key("node", "iroh")

  private fun key(
    name: String,
    form: String,
  ) = vectors.getValue("keys").jsonObject.getValue(name).jsonObject.getValue(form).jsonPrimitive.content

  private fun body(statement: JsonObject) = statement.getValue("body").jsonObject

  private fun sign(
    seedHex: String,
    type: String,
    body: JsonObject,
  ): JsonObject {
    val seed = OpenClawIdEnrollmentCrypto.unhex(seedHex)
    return try {
      OpenClawIdEnrollmentSigner(seed).use { it.statement(type, body) }
    } finally {
      seed.fill(0)
    }
  }

  private fun binding(
    seq: Int,
    gateway: String,
  ) = sign(vectors.getValue("kit").jsonObject.getValue("root_seed_hex").jsonPrimitive.content, "ServerBinding", JsonObject(body(binding1) + mapOf("binding_seq" to JsonPrimitive(seq), "k_gw" to JsonPrimitive(key(gateway, "ed25519")))))

  private fun snapshot(
    gateway: String,
    seq: Int,
    bindingSeq: Int,
    issuedAt: Long = now,
  ) = sign(key(gateway, "seed_hex"), "MembershipSnapshot", JsonObject(body(snapshot1) + mapOf("seq" to JsonPrimitive(seq), "binding_seq" to JsonPrimitive(bindingSeq), "issued_at" to JsonPrimitive(issuedAt))))

  private fun response(
    binding: JsonObject,
    snapshot: JsonObject,
  ) = JsonObject(
    mapOf(
      "descriptor" to JsonObject(mapOf("v" to JsonPrimitive(1), "claw_id" to JsonPrimitive(pin.clawId), "transport" to JsonPrimitive("iroh"), "relay_url" to JsonPrimitive("https://relay.example.test/"), "root_pub" to vectors.getValue("kit").jsonObject.getValue("root_pub"), "binding" to binding, "published_at" to JsonPrimitive(now))),
      "snapshot" to snapshot,
    ),
  )

  private fun verify(
    binding: JsonObject,
    snapshot: JsonObject,
    stored: OpenClawIdTrustState?,
    at: Long = now,
  ) = OpenClawIdTrust.verify(response(binding, snapshot), pin, nodePeer, stored, at)

  @Test fun snapshotNamingAnUnverifiedBindingIsRefusedAndNothingOfItKept() {
    val admitted = verify(binding1, snapshot("gateway", 2, 1), null)
    assertNotNull(admitted.target)
    // K_gw alone signs binding_seq 9 under binding 1: before J5 this raised the high-water for good.
    val inflated = verify(binding1, snapshot("gateway", 50, 9, now + 1), admitted.state, now + 1)
    assertEquals("snapshot_ahead", inflated.failure)
    assertEquals(admitted.state, inflated.state)
    // An honest re-bind to binding 2 under new keys is then dialed.
    val rebound = verify(binding(2, "invitee"), snapshot("invitee", 1, 2, now + 2), inflated.state, now + 2)
    assertNotNull(rebound.target)
    assertEquals(2L, rebound.state!!.snapshotBindingSeq)
  }

  @Test fun newGatewayKeyRestartsOrderOnlyUnderANewerVerifiedBinding() {
    val old = verify(binding1, snapshot("gateway", 7, 1), null).state
    // The new K_gw starts its own order at seq 1, below the old key's 7: not a replay.
    val rebound = verify(binding(2, "invitee"), snapshot("invitee", 1, 2, now + 1), old, now + 1)
    assertNotNull(rebound.target)
    assertEquals(OpenClawIdTrustState(pin, 2, 1, now + 1, 2, key("invitee", "ed25519")), rebound.state)
    assertEquals("snapshot_replayed", verify(binding(2, "invitee"), snapshot("invitee", 1, 2, now), rebound.state, now + 2).failure)
    // The retired binding and key are refused, and they do not move the marker back.
    val retired = verify(binding1, snapshot("gateway", 8, 1, now + 3), rebound.state, now + 3)
    assertEquals("binding_rollback", retired.failure)
    assertEquals(rebound.state, retired.state)
  }

  @Test fun legacyMarkerIsCappedAtThePinAndLosesItsOrderOnLoad() {
    val memory = mutableMapOf<String, String>()
    val store =
      OpenClawIdNodeStore(memory::get) { k, value ->
        if (value == null) memory.remove(k) else memory[k] = value
        true
      }
    val target = store.prepare(OpenClawIdEnrollment.parse(vectors.getValue("node_invite").jsonObject.getValue("link").jsonPrimitive.content, "https://discovery.example.test"))
    val storageKey = memory.keys.single()
    val record = OpenClawIdCanonical.json.parseToJsonElement(memory.getValue(storageKey)).jsonObject
    // Saved by the previous build: no key, binding_seq 9 from an inflated snapshot, seq 50.
    val legacy = JsonObject(mapOf("binding" to JsonPrimitive(1), "seq" to JsonPrimitive(50), "issued" to JsonPrimitive(now), "snapshotBinding" to JsonPrimitive(9)))
    memory[storageKey] = JsonObject(record + ("trust" to legacy)).toString()
    val loaded = store.target(target.stableId)!!.trust!!
    assertEquals(OpenClawIdTrustState(target.pin, 1, 0, 0, 1, null), loaded)
    // Before the clamp this was stale_binding (9 > 2) and snapshot_replayed (1 < 50) forever.
    val rebound = verify(binding(2, "invitee"), snapshot("invitee", 1, 2, now + 1), loaded.copy(pin = pin), now + 1)
    assertNull(rebound.failure)
  }
}
