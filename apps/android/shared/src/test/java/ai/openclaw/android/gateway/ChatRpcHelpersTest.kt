package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatRpcHelpersTest {
  @Test
  fun applyMainSessionKeyMovesCurrentSessionWhenStillOnDefault() {
    val state =
      applyMainSessionKey(
        currentSessionKey = "main",
        appliedMainSessionKey = "main",
        nextMainSessionKey = "agent:ops:node-device",
      )

    assertEquals("agent:ops:node-device", state.currentSessionKey)
    assertEquals("agent:ops:node-device", state.appliedMainSessionKey)
  }

  @Test
  fun buildSessionsListParamsOmitsLimitWhenUnset() {
    val params = buildSessionsListParams()

    assertEquals("true", params["includeGlobal"]?.toString())
    assertEquals("false", params["includeUnknown"]?.toString())
    assertNull(params["limit"])
  }

  @Test
  fun parseChatRunIdReturnsNullForBlankOrMissingValues() {
    assertNull(parseChatRunId("""{"ok":true}"""))
    assertNull(parseChatRunId("""{"runId":"   "}"""))
  }

  @Test
  fun parseChatRunIdParsesTrimmedRunId() {
    assertEquals("run-1", parseChatRunId("""{"runId":"  run-1  "}"""))
  }
}
