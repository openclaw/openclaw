package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class NetworkMonitorTest {
  @Test
  fun emitsOnceOnOfflineToOnline() {
    // First validated transition after being offline fires the reconnect signal.
    assertEquals(true, shouldEmitOnlineTransition(previouslyOnline = false))
  }

  @Test
  fun suppressesDuplicateOnline() {
    // Capability churn (signal strength, dual-stack validation) while already online
    // must not re-fire; the gateway reconnect path guards on its own isConnected anyway.
    assertEquals(false, shouldEmitOnlineTransition(previouslyOnline = true))
  }

  @Test
  fun emitsAgainAfterALost() {
    // onLost clears the lastOnline flag so a later restore is treated as fresh.
    // Simulate the state machine: offline -> online (emit) -> lost -> online (emit).
    var online = false
    assertEquals(true, shouldEmitOnlineTransition(online))
    online = true
    assertEquals(false, shouldEmitOnlineTransition(online))
    online = false // onLost
    assertEquals(true, shouldEmitOnlineTransition(online))
  }
}
