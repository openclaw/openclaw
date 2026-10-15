package ai.openclaw.app.calls

import android.os.PowerManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPowerManager

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class IncomingCallProximityTest {
  @Test
  fun `controller scope cancellation releases proximity without another route callback`() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        val app = RuntimeEnvironment.getApplication()
        shadowOf(app.getSystemService(PowerManager::class.java)).setIsWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, true)
        val proximity = IncomingCallProximity(app, backgroundScope)
        proximity.setEarpieceCallActive(true)
        runCurrent()
        val lock = requireNotNull(ShadowPowerManager.getLatestWakeLock())
        assertTrue(lock.isHeld)

        backgroundScope.cancel()
        runCurrent()
        assertFalse(lock.isHeld)
        proximity.setEarpieceCallActive(true)
        runCurrent()
        assertFalse(lock.isHeld)
        assertEquals(1, shadowOf(lock).timesHeld)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `route release is immediate and old cancellation cannot release the next lease`() =
    runTest {
      Dispatchers.setMain(StandardTestDispatcher(testScheduler))
      try {
        val app = RuntimeEnvironment.getApplication()
        shadowOf(app.getSystemService(PowerManager::class.java)).setIsWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, true)
        val proximity = IncomingCallProximity(app, backgroundScope)
        proximity.setEarpieceCallActive(true)
        runCurrent()
        val oldLock = requireNotNull(ShadowPowerManager.getLatestWakeLock())
        assertTrue(oldLock.isHeld)

        proximity.setEarpieceCallActive(false)
        assertFalse(oldLock.isHeld)
        proximity.setEarpieceCallActive(true)
        runCurrent()
        val newLock = requireNotNull(ShadowPowerManager.getLatestWakeLock())
        assertTrue(newLock.isHeld)
        assertFalse(oldLock.isHeld)
        proximity.setEarpieceCallActive(true)
        runCurrent()
        assertEquals(1, shadowOf(newLock).timesHeld)

        proximity.setEarpieceCallActive(false)
        assertFalse(newLock.isHeld)
        runCurrent()
      } finally {
        Dispatchers.resetMain()
      }
    }
}
