package ai.openclaw.app.ui

import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Drives the shipped sign-in dialog through the platform [androidx.compose.ui.platform.UriHandler].
 * A second installed browser records http and https delivery. Unsafe schemes must not start that browser.
 */
@RunWith(AndroidJUnit4::class)
class ProviderSignInDialogDeviceTest {
  @Test fun browserWizardUrlsOpenOnThePlatform() {
    val failures = mutableListOf<String>()
    for (case in BROWSER_CASES) {
      val outcome = runCatching { exercise(case, expectButton = true, expectBrowser = true) }
      outcome.exceptionOrNull()?.let { failures += "${case.name}: ${it.message}" }
    }
    assertTrue(failures.joinToString("\n"), failures.isEmpty())
  }

  @Test fun intentSchemeDoesNotOpenOnThePlatform() = unsafe("intent", "intent://scan/#Intent;scheme=https;end")

  @Test fun fileSchemeDoesNotOpenOnThePlatform() = unsafe("file", "file:///sdcard/secret.txt")

  @Test fun javascriptSchemeDoesNotOpenOnThePlatform() = unsafe("javascript", "javascript:alert(1)")

  private fun unsafe(
    name: String,
    url: String,
  ) {
    val expectHidden = expectSafeOnly()
    exercise(Case(name, url), expectButton = !expectHidden, expectBrowser = false)
  }

  private fun exercise(
    case: Case,
    expectButton: Boolean,
    expectBrowser: Boolean,
  ) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val device = UiDevice.getInstance(instrumentation)
    device.wakeUp()
    val stage = if (expectSafeOnly()) "after" else "before"
    val proofDirectory = File(checkNotNull(instrumentation.targetContext.getExternalFilesDir(null)), "signin-proof").apply { mkdirs() }
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    val intent = Intent(instrumentation.targetContext, ComponentActivity::class.java).putExtra(EXTRA_URL, case.url)
    ActivityScenario.launch<ComponentActivity>(intent).use { scenario ->
      scenario.onActivity { activity ->
        val externalUrl = checkNotNull(activity.intent.getStringExtra(EXTRA_URL))
        val controller =
          ProviderAuthController(
            scope,
            GatewaySession.RequestLease("gateway", { true }, null) { method, _, _, enqueue ->
              enqueue {}
              when (method) {
                "models.authStatus" -> AUTH_STATUS
                "models.authLogin" -> wizard(externalUrl)
                else -> error("Unexpected method: $method")
              }
            },
            "writer",
            Json,
            { true },
          ) {}
        activity.setContent {
          ClawDesignTheme { ProviderSignInDialog(controller) {} }
        }
      }
      val openLabel = nativeString("Open sign-in page")
      checkNotNull(device.wait(Until.findObject(By.text("Device code")), 20_000)) { "sign-in choices did not render for ${case.name}" }
      device.findObject(By.text("Device code")).click()
      checkNotNull(device.wait(Until.findObject(By.text("ABCD")), 10_000)) { "device code did not render for ${case.name}" }
      val button = device.wait(Until.findObject(By.text(openLabel)), 3_000)
      device.takeScreenshot(File(proofDirectory, "$stage-${case.name}-dialog.png"))
      val lines = mutableListOf("stage=$stage case=${case.name} wizardUrl=${case.url} buttonVisible=${button != null}")
      File(proofDirectory, "$stage-${case.name}.txt").writeText(lines.joinToString("\n"))
      if (button != null) {
        button.click()
        val opened = waitForOpened(device)
        device.takeScreenshot(File(proofDirectory, "$stage-${case.name}-navigation.png"))
        val hierarchy = File(proofDirectory, "$stage-${case.name}-hierarchy.xml")
        device.dumpWindowHierarchy(hierarchy)
        val host = case.url.substringAfter("://").substringBefore("/")
        val hostVisible =
          hierarchy.readText().contains(host, ignoreCase = true) ||
            opened?.contains(host, ignoreCase = true) == true
        lines += "opened=${opened ?: "none"} package=${device.currentPackageName} hostVisible=$hostVisible"
        lines += device.executeShellCommand("logcat -d -t 40 ActivityTaskManager:I AndroidRuntime:E *:S")
        File(proofDirectory, "$stage-${case.name}.txt").writeText(lines.joinToString("\n"))
      }
      assertTrue("button visibility for ${case.url}", (button != null) == expectButton)
      if (expectBrowser) {
        assertTrue(
          "platform did not open ${case.url}: ${lines.joinToString(" | ")}",
          lines.any { it.startsWith("opened=") && "none" !in it && "hostVisible=true" in it },
        )
      }
      if (!expectBrowser) assertTrue("platform opened ${case.url}", lines.none { it.startsWith("opened=") && "none" !in it })
    }
  }

  private fun waitForOpened(device: UiDevice): String? {
    device.wait(Until.findObject(By.textContains("Proof Browser")), 1_500)?.click()
    device.wait(Until.findObject(By.text("Just once")), 1_000)?.click()
    device.wait(Until.findObject(By.text("Use without an account")), 1_500)?.click()
    device.wait(Until.findObject(By.text("No thanks")), 1_000)?.click()
    val opened = device.wait(Until.findObject(By.textStartsWith("OPENED")), 6_000)
    if (opened != null) return opened.text
    if (device.currentPackageName == "com.android.chrome") return "chrome"
    return null
  }

  private fun expectSafeOnly(): Boolean = InstrumentationRegistry.getArguments().getString("expectSafeOnly") != "false"

  private data class Case(
    val name: String,
    val url: String,
  )

  private companion object {
    private const val EXTRA_URL = "externalUrl"
    private const val AUTH_STATUS =
      """{"ts":1,"providers":[],"providerCapabilities":[{"provider":"fixture","apiKeySupported":false,"quickApiKeySetup":false,"loginOptions":[{"id":"plugin/device","brandId":"fixture","label":"Device code","kind":"device-code","featured":true}]}]}"""
    private val BROWSER_CASES =
      listOf(
        Case("https", "https://example.com/login"),
        Case("loopback", "http://127.0.0.1:18789/login"),
        Case("uppercase", "HTTPS://example.com/login"),
      )

    private fun wizard(externalUrl: String): String {
      val encoded = JsonPrimitive(externalUrl).toString()
      return """{"done":false,"status":"running","step":{"id":"device","type":"action","executor":"client","externalUrl":$encoded,"deviceCode":{"code":"ABCD"}}}"""
    }
  }
}
