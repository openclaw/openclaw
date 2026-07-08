package ai.openclaw.app

import ai.openclaw.app.gateway.GatewayEndpoint
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.lang.reflect.Field
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SkillWorkshopAgentScopeRuntimeTest {
  @Before
  fun clearPlainPrefs() {
    RuntimeEnvironment
      .getApplication()
      .getSharedPreferences("openclaw.node", android.content.Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
  }

  @Test
  fun resetSkillWorkshopAgentScopeClearsRowsAndInFlightActionState() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.resetSkillWorkshopAgentScope("main")
    readField<MutableStateFlow<GatewaySkillWorkshopSummary>>(runtime, "_skillWorkshopSummary").value =
      GatewaySkillWorkshopSummary(
        agentId = "main",
        proposals = listOf(skillWorkshopProposal("main-proposal")),
      )

    runtime.resetSkillWorkshopAgentScope("ops")

    assertEquals("ops", runtime.skillWorkshopSummary.value.agentId)
    assertEquals(emptyList<GatewaySkillWorkshopProposal>(), runtime.skillWorkshopSummary.value.proposals)
    assertFalse(runtime.skillWorkshopRefreshing.value)
    assertNull(runtime.skillWorkshopErrorText.value)
    assertNull(runtime.skillWorkshopNoticeText.value)
    assertNull(runtime.skillWorkshopInspectingProposalId.value)
    assertNull(runtime.skillWorkshopMutatingProposalId.value)
  }

  @Test
  fun inspectAndMutateDoNotStartForStaleSelectedAgentScope() {
    val runtime = createTestRuntime()
    seedConnectedRuntime(runtime)
    runtime.resetSkillWorkshopAgentScope("main")

    runtime.inspectSkillWorkshopProposal(proposalId = "ops-proposal", agentId = "ops")
    readField<MutableStateFlow<List<String>>>(runtime, "_operatorScopes").value = listOf("operator.admin")
    waitUntil { runtime.operatorAdminScopeAvailable.value }
    runtime.applySkillWorkshopProposal(proposalId = "ops-proposal", agentId = "ops")
    Thread.sleep(100)

    assertEquals("main", runtime.skillWorkshopSummary.value.agentId)
    assertNull(runtime.skillWorkshopInspectingProposalId.value)
    assertNull(runtime.skillWorkshopMutatingProposalId.value)
    assertNull(runtime.skillWorkshopErrorText.value)
    assertNull(runtime.skillWorkshopNoticeText.value)
  }

  private fun createTestRuntime(): NodeRuntime {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    return NodeRuntime(app, SecurePrefs(app, securePrefsOverride = securePrefs))
  }

  private fun seedConnectedRuntime(runtime: NodeRuntime) {
    writeField(runtime, "connectedEndpoint", GatewayEndpoint.manual("127.0.0.1", 18789))
    writeField(runtime, "operatorConnected", true)
  }

  private fun skillWorkshopProposal(id: String): GatewaySkillWorkshopProposal =
    GatewaySkillWorkshopProposal(
      id = id,
      status = "pending",
      kind = "create",
      title = "Proposal $id",
      skillKey = id,
      skillName = "Proposal $id",
      description = "desc",
      createdAt = "2026-07-08T00:00:00Z",
      updatedAt = "2026-07-08T00:00:00Z",
      scanState = null,
    )

  private fun waitUntil(condition: () -> Boolean) {
    repeat(50) {
      if (condition()) return
      Thread.sleep(10)
    }
    error("Expected condition to become true")
  }

  private fun writeField(
    target: Any,
    name: String,
    value: Any?,
  ) {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        field.set(target, value)
        return
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }

  private fun <T> readField(
    target: Any,
    name: String,
  ): T {
    var type: Class<*>? = target.javaClass
    while (type != null) {
      try {
        val field: Field = type.getDeclaredField(name)
        field.isAccessible = true
        @Suppress("UNCHECKED_CAST")
        return field.get(target) as T
      } catch (_: NoSuchFieldException) {
        type = type.superclass
      }
    }
    error("Field $name not found on ${target.javaClass.name}")
  }
}
