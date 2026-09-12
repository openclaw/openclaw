package ai.openclaw.wear

import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearProxyCapability
import ai.openclaw.wear.shared.WearRealtimeTalkCodec
import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = WearApplication::class, sdk = [35])
class WearViewModelLifecycleTest {
  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun stopClearsRemoteSpeakingProjectionWhileRpcIsStalledAndClearClosesResources() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val app = RuntimeEnvironment.getApplication() as WearApplication
      val owner = TestViewModelStoreOwner()
      val viewModel = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[WearViewModel::class.java]
      val client = viewModel.realtimeTalkClientForTest()
      val fixture = WearTalkTestFixture(app, client)
      try {
        (viewModel.talkTestField("loadJob") as? Job)?.cancel()
        testScheduler.runCurrent()
        @Suppress("UNCHECKED_CAST")
        val state = viewModel.talkTestField("mutableState") as MutableStateFlow<WearUiState>
        viewModel.setTalkTestField("talkAttemptId", "attempt-1")
        state.value =
          WearUiState(
            loading = false,
            connected = true,
            phoneNodeId = "phone-a",
            realtimeTalk =
              WearRealtimeTalkSnapshot(
                attemptId = "attempt-1",
                active = true,
                speaking = true,
                status = WearRealtimeTalkStatus.SPEAKING,
              ),
          )
        fixture.activate()
        viewModel.stopRealtimeTalk()
        testScheduler.runCurrent()
        assertTrue(fixture.rpcEntered.isCompleted)
        assertFalse(fixture.rpcReply.isCompleted)
        assertTrue(state.value.talkBusy)
        assertFalse(
          "production snapshot cannot retain remote Speaking after local Stop",
          state.value
            .toConversationSnapshot()!!
            .realtimeTalk.speaking,
        )
        assertFalse(state.value.realtimeTalk.active)
        assertEquals(1, fixture.input.closes.get())
        assertTrue(state.value.talkStopping)
        (viewModel.talkTestField("eventSourceTracker") as WearEventSourceTracker).adopt("phone-a")
        (viewModel.talkTestField("eventSequenceTracker") as WearEventSequenceTracker).adoptSnapshot("stream-a", 1L)
        viewModel.callTalkTestMethod(
          "handleEvent",
          WearInboundEvent(
            sourceNodeId = "phone-a",
            sequence = 2L,
            event = WearEventType.Talk,
            streamId = "stream-a",
            payload =
              WearRealtimeTalkCodec.encode(
                WearRealtimeTalkSnapshot(
                  attemptId = "attempt-1",
                  active = true,
                  listening = true,
                  status = WearRealtimeTalkStatus.LISTENING,
                ),
              ),
          ),
        )
        assertTrue(state.value.talkStopping)
        assertFalse(state.value.realtimeTalk.listening)
        fixture.rpcReply.complete(Unit)
        testScheduler.runCurrent()
        assertFalse(state.value.talkStopping)
        assertFalse(state.value.talkBusy)
        owner.viewModelStore.clear()
        testScheduler.runCurrent()
        assertEquals(1, fixture.input.closes.get())
        assertEquals(1, fixture.channelCloses.get())
      } finally {
        owner.viewModelStore.clear()
        Dispatchers.resetMain()
      }
    }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test
  fun foregroundExitCancelsPendingCaptureIntentAndIgnoresLateCompletion() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      val app = RuntimeEnvironment.getApplication() as WearApplication
      val owner = TestViewModelStoreOwner()
      val vm = ViewModelProvider(owner, ViewModelProvider.AndroidViewModelFactory.getInstance(app))[WearViewModel::class.java]
      val client = vm.realtimeTalkClientForTest()
      val fixture = WearTalkTestFixture(app, client)
      try {
        (vm.talkTestField("loadJob") as? Job)?.cancel()
        testScheduler.runCurrent()
        fixture.activate()
        val pending = Job()
        vm.setTalkTestField("talkStartJob", pending)
        vm.setTalkTestField("talkAttemptId", "attempt-1")
        vm.suspendRealtimeTalk()
        assertFalse(pending.isActive)
        assertNull(vm.talkTestField("talkAttemptId"))
        assertFalse(vm.state.value.talkBusy)
        assertFalse(vm.state.value.realtimeTalk.active)
        assertEquals(1, fixture.input.closes.get())
        client.callTalkTestMethod("clearOutput", fixture.attempt, true)
        assertFalse(client.isCapturing.value)
      } finally {
        owner.viewModelStore.clear()
        Dispatchers.resetMain()
      }
    }

  @Test
  fun recreatedViewModelGetsALiveTalkClientAfterThePreviousOneClears() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
    val firstOwner = TestViewModelStoreOwner()
    val firstViewModel = ViewModelProvider(firstOwner, factory)[WearViewModel::class.java]
    val firstClient = firstViewModel.realtimeTalkClientForTest()
    val fixture = WearTalkTestFixture(app, firstClient)
    fixture.activate()

    firstOwner.viewModelStore.clear()
    assertEquals(1, fixture.input.closes.get())
    assertEquals(1, fixture.output.closes.get())
    assertEquals(1, fixture.channelCloses.get())

    val reopenedOwner = TestViewModelStoreOwner()
    val reopenedViewModel = ViewModelProvider(reopenedOwner, factory)[WearViewModel::class.java]
    val reopenedClient = reopenedViewModel.realtimeTalkClientForTest()
    try {
      assertFalse(firstClient.scopeForTest().coroutineContext[Job]?.isActive == true)
      assertNotSame(firstClient, reopenedClient)
      assertTrue(reopenedClient.scopeForTest().coroutineContext[Job]?.isActive == true)
    } finally {
      reopenedOwner.viewModelStore.clear()
    }
  }

  @Test
  fun agentPulsePollingRequiresVisibleConnectedCapablePreferredRoute() {
    val connected =
      WearUiState(
        loading = false,
        connected = true,
        phoneNodeId = "phone-a",
        proxyCapabilities = setOf(WearProxyCapability.AgentPulse),
      )

    assertTrue(shouldPollAgentPulse(connected, pulseVisible = true))
    assertFalse(shouldPollAgentPulse(connected, pulseVisible = false))
    assertFalse(shouldPollAgentPulse(connected.copy(connected = false), pulseVisible = true))
    assertFalse(shouldPollAgentPulse(connected.copy(phoneNodeId = null), pulseVisible = true))
    assertFalse(
      shouldPollAgentPulse(
        connected.copy(proxyCapabilities = emptySet()),
        pulseVisible = true,
      ),
    )
  }

  @Test
  fun agentPulseRouteRejectsPhoneAgentSessionAndGenerationChanges() {
    val session =
      WearSession(
        key = "agent:main:one",
        title = "One",
        updatedAt = null,
        hasActiveRun = false,
        phoneNodeId = "phone-a",
        agentId = "main",
      )
    val current =
      WearUiState(
        loading = false,
        connected = true,
        phoneNodeId = "phone-a",
        activeAgentId = "main",
        proxyCapabilities = setOf(WearProxyCapability.AgentPulse),
        selectedSession = session,
      )

    fun accepts(
      state: WearUiState = current,
      routeGeneration: Long = 7L,
      requestGeneration: Long = 11L,
    ): Boolean =
      wearAgentPulseRouteIsCurrent(
        requestedPhoneNodeId = "phone-a",
        requestedAgentId = "main",
        requestedSessionKey = session.key,
        requestedRouteGeneration = 7L,
        currentRouteGeneration = routeGeneration,
        requestedGeneration = 11L,
        currentGeneration = requestGeneration,
        pulseVisible = true,
        state = state,
      )

    assertTrue(accepts())
    assertFalse(accepts(current.copy(phoneNodeId = "phone-b")))
    assertFalse(accepts(current.copy(activeAgentId = "secondary")))
    assertFalse(accepts(current.copy(selectedSession = session.copy(key = "agent:main:two"))))
    assertFalse(accepts(routeGeneration = 8L))
    assertFalse(accepts(requestGeneration = 12L))
  }

  @Test
  fun hidingAgentPulseCancelsTheSinglePoller() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
    val owner = TestViewModelStoreOwner()
    val viewModel = ViewModelProvider(owner, factory)[WearViewModel::class.java]
    val pollJob = Job()
    try {
      viewModel.setAgentPulseVisibleForTest(true)
      viewModel.setAgentPulsePollJobForTest(pollJob)

      viewModel.setAgentPulseVisible(false)

      assertFalse(pollJob.isActive)
      assertNull(viewModel.agentPulsePollJobForTest())
      assertFalse(viewModel.state.value.agentPulseLoading)
    } finally {
      owner.viewModelStore.clear()
    }
  }

  @Test
  fun clearingViewModelCancelsTheAgentPulsePoller() {
    val app = RuntimeEnvironment.getApplication() as WearApplication
    val factory = ViewModelProvider.AndroidViewModelFactory.getInstance(app)
    val owner = TestViewModelStoreOwner()
    val viewModel = ViewModelProvider(owner, factory)[WearViewModel::class.java]
    val pollJob = Job()
    viewModel.setAgentPulsePollJobForTest(pollJob)

    owner.viewModelStore.clear()

    assertFalse(pollJob.isActive)
    assertNull(viewModel.agentPulsePollJobForTest())
  }

  private class TestViewModelStoreOwner : ViewModelStoreOwner {
    override val viewModelStore = ViewModelStore()
  }

  private fun WearViewModel.realtimeTalkClientForTest(): WearRealtimeTalkClient =
    javaClass.getDeclaredField("realtimeTalkClient").run {
      isAccessible = true
      get(this@realtimeTalkClientForTest) as WearRealtimeTalkClient
    }

  private fun WearViewModel.setAgentPulseVisibleForTest(visible: Boolean) {
    javaClass.getDeclaredField("agentPulseVisible").run {
      isAccessible = true
      setBoolean(this@setAgentPulseVisibleForTest, visible)
    }
  }

  private fun WearViewModel.setAgentPulsePollJobForTest(job: Job?) {
    javaClass.getDeclaredField("agentPulsePollJob").run {
      isAccessible = true
      set(this@setAgentPulsePollJobForTest, job)
    }
  }

  private fun WearViewModel.agentPulsePollJobForTest(): Job? =
    javaClass.getDeclaredField("agentPulsePollJob").run {
      isAccessible = true
      get(this@agentPulsePollJobForTest) as? Job
    }

  private fun WearRealtimeTalkClient.scopeForTest(): CoroutineScope =
    javaClass.getDeclaredField("scope").run {
      isAccessible = true
      get(this@scopeForTest) as CoroutineScope
    }
}
