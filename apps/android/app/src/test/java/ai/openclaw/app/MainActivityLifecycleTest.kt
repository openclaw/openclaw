package ai.openclaw.app

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class MainActivityLifecycleTest {
  @Test
  fun pendingIntentRouter_defersInitialIntentUntilActivationAndConsumesOnce() {
    val router = MainActivityPendingIntentRouter()
    val routedActions = mutableListOf<String?>()

    router.setInitialIntent(Intent("ai.openclaw.FIRST"))

    assertTrue(router.activate { intent -> routedActions += intent.action })
    assertFalse(router.activate { intent -> routedActions += intent.action })

    assertEquals(listOf("ai.openclaw.FIRST"), routedActions)
  }

  @Test
  fun pendingIntentRouter_routesLatestIntentReceivedBeforeActivation() {
    val router = MainActivityPendingIntentRouter()
    val routedActions = mutableListOf<String?>()

    router.setInitialIntent(Intent("ai.openclaw.FIRST"))
    router.onNewIntent(Intent("ai.openclaw.SECOND")) { intent -> routedActions += intent.action }

    assertTrue(router.activate { intent -> routedActions += intent.action })

    assertEquals(listOf("ai.openclaw.SECOND"), routedActions)
  }

  @Test
  fun pendingIntentRouter_routesNewIntentImmediatelyAfterActivation() {
    val router = MainActivityPendingIntentRouter()
    val routedActions = mutableListOf<String?>()

    assertTrue(router.activate { intent -> routedActions += intent.action })
    router.onNewIntent(Intent("ai.openclaw.NEXT")) { intent -> routedActions += intent.action }

    assertEquals(listOf("ai.openclaw.NEXT"), routedActions)
  }

  @Test
  fun runtimeUiStarter_attachesRuntimeUiAndStartsServiceOnceWhenReady() {
    val starter = MainActivityRuntimeUiStarter()
    val calls = mutableListOf<String>()

    starter.onRuntimeInitialized(
      ready = false,
      attachRuntimeUi = { calls += "attach" },
      startNodeService = { calls += "service" },
    )
    starter.onRuntimeInitialized(
      ready = true,
      attachRuntimeUi = { calls += "attach" },
      startNodeService = { calls += "service" },
    )
    starter.onRuntimeInitialized(
      ready = true,
      attachRuntimeUi = { calls += "attach-again" },
      startNodeService = { calls += "service-again" },
    )

    assertEquals(listOf("attach", "service"), calls)
  }
}
