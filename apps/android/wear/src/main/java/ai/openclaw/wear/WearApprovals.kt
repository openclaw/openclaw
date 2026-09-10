package ai.openclaw.wear

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

internal fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

internal fun JsonObject.number(key: String): Long? = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull

internal fun JsonObject.flag(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull

private fun String.fitsCodePointLimit(limit: Int): Boolean = codePointCount(0, length) <= limit

internal data class WearApprovalDetail(
  val label: Int?,
  val value: String = "",
)

internal data class WearApprovalExternalResolution(
  val label: String,
  val decisions: List<String>,
)

internal data class WearApproval(
  val id: String,
  val kind: String,
  val status: String,
  val title: String,
  val details: List<WearApprovalDetail>,
  val decisions: List<String>,
  val expiresAtMs: Long,
  val sourceSessionKey: String?,
  val decision: String?,
  val reviewIssue: Int?,
  val presentation: JsonObject,
  val externalResolution: WearApprovalExternalResolution?,
) {
  fun canResolve(
    decision: String,
    now: Long,
  ): Boolean = status == "pending" && expiresAtMs > now && decision in decisions && (decision == "deny" || reviewIssue == null)

  fun sameReview(other: WearApproval): Boolean = id == other.id && kind == other.kind && expiresAtMs == other.expiresAtMs && presentation == other.presentation
}

/** Consumes the canonical exec/plugin/system-agent union, never legacy request payloads. */
internal fun parseWearApproval(value: JsonElement?): WearApproval? {
  val obj = value as? JsonObject ?: return null
  val id = obj.text("id")?.takeIf { it.isNotBlank() && it.length <= 1024 } ?: return null
  val status = obj.text("status")?.takeIf { it in setOf("pending", "allowed", "denied", "expired", "cancelled") } ?: return null
  val expires = obj.number("expiresAtMs")?.takeIf { it >= 0 } ?: return null
  val presentation = obj["presentation"] as? JsonObject ?: return null
  val kind = presentation.text("kind") ?: return null
  val offered = presentation["allowedDecisions"] as? JsonArray ?: return null
  val decisions = offered.map { (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.contentOrNull ?: return null }
  if (decisions.size !in 1..3 || decisions.distinct() != decisions ||
    decisions.any { it !in setOf("allow-once", "allow-always", "deny") }
  ) {
    return null
  }
  val details = mutableListOf<WearApprovalDetail>()
  var issue: Int? = null

  fun invalid() {
    issue = R.string.watch_approval_context_invalid
  }

  fun required(
    source: JsonObject,
    key: String,
    max: Int,
  ): String? = source.text(key)?.takeIf { it.isNotBlank() && it.fitsCodePointLimit(max) }.also { if (it == null) invalid() }

  fun optional(
    key: String,
    label: Int?,
    nullable: Boolean = true,
    max: Int = 1024,
    allowBlank: Boolean = false,
  ) {
    val raw = presentation[key] ?: return
    if (raw == JsonNull && nullable) return
    val value = presentation.text(key)?.takeIf { it.fitsCodePointLimit(max) && (allowBlank || it.isNotBlank()) }
    if (value == null) invalid() else details += WearApprovalDetail(label, value)
  }

  fun detail(
    key: String,
    label: Int?,
    max: Int,
  ) {
    required(presentation, key, max)?.let { details += WearApprovalDetail(label, it) }
  }
  var title = ""
  var externalResolution: WearApprovalExternalResolution? = null
  val commonKeys = setOf("kind", "allowedDecisions", "agentId")
  val knownKeys: Set<String>
  when (kind) {
    "exec" -> {
      knownKeys = commonKeys + setOf("commandText", "commandPreview", "warningText", "host", "nodeId", "scope")
      detail("commandText", null, 20_000)
      optional("commandPreview", R.string.watch_approval_preview, max = 20_000, allowBlank = true)
      optional("warningText", R.string.watch_approval_warning, max = 20_000, allowBlank = true)
      optional("host", R.string.watch_approval_host, allowBlank = true)
      optional("nodeId", R.string.watch_approval_node)
    }

    "plugin" -> {
      knownKeys = commonKeys + setOf("title", "description", "severity", "detail", "pluginId", "toolName", "scope", "externalResolution")
      title = required(presentation, "title", 80).orEmpty()
      detail("description", null, 512)
      when (presentation.text("severity")) {
        "info" -> details += WearApprovalDetail(R.string.watch_approval_severity_info)
        "warning" -> details += WearApprovalDetail(R.string.watch_approval_severity_warning)
        "critical" -> details += WearApprovalDetail(R.string.watch_approval_severity_critical)
        else -> invalid()
      }
      optional("detail", null, nullable = false, max = 16_384)
      optional("pluginId", R.string.watch_approval_plugin)
      optional("toolName", R.string.watch_approval_tool)
      if ("externalResolution" in presentation) {
        val external = presentation["externalResolution"] as? JsonObject
        val label = external?.let { required(it, "label", 80) }
        val choices =
          (external?.get("decisions") as? JsonArray)?.map {
            (it as? JsonPrimitive)?.takeIf { primitive -> primitive.isString }?.contentOrNull
          }
        if (external == null || external.keys != setOf("label", "decisions") || label == null || choices == null ||
          choices.size !in 1..2 || choices.distinct() != choices ||
          choices.any { it !in listOf("allow-once", "allow-always") }
        ) {
          invalid()
        } else {
          externalResolution = WearApprovalExternalResolution(label, choices.filterNotNull())
        }
      }
    }

    "system-agent" -> {
      knownKeys = commonKeys + setOf("title", "description", "proposalHash")
      title = required(presentation, "title", 80).orEmpty()
      detail("description", null, 512)
      val hash = presentation.text("proposalHash")?.takeIf { it.matches(Regex("[a-f0-9]{64}")) }
      if (hash == null) invalid() else details += WearApprovalDetail(R.string.watch_approval_proposal, hash)
      if (decisions != listOf("allow-once", "deny")) invalid()
    }

    else -> {
      return null
    }
  }
  optional("agentId", R.string.watch_approval_agent)
  if (presentation.keys.any { it !in knownKeys }) invalid()
  if ("sourceSessionKey" in obj && obj.text("sourceSessionKey")?.takeIf { it.isNotBlank() && it.length <= 1024 } == null) invalid()
  if ("scope" in presentation) {
    val scope = parseWearApprovalScope(presentation["scope"])
    if (scope == null) invalid() else details += scope
  }
  val fits = details.sumOf { it.value.length } <= 20_000
  if (!fits) issue = R.string.watch_approval_too_large
  return WearApproval(
    id,
    kind,
    status,
    title,
    if (fits) details else emptyList(),
    decisions,
    expires,
    obj.text("sourceSessionKey"),
    obj.text("decision"),
    issue,
    presentation,
    externalResolution,
  )
}

private fun parseWearApprovalScope(value: JsonElement?): List<WearApprovalDetail>? {
  val scope = value as? JsonObject ?: return null

  fun text(
    key: String,
    max: Int,
  ): String? = scope.text(key)?.takeIf { it.isNotBlank() && it.fitsCodePointLimit(max) }

  fun number(
    key: String,
    max: Long,
  ): String? = scope.number(key)?.takeIf { it in 1..max }?.toString()
  val lines = mutableListOf<WearApprovalDetail>()
  val knownKeys: Set<String>
  when (scope.text("kind")) {
    "message-send" -> {
      knownKeys = setOf("kind", "target", "recipientCount", "recipients", "audience")
      lines += WearApprovalDetail(R.string.watch_scope_message)
      lines += WearApprovalDetail(R.string.watch_scope_target, text("target", 128) ?: return null)
      lines += WearApprovalDetail(R.string.watch_scope_recipient_count, number("recipientCount", 1_000_000) ?: return null)
      if ("recipients" in scope) {
        val recipients = scope["recipients"] as? JsonArray ?: return null
        if (recipients.size > 5) return null
        for (raw in recipients) {
          val recipient =
            (raw as? JsonPrimitive)
              ?.takeIf { it.isString }
              ?.contentOrNull
              ?.takeIf { it.isNotBlank() && it.fitsCodePointLimit(128) } ?: return null
          lines += WearApprovalDetail(R.string.watch_scope_recipient, recipient)
        }
      }
      if ("audience" in scope) {
        lines +=
          WearApprovalDetail(
            when (scope.text("audience")) {
              "internal" -> R.string.watch_scope_audience_internal
              "external" -> R.string.watch_scope_audience_external
              else -> return null
            },
          )
      }
    }

    "payment" -> {
      knownKeys = setOf("kind", "amount", "currency", "target")
      lines += WearApprovalDetail(R.string.watch_scope_payment)
      lines += WearApprovalDetail(R.string.watch_scope_amount, text("amount", 40) ?: return null)
      lines += WearApprovalDetail(R.string.watch_scope_currency, text("currency", 12) ?: return null)
      lines += WearApprovalDetail(R.string.watch_scope_target, text("target", 128) ?: return null)
    }

    "external-post" -> {
      knownKeys = setOf("kind", "target", "visibility")
      lines += WearApprovalDetail(R.string.watch_scope_post)
      lines += WearApprovalDetail(R.string.watch_scope_target, text("target", 128) ?: return null)
      lines +=
        WearApprovalDetail(
          when (scope.text("visibility")) {
            "public" -> R.string.watch_scope_visibility_public
            "restricted" -> R.string.watch_scope_visibility_restricted
            else -> return null
          },
        )
    }

    "standing-grant" -> {
      knownKeys = setOf("kind", "automation", "command", "expiresInDays")
      lines += WearApprovalDetail(R.string.watch_scope_standing_grant)
      lines += WearApprovalDetail(R.string.watch_scope_automation, text("automation", 128) ?: return null)
      lines += WearApprovalDetail(R.string.watch_scope_command, text("command", 256) ?: return null)
      lines +=
        if ("expiresInDays" in scope) {
          WearApprovalDetail(R.string.watch_scope_expiry_days, number("expiresInDays", 3650) ?: return null)
        } else {
          WearApprovalDetail(R.string.watch_scope_expiry_until_revoked)
        }
    }

    else -> {
      return null
    }
  }
  return lines.takeIf { scope.keys.all { it in knownKeys } }
}

internal data class WearApprovalTransition(
  val sessionKey: String,
  val updatedAtMs: Long,
  val approval: WearApproval,
)

internal fun parseWearApprovalTransition(value: JsonObject): WearApprovalTransition? {
  val session = value.text("sessionKey") ?: return null
  val time = value.number("updatedAtMs") ?: return null
  val approval = parseWearApproval(value["approval"]) ?: return null
  if (value.text("phase") != if (approval.status == "pending") "pending" else "terminal") return null
  return WearApprovalTransition(session, time, approval.copy(sourceSessionKey = value.text("sourceSessionKey") ?: approval.sourceSessionKey))
}

/** Replay is a pending-set snapshot; terminal transitions observed during the RPC always win. */
internal class WearApprovalFeed {
  private var sessionKey: String? = null
  private var records = linkedMapOf<String, WearApprovalTransition>()
  private val duringReplay = mutableListOf<WearApprovalTransition>()
  var ready = false
    private set
  private var replayTruncated = false
  private var overflow = false

  val incomplete: Boolean
    get() = replayTruncated || overflow || records.size > MAX_APPROVALS

  val approvals: List<WearApproval>
    get() =
      records.values
        .map { it.approval }
        .sortedWith(compareBy({ it.status != "pending" }, { it.expiresAtMs }))
        .take(MAX_APPROVALS)

  fun begin() {
    ready = false
    overflow = false
    duringReplay.clear()
  }

  fun accept(event: WearApprovalTransition) {
    if (!ready) {
      if (duringReplay.size < MAX_TRANSITIONS) duringReplay += event else overflow = true
    } else if (event.sessionKey == sessionKey) {
      merge(event)
    }
  }

  fun replay(value: JsonObject): Boolean {
    val key = value.text("sessionKey") ?: return false
    val at = value.number("updatedAtMs") ?: return false
    val raw = value["approvals"] as? JsonArray ?: return false
    val truncated = value.flag("truncated") ?: return false
    if (overflow) return false
    val snapshots = raw.take(MAX_APPROVALS).map { parseWearApproval(it) ?: return false }
    if (snapshots.any { it.status != "pending" }) return false
    sessionKey = key
    records = snapshots.associateTo(linkedMapOf()) { it.id to WearApprovalTransition(key, at, it) }
    replayTruncated = truncated || raw.size > MAX_APPROVALS
    duringReplay.filter { it.sessionKey == key }.forEach(::merge)
    duringReplay.clear()
    ready = true
    return true
  }

  fun replace(approval: WearApproval) {
    val key = sessionKey ?: return
    merge(WearApprovalTransition(key, Long.MAX_VALUE, approval))
  }

  private fun merge(event: WearApprovalTransition) {
    val previous = records[event.approval.id]
    if (previous?.approval?.status != null && previous.approval.status != "pending" && event.approval.status == "pending") return
    if (previous != null && previous.updatedAtMs > event.updatedAtMs && event.approval.status == "pending") return
    if (previous == null && records.size >= MAX_TRANSITIONS) {
      overflow = true
      ready = false
      return
    }
    records[event.approval.id] = event
  }

  companion object {
    const val MAX_APPROVALS = 50
    private const val MAX_TRANSITIONS = 256
  }
}
