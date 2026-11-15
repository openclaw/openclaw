package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class AndroidLicenseNoticesTest {
  @Test
  fun isAndroidLicenseFileName_acceptsTxtOnly() {
    assertTrue(isAndroidLicenseFileName("MANROPE_OFL.txt"))
    assertTrue(isAndroidLicenseFileName("notice.TXT"))
    assertEquals(false, isAndroidLicenseFileName("notice.md"))
    assertEquals(false, isAndroidLicenseFileName("notice"))
  }

  @Test
  fun androidLicenseTitleFromFileName_usesExactFileNameStem() {
    assertEquals("Manrope", androidLicenseTitleFromFileName("Manrope.txt"))
    assertEquals("OkHttp and Okio", androidLicenseTitleFromFileName("OkHttp and Okio.txt"))
    assertEquals("SLF4J API", androidLicenseTitleFromFileName("SLF4J API.TXT"))
  }

  @Test
  fun androidLicenseTitleFromFileName_fallsBackForBlankStem() {
    assertEquals("License", androidLicenseTitleFromFileName(".txt"))
  }

  @Test
  fun loadAndroidLicenseNotices_readsPackagedTxtAssets() {
    val context = RuntimeEnvironment.getApplication()
    val licenses = loadAndroidLicenseNotices(context.assets)

    assertEquals(
      listOf(
        "Accompanist Drawable Painter",
        "AndroidSVG",
        "AndroidX CameraX",
        "AndroidX Compose",
        "AndroidX Media3",
        "AndroidX Room",
        "AndroidX SQLite",
        "AndroidX Wear",
        "AndroidX WebKit",
        "AndroidX WindowManager",
        "Bouncy Castle Provider",
        "CodexBar",
        "Coil",
        "CommonMark Java",
        "dnsjava",
        "DOMPurify",
        "JNA",
        "KaTeX",
        "Kotlin Libraries",
        "libffi",
        "libsodium",
        "llama.cpp",
        "Lobe Icons",
        "Lucide",
        "Manrope",
        "Markdown",
        "nibor autolink",
        "OkHttp and Okio",
        "Pele",
        "SLF4J API",
      ),
      licenses.map { license -> license.title },
    )
    assertEquals(false, licenses.any { license -> license.text.startsWith("Title:") })
    assertTrue(licenses.any { license -> license.text.contains("SIL Open Font License") })
    assertTrue(licenses.any { license -> license.text.contains("Apache License") })
    assertTrue(licenses.any { license -> license.text.contains("BSD 2-Clause") })
    assertTrue(licenses.any { license -> license.text.contains("BSD 3-Clause") })
    assertTrue(licenses.any { license -> license.text.contains("MIT License") })
    val pele = licenses.single { license -> license.title == "Pele" }.text
    assertTrue(pele.contains("Copyright (c) 2026 kepano"))
    assertTrue(pele.contains("Copyright (c) 2026 Lucide Icons and Contributors"))
    assertTrue(pele.contains("Permission to use, copy, modify, and/or distribute"))
    assertTrue(licenses.any { license -> license.text.contains("Bouncy Castle Licence") })
    assertTrue(licenses.any { license -> license.title == "Coil" && license.text.contains("Coil Contributors") })
    assertTrue(licenses.any { license -> license.title == "CodexBar" && license.text.contains("Peter Steinberger") })
    assertTrue(licenses.any { license -> license.title == "Lobe Icons" && license.text.contains("LobeHub") })
    assertTrue(licenses.any { license -> license.title == "llama.cpp" && license.text.contains("ggml authors") })
  }
}
