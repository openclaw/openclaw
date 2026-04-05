package ai.openclaw.app.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class WearProxyServiceTest {
  @Test
  fun classifyWearProxyRpcError_preservesOrdinaryRpcRejections() {
    val error = classifyWearProxyRpcError(IllegalStateException("INVALID_REQUEST: paramsJSON required"))

    assertEquals("INVALID_REQUEST", error.code)
    assertEquals("paramsJSON required", error.message)
  }

  @Test
  fun classifyWearProxyRpcError_onlyTreatsDisconnectsAsProxyErrors() {
    val error = classifyWearProxyRpcError(IllegalStateException("not connected"))

    assertEquals("PROXY_ERROR", error.code)
    assertEquals("Gateway disconnected", error.message)
  }

  @Test
  fun classifyWearProxyRpcError_mapsTimeoutsSeparately() {
    val error = classifyWearProxyRpcError(IllegalStateException("request timeout"))

    assertEquals("REQUEST_TIMEOUT", error.code)
    assertEquals("Request timed out", error.message)
  }

  @Test
  fun classifyWearProxyRpcError_rejectsNonCanonicalCodePrefixes() {
    val error = classifyWearProxyRpcError(IllegalStateException("IllegalStateException: boom"))

    assertEquals("REQUEST_ERROR", error.code)
    assertEquals("IllegalStateException: boom", error.message)
  }
}
