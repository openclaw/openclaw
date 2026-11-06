package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/** Invitation-pinned identity, scoped to the exact claw hostname (including port). */
data class OpenClawIdTrustPin(
  val clawId: String,
  val rootFingerprint: String,
  val hostname: String,
) {
  init {
    require(Regex("[0-9a-f]{32}").matches(clawId)) { "invalid_claw" }
    require(Regex("fp:[0-9a-f]{64}").matches(rootFingerprint)) { "invalid_pin" }
    require(OpenClawIdTrustUrls.hostname.matches(hostname)) { "invalid_hostname" }
  }
}

/** Persist atomically before dialing, including state returned with a refused assessment. */
data class OpenClawIdTrustState(
  val pin: OpenClawIdTrustPin,
  val bindingSeq: Long,
  val snapshotSeq: Long,
  val snapshotIssuedAt: Long,
  val snapshotBindingSeq: Long,
) {
  init {
    require(listOf(bindingSeq, snapshotSeq, snapshotIssuedAt, snapshotBindingSeq).all { it in 0..OpenClawIdCanonical.MAX_SAFE_INTEGER }) { "invalid_trust_state" }
  }
}

/** Dial facts exist only on an admitted, fresh, cryptographically verified assessment. */
class OpenClawIdTrustTarget internal constructor(
  val pin: OpenClawIdTrustPin,
  val serverKey: String,
  val gatewayKey: String,
  val relayUrl: String,
  val descriptor: JsonObject,
)

/** A refusal can still advance signed anti-rollback facts; the caller must persist state first. */
class OpenClawIdTrustAssessment internal constructor(
  val state: OpenClawIdTrustState?,
  val target: OpenClawIdTrustTarget?,
  val failure: String?,
)

/** Verify Discovery data without trusting routing, account state, or unsigned fields as authority. */
object OpenClawIdTrust {
  /** Require complete v1 schemas, root/K_gw signatures, pinned host, freshness and node membership. */
  fun verify(
    response: JsonObject,
    expectedPin: OpenClawIdTrustPin,
    peerKey: String,
    storedState: OpenClawIdTrustState?,
    now: Long,
  ): OpenClawIdTrustAssessment {
    require(now in 0..OpenClawIdCanonical.MAX_SAFE_INTEGER - 300) { "invalid_timestamp" }
    require(Regex("iroh:[0-9a-f]{64}").matches(peerKey)) { "invalid_peer" }
    require(storedState == null || storedState.pin == expectedPin) { "wrong_trust_scope" }
    var state = storedState
    return try {
      val root = OpenClawIdCanonical.obj(response, "descriptor", "snapshot")
      val descriptor = OpenClawIdCanonical.obj(root.getValue("descriptor"), "v", "claw_id", "transport", "relay_url", "root_pub", "binding", "published_at")
      require(OpenClawIdCanonical.integer(descriptor.getValue("v"), 1) == 1L) { "unsupported_version" }
      require(OpenClawIdCanonical.text(descriptor.getValue("transport")) == "iroh") { "invalid_transport" }
      require(OpenClawIdTrustSchema.id(descriptor.getValue("claw_id")) == expectedPin.clawId) { "wrong_claw" }
      OpenClawIdCanonical.integer(descriptor.getValue("published_at"))
      val relay = OpenClawIdTrustUrls.https(OpenClawIdCanonical.text(descriptor.getValue("relay_url")))
      val rootKey = OpenClawIdTrustSchema.key(descriptor.getValue("root_pub"), "ed25519")
      val fingerprint = "fp:" + OpenClawIdEnrollmentCrypto.hex(OpenClawIdEnrollmentCrypto.sha256(OpenClawIdEnrollmentCrypto.unhex(rootKey.substringAfter(':'))))
      require(fingerprint == expectedPin.rootFingerprint) { "root_mismatch" }
      val bindingEnvelope = OpenClawIdTrustSchema.envelope(descriptor.getValue("binding"), "ServerBinding")
      OpenClawIdTrustSchema.signature(bindingEnvelope, rootKey)
      val binding = bindingEnvelope.getValue("body").jsonObject
      require(binding.getValue("claw_id") == JsonPrimitive(expectedPin.clawId)) { "wrong_claw" }
      require(binding.getValue("hostname") == JsonPrimitive(expectedPin.hostname)) { "host_mismatch" }
      val bindingSeq = OpenClawIdCanonical.integer(binding.getValue("binding_seq"), 1)
      require(bindingSeq >= (state?.bindingSeq ?: 0)) { "binding_rollback" }
      // A verified binding advances its pin even if freshness is unavailable, as in verifyBindingForPin.
      state = OpenClawIdTrustState(expectedPin, bindingSeq, state?.snapshotSeq ?: 0, state?.snapshotIssuedAt ?: 0, state?.snapshotBindingSeq ?: 0)
      val snapshotEnvelope = OpenClawIdTrustSchema.envelope(root.getValue("snapshot"), "MembershipSnapshot")
      val gatewayKey = OpenClawIdCanonical.text(binding.getValue("k_gw"))
      OpenClawIdTrustSchema.signature(snapshotEnvelope, gatewayKey)
      val snapshot = snapshotEnvelope.getValue("body").jsonObject
      require(snapshot.getValue("claw_id") == JsonPrimitive(expectedPin.clawId)) { "wrong_claw" }
      val previouslySeenBinding = state.snapshotBindingSeq
      val seq = OpenClawIdCanonical.integer(snapshot.getValue("seq"))
      val issuedAt = OpenClawIdCanonical.integer(snapshot.getValue("issued_at"))
      val snapshotBinding = OpenClawIdCanonical.integer(snapshot.getValue("binding_seq"), 1)
      val replayed = seq < state.snapshotSeq || (seq == state.snapshotSeq && issuedAt < state.snapshotIssuedAt)
      // Future snapshots cannot poison the high-water mark. Valid stale/newer evidence is retained.
      if (issuedAt <= now + 300 && (seq > state.snapshotSeq || (seq == state.snapshotSeq && issuedAt > state.snapshotIssuedAt))) {
        state = state.copy(snapshotSeq = seq, snapshotIssuedAt = issuedAt, snapshotBindingSeq = maxOf(previouslySeenBinding, snapshotBinding))
      }
      require(maxOf(snapshotBinding, previouslySeenBinding) <= bindingSeq) { "stale_binding" }
      require(issuedAt <= now + 300) { "snapshot_future" }
      require(issuedAt >= now - 10800) { "snapshot_stale" }
      require(!replayed) { "snapshot_replayed" }
      require(snapshotBinding == bindingSeq) { "snapshot_lagging" }
      val protocols = snapshot.getValue("protocols").jsonObject
      require(protocols.values.all { versions -> (versions as JsonArray).any { OpenClawIdCanonical.integer(it) == 1L } }) { "unsupported_version" }
      require((snapshot.getValue("node_peer_keys") as JsonArray).contains(JsonPrimitive(peerKey))) { "node_not_admitted" }
      OpenClawIdTrustAssessment(state, OpenClawIdTrustTarget(expectedPin, OpenClawIdCanonical.text(binding.getValue("k_srv")), gatewayKey, relay, descriptor), null)
    } catch (error: IllegalArgumentException) {
      // Only our stable validation codes cross this boundary; never echo descriptor or crypto errors.
      val code = error.message?.takeIf { Regex("[a-z_]{1,40}").matches(it) } ?: "invalid_evidence"
      OpenClawIdTrustAssessment(state, null, code)
    }
  }
}
