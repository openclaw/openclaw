package ai.openclaw.wear

import ai.openclaw.android.gateway.GatewayEvent
import ai.openclaw.wear.gateway.GatewayClientInterface
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class WearAppTest {
  @Test
  fun activateWearGatewayClient_refreshesAlreadyConnectedHandoffs() {
    val current = FakeGatewayClient(connected = true)
    val next = FakeGatewayClient(connected = true)
    val calls = mutableListOf<String>()
    var active: GatewayClientInterface = current

    activateWearGatewayClient(
      currentClient = current,
      nextClient = next,
      setActiveClient = {
        active = it
        calls += "setActiveClient"
      },
      switchClient = { calls += "switchClient" },
      onConnected = { calls += "onConnected" },
    )

    assertSame(next, active)
    assertEquals(listOf("setActiveClient", "switchClient", "onConnected"), calls)
  }

  @Test
  fun activateWearGatewayClient_skipsNoOpSwitches() {
    val current = FakeGatewayClient(connected = true)
    val calls = mutableListOf<String>()
    var active: GatewayClientInterface = current

    activateWearGatewayClient(
      currentClient = current,
      nextClient = current,
      setActiveClient = {
        active = it
        calls += "setActiveClient"
      },
      switchClient = { calls += "switchClient" },
      onConnected = { calls += "onConnected" },
    )

    assertSame(current, active)
    assertEquals(emptyList<String>(), calls)
  }

  private class FakeGatewayClient(
    connected: Boolean,
  ) : GatewayClientInterface {
    override val connected: StateFlow<Boolean> = MutableStateFlow(connected)
    override val statusText: StateFlow<String> = MutableStateFlow("")
    override val events: SharedFlow<GatewayEvent> = MutableSharedFlow()

    override suspend fun request(method: String, paramsJson: String?, timeoutMs: Long): String {
      throw UnsupportedOperationException("unused in test")
    }
  }
}
