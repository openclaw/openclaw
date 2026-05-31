package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugHandlerTest {
  @Test
  fun collectProcessOutputDrainsLargeStdoutBeforeWaiting() {
    val process =
      ProcessBuilder("sh", "-c", "yes openclaw-log-line | head -n 20000")
        .redirectErrorStream(true)
        .start()

    val (finished, output) = collectProcessOutput(process, timeoutMs = 4_000, maxChars = 128_000)

    assertTrue("expected process to finish without timing out", finished)
    assertEquals(128_000, output.length)
    assertTrue(output.startsWith("openclaw-log-line"))
  }
}
