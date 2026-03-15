package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayProtocolModelsTest {
  @Test
  fun parseSessionsListReturnsSessionEntries() {
    val json = """
      {
        "sessions": [
          {"key": "main", "updatedAt": 1710500000, "displayName": "Main Session"},
          {"key": "agent:work", "updatedAt": 1710600000, "displayName": "Work Tasks"},
          {"key": "", "updatedAt": 1}
        ]
      }
    """.trimIndent()

    val sessions = parseSessionsList(json)
    assertEquals(2, sessions.size)
    assertEquals("main", sessions[0].key)
    assertEquals(1710500000L, sessions[0].updatedAtMs)
    assertEquals("Main Session", sessions[0].displayName)
    assertEquals("agent:work", sessions[1].key)
    assertEquals("Work Tasks", sessions[1].displayName)
  }

  @Test
  fun parseSessionsListReturnsEmptyForInvalidJson() {
    assertTrue(parseSessionsList("").isEmpty())
    assertTrue(parseSessionsList("{}").isEmpty())
    assertTrue(parseSessionsList("{invalid").isEmpty())
  }

  @Test
  fun parseSessionsListStripsWhitespaceFromKeys() {
    val json = """{"sessions": [{"key": "  trimmed  ", "updatedAt": null}]}"""
    val sessions = parseSessionsList(json)
    assertEquals(1, sessions.size)
    assertEquals("trimmed", sessions[0].key)
  }

  @Test
  fun proxyPathsContainExpectedValues() {
    assertEquals("/openclaw/rpc", ProxyPaths.RPC)
    assertEquals("/openclaw/rpc-response", ProxyPaths.RPC_RESPONSE)
    assertEquals("/openclaw/event", ProxyPaths.EVENT)
    assertEquals("/openclaw/ping", ProxyPaths.PING)
    assertEquals("/openclaw/pong", ProxyPaths.PONG)
  }
}
