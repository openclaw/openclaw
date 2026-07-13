package ai.openclaw.app.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatMessageViewsTest {
  @Test
  fun roleLabelMapsKnownChatRoles() {
    assertEquals("You", chatRoleLabel("user"))
    assertEquals("System", chatRoleLabel("system"))
    assertEquals("Tools", chatRoleLabel("tools"))
    assertEquals("OpenClaw · Live", chatRoleLabel("assistant_live"))
    assertEquals("OpenClaw", chatRoleLabel("assistant"))
  }
}
