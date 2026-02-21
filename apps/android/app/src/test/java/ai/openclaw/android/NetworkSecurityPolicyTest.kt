package ai.openclaw.android

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NetworkSecurityPolicyTest {
  @Test
  fun releaseManifestDisablesGlobalCleartextTraffic() {
    val manifest = readAppFile("src/main/AndroidManifest.xml")
    assertTrue(manifest.contains("android:networkSecurityConfig=\"@xml/network_security_config\""))
    assertTrue(manifest.contains("android:usesCleartextTraffic=\"false\""))
    assertFalse(manifest.contains("android:usesCleartextTraffic=\"true\""))
  }

  @Test
  fun mainNetworkSecurityConfigDeniesCleartextByDefault() {
    val config = readAppFile("src/main/res/xml/network_security_config.xml")
    assertTrue(config.contains("<network-security-config"))
    assertTrue(config.contains("<base-config cleartextTrafficPermitted=\"false\""))
    assertFalse(config.contains("cleartextTrafficPermitted=\"true\""))
  }

  @Test
  fun debugNetworkSecurityConfigAllowsDevelopmentCleartextOverrides() {
    val debugConfig = readAppFile("src/debug/res/xml/network_security_config.xml")
    assertTrue(debugConfig.contains("<base-config cleartextTrafficPermitted=\"true\""))
  }

  private fun readAppFile(relativePath: String): String {
    val candidates = listOf(
      Paths.get(relativePath),
      Paths.get("app", relativePath),
      Paths.get("apps/android/app", relativePath),
    )

    val file =
      candidates
        .map(Path::normalize)
        .firstOrNull(Files::exists)
        ?: error("Unable to locate app file: $relativePath")

    return Files.readString(file)
  }
}
