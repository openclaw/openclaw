package ai.openclaw.app.node

import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.protocol.OpenClawSmsCommand
import android.content.Context
import android.content.pm.PackageManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class InvokeDispatcherTest {
  @Test
  fun classifySmsSearchAvailability_returnsAvailable_whenReadSmsIsAvailable() {
    assertEquals(
      SmsSearchAvailabilityReason.Available,
      classifySmsSearchAvailability(
        readSmsAvailable = true,
        smsFeatureEnabled = true,
        smsTelephonyAvailable = true,
      ),
    )
  }

  @Test
  fun classifySmsSearchAvailability_returnsUnavailable_whenSmsFeatureDisabled() {
    assertEquals(
      SmsSearchAvailabilityReason.Unavailable,
      classifySmsSearchAvailability(
        readSmsAvailable = false,
        smsFeatureEnabled = false,
        smsTelephonyAvailable = true,
      ),
    )
  }

  @Test
  fun classifySmsSearchAvailability_returnsUnavailable_whenTelephonyUnavailable() {
    assertEquals(
      SmsSearchAvailabilityReason.Unavailable,
      classifySmsSearchAvailability(
        readSmsAvailable = false,
        smsFeatureEnabled = true,
        smsTelephonyAvailable = false,
      ),
    )
  }

  @Test
  fun classifySmsSearchAvailability_returnsPermissionRequired_whenOnlyReadSmsPermissionIsMissing() {
    assertEquals(
      SmsSearchAvailabilityReason.PermissionRequired,
      classifySmsSearchAvailability(
        readSmsAvailable = false,
        smsFeatureEnabled = true,
        smsTelephonyAvailable = true,
      ),
    )
  }

  @Test
  fun smsSearchAvailabilityError_returnsNull_whenReadSmsPermissionIsRequestable() {
    assertNull(
      smsSearchAvailabilityError(
        readSmsAvailable = false,
        smsFeatureEnabled = true,
        smsTelephonyAvailable = true,
      ),
    )
  }

  @Test
  fun smsSearchAvailabilityError_returnsUnavailable_whenSmsSearchIsImpossible() {
    val result =
      smsSearchAvailabilityError(
        readSmsAvailable = false,
        smsFeatureEnabled = false,
        smsTelephonyAvailable = true,
      )

    assertEquals("SMS_UNAVAILABLE", result?.error?.code)
    assertEquals("SMS_UNAVAILABLE: SMS not available on this device", result?.error?.message)
  }

  @Test
  fun handleInvoke_allowsRequestableSmsSearchToReachHandler() =
    runTest {
      val result =
        newDispatcher(
          readSmsAvailable = false,
          smsFeatureEnabled = true,
          smsTelephonyAvailable = true,
        ).handleInvoke(OpenClawSmsCommand.Search.rawValue, "not-json")

      assertEquals("SMS_PERMISSION_REQUIRED", result.error?.code)
      assertEquals("grant READ_SMS permission", result.error?.message)
    }

  @Test
  fun handleInvoke_blocksSmsSearchWhenFeatureIsUnavailable() =
    runTest {
      val result =
        newDispatcher(
          readSmsAvailable = false,
          smsFeatureEnabled = false,
          smsTelephonyAvailable = true,
        ).handleInvoke(OpenClawSmsCommand.Search.rawValue, "not-json")

      assertEquals("SMS_UNAVAILABLE", result.error?.code)
      assertEquals("SMS_UNAVAILABLE: SMS not available on this device", result.error?.message)
    }

  private fun newDispatcher(
    sendSmsAvailable: Boolean = false,
    readSmsAvailable: Boolean = false,
    smsFeatureEnabled: Boolean = true,
    smsTelephonyAvailable: Boolean = true,
  ): InvokeDispatcher {
    val appContext = RuntimeEnvironment.getApplication()
    shadowOf(appContext.packageManager).setSystemFeature(PackageManager.FEATURE_TELEPHONY, smsTelephonyAvailable)
    val canvas = CanvasController()
    return InvokeDispatcher(
      canvas = canvas,
      cameraHandler = newCameraHandler(appContext),
      locationHandler =
        LocationHandler.forTesting(
          appContext = appContext,
          dataSource = InvokeDispatcherFakeLocationDataSource(),
        ),
      deviceHandler = DeviceHandler(appContext),
      notificationsHandler =
        NotificationsHandler.forTesting(
          appContext = appContext,
          stateProvider = InvokeDispatcherFakeNotificationsStateProvider(),
        ),
      systemHandler = SystemHandler.forTesting(InvokeDispatcherFakeSystemNotificationPoster()),
      photosHandler = PhotosHandler.forTesting(appContext, InvokeDispatcherFakePhotosDataSource()),
      contactsHandler = ContactsHandler.forTesting(appContext, InvokeDispatcherFakeContactsDataSource()),
      calendarHandler = CalendarHandler.forTesting(appContext, InvokeDispatcherFakeCalendarDataSource()),
      motionHandler = MotionHandler.forTesting(appContext, InvokeDispatcherFakeMotionDataSource()),
      smsHandler = SmsHandler(SmsManager(appContext)),
      a2uiHandler =
        A2UIHandler(
          canvas = canvas,
          json = Json { ignoreUnknownKeys = true },
          getNodeCanvasHostUrl = { null },
          getOperatorCanvasHostUrl = { null },
        ),
      debugHandler = DebugHandler(appContext, DeviceIdentityStore(appContext)),
      callLogHandler = CallLogHandler.forTesting(appContext, InvokeDispatcherFakeCallLogDataSource()),
      isForeground = { true },
      cameraEnabled = { false },
      locationEnabled = { false },
      sendSmsAvailable = { sendSmsAvailable },
      readSmsAvailable = { readSmsAvailable },
      smsFeatureEnabled = { smsFeatureEnabled },
      smsTelephonyAvailable = { smsTelephonyAvailable },
      callLogAvailable = { false },
      debugBuild = { false },
      refreshNodeCanvasCapability = { false },
      onCanvasA2uiPush = {},
      onCanvasA2uiReset = {},
      motionActivityAvailable = { false },
      motionPedometerAvailable = { false },
    )
  }

  private fun newCameraHandler(appContext: Context): CameraHandler {
    return CameraHandler(
      appContext = appContext,
      camera = CameraCaptureManager(appContext),
      externalAudioCaptureActive = MutableStateFlow(false),
      showCameraHud = { _, _, _ -> },
      triggerCameraFlash = {},
      invokeErrorFromThrowable = { err -> "UNAVAILABLE" to (err.message ?: "camera failed") },
    )
  }
}

