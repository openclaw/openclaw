package ai.openclaw.app.gateway

import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class OpenClawIdRefreshOutcomeTest {
  private val response = JsonObject(emptyMap())

  private suspend fun outcome(
    fetch: suspend () -> JsonObject,
    assessment: OpenClawIdTrustAssessment = OpenClawIdTrustAssessment(null, null, "unused"),
  ): Throwable? = runCatching { OpenClawIdNodeController.refreshTarget(fetch) { assessment } }.exceptionOrNull()

  @Test fun discoveryRefusalsAndNetworkErrorsStayRetryableAndAreNeverRemoval() =
    runTest {
      // 403 is unsigned: it must not end the node's access the way a verified snapshot does.
      for (status in listOf(403, 404, 500, 503)) {
        val failure = OpenClawIdDiscoveryFailure(status)
        assertSame(failure, outcome({ throw failure }))
      }
      val offline = IOException("offline")
      assertSame(offline, outcome({ throw offline }))
    }

  @Test fun onlyAVerifiedSnapshotWithoutThisNodeIsRemoval() =
    runTest {
      assertTrue(outcome({ response }, OpenClawIdTrustAssessment(null, null, "node_not_admitted")) is OpenClawIdRemovedException)
      val refused = outcome({ response }, OpenClawIdTrustAssessment(null, null, "snapshot_ahead"))
      assertTrue(refused is IllegalStateException)
      assertEquals("node_evidence_refused", refused?.message)
    }
}
