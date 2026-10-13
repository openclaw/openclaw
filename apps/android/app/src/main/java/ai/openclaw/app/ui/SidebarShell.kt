package ai.openclaw.app.ui

import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.recalculateWindowInsets
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.DrawerState
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature
import kotlin.math.roundToInt

internal data class BookPaneBounds(
  val start: IntRect,
  val end: IntRect,
)

/** Physical window rectangles. Partial or additional separators retain the root safety fallback. */
internal fun bookPaneBounds(
  host: IntRect,
  features: List<DisplayFeature>,
  direction: LayoutDirection,
  density: Density,
): BookPaneBounds? {
  val separator =
    features.filterIsInstance<FoldingFeature>().singleOrNull {
      (it.isSeparating || it.occlusionType == FoldingFeature.OcclusionType.FULL) &&
        it.orientation == FoldingFeature.Orientation.VERTICAL &&
        it.bounds.left > host.left && it.bounds.right < host.right &&
        it.bounds.top <= host.top && it.bounds.bottom >= host.bottom
    } ?: return null
  val left = host.copy(right = separator.bounds.left)
  val right = host.copy(left = separator.bounds.right)
  val panes = if (direction == LayoutDirection.Ltr) BookPaneBounds(left, right) else BookPaneBounds(right, left)
  with(density) {
    // Reserve a usable navigation header and a phone-width destination, not a fixed drawer width.
    if (panes.start.width < 280.dp.roundToPx() || panes.end.width < 320.dp.roundToPx() ||
      host.height < 320.dp.roundToPx()
    ) {
      return null
    }
  }
  if (foldSafeRegion(left, features, direction) != left || foldSafeRegion(right, features, direction) != right) return null
  return panes
}

@Composable
internal fun SidebarNavigationShell(
  drawerState: DrawerState,
  bookPanes: BookPaneBounds? = null,
  sidebarBand: IntRect? = null,
  gesturesEnabled: Boolean = true,
  drawerContent: @Composable () -> Unit,
  content: @Composable () -> Unit,
) {
  val currentSidebar by rememberUpdatedState(drawerContent)
  val sidebar = remember { movableContentOf { currentSidebar() } }

  BoxWithConstraints(Modifier.fillMaxSize()) {
    val density = LocalDensity.current
    val bandInsets =
      with(density) {
        PaddingValues(
          top = (sidebarBand?.top ?: 0).toDp(),
          bottom = (sidebarBand?.let { constraints.maxHeight - it.bottom } ?: 0).toDp(),
        )
      }
    ModalNavigationDrawer(
      drawerState = drawerState,
      gesturesEnabled = bookPanes == null && gesturesEnabled,
      drawerContent = {
        // Discard predictive-Back mechanics, never the destination's layout ancestry.
        key(drawerState) {
          ModalDrawerSheet(
            drawerState = drawerState,
            drawerContainerColor = ClawTheme.colors.canvas,
            modifier =
              Modifier
                .widthIn(max = 360.dp)
                .fillMaxWidth()
                // Material's spring can pass its open anchor. Keep content at that anchor;
                // its surface stretch alone does not pin the inverse-scaled child content.
                .offset {
                  val overshoot =
                    drawerState.currentOffset
                      .takeUnless { it.isNaN() }
                      ?.roundToInt()
                      ?.coerceAtLeast(0) ?: 0
                  IntOffset(-overshoot, 0)
                }.layout { measurable, constraints ->
                  // Keep Material's real width anchors; only the stationary vertical band changes.
                  val height = sidebarBand?.height ?: constraints.maxHeight
                  val sheet = measurable.measure(Constraints.fixed(constraints.maxWidth, height))
                  layout(sheet.width, constraints.maxHeight) {
                    sheet.place(0, sidebarBand?.top ?: 0)
                  }
                }
                // Consume only the stationary band's vertical displacement. Recalculating
                // insets on the sliding sheet turns its offset into changing content padding.
                .consumeWindowInsets(bandInsets)
                .testTag("sidebar-drawer"),
          ) {
            // The closed empty sheet retains real measured anchors in permanent mode.
            if (bookPanes == null) sidebar()
          }
        }
      },
    ) {
      Box(modifier = Modifier.fillMaxSize()) {
        Layout(
          content = {
            // Keep the focused destination attached to the same parents across mode changes.
            Box(Modifier.recalculateWindowInsets().clipToBounds()) { content() }
            if (bookPanes != null) {
              Box(Modifier.recalculateWindowInsets().clipToBounds().testTag("sidebar-permanent")) { sidebar() }
            }
          },
          modifier = Modifier.fillMaxSize(),
        ) { measurables, constraints ->
          val destinationBounds = bookPanes?.end ?: IntRect(0, 0, constraints.maxWidth, constraints.maxHeight)
          val destinationPlaceable =
            measurables[0].measure(Constraints.fixed(destinationBounds.width, destinationBounds.height))
          val sidebarPlaceable =
            bookPanes?.let { measurables[1].measure(Constraints.fixed(it.start.width, it.start.height)) }
          layout(constraints.maxWidth, constraints.maxHeight) {
            destinationPlaceable.place(destinationBounds.left, destinationBounds.top)
            bookPanes?.let { sidebarPlaceable?.place(it.start.left, it.start.top) }
          }
        }
      }
    }
  }
}
