package ai.openclaw.app.wear

import ai.openclaw.app.chat.ChatSwarmDotStatus
import ai.openclaw.app.chat.ChatSwarmGroup
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal fun projectWearAgentPulse(
  gatewayConnected: Boolean,
  swarmAvailable: Boolean,
  swarmGroups: List<ChatSwarmGroup>,
  pendingApprovalCount: Int,
  approvalsAvailable: Boolean,
  approvalsRefreshing: Boolean,
): JsonObject =
  buildJsonObject {
    put(
      "swarm",
      buildJsonObject {
        val activeGroups = activeSwarmGroups(swarmGroups)
        when {
          !gatewayConnected || !swarmAvailable -> {
            put("state", "unavailable")
          }

          activeGroups.isEmpty() -> {
            put("state", "idle")
            put("scope", "selected-session")
          }

          else -> {
            val phaseBuckets = MutableList(MAX_PHASE_BUCKETS) { MutablePhaseCounts() }
            var morePhases = false
            activeGroups.forEach { group ->
              if (group.phases.size > MAX_PHASE_BUCKETS) morePhases = true
              group.phases.take(MAX_PHASE_BUCKETS).forEachIndexed { index, phase ->
                val bucket = phaseBuckets[index]
                phase.dots.forEach { dot ->
                  when (dot.status) {
                    ChatSwarmDotStatus.Queued -> bucket.queued += 1
                    ChatSwarmDotStatus.Running -> bucket.running += 1
                    ChatSwarmDotStatus.Done, ChatSwarmDotStatus.Paused -> bucket.done += 1
                    ChatSwarmDotStatus.Failed -> bucket.failed += 1
                  }
                }
                bucket.hidden += phase.hidden
              }
            }
            put("state", "active")
            put("scope", "selected-session")
            put("groups", activeGroups.size)
            put("running", activeGroups.sumOf(ChatSwarmGroup::running))
            put("done", activeGroups.sumOf { it.done + it.paused })
            put("failed", activeGroups.sumOf(ChatSwarmGroup::failed))
            put(
              "phases",
              JsonArray(
                phaseBuckets
                  .dropLastWhile { phase -> !phase.hasData() }
                  .map { phase ->
                    buildJsonObject {
                      put("queued", phase.queued)
                      put("running", phase.running)
                      put("done", phase.done)
                      put("failed", phase.failed)
                      put("hidden", phase.hidden)
                    }
                  },
              ),
            )
            put("morePhases", morePhases)
          }
        }
      },
    )
    put(
      "approvals",
      buildJsonObject {
        val state =
          when {
            !gatewayConnected -> "unavailable"
            approvalsRefreshing -> "refreshing"
            !approvalsAvailable -> "unavailable"
            else -> "ready"
          }
        put("state", state)
        if (state == "ready") put("pending", pendingApprovalCount.coerceAtLeast(0))
      },
    )
  }

// The watch protocol has no paused state: it keeps receiving only groups with queued or
// running work and counting paused children as done, as before the phone listed them.
private fun activeSwarmGroups(groups: List<ChatSwarmGroup>): List<ChatSwarmGroup> =
  groups.filter { group ->
    group.phases.any { phase ->
      phase.dots.any { it.status == ChatSwarmDotStatus.Queued || it.status == ChatSwarmDotStatus.Running }
    }
  }

private data class MutablePhaseCounts(
  var queued: Int = 0,
  var running: Int = 0,
  var done: Int = 0,
  var failed: Int = 0,
  var hidden: Int = 0,
) {
  fun hasData(): Boolean = queued != 0 || running != 0 || done != 0 || failed != 0 || hidden != 0
}

private const val MAX_PHASE_BUCKETS = 8
