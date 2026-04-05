package ai.openclaw.app

import android.app.Notification
import android.content.pm.ServiceInfo
import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class NodeForegroundServiceTest {
  @Test
  fun buildNotificationSetsLaunchIntent() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()
    val notification = buildNotification(service)

    val pendingIntent = notification.contentIntent
    assertNotNull(pendingIntent)

    val savedIntent = Shadows.shadowOf(pendingIntent).savedIntent
    assertNotNull(savedIntent)
    assertEquals(MainActivity::class.java.name, savedIntent.component?.className)

    val expectedFlags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    assertEquals(expectedFlags, savedIntent.flags and expectedFlags)
  }

  @Test
  fun foregroundServiceType_omitsLocationWhenPermissionMissing() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()

    val serviceType = foregroundServiceType(service, locationGranted = false)

    assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC, serviceType)
  }

  @Test
  fun foregroundServiceType_includesLocationWhenPermissionGranted() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()

    val serviceType = foregroundServiceType(service, locationGranted = true)

    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      serviceType,
    )
  }

  @Test
  fun shouldRestartForeground_whenNeverStarted() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()

    val shouldRestart =
      shouldRestartForeground(
        service = service,
        didStartForeground = false,
        currentForegroundServiceType = null,
        requestedServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )

    assertTrue(shouldRestart)
  }

  @Test
  fun shouldRestartForeground_whenServiceTypeChanges() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()

    val shouldRestart =
      shouldRestartForeground(
        service = service,
        didStartForeground = true,
        currentForegroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        requestedServiceType =
          ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      )

    assertTrue(shouldRestart)
  }

  @Test
  fun shouldRestartForeground_whenServiceTypeMatches() {
    val service = Robolectric.buildService(NodeForegroundService::class.java).get()

    val shouldRestart =
      shouldRestartForeground(
        service = service,
        didStartForeground = true,
        currentForegroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        requestedServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
      )

    assertFalse(shouldRestart)
  }

  @Test
  fun onStartCommand_refreshActionReevaluatesForegroundServiceType() {
    TestNodeForegroundService.locationGranted = true
    val service = Robolectric.buildService(TestNodeForegroundService::class.java).get()
    setForegroundState(
      service = service,
      didStartForeground = true,
      currentForegroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
    )

    service.onStartCommand(
      Intent(service, NodeForegroundService::class.java).setAction(refreshForegroundAction()),
      0,
      1,
    )

    assertEquals(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      currentForegroundServiceType(service),
    )
  }

  private fun buildNotification(service: NodeForegroundService): Notification {
    val method =
      NodeForegroundService::class.java.getDeclaredMethod(
        "buildNotification",
        String::class.java,
        String::class.java,
      )
    method.isAccessible = true
    return method.invoke(service, "Title", "Text") as Notification
  }

  private fun foregroundServiceType(service: NodeForegroundService, locationGranted: Boolean): Int {
    val method =
      NodeForegroundService::class.java.getDeclaredMethod(
        "foregroundServiceType",
        Boolean::class.javaPrimitiveType,
      )
    method.isAccessible = true
    return method.invoke(service, locationGranted) as Int
  }

  private fun shouldRestartForeground(
    service: NodeForegroundService,
    didStartForeground: Boolean,
    currentForegroundServiceType: Int?,
    requestedServiceType: Int,
  ): Boolean {
    val didStartField = NodeForegroundService::class.java.getDeclaredField("didStartForeground")
    didStartField.isAccessible = true
    didStartField.setBoolean(service, didStartForeground)

    val currentTypeField = NodeForegroundService::class.java.getDeclaredField("currentForegroundServiceType")
    currentTypeField.isAccessible = true
    currentTypeField.set(service, currentForegroundServiceType)

    val method =
      NodeForegroundService::class.java.getDeclaredMethod(
        "shouldRestartForeground",
        Int::class.javaPrimitiveType,
      )
    method.isAccessible = true
    return method.invoke(service, requestedServiceType) as Boolean
  }

  private fun setForegroundState(
    service: NodeForegroundService,
    didStartForeground: Boolean,
    currentForegroundServiceType: Int?,
  ) {
    val didStartField = NodeForegroundService::class.java.getDeclaredField("didStartForeground")
    didStartField.isAccessible = true
    didStartField.setBoolean(service, didStartForeground)

    val currentTypeField = NodeForegroundService::class.java.getDeclaredField("currentForegroundServiceType")
    currentTypeField.isAccessible = true
    currentTypeField.set(service, currentForegroundServiceType)
  }

  private fun currentForegroundServiceType(service: NodeForegroundService): Int? {
    val currentTypeField = NodeForegroundService::class.java.getDeclaredField("currentForegroundServiceType")
    currentTypeField.isAccessible = true
    return currentTypeField.get(service) as Int?
  }

  private fun refreshForegroundAction(): String {
    val field = NodeForegroundService::class.java.getDeclaredField("ACTION_REFRESH_FOREGROUND")
    field.isAccessible = true
    return field.get(null) as String
  }

  private class TestNodeForegroundService : NodeForegroundService() {
    override fun hasAnyLocationPermission(): Boolean = locationGranted

    companion object {
      var locationGranted: Boolean = false
    }
  }
}
