package ai.openclaw.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionKeyTest {
  @Test
  fun shouldReplaceMainSessionKeyRejectsBlankCandidate() {
    assertFalse(shouldReplaceMainSessionKey("main", null))
    assertFalse(shouldReplaceMainSessionKey("main", ""))
    assertFalse(shouldReplaceMainSessionKey("main", "   "))
  }

  @Test
  fun shouldReplaceMainSessionKeyRejectsEquivalentKey() {
    assertFalse(shouldReplaceMainSessionKey("agent:main:main", "agent:main:main"))
    assertFalse(shouldReplaceMainSessionKey("agent:main:main", "  agent:main:main  "))
  }

  @Test
  fun shouldReplaceMainSessionKeyAcceptsCanonicalRotation() {
    assertTrue(shouldReplaceMainSessionKey("agent:alpha:main", "agent:beta:main"))
  }
}
