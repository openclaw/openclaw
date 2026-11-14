package ai.openclaw.app.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLDecoder

/** Caller-supplied actual runtime manifest; no inferred or default command surface. */
class OpenClawIdEnrollmentDescription(
  displayName: String,
  platform: String,
  commands: List<String>,
  caps: List<String>,
) {
  internal val body: JsonObject

  init {
    fun text(
      value: String,
      max: Int,
    ): String {
      OpenClawIdCanonical.unicode(value)
      require(value.isNotEmpty() && value.length <= max && value.none { it.code < 32 || it.code == 127 }) { "invalid_description" }
      return value
    }

    fun surface(values: List<String>): JsonArray {
      require(values.size <= 64 && values.toSet().size == values.size) { "invalid_surface" }
      return JsonArray(values.map { JsonPrimitive(text(it, 128)) })
    }
    body =
      buildJsonObject {
        put("display_name", text(displayName, 128))
        put("platform", text(platform, 64))
        put("commands", surface(commands))
        put("caps", surface(caps))
      }
  }
}

/** A fragment-only secret consumed exactly once; call close when cancelling before preparation. */
class OpenClawIdEnrollment private constructor(
  val inviteId: String,
  val pin: OpenClawIdTrustPin,
  val discoveryOrigin: String,
  val relayHint: String,
  private val secret: ByteArray,
) : AutoCloseable {
  private var consumed = false
  val mailPath: String get() = "/v1/claws/${pin.clawId}/mailbox/node"
  val descriptorPath: String get() = "/v1/claws/${pin.clawId}/node/descriptor"

  /** Consume the invite secret locally; output has proof/signature but neither secret nor proof key. */
  fun prepare(
    signer: OpenClawIdEnrollmentSigner,
    description: OpenClawIdEnrollmentDescription,
    now: Long,
  ): OpenClawIdEnrollmentPrepared {
    check(!consumed) { "invite_consumed" }
    require(now in 0..OpenClawIdCanonical.MAX_SAFE_INTEGER) { "invalid_timestamp" }
    consumed = true
    val key = OpenClawIdEnrollmentCrypto.proofKey(secret)
    try {
      val parts =
        buildJsonObject {
          put("claw_id", pin.clawId)
          put("invite_id", inviteId)
          put("peer_key", signer.peerKey)
        }
      val proof = OpenClawIdEnrollmentCrypto.hex(OpenClawIdEnrollmentCrypto.hmac(key, "openclaw/node-invite-proof/v1\u0000".toByteArray() + OpenClawIdCanonical.encode(parts).toByteArray()))
      val compared = JsonObject(parts + ("description" to description.body))
      val digest = OpenClawIdEnrollmentCrypto.sha256("openclaw/node-verification-code/v1\u0000".toByteArray() + OpenClawIdCanonical.encode(compared).toByteArray())
      val value = digest.take(4).fold(0L) { acc, byte -> (acc shl 8) or (byte.toLong() and 255) }
      val body = JsonObject(compared + mapOf("proof" to JsonPrimitive(proof), "requested_at" to JsonPrimitive(now)))
      return OpenClawIdEnrollmentPrepared(signer.statement("NodeRedemption", body), (value % 1000000).toString().padStart(6, '0'))
    } finally {
      key.fill(0)
      secret.fill(0)
    }
  }

  /** Erase unused invitation material on cancellation. */
  override fun close() {
    consumed = true
    secret.fill(0)
  }

  override fun toString(): String = "OpenClawIdEnrollment([redacted])"

  companion object {
    /** Both inputs are required and validated before callers generate or load W. HTTPS only. */
    fun parse(
      link: String,
      discoveryOrigin: String,
    ): OpenClawIdEnrollment {
      try {
        val discovery = OpenClawIdTrustUrls.https(discoveryOrigin, originOnly = true)
        require(link.length <= 2048)
        val uri = URI(link)
        require(uri.scheme == "openclaw-node" && uri.rawAuthority == "join" && uri.rawPath.isNullOrEmpty() && uri.rawQuery == null)
        val pairs =
          requireNotNull(uri.rawFragment).split('&').map {
            val fields = it.split('=', limit = 2)
            require(fields.size == 2)
            URLDecoder.decode(fields[0], "UTF-8") to URLDecoder.decode(fields[1], "UTF-8")
          }
        require(pairs.size == 5 && pairs.map { it.first }.toSet() == setOf("i", "c", "r", "h", "relay"))
        val values = pairs.toMap()
        val invite = values.getValue("i").split('.')
        require(invite.size == 2 && Regex("[0-9a-f]{32}").matches(invite[0]))
        val pin = OpenClawIdTrustPin(values.getValue("c"), "fp:" + values.getValue("r"), values.getValue("h"))
        val relay = OpenClawIdTrustUrls.https(values.getValue("relay"))
        val secret = OpenClawIdEnrollmentCrypto.decode64(invite[1], 32)
        return OpenClawIdEnrollment(invite[0], pin, discovery, relay, secret)
      } catch (_: Exception) {
        // URI/decoder exceptions may echo the secret-bearing original link; never retain their causes.
        throw IllegalArgumentException("invalid_enrollment_inputs")
      }
    }
  }
}

/** Signed pending-only declaration. It does not indicate admission or a saved target. */
class OpenClawIdEnrollmentPrepared internal constructor(
  val redemption: JsonObject,
  val verificationCode: String,
) {
  /** Exact body to transmit and authenticate with requestSignature; contains no invitation secret. */
  fun mailBytes(): ByteArray =
    OpenClawIdCanonical
      .encode(
        buildJsonObject {
          put("to", "gateway")
          put(
            "payload",
            buildJsonObject {
              put("kind", "node_redemption")
              put("redemption", redemption)
            },
          )
        },
      ).toByteArray()

  override fun toString(): String = "OpenClawIdEnrollmentPrepared([redacted])"
}

/** URI policy shared by enrollment routing and untrusted descriptor validation. */
internal object OpenClawIdTrustUrls {
  val hostname = Regex("^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::[0-9]{1,5})?$")

  fun https(
    value: String,
    originOnly: Boolean = false,
  ): String {
    require(value.length <= 512 && value.all { it.code in 33..126 }) { "invalid_url" }
    val uri =
      try {
        URI(value)
      } catch (_: Exception) {
        throw IllegalArgumentException("invalid_url")
      }
    require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.port in -1..65535) { "invalid_url" }
    require(!originOnly || uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") { "invalid_origin" }
    return if (originOnly) "https://${uri.rawAuthority}" else value
  }
}
