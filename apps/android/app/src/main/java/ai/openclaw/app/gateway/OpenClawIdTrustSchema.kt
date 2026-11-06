package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Complete v1 schemas for the only two statements consumed by a node's trust boundary. */
internal object OpenClawIdTrustSchema {
  private val ownerCaps = setOf("approve_device", "bind", "invite", "manage_members")
  private val roles = setOf("operator", "viewer")

  fun key(
    value: JsonElement,
    prefix: String,
  ): String =
    OpenClawIdCanonical.text(value).also {
      require(Regex("$prefix:[0-9a-f]{64}").matches(it)) { "invalid_key" }
    }

  fun id(value: JsonElement): String =
    OpenClawIdCanonical.text(value).also {
      require(Regex("[0-9a-f]{32}").matches(it)) { "invalid_id" }
    }

  // Lists of strings are unique in v1; object lists are bounded but not deduplicated by the schema.
  private fun list(
    value: JsonElement,
    check: (JsonElement) -> Unit,
  ): JsonArray {
    require(value is JsonArray && value.size <= 256) { "invalid_list" }
    value.forEach(check)
    return value
  }

  private fun strings(
    value: JsonElement,
    check: (JsonElement) -> Unit,
  ) {
    val items = list(value, check)
    require(items.distinct().size == items.size) { "duplicate_items" }
  }

  private fun protocols(value: JsonElement) {
    val obj = OpenClawIdCanonical.obj(value, "statement", "descriptor")
    obj.values.forEach { versions ->
      val items = list(versions) { OpenClawIdCanonical.integer(it, 1) }
      val numbers = items.map { OpenClawIdCanonical.integer(it, 1) }
      require(numbers.isNotEmpty() && numbers.zipWithNext().all { (a, b) -> a < b }) { "invalid_versions" }
    }
  }

  fun envelope(
    value: JsonElement,
    type: String,
  ): JsonObject {
    val envelope = OpenClawIdCanonical.obj(value, "v", "type", "body", "signer", "alg", "sig")
    require(OpenClawIdCanonical.integer(envelope.getValue("v"), 1) == 1L) { "unsupported_version" }
    require(OpenClawIdCanonical.text(envelope.getValue("type")) == type && OpenClawIdCanonical.text(envelope.getValue("alg")) == "ed25519") { "invalid_envelope" }
    key(envelope.getValue("signer"), "ed25519")
    OpenClawIdEnrollmentCrypto.decode64(OpenClawIdCanonical.text(envelope.getValue("sig")), 64)
    when (type) {
      "ServerBinding" -> binding(envelope.getValue("body"))
      "MembershipSnapshot" -> snapshot(envelope.getValue("body"))
      else -> error("unsupported_statement")
    }
    return envelope
  }

  private fun binding(value: JsonElement) {
    val body = OpenClawIdCanonical.obj(value, "claw_id", "hostname", "k_srv", "k_gw", "binding_seq", "root_epoch", "issued_at")
    id(body.getValue("claw_id"))
    require(OpenClawIdTrustUrls.hostname.matches(OpenClawIdCanonical.text(body.getValue("hostname")))) { "invalid_hostname" }
    key(body.getValue("k_srv"), "iroh")
    key(body.getValue("k_gw"), "ed25519")
    OpenClawIdCanonical.integer(body.getValue("binding_seq"), 1)
    require(OpenClawIdCanonical.integer(body.getValue("root_epoch")) == 1L) { "invalid_root_epoch" }
    OpenClawIdCanonical.integer(body.getValue("issued_at"))
  }

  private fun snapshot(value: JsonElement) {
    val body = OpenClawIdCanonical.obj(value, "claw_id", "seq", "binding_seq", "owner_devices", "owner_peer_keys", "node_peer_keys", "members", "protocols", "issued_at")
    id(body.getValue("claw_id"))
    OpenClawIdCanonical.integer(body.getValue("seq"))
    OpenClawIdCanonical.integer(body.getValue("binding_seq"), 1)
    OpenClawIdCanonical.integer(body.getValue("issued_at"))
    strings(body.getValue("owner_peer_keys")) { key(it, "iroh") }
    strings(body.getValue("node_peer_keys")) { key(it, "iroh") }
    list(body.getValue("owner_devices")) {
      val owner = OpenClawIdCanonical.obj(it, "device_pub", "caps")
      key(owner.getValue("device_pub"), "ed25519")
      strings(owner.getValue("caps")) { cap -> require(OpenClawIdCanonical.text(cap) in ownerCaps) { "invalid_capability" } }
    }
    list(body.getValue("members")) {
      val member = OpenClawIdCanonical.obj(it, "account_id", "role", "peer_keys")
      val account = OpenClawIdCanonical.text(member.getValue("account_id"))
      require(account.isNotEmpty() && account.length <= 256) { "invalid_account" }
      require(OpenClawIdCanonical.text(member.getValue("role")) in roles) { "invalid_role" }
      strings(member.getValue("peer_keys")) { peer -> key(peer, "iroh") }
    }
    protocols(body.getValue("protocols"))
  }

  fun signature(
    envelope: JsonObject,
    expectedSigner: String,
  ) {
    val signer = OpenClawIdCanonical.text(envelope.getValue("signer"))
    require(signer == expectedSigner) { "wrong_signer" }
    val type = OpenClawIdCanonical.text(envelope.getValue("type"))
    val bytes = "openclaw/$type/v1\u0000".toByteArray() + OpenClawIdCanonical.encode(envelope.getValue("body")).toByteArray()
    require(OpenClawIdEnrollmentCrypto.verify(signer, bytes, OpenClawIdCanonical.text(envelope.getValue("sig")))) { "bad_signature" }
  }
}
