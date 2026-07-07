package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLanguageModeTest {
  @Test
  fun fromRawValue_defaultsToSystemForMissingOrUnknownValue() {
    assertEquals(AppLanguageMode.System, AppLanguageMode.fromRawValue(null))
    assertEquals(AppLanguageMode.System, AppLanguageMode.fromRawValue(""))
    assertEquals(AppLanguageMode.System, AppLanguageMode.fromRawValue("unsupported"))
  }

  @Test
  fun localeBackedModesExposeStableLanguageTags() {
    assertEquals("zh-CN", AppLanguageMode.ChineseSimplified.localeTag)
    assertEquals("pt-BR", AppLanguageMode.PortugueseBrazil.localeTag)
    assertEquals("ja-JP", AppLanguageMode.Japanese.localeTag)
    assertNull(AppLanguageMode.System.localeTag)
  }

  @Test
  fun optionLabelsRoundTripToModes() {
    for (mode in appLanguageOptions()) {
      assertEquals(mode, appLanguageModeForLabel(appLanguageOptionLabel(mode)))
    }
  }

  @Test
  fun appLanguageOptionsIncludeAllNativeResourceLocales() {
    val localeTags = appLanguageOptions().mapNotNull { it.localeTag }.toSet()

    assertTrue(localeTags.contains("zh-CN"))
    assertTrue(localeTags.contains("zh-TW"))
    assertTrue(localeTags.contains("pt-BR"))
    assertTrue(localeTags.contains("sv"))
  }
}
