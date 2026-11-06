package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OpenClawIdNodeStoreTest {
  private val vectors = OpenClawIdCanonical.json.parseToJsonElement(requireNotNull(javaClass.getResource("/openclaw-id-statements.json")).readText()).jsonObject
  private val link =
    vectors
      .getValue("node_invite")
      .jsonObject
      .getValue("link")
      .jsonPrimitive.content

  private fun input(origin: String = "https://discovery.example.test") = OpenClawIdEnrollment.parse(link, origin)

  @Test fun committedSeedIsReusedAndPersistenceFailureCannotCreateUsableTarget() {
    val memory = mutableMapOf<String, String>()
    var writable = true
    val store =
      OpenClawIdNodeStore(memory::get) { key, value ->
        if (!writable) {
          false
        } else {
          if (value == null) memory.remove(key) else memory[key] = value
          true
        }
      }
    writable = false
    assertThrows(IllegalStateException::class.java) { store.prepare(input()) }
    assertTrue(memory.isEmpty())
    writable = true
    val target = store.prepare(input())
    val first = store.seed(target.stableId)
    assertEquals(32, first.size)
    assertFalse(target.admitted)
    store.prepare(input())
    assertArrayEquals(first, store.seed(target.stableId))
    val corrected = store.prepare(input("https://other-discovery.example.test"))
    assertEquals("https://other-discovery.example.test", corrected.discoveryOrigin)
    assertArrayEquals(first, store.seed(target.stableId))
    writable = false
    assertThrows(IllegalStateException::class.java) { store.forget(target.stableId) }
    assertArrayEquals(first, store.seed(target.stableId))
    writable = true
    store.forget(target.stableId)
    assertNull(store.target(target.stableId))
  }

  @Test fun signedAssessmentIsNotPublishedUnlessAdvancedTrustIsCommitted() {
    val memory = mutableMapOf<String, String>()
    var writable = true
    val store =
      OpenClawIdNodeStore(memory::get) { key, value ->
        if (!writable) {
          false
        } else {
          if (value == null) memory.remove(key) else memory[key] = value
          true
        }
      }
    val target = store.prepare(input())
    val storageKey = memory.keys.single()
    val record = OpenClawIdCanonical.json.parseToJsonElement(memory.getValue(storageKey)).jsonObject
    val seed =
      OpenClawIdEnrollmentCrypto.unhex(
        vectors
          .getValue("keys")
          .jsonObject
          .getValue("node")
          .jsonObject
          .getValue("seed_hex")
          .jsonPrimitive.content,
      )
    memory[storageKey] = JsonObject(record + ("seed" to JsonPrimitive(OpenClawIdEnrollmentCrypto.base64(seed)))).toString()
    val statements = vectors.getValue("valid").jsonArray.map { it.jsonObject.getValue("statement").jsonObject }
    val now =
      vectors
        .getValue("now")
        .jsonPrimitive.content
        .toLong()
    val response =
      JsonObject(
        mapOf(
          "descriptor" to JsonObject(mapOf("v" to JsonPrimitive(1), "claw_id" to JsonPrimitive(target.pin.clawId), "transport" to JsonPrimitive("iroh"), "relay_url" to JsonPrimitive(target.relayUrl), "root_pub" to vectors.getValue("kit").jsonObject.getValue("root_pub"), "binding" to statements.first { it["type"] == JsonPrimitive("ServerBinding") }, "published_at" to JsonPrimitive(now))),
          "snapshot" to statements.first { it["type"] == JsonPrimitive("MembershipSnapshot") },
        ),
      )
    writable = false
    assertThrows(IllegalStateException::class.java) { store.assess(target.stableId, response, now) }
    assertFalse(store.target(target.stableId)!!.admitted)
    writable = true
    assertNotNull(store.assess(target.stableId, response, now).second.target)
    assertTrue(store.target(target.stableId)!!.admitted)
    assertThrows(IllegalArgumentException::class.java) { store.prepare(input("https://other-discovery.example.test")) }
    assertEquals(2L, store.target(target.stableId)!!.trust!!.snapshotSeq)
  }
}
