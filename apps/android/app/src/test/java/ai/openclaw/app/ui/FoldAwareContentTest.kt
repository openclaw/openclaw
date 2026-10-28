package ai.openclaw.app.ui

import android.graphics.Rect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.absoluteOffset
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.AbsoluteAlignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.DpRect
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(minSdk = 34, maxSdk = 34, qualifiers = "w1000dp-h1000dp-mdpi")
class FoldAwareContentTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  @Config(qualifiers = "w1800dp-h1000dp-hdpi")
  fun sidebarAllocationUsesRealConstraintsDensityAndCompletePhysicalFoldSafety() {
    var width by mutableStateOf(1000.dp)
    var height by mutableStateOf(800.dp)
    var origin by mutableStateOf(IntOffset(150, 75))
    var direction by mutableStateOf(LayoutDirection.Ltr)
    var features by mutableStateOf(emptyList<DisplayFeature>())
    var starts = 0
    var disposals = 0
    composeRule.setContent {
      CompositionLocalProvider(LocalLayoutDirection provides direction) {
        Box(Modifier.fillMaxSize(), contentAlignment = AbsoluteAlignment.TopLeft) {
          FoldAwareContent(
            features,
            Modifier.absoluteOffset { origin }.size(width, height),
            sidebarPanesEnabled = true,
          ) { bounds ->
            SidebarNavigationShell(
              drawerState = rememberDrawerState(DrawerValue.Closed),
              sidebarPanes = bounds.sidebar,
              drawerContent = { Box(Modifier.fillMaxSize()) },
            ) {
              var draft by remember { mutableStateOf("") }
              DisposableEffect(Unit) {
                starts++
                onDispose { disposals++ }
              }
              Box(Modifier.fillMaxSize().testTag("destination")) {
                BasicTextField(draft, { draft = it }, Modifier.testTag("editor"))
              }
            }
          }
        }
      }
    }
    assertEquals("Exercise non-mdpi pixel rounding", 1.5f, composeRule.density.density, 0f)
    val editor = composeRule.onNodeWithTag("editor")
    editor.performTextReplacement("retained allocation draft")
    val editorId = editor.fetchSemanticsNode().id

    fun physicalBounds(tag: String): IntRect {
      val bounds = composeRule.onNodeWithTag(tag).getUnclippedBoundsInRoot()
      return with(composeRule.density) {
        IntRect(bounds.left.roundToPx(), bounds.top.roundToPx(), bounds.right.roundToPx(), bounds.bottom.roundToPx())
      }
    }

    fun verify(
      sidebar: IntRect?,
      destination: IntRect,
    ) {
      assertEquals("Actual destination for $width x $height, $direction, $features", destination, physicalBounds("destination"))
      if (sidebar == null) {
        composeRule.onNodeWithTag("sidebar-permanent").assertDoesNotExist()
      } else {
        composeRule.onNodeWithTag("sidebar-permanent").assertIsDisplayed()
        assertEquals(sidebar, physicalBounds("sidebar-permanent"))
      }
      editor.assertTextEquals("retained allocation draft")
      assertEquals(editorId, editor.fetchSemanticsNode().id)
      assertEquals(1, starts)
      assertEquals(0, disposals)
    }
    val sizes =
      listOf(
        Triple(360.dp, 800.dp, false),
        Triple(600.dp, 800.dp, false),
        Triple(839.dp, 800.dp, false),
        Triple((1259f / 1.5f).dp, 800.dp, false),
        Triple(840.dp, 800.dp, true),
        Triple(1000.dp, 800.dp, true),
        Triple(1600.dp, 800.dp, true),
        Triple(1000.dp, 319.dp, false),
        Triple(1000.dp, 320.dp, true),
      )
    for ((nextWidth, nextHeight, permanent) in sizes) {
      composeRule.runOnIdle {
        width = nextWidth
        height = nextHeight
      }
      val host = with(composeRule.density) { IntRect(origin, IntSize(nextWidth.roundToPx(), nextHeight.roundToPx())) }
      verify(
        if (permanent) host.copy(right = host.left + 540) else null,
        if (permanent) host.copy(left = host.left + 540) else host,
      )
    }
    composeRule.runOnIdle {
      width = 1000.dp
      height = 800.dp
    }
    val host = IntRect(150, 75, 1650, 1275)
    val flat = host.copy(right = 690) to host.copy(left = 690)
    val book = host.copy(right = 750) to host.copy(left = 780)
    val cases =
      listOf(
        emptyList<DisplayFeature>() to flat,
        listOf(testFold(Rect(750, 0, 780, 1500), separating = false, state = FoldingFeature.State.FLAT)) to flat,
        listOf(testFold(Rect(-40, -40, -20, -20))) to flat,
        listOf(testFold(Rect(1650, 0, 1650, 1500))) to flat,
        listOf(testFold(Rect(750, 0, 780, 1500))) to book,
        listOf(testFold(Rect(750, 0, 780, 1500), state = FoldingFeature.State.FLAT)) to book,
        listOf(testFold(Rect(750, 0, 780, 1500), separating = false, occlusion = FoldingFeature.OcclusionType.FULL)) to book,
        listOf(testFold(Rect(600, 0, 600, 1500))) to (host.copy(right = 600) to host.copy(left = 600)),
        listOf(testFold(Rect(750, 75, 780, 300))) to (null to host.copy(top = 300)),
        listOf(testFold(Rect(750, 0, 780, 1500)), testFold(Rect(1200, 0, 1230, 1500))) to (null to host.copy(right = 750)),
        listOf(testFold(Rect(150, 675, 1650, 705))) to (null to host.copy(bottom = 675)),
        listOf(testFold(Rect(360, 0, 390, 1500))) to (null to host.copy(left = 390)),
      )
    for ((folds, expected) in cases) {
      composeRule.runOnIdle { features = folds }
      verify(expected.first, expected.second)
    }
    // A valid book split retains the 280dp/320dp minima even below the width breakpoint.
    composeRule.runOnIdle {
      width = 600.dp
      height = 320.dp
      features = listOf(testFold(Rect(570, 0, 570, 1500)))
    }
    verify(IntRect(150, 75, 570, 555), IntRect(570, 75, 1050, 555))
    composeRule.runOnIdle { height = 319.dp }
    verify(null, IntRect(570, 75, 1050, 554))
    composeRule.runOnIdle {
      width = 1000.dp
      height = 800.dp
      features = emptyList()
      direction = LayoutDirection.Rtl
    }
    verify(host.copy(left = 1110), host.copy(right = 1110))
    composeRule.runOnIdle { origin = IntOffset(173, 97) }
    verify(IntRect(1133, 97, 1673, 1297), IntRect(173, 97, 1133, 1297))
    composeRule.runOnIdle { features = listOf(testFold(Rect(750, 0, 780, 1500))) }
    verify(IntRect(780, 97, 1673, 1297), IntRect(173, 97, 750, 1297))
    composeRule.runOnIdle { origin = IntOffset(150, 75) }
    verify(book.second, book.first)
  }

  @Test
  fun movingHostAndRtlPlaceOneLiveEditorInPhysicalWindowCoordinates() {
    var folds by mutableStateOf(emptyList<DisplayFeature>())
    var direction by mutableStateOf(LayoutDirection.Ltr)
    var x by mutableStateOf(100.dp)
    var starts = 0
    var disposals = 0
    composeRule.setContent {
      CompositionLocalProvider(LocalLayoutDirection provides direction) {
        Box(Modifier.fillMaxSize(), contentAlignment = AbsoluteAlignment.TopLeft) {
          FoldAwareContent(folds, Modifier.absoluteOffset { IntOffset(x.roundToPx(), 50.dp.roundToPx()) }.size(800.dp, 800.dp)) {
            var draft by remember { mutableStateOf("") }
            DisposableEffect(Unit) {
              starts++
              onDispose { disposals++ }
            }
            Box(Modifier.fillMaxSize().testTag("pane")) {
              BasicTextField(draft, { draft = it }, Modifier.testTag("editor"))
            }
          }
        }
      }
    }
    val pane = composeRule.onNodeWithTag("pane")
    val original = pane.getUnclippedBoundsInRoot()
    composeRule.onNodeWithTag("editor").performTextReplacement("retained draft")
    // Features use window coordinates; this host starts away from the window origin.
    val foldX = original.left.value.toInt() + 390
    val feature = testFold(Rect(foldX, 0, foldX + 20, 2000))
    composeRule.runOnIdle { folds = listOf(feature) }
    assertEquals(DpRect(original.left, original.top, original.left + 390.dp, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.runOnIdle { direction = LayoutDirection.Rtl }
    assertEquals(DpRect(original.left + 410.dp, original.top, original.right, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.runOnIdle { x = 120.dp }
    assertEquals(DpRect(original.left + 410.dp, original.top, original.right + 20.dp, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.runOnIdle { folds = emptyList() }
    assertEquals(DpRect(original.left + 20.dp, original.top, original.right + 20.dp, original.bottom), pane.getUnclippedBoundsInRoot())
    composeRule.onNodeWithTag("editor").assertTextEquals("retained draft")
    composeRule.runOnIdle {
      assertEquals("Fold changes must not recreate the editor composition", 1, starts)
      assertEquals(0, disposals)
    }
  }

  @Test
  fun tabletopExposesBothPlanesOnlyWhenEverySeparatorAllowsThem() {
    var folds by mutableStateOf(emptyList<DisplayFeature>())
    composeRule.setContent {
      Box(Modifier.fillMaxSize(), contentAlignment = AbsoluteAlignment.TopLeft) {
        FoldAwareContent(
          folds,
          Modifier.absoluteOffset { IntOffset(100, 50) }.size(800.dp, 800.dp),
          tabletopEnabled = true,
        ) {
          var draft by remember { mutableStateOf("") }
          Box(Modifier.fillMaxSize().testTag("pane")) {
            BasicTextField(draft, { draft = it }, Modifier.testTag("editor"))
          }
        }
      }
    }
    val pane = composeRule.onNodeWithTag("pane")
    val editor = composeRule.onNodeWithTag("editor")
    editor.performTextReplacement("all-feature draft")
    val editorId = editor.fetchSemanticsNode().id
    val full = DpRect(100.dp, 50.dp, 900.dp, 850.dp)
    val horizontal = testFold(Rect(100, 350, 900, 370))
    val cases =
      listOf(
        listOf(horizontal) to full,
        listOf(testFold(Rect(100, 350, 900, 370), state = FoldingFeature.State.FLAT)) to full,
        listOf(testFold(Rect(100, 350, 900, 350))) to full,
        listOf(testFold(Rect(100, 350, 900, 370), separating = false, occlusion = FoldingFeature.OcclusionType.FULL)) to full,
        listOf(horizontal, testFold(Rect(-40, -40, -20, -20))) to full,
        listOf(testFold(Rect(100, 850, 900, 870))) to full,
        listOf(testFold(Rect(100, 350, 900, 370), separating = false, state = FoldingFeature.State.FLAT)) to full,
        listOf(testFold(Rect(200, 350, 700, 370))) to DpRect(100.dp, 370.dp, 900.dp, 850.dp),
        listOf(testFold(Rect(100, 300, 900, 320)), testFold(Rect(100, 600, 900, 620))) to DpRect(100.dp, 320.dp, 900.dp, 600.dp),
        listOf(horizontal, testFold(Rect(500, 50, 520, 850))) to DpRect(100.dp, 370.dp, 500.dp, 850.dp),
        listOf(horizontal, testFold(Rect(100, 360, 900, 380))) to DpRect(100.dp, 380.dp, 900.dp, 850.dp),
        emptyList<DisplayFeature>() to full,
      )
    for ((features, expected) in cases) {
      composeRule.runOnIdle { folds = features }
      assertEquals("Actual host allocation for $features", expected, pane.getUnclippedBoundsInRoot())
      editor.assertTextEquals("all-feature draft")
      assertEquals(editorId, editor.fetchSemanticsNode().id)
    }
  }
}
