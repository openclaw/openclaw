package ai.openclaw.app.ui.chat

import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class EmbeddedGallerySelectionTest {
  @Test
  fun dismissalClosesWithoutCallbacksAndIgnoresLateConfirmation() {
    val uri = Uri.parse("content://media/selected")
    for (hasSelection in listOf(true, false)) {
      var closes = 0
      var imports = 0
      val selection = EmbeddedGallerySelection(close = { closes++ })
      if (hasSelection) selection.granted(listOf(uri))
      selection.dispose()
      assertEquals(1, closes)
      selection.granted(listOf(uri))
      selection.complete {
        imports++
        true
      }
      selection.dispose()
      assertEquals(0, imports)
      assertEquals(1, closes)
    }
  }

  @Test
  fun confirmationImportsOnlyItemsStillSelected() {
    val first = Uri.parse("content://media/first")
    val removed = Uri.parse("content://media/removed")
    var closes = 0
    var imported = emptyList<Uri>()
    val selection = EmbeddedGallerySelection(close = { closes++ })
    selection.granted(listOf(first, removed))
    selection.revoked(listOf(removed))
    selection.complete {
      imported = it
      true
    }
    assertEquals(listOf(first), imported)
    selection.dispose()
    assertEquals(1, closes)
  }
}
