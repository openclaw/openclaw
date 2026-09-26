package ai.openclaw.app.wear

import ai.openclaw.app.WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS
import ai.openclaw.app.chat.ChatSwarmDot
import ai.openclaw.app.chat.ChatSwarmDotStatus
import ai.openclaw.app.chat.ChatSwarmGroup
import ai.openclaw.app.chat.ChatSwarmPhase
import ai.openclaw.app.readWearAgentPulseComponent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WearAgentPulseProjectionTest {
  @Test
  fun projectsOnlyBoundedAggregateFields() {
    val result =
      projectWearAgentPulse(
        gatewayConnected = true,
        swarmAvailable = true,
        swarmGroups =
          listOf(
            ChatSwarmGroup(
              groupId = "private-group",
              label = "private-label",
              running = 1,
              done = 2,
              failed = 3,
              narrator = "private-narrator",
              phases =
                listOf(
                  ChatSwarmPhase(
                    key = "private-phase",
                    title = "private-title",
                    dots =
                      listOf(
                        dot("queued", ChatSwarmDotStatus.Queued),
                        dot("running", ChatSwarmDotStatus.Running),
                        dot("done", ChatSwarmDotStatus.Done),
                        dot("failed", ChatSwarmDotStatus.Failed),
                      ),
                    hidden = 7,
                  ),
                ),
            ),
          ),
        pendingApprovalCount = 2,
        approvalsAvailable = true,
        approvalsRefreshing = false,
      )

    assertEquals(
      Json
        .parseToJsonElement(
          """{"swarm":{"state":"active","scope":"selected-session","groups":1,"running":1,"done":2,"failed":3,"phases":[{"queued":1,"running":1,"done":1,"failed":1,"hidden":7}],"morePhases":false},"approvals":{"state":"ready","pending":2}}""",
        ).jsonObject,
      result,
    )
    assertFalse(result.toString().contains("private-"))
  }

  @Test
  fun keepsUnknownApprovalCountUnavailable() {
    val bounded =
      projectWearAgentPulse(
        gatewayConnected = true,
        swarmAvailable = true,
        swarmGroups = emptyList(),
        pendingApprovalCount = 9,
        approvalsAvailable = false,
        approvalsRefreshing = true,
      )

    assertEquals(
      Json
        .parseToJsonElement(
          """{"swarm":{"state":"idle","scope":"selected-session"},"approvals":{"state":"refreshing"}}""",
        ).jsonObject,
      bounded,
    )
  }

  @Test
  fun makesEveryComponentUnavailableWhenTheGatewayRouteIsStale() {
    val result =
      projectWearAgentPulse(
        gatewayConnected = false,
        swarmAvailable = true,
        swarmGroups = emptyList(),
        pendingApprovalCount = 1,
        approvalsAvailable = true,
        approvalsRefreshing = true,
      )

    assertEquals(
      Json
        .parseToJsonElement(
          """{"swarm":{"state":"unavailable"},"approvals":{"state":"unavailable"}}""",
        ).jsonObject,
      result,
    )
  }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun phoneBudgetBoundsSlowSwarmRead() =
    runTest {
      val result = readWearAgentPulseComponent(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS) {
        delay(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS * 2)
        "swarm"
      }
      assertEquals(null, result)
      assertEquals(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS, currentTime)
    }

  @Test
  fun phoneBudgetPreservesCallerCancellation() =
    runTest {
      val failure = runCatching {
        readWearAgentPulseComponent(WEAR_AGENT_PULSE_PHONE_BUDGET_MILLIS) {
          throw CancellationException("request retired")
        }
      }.exceptionOrNull()
      assertTrue(failure is CancellationException)
    }

  private fun dot(
    suffix: String,
    status: ChatSwarmDotStatus,
  ): ChatSwarmDot =
    ChatSwarmDot(
      key = "private-dot-$suffix",
      label = "private-child-$suffix",
      status = status,
    )
}
