package ai.openclaw.app.ui.chat

import ai.openclaw.android.gateway.GatewaySessionEntry
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionFiltersTest {
  @Test
  fun sessionChoicesPreferMainAndRecent() {
    val now = 1_700_000_000_000L
    val recent1 = now - 2 * 60 * 60 * 1000L
    val recent2 = now - 5 * 60 * 60 * 1000L
    val stale = now - 26 * 60 * 60 * 1000L
    val sessions =
      listOf(
        GatewaySessionEntry(key = "recent-1", updatedAtMs = recent1),
        GatewaySessionEntry(key = "main", updatedAtMs = stale),
        GatewaySessionEntry(key = "old-1", updatedAtMs = stale),
        GatewaySessionEntry(key = "recent-2", updatedAtMs = recent2),
      )

    val result = resolveSessionChoices("main", sessions, mainSessionKey = "main", nowMs = now).map { it.key }
    assertEquals(listOf("main", "recent-1", "recent-2"), result)
  }

  @Test
  fun sessionChoicesIncludeCurrentWhenMissing() {
    val now = 1_700_000_000_000L
    val recent = now - 10 * 60 * 1000L
    val sessions = listOf(GatewaySessionEntry(key = "main", updatedAtMs = recent))

    val result = resolveSessionChoices("custom", sessions, mainSessionKey = "main", nowMs = now).map { it.key }
    assertEquals(listOf("main", "custom"), result)
  }
}
