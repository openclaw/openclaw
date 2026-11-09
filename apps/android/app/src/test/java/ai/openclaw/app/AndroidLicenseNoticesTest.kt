package ai.openclaw.app

import ai.openclaw.app.ui.SettingsDetailScreen
import ai.openclaw.app.ui.SettingsRoute
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidLicenseNoticesTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun selectedSettingsDetailsSurviveSavedStateRestorationAndBackClearsThem() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val prefs = SecurePrefs(app, app.getSharedPreferences("settings-detail-restoration", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val route = mutableStateOf(SettingsRoute.Licenses)
    val restoration = StateRestorationTester(composeRule)
    var parentBacks = 0
    try {
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("settings", it) }
      // Seed external data only; selection, saving, restoration and Back use the real screens.
      fun <T> summaryState(field: String): MutableStateFlow<GatewaySummaryState<T>> =
        ReflectionHelpers.getField(ReflectionHelpers.getField<Any>(runtime, field), "mutableState")

      val skills = summaryState<GatewaySkillsSummary>("skillsSummary")
      skills.value =
        GatewaySummaryState(
          summary =
            GatewaySkillsSummary(
              listOf(
                GatewaySkillSummary(
                  skillKey = "restoration-skill",
                  name = "Restoration skill",
                  description = "Skill fixture",
                  source = "workspace",
                  emoji = null,
                  disabled = false,
                  eligible = true,
                  blockedByAllowlist = false,
                  blockedByAgentFilter = false,
                  bundled = false,
                  missingCount = 0,
                  installCount = 0,
                ),
              ),
            ),
        )
      val logs = summaryState<GatewayHealthLogsSummary>("healthLogsSummary")
      val logSummary =
        GatewaySummaryState(
          summary =
            GatewayHealthLogsSummary(
              entries = listOf(GatewayLogEntry("2026-11-09T09:41:00Z", "warn", null, "Restoration log", "raw log fixture")),
            ),
        )
      logs.value = logSummary
      restoration.setContent {
        if (mounted.value) {
          ClawDesignTheme {
            key(route.value) {
              SettingsDetailScreen(viewModel = model, route = route.value, onBack = { parentBacks++ })
            }
          }
        }
      }
      val cases =
        listOf(
          Triple(SettingsRoute.Licenses, "Manrope", "SIL OPEN FONT LICENSE Version 1.1"),
          Triple(SettingsRoute.Skills, "Restoration skill", "Inspect and manage installed skill state."),
          Triple(SettingsRoute.Health, "Restoration log", "raw log fixture"),
        )
      for ((target, item, detail) in cases) {
        composeRule.runOnIdle { route.value = target }
        composeRule.onNodeWithText(item).performScrollTo().performClick()
        composeRule.onNodeWithText(detail, substring = true).performScrollTo().assertIsDisplayed()
        if (target == SettingsRoute.Health) {
          // A new tail must not replace the snapshot already open in the detail screen.
          composeRule.runOnIdle { logs.value = GatewaySummaryState(summary = GatewayHealthLogsSummary()) }
        }
        restoration.emulateSavedInstanceStateRestore()
        composeRule.onNodeWithText(detail, substring = true).performScrollTo().assertIsDisplayed()
        if (target == SettingsRoute.Health) {
          for (value in listOf("09:41", "WARN", "Unknown", "Restoration log")) {
            composeRule.onNodeWithText(value).performScrollTo().assertIsDisplayed()
          }
          composeRule.runOnIdle { logs.value = logSummary }
        }
        composeRule.onNodeWithContentDescription("Back").performScrollTo().performClick()
        restoration.emulateSavedInstanceStateRestore()
        composeRule.onNodeWithText(detail, substring = true).assertDoesNotExist()
        composeRule.onNodeWithText(item).performScrollTo().assertIsDisplayed()
        assertEquals(0, parentBacks)
      }
    } finally {
      try {
        composeRule.runOnIdle { mounted.value = false }
        models.clear()
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
        }
      }
    }
  }

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
