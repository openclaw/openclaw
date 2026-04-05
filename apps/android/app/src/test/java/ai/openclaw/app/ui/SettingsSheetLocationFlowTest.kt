package ai.openclaw.app.ui

import ai.openclaw.app.LocationMode
import ai.openclaw.app.restoreLocationModeAfterCanceledAlwaysGrant
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsSheetLocationFlowTest {
  @Test
  fun restoreLocationModeAfterCanceledAlwaysGrant_restoresOffWhenPromptStartedFromOff() {
    val restored =
      restoreLocationModeAfterCanceledAlwaysGrant(
        previousMode = LocationMode.Off,
        locationGranted = true,
      )

    assertEquals(LocationMode.Off, restored)
  }

  @Test
  fun restoreLocationModeAfterCanceledAlwaysGrant_keepsWhileUsingWhenPromptStartedFromWhileUsing() {
    val restored =
      restoreLocationModeAfterCanceledAlwaysGrant(
        previousMode = LocationMode.WhileUsing,
        locationGranted = true,
      )

    assertEquals(LocationMode.WhileUsing, restored)
  }

  @Test
  fun restoreLocationModeAfterCanceledAlwaysGrant_fallsBackToOffWithoutForegroundPermission() {
    val restored =
      restoreLocationModeAfterCanceledAlwaysGrant(
        previousMode = LocationMode.WhileUsing,
        locationGranted = false,
      )

    assertEquals(LocationMode.Off, restored)
  }
}