private class InvokeDispatcherFakeLocationDataSource : LocationDataSource {
  override fun hasFinePermission(context: Context): Boolean = false

  override fun hasCoarsePermission(context: Context): Boolean = false

  override suspend fun fetchLocation(
    desiredProviders: List<String>,
    maxAgeMs: Long?,
    timeoutMs: Long,
    isPrecise: Boolean,
  ): LocationCaptureManager.Payload {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeNotificationsStateProvider : NotificationsStateProvider {
  override fun readSnapshot(context: Context): DeviceNotificationSnapshot {
    return DeviceNotificationSnapshot(enabled = false, connected = false, notifications = emptyList())
  }

  override fun requestServiceRebind(context: Context) = Unit

  override fun executeAction(context: Context, request: NotificationActionRequest): NotificationActionResult {
    return NotificationActionResult(ok = true, code = null, message = null)
  }
}

private class InvokeDispatcherFakeSystemNotificationPoster : SystemNotificationPoster {
  override fun isAuthorized(): Boolean = true

  override fun post(request: SystemNotifyRequest) = Unit
}

private class InvokeDispatcherFakePhotosDataSource : PhotosDataSource {
  override fun hasPermission(context: Context): Boolean = true

  override fun latest(context: Context, request: PhotosLatestRequest): List<EncodedPhotoPayload> = emptyList()
}

private class InvokeDispatcherFakeContactsDataSource : ContactsDataSource {
  override fun hasReadPermission(context: Context): Boolean = true

  override fun hasWritePermission(context: Context): Boolean = true

  override fun search(context: Context, request: ContactsSearchRequest): List<ContactRecord> = emptyList()

  override fun add(context: Context, request: ContactsAddRequest): ContactRecord {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeCalendarDataSource : CalendarDataSource {
  override fun hasReadPermission(context: Context): Boolean = true

  override fun hasWritePermission(context: Context): Boolean = true

  override fun events(context: Context, request: CalendarEventsRequest): List<CalendarEventRecord> = emptyList()

  override fun add(context: Context, request: CalendarAddRequest): CalendarEventRecord {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeMotionDataSource : MotionDataSource {
  override fun isActivityAvailable(context: Context): Boolean = false

  override fun isPedometerAvailable(context: Context): Boolean = false

  override fun hasPermission(context: Context): Boolean = true

  override suspend fun activity(context: Context, request: MotionActivityRequest): MotionActivityRecord {
    error("unused in InvokeDispatcherTest")
  }

  override suspend fun pedometer(context: Context, request: MotionPedometerRequest): PedometerRecord {
    error("unused in InvokeDispatcherTest")
  }
}

private class InvokeDispatcherFakeCallLogDataSource : CallLogDataSource {
  override fun hasReadPermission(context: Context): Boolean = true

  override fun search(context: Context, request: CallLogSearchRequest): List<CallLogRecord> = emptyList()
}
