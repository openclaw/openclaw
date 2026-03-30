package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

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
}
