package ai.openclaw.app.wear

import ai.openclaw.android.gateway.ProxyPaths
import java.nio.file.Files
import java.nio.file.Path
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import org.w3c.dom.NodeList

private const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
private const val DATA_LAYER_APPLICATION_ID = "ai.openclaw.app"
private const val MESSAGE_RECEIVED_ACTION = "com.google.android.gms.wearable.MESSAGE_RECEIVED"
private const val WEAR_SCHEME = "wear"

class WearProxyPackagingContractTest {
  @Test
  fun phoneAndWearAppsShareTheSameDataLayerApplicationId() {
    val androidRoot = resolveAndroidProjectRoot()
    val phoneApplicationId = applicationIdFrom(readUtf8(androidRoot.resolve("app/build.gradle.kts")))
    val wearApplicationId = applicationIdFrom(readUtf8(androidRoot.resolve("wear/build.gradle.kts")))

    assertEquals(DATA_LAYER_APPLICATION_ID, phoneApplicationId)
    assertEquals(phoneApplicationId, wearApplicationId)
  }

  @Test
  fun phoneManifestReceivesWearProxyPingMessages() {
    val androidRoot = resolveAndroidProjectRoot()
    val manifest = androidRoot.resolve("app/src/main/AndroidManifest.xml")
    val root =
      DocumentBuilderFactory
        .newInstance()
        .apply { isNamespaceAware = true }
        .newDocumentBuilder()
        .parse(manifest.toFile())
        .documentElement

    val service =
      root
        .getElementsByTagName("service")
        .asElements()
        .firstOrNull { it.androidAttr("name") == ".wear.WearProxyService" }

    assertNotNull("Phone manifest must register WearProxyService", service)

    val messageFilter =
      checkNotNull(service)
        .getElementsByTagName("intent-filter")
        .asElements()
        .firstOrNull { filter ->
          filter.getElementsByTagName("action").asElements().any {
            it.androidAttr("name") == MESSAGE_RECEIVED_ACTION
          }
        }

    assertNotNull("WearProxyService must wake for Wear MessageClient ping messages", messageFilter)
    assertTrue(
      "WearProxyService message filter must match ${ProxyPaths.PING}",
      checkNotNull(messageFilter)
        .getElementsByTagName("data")
        .asElements()
        .any {
          it.androidAttr("scheme") == WEAR_SCHEME &&
            it.androidAttr("host") == "*" &&
            it.androidAttr("pathPrefix") == ProxyPaths.PREFIX &&
            ProxyPaths.PING.startsWith(it.androidAttr("pathPrefix"))
        },
    )
  }

  private fun applicationIdFrom(buildFile: String): String {
    return Regex("""(?m)^\s*applicationId\s*=\s*"([^"]+)"""")
      .find(buildFile)
      ?.groupValues
      ?.get(1)
      ?: error("applicationId not found")
  }

  private fun resolveAndroidProjectRoot(): Path {
    var current = Path.of(System.getProperty("user.dir")).toAbsolutePath()
    repeat(8) {
      if (isAndroidProjectRoot(current)) {
        return current
      }
      val nestedAndroidRoot = current.resolve("apps/android")
      if (isAndroidProjectRoot(nestedAndroidRoot)) {
        return nestedAndroidRoot
      }
      current = current.parent ?: return@repeat
    }
    error("Could not locate apps/android project root from ${System.getProperty("user.dir")}")
  }

  private fun isAndroidProjectRoot(path: Path): Boolean {
    return Files.isRegularFile(path.resolve("settings.gradle.kts")) &&
      Files.isRegularFile(path.resolve("app/build.gradle.kts")) &&
      Files.isRegularFile(path.resolve("wear/build.gradle.kts"))
  }

  private fun readUtf8(path: Path): String = String(Files.readAllBytes(path), Charsets.UTF_8)

  private fun NodeList.asElements(): List<Element> =
    (0 until length).mapNotNull { item(it) as? Element }

  private fun Element.androidAttr(name: String): String = getAttributeNS(ANDROID_NS, name)
}
