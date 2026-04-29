package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Test

class NemoProfileStatusResolverTest {
  @Test
  fun readyWhenNemoAgentExists() {
    assertEquals(
      NemoProfileStatus.Ready,
      NemoProfileStatusResolver.resolve(
        current = NemoProfileStatus.Missing,
        agentIds = listOf("openclaw", "nemo"),
      ),
    )
  }

  @Test
  fun missingWhenNoNemoAndNotInitializing() {
    assertEquals(
      NemoProfileStatus.Missing,
      NemoProfileStatusResolver.resolve(
        current = NemoProfileStatus.Unknown,
        agentIds = listOf("openclaw"),
      ),
    )
  }

  @Test
  fun initializingIsHeldWhileGatewayHasNotRefreshedNemo() {
    assertEquals(
      NemoProfileStatus.Initializing,
      NemoProfileStatusResolver.resolve(
        current = NemoProfileStatus.Initializing,
        agentIds = listOf("openclaw"),
      ),
    )
  }

  @Test
  fun needsRestartIsPreservedUntilNemoAppears() {
    assertEquals(
      NemoProfileStatus.NeedsRestart,
      NemoProfileStatusResolver.resolve(
        current = NemoProfileStatus.NeedsRestart,
        agentIds = listOf("openclaw"),
      ),
    )
  }

  @Test
  fun failedIsPreservedUntilUserRetriesOrNemoAppears() {
    assertEquals(
      NemoProfileStatus.Failed,
      NemoProfileStatusResolver.resolve(
        current = NemoProfileStatus.Failed,
        agentIds = listOf("openclaw"),
      ),
    )
  }

  @Test
  fun readyOverridesFailedWhenNemoAppears() {
    assertEquals(
      NemoProfileStatus.Ready,
      NemoProfileStatusResolver.resolve(
        current = NemoProfileStatus.Failed,
        agentIds = listOf("openclaw", "NEMO"),
      ),
    )
  }
}
