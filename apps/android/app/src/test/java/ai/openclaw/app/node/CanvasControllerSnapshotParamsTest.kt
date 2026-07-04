package ai.openclaw.app.node

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CanvasControllerSnapshotParamsTest {
  @Test
  fun normalizeNavigateUrlShowsDefaultCanvasForLoopbackWebUrls() {
    listOf(
        "http://127.0.0.1:18789",
        "https://localhost",
        "http://[::1]/canvas",
        "http://[::ffff:127.0.0.1]/canvas",
        "http://2130706433/canvas",
        "http://0x7f000001/canvas",
        "http://017700000001/canvas",
        "http://127.1/canvas",
        "http://0x7f.1/canvas",
        "http://127.0.0.1/a raw space",
        "http://127.0.0.1/#raw space",
        "http://127.0.0.1\\@example.com/",
        "http://%31%32%37.0.0.1:18789/",
        "http://%6c%6f%63%61%6c%68%6f%73%74/",
        "http:\\127.0.0.1:18789/",
        "http:127.0.0.1:18789/",
      )
      .forEach { url ->
        assertEquals(url, "", CanvasController.normalizeNavigateUrl(url))
        assertEquals(url, true, CanvasController.shouldBlockNavigateUrl(url))
      }
  }

  @Test
  fun normalizeNavigateUrlKeepsRemoteAndBundledFileUrls() {
    assertEquals("https://example.com/canvas", CanvasController.normalizeNavigateUrl(" https://example.com/canvas "))
    assertEquals(false, CanvasController.shouldBlockNavigateUrl("https://example.com/canvas"))
    assertEquals(
      CanvasActionTrust.scaffoldAssetUrl,
      CanvasController.normalizeNavigateUrl(CanvasActionTrust.scaffoldAssetUrl),
    )
    assertEquals(false, CanvasController.shouldBlockNavigateUrl(CanvasActionTrust.scaffoldAssetUrl))
  }

  @Test
  fun normalizeNavigateUrlShowsDefaultCanvasForBlankAndSlash() {
    assertEquals("", CanvasController.normalizeNavigateUrl(""))
    assertEquals("", CanvasController.normalizeNavigateUrl(" / "))
  }

  @Test
  fun parseSnapshotParamsDefaultsToJpeg() {
    val params = CanvasController.parseSnapshotParams(null)
    assertEquals(CanvasController.SnapshotFormat.Jpeg, params.format)
    assertNull(params.quality)
    assertNull(params.maxWidth)
  }

  @Test
  fun parseSnapshotParamsParsesPng() {
    val params = CanvasController.parseSnapshotParams("""{"format":"png","maxWidth":900}""")
    assertEquals(CanvasController.SnapshotFormat.Png, params.format)
    assertEquals(900, params.maxWidth)
  }

  @Test
  fun parseSnapshotParamsParsesJpegAliases() {
    assertEquals(
      CanvasController.SnapshotFormat.Jpeg,
      CanvasController.parseSnapshotParams("""{"format":"jpeg"}""").format,
    )
    assertEquals(
      CanvasController.SnapshotFormat.Jpeg,
      CanvasController.parseSnapshotParams("""{"format":"jpg"}""").format,
    )
  }

  @Test
  fun parseSnapshotParamsClampsQuality() {
    val low = CanvasController.parseSnapshotParams("""{"quality":0.01}""")
    assertEquals(0.1, low.quality)

    val high = CanvasController.parseSnapshotParams("""{"quality":5}""")
    assertEquals(1.0, high.quality)
  }
}
