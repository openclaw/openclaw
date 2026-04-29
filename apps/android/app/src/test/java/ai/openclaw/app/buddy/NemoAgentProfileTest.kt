package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NemoAgentProfileTest {
  @Test
  fun detectsNemoAgentIdCaseInsensitively() {
    assertTrue(NemoAgentProfile.isNemoAgentId("nemo"))
    assertTrue(NemoAgentProfile.isNemoAgentId(" Nemo "))
    assertFalse(NemoAgentProfile.isNemoAgentId("openclaw-tui"))
  }

  @Test
  fun buildsAndroidBuddySessionKey() {
    assertEquals(
      "agent:nemo:android-buddy-abcdef123456",
      NemoAgentProfile.androidSessionKey("abcdef1234567890"),
    )
  }

  @Test
  fun setupSessionUsesMainAgentWhenAvailable() {
    assertEquals("agent:openclaw-tui:nemo-setup", NemoAgentProfile.setupSessionKey("openclaw-tui"))
    assertEquals("nemo-setup", NemoAgentProfile.setupSessionKey(null))
    assertEquals("nemo-setup", NemoAgentProfile.setupSessionKey("nemo"))
  }

  @Test
  fun setupPromptContainsProfileWorkspaceAndSafetyRequirements() {
    val prompt = NemoAgentProfile.setupPrompt()

    assertTrue(prompt.contains("id: nemo"))
    assertTrue(prompt.contains("~/.openclaw/workspace-nemo"))
    assertTrue(prompt.contains("保持主 agent 和默认 agent 设置不变"))
    assertTrue(prompt.contains("不要输出任何 token、密钥或隐私内容"))
  }
}
