package ai.openclaw.android

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackupRulesTest {
  @Test
  fun backupRules_excludeIdentityDirectory() {
    val xml = loadXml("backup_rules.xml")
    assertTrue(xml.contains("""<exclude domain="file" path="openclaw/identity" />"""))
  }

  @Test
  fun dataExtractionRules_excludeIdentityDirectoryForCloudAndTransfer() {
    val xml = loadXml("data_extraction_rules.xml")
    val marker = """<exclude domain="file" path="openclaw/identity" />"""
    val count = Regex(Regex.escape(marker)).findAll(xml).count()
    assertEquals(2, count)
  }

  private fun loadXml(fileName: String): String {
    val candidates =
      listOf(
        File("src/main/res/xml/$fileName"),
        File("app/src/main/res/xml/$fileName"),
        File("apps/android/app/src/main/res/xml/$fileName"),
      )
    val match = candidates.firstOrNull { it.exists() }
      ?: throw IllegalStateException("Missing XML fixture: $fileName")
    return match.readText(Charsets.UTF_8)
  }
}
