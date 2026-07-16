package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class WearThemeTest {
  @Test
  fun defaultsToDarkForMissingOrUnknownValue() {
    assertEquals(WearThemeMode.Dark, WearThemeMode.fromRawValue(null))
    assertEquals(WearThemeMode.Dark, WearThemeMode.fromRawValue("unknown"))
  }

  @Test
  fun restoresStoredThemeIgnoringCaseAndWhitespace() {
    assertEquals(WearThemeMode.Dark, WearThemeMode.fromRawValue(" DARK "))
    assertEquals(WearThemeMode.Light, WearThemeMode.fromRawValue(" light "))
  }
}
