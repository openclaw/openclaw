package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenClawIdEnrollmentTest {
  private val vectors = OpenClawIdCanonical.json.parseToJsonElement(requireNotNull(javaClass.getResource("/openclaw-id-statements.json")).readText()).jsonObject
  private val now =
    vectors
      .getValue("now")
      .jsonPrimitive.content
      .toLong()
  private val link =
    vectors
      .getValue("node_invite")
      .jsonObject
      .getValue("link")
      .jsonPrimitive.content
  private val origin = "https://discovery.example.test"
  private val description = OpenClawIdEnrollmentDescription("Build node", "linux", listOf("system.run"), listOf("system"))

  private fun signer(name: String) =
    OpenClawIdEnrollmentSigner(
      OpenClawIdEnrollmentCrypto.unhex(
        vectors
          .getValue("keys")
          .jsonObject
          .getValue(name)
          .jsonObject
          .getValue("seed_hex")
          .jsonPrimitive.content,
      ),
    )

  private fun statement(type: String) =
    vectors
      .getValue("valid")
      .jsonArray
      .map { it.jsonObject.getValue("statement").jsonObject }
      .first { it.getValue("type") == JsonPrimitive(type) }

  private fun response(): JsonObject {
    val enrollment = OpenClawIdEnrollment.parse(link, origin)
    return JsonObject(
      mapOf(
        "descriptor" to
          JsonObject(
            mapOf(
              "v" to JsonPrimitive(1),
              "claw_id" to JsonPrimitive(enrollment.pin.clawId),
              "transport" to JsonPrimitive("iroh"),
              "relay_url" to JsonPrimitive("https://relay.example.test/"),
              "root_pub" to vectors.getValue("kit").jsonObject.getValue("root_pub"),
              "binding" to statement("ServerBinding"),
              "published_at" to JsonPrimitive(now),
            ),
          ),
        "snapshot" to statement("MembershipSnapshot"),
      ),
    )
  }

  private fun assess(
    raw: JsonObject = response(),
    state: OpenClawIdTrustState? = null,
    at: Long = now,
  ) = signer("node").use {
    OpenClawIdTrust.verify(raw, OpenClawIdEnrollment.parse(link, origin).pin, it.peerKey, state, at)
  }

  private fun changedSnapshot(vararg values: Pair<String, kotlinx.serialization.json.JsonElement>): JsonObject {
    val body = JsonObject(statement("MembershipSnapshot").getValue("body").jsonObject + values.toMap())
    return signer("gateway").use { JsonObject(response() + ("snapshot" to it.statement("MembershipSnapshot", body))) }
  }

  @Test fun matchesPublishedRedemptionProofSignatureAndCode() {
    signer("node").use { signer ->
      OpenClawIdEnrollment.parse(link, origin).use { input ->
        val prepared = input.prepare(signer, description, now)
        assertEquals("168017", prepared.verificationCode)
        assertEquals(statement("NodeRedemption"), prepared.redemption)
        assertEquals("/v1/claws/${input.pin.clawId}/mailbox/node", input.mailPath)
        assertEquals(
          prepared.redemption,
          OpenClawIdCanonical.json
            .parseToJsonElement(prepared.mailBytes().decodeToString())
            .jsonObject
            .getValue("payload")
            .jsonObject
            .getValue("redemption"),
        )
        assertFalse(prepared.mailBytes().decodeToString().contains("KioqKioq"))
        assertThrows(IllegalStateException::class.java) { input.prepare(signer, description, now) }
      }
    }
  }

  @Test fun rejectsAmbiguousLinksAndRequiresIndependentHttpsOrigin() {
    val invalid = listOf(link + "&i=duplicate", link + "&extra=x", link.replace("join#", "join/#"), link.replace("join#", "join?x=1#"), link.replace("join#", "u@join#"), link.replace("KioqKio&", "KioqKip&"), link.replace("https%3A", "http%3A"))
    invalid.forEach { value ->
      val error = assertThrows(IllegalArgumentException::class.java) { OpenClawIdEnrollment.parse(value, origin) }
      assertEquals("invalid_enrollment_inputs", error.message)
      assertNull(error.cause)
    }
    listOf("", "http://localhost", "$origin/path", "$origin?x", "$origin#x", "https://user@discovery.example.test").forEach {
      assertThrows(IllegalArgumentException::class.java) { OpenClawIdEnrollment.parse(link, it) }
    }
    assertEquals(origin, OpenClawIdEnrollment.parse(link, "$origin/").discoveryOrigin)
  }

  @Test fun validatesActualManifestWithoutReorderingOrDuplicateSurface() {
    listOf("\u0000", "\u007f", "\ud800", "x".repeat(129), "").forEach {
      assertThrows(IllegalArgumentException::class.java) { OpenClawIdEnrollmentDescription(it, "android", emptyList(), emptyList()) }
    }
    assertThrows(IllegalArgumentException::class.java) { OpenClawIdEnrollmentDescription("Phone", "android", listOf("camera.snap", "camera.snap"), emptyList()) }
    val ordered = OpenClawIdEnrollmentDescription("Phone 😀", "android", listOf("z", "a"), emptyList())
    assertEquals(JsonArray(listOf(JsonPrimitive("z"), JsonPrimitive("a"))), ordered.body.getValue("commands"))
  }

  @Test fun authenticatesExactRequestAndClosesSigner() {
    val signer = signer("node")
    val bytes = "{\"test\":true}".toByteArray()
    val path = "/v1/claws/abc/mailbox/node"
    val header = signer.requestSignature("post", path, bytes, now)
    val canonical = "{\"body_sha256\":\"${OpenClawIdEnrollmentCrypto.hex(OpenClawIdEnrollmentCrypto.sha256(bytes))}\",\"method\":\"POST\",\"path\":\"$path\",\"ts\":$now}"
    val input = "openclaw/discovery-request/v1\u0000$canonical".toByteArray()
    assertTrue(OpenClawIdEnrollmentCrypto.verify(signer.publicKey, input, header.substringAfter("sig=")))
    assertNotEquals(header, signer.requestSignature("POST", path, bytes + 32.toByte(), now))
    assertNotEquals(header, signer.requestSignature("POST", "$path?x=1", bytes, now))
    signer.close()
    assertThrows(IllegalStateException::class.java) { signer.requestSignature("POST", path, bytes, now) }
  }

  @Test fun verifiesFixtureBindingSnapshotAndMembershipBeforeDial() {
    val result = assess()
    assertNull(result.failure)
    assertNotNull(result.target)
    assertEquals(
      statement("ServerBinding")
        .getValue("body")
        .jsonObject
        .getValue("k_srv")
        .jsonPrimitive.content,
      result.target!!.serverKey,
    )
    assertEquals(2L, result.state!!.snapshotSeq)
    assertEquals("snapshot_stale", assess(at = now + 10801).failure)
    assertEquals("snapshot_future", assess(at = now - 3901).failure)
    assertEquals("node_not_admitted", assess(changedSnapshot("node_peer_keys" to JsonArray(emptyList()))).failure)
  }

  @Test fun persistsVerifiedRollbackEvidenceEvenWhenDialRefused() {
    val first = assess().state!!
    assertEquals("binding_rollback", assess(state = first.copy(bindingSeq = 2)).failure)
    assertEquals("snapshot_replayed", assess(state = first.copy(snapshotSeq = 3)).failure)
    val newerBinding = assess(changedSnapshot("binding_seq" to JsonPrimitive(2), "seq" to JsonPrimitive(3)))
    assertEquals("stale_binding", newerBinding.failure)
    assertEquals(2L, newerBinding.state!!.snapshotBindingSeq)
    assertEquals("stale_binding", assess(state = newerBinding.state).failure)
    val higherSeqOldBinding = assess(changedSnapshot("seq" to JsonPrimitive(4)), newerBinding.state)
    assertEquals("stale_binding", higherSeqOldBinding.failure)
    assertEquals(2L, higherSeqOldBinding.state!!.snapshotBindingSeq)
    val future = assess(changedSnapshot("issued_at" to JsonPrimitive(now + 301), "seq" to JsonPrimitive(99)), first)
    assertEquals("snapshot_future", future.failure)
    assertEquals(first.snapshotSeq, future.state!!.snapshotSeq)
  }

  @Test fun validatesEveryNestedFieldBeforeAcceptingEvenValidSignatures() {
    val invalid =
      listOf(
        changedSnapshot("members" to JsonArray(listOf(JsonObject(mapOf("account_id" to JsonPrimitive("bob"), "role" to JsonPrimitive("owner"), "peer_keys" to JsonArray(emptyList())))))),
        changedSnapshot("owner_devices" to JsonArray(listOf(JsonObject(mapOf("device_pub" to JsonPrimitive("invalid"), "caps" to JsonArray(emptyList())))))),
        changedSnapshot("protocols" to JsonObject(mapOf("statement" to JsonArray(listOf(JsonPrimitive(1), JsonPrimitive(1))), "descriptor" to JsonArray(listOf(JsonPrimitive(1)))))),
        changedSnapshot("extra" to JsonPrimitive(true)),
        changedSnapshot("node_peer_keys" to JsonArray(listOf(JsonPrimitive(signer("node").use { it.peerKey }), JsonPrimitive(signer("node").use { it.peerKey })))),
      )
    invalid.forEach { assertNull(assess(it).target) }
    val raw = response()
    val descriptor = raw.getValue("descriptor").jsonObject
    val tampered = JsonObject(raw + ("descriptor" to JsonObject(descriptor + ("binding" to JsonObject(statement("ServerBinding") + ("sig" to JsonPrimitive("A".repeat(86))))))))
    assertEquals("bad_signature", assess(tampered).failure)
    val pin = OpenClawIdEnrollment.parse(link, origin).pin
    signer("node").use {
      assertEquals("host_mismatch", OpenClawIdTrust.verify(raw, pin.copy(hostname = "elsewhere.test"), it.peerKey, null, now).failure)
      assertEquals("root_mismatch", OpenClawIdTrust.verify(raw, pin.copy(rootFingerprint = "fp:" + "0".repeat(64)), it.peerKey, null, now).failure)
    }
  }

  @Test fun canonicalizesProtocolIntegersAndUtf16Keys() {
    val value = OpenClawIdCanonical.json.parseToJsonElement("{\"z\":1e3,\"a\":-0,\"😀\":\"line\\nquote\\\"\",\"\\ue000\":true}")
    assertEquals("{\"a\":0,\"z\":1000,\"😀\":\"line\\nquote\\\"\",\"\ue000\":true}", OpenClawIdCanonical.encode(value))
    assertThrows(IllegalArgumentException::class.java) { OpenClawIdCanonical.encode(JsonPrimitive(1.5)) }
    assertThrows(IllegalArgumentException::class.java) { OpenClawIdCanonical.encode(JsonPrimitive("\ud800")) }
  }
}
