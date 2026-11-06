package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.SecureRandom

/** All fields, including W, live in the app's existing Keystore-backed secure preference owner. */
internal class OpenClawIdNodeStore(
  private val load: (String) -> String?,
  private val commit: (String, String?) -> Boolean,
) {
  class Target(
    val pin: OpenClawIdTrustPin,
    val discoveryOrigin: String,
    val relayUrl: String,
    val trust: OpenClawIdTrustState?,
    val admitted: Boolean,
  ) {
    val stableId: String get() = "openclaw-id|${pin.clawId}|${pin.rootFingerprint.substringAfter(':')}"
    val descriptorPath: String get() = "/v1/claws/${pin.clawId}/node/descriptor"
  }

  private fun storageKey(stableId: String) = "node.openclaw-id.$stableId"

  @Synchronized fun target(stableId: String): Target? {
    val record = read(stableId) ?: return null
    val target = decodeTarget(record)
    require(target.stableId == stableId) { "invalid_node_target" }
    return target
  }

  @Synchronized fun prepare(enrollment: OpenClawIdEnrollment): Target {
    val proposed = Target(enrollment.pin, enrollment.discoveryOrigin, enrollment.relayHint, null, false)
    val previous = target(proposed.stableId)
    if (previous != null) {
      require(previous.pin == proposed.pin) { "node_target_changed" }
      if (previous.discoveryOrigin == proposed.discoveryOrigin) return previous
      // A failed first attempt must allow the user to correct a typo without losing W or rollback facts.
      require(!previous.admitted) { "node_target_changed" }
      val corrected = Target(previous.pin, proposed.discoveryOrigin, proposed.relayUrl, previous.trust, false)
      val record = checkNotNull(read(previous.stableId))
      check(commit(storageKey(previous.stableId), encode(corrected, OpenClawIdCanonical.text(record.getValue("seed"))))) { "node_storage_failed" }
      return corrected
    }
    val seed = ByteArray(32).also { SecureRandom().nextBytes(it) }
    try {
      check(commit(storageKey(proposed.stableId), encode(proposed, OpenClawIdEnrollmentCrypto.base64(seed)))) { "node_storage_failed" }
    } finally {
      seed.fill(0)
    }
    return proposed
  }

  /** The caller must erase the returned seed after constructing signer/native endpoint. */
  @Synchronized fun seed(stableId: String): ByteArray {
    val record = read(stableId) ?: error("node_key_missing")
    return OpenClawIdEnrollmentCrypto.decode64(OpenClawIdCanonical.text(record.getValue("seed")), 32)
  }

  @Synchronized fun assess(
    stableId: String,
    response: JsonObject,
    now: Long,
  ): Pair<Target, OpenClawIdTrustAssessment> {
    val record = read(stableId) ?: error("node_key_missing")
    val previous = decodeTarget(record)
    val seed = seed(stableId)
    val assessment =
      try {
        OpenClawIdEnrollmentSigner(seed).use { signer -> OpenClawIdTrust.verify(response, previous.pin, signer.peerKey, previous.trust, now) }
      } finally {
        seed.fill(0)
      }
    val updated = Target(previous.pin, previous.discoveryOrigin, assessment.target?.relayUrl ?: previous.relayUrl, assessment.state, previous.admitted || assessment.target != null)
    // Never expose a dial target before all advanced anti-rollback facts are durable.
    check(commit(storageKey(stableId), encode(updated, OpenClawIdCanonical.text(record.getValue("seed"))))) { "node_storage_failed" }
    return updated to assessment
  }

  @Synchronized fun forget(stableId: String) {
    check(commit(storageKey(stableId), null)) { "node_storage_failed" }
  }

  private fun read(stableId: String): JsonObject? {
    val raw = load(storageKey(stableId)) ?: return null
    return try {
      OpenClawIdCanonical.obj(OpenClawIdCanonical.json.parseToJsonElement(raw), "claw", "root", "host", "discovery", "relay", "seed", "admitted", "trust")
    } catch (_: Exception) {
      // Parser diagnostics can include the encrypted record's decoded W; keep only a stable error.
      throw IllegalStateException("node_storage_invalid")
    }
  }

  private fun decodeTarget(value: JsonObject): Target {
    val pin = OpenClawIdTrustPin(text(value, "claw"), text(value, "root"), text(value, "host"))
    val trustValue = value.getValue("trust")
    val trust =
      if (trustValue == kotlinx.serialization.json.JsonNull) {
        null
      } else {
        val state = OpenClawIdCanonical.obj(trustValue, "binding", "seq", "issued", "snapshotBinding")
        OpenClawIdTrustState(pin, number(state, "binding"), number(state, "seq"), number(state, "issued"), number(state, "snapshotBinding"))
      }
    val admitted = value.getValue("admitted")
    require(admitted == kotlinx.serialization.json.JsonPrimitive(true) || admitted == kotlinx.serialization.json.JsonPrimitive(false)) { "invalid_node_target" }
    return Target(pin, OpenClawIdTrustUrls.https(text(value, "discovery"), true), OpenClawIdTrustUrls.https(text(value, "relay")), trust, admitted == kotlinx.serialization.json.JsonPrimitive(true))
  }

  private fun encode(
    target: Target,
    seed: String,
  ): String =
    OpenClawIdCanonical.encode(
      buildJsonObject {
        put("claw", target.pin.clawId)
        put("root", target.pin.rootFingerprint)
        put("host", target.pin.hostname)
        put("discovery", target.discoveryOrigin)
        put("relay", target.relayUrl)
        put("seed", seed)
        put("admitted", target.admitted)
        put(
          "trust",
          target.trust?.let { trust ->
            buildJsonObject {
              put("binding", trust.bindingSeq)
              put("seq", trust.snapshotSeq)
              put("issued", trust.snapshotIssuedAt)
              put("snapshotBinding", trust.snapshotBindingSeq)
            }
          } ?: kotlinx.serialization.json.JsonNull,
        )
      },
    )

  private fun text(
    value: JsonObject,
    key: String,
  ) = OpenClawIdCanonical.text(value.getValue(key))

  private fun number(
    value: JsonObject,
    key: String,
  ) = OpenClawIdCanonical.integer(value.getValue(key))
}
