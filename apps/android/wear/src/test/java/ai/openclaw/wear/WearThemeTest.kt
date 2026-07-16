package ai.openclaw.wear

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import java.lang.reflect.Proxy

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

  @Test
  fun autoSpeakDefaultsToOffForFreshPreferences() {
    val emptyPreferences =
      Proxy.newProxyInstance(
        WearThemeTest::class.java.classLoader,
        arrayOf(SharedPreferences::class.java),
      ) { _, method, arguments ->
        when (method.name) {
          "getBoolean" -> arguments?.get(1)
          else -> error("Unexpected SharedPreferences call: ${method.name}")
        }
      } as SharedPreferences

    assertFalse(WearConversationPreferences(emptyPreferences).readAutoSpeak())
  }
}
