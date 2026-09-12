package ai.openclaw.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.window.layout.DisplayFeature
import androidx.window.layout.FoldingFeature

internal data class SidebarPaneBounds(
  val start: IntRect,
  val end: IntRect,
)

/** Physical window rectangles. Partial or additional separators retain the root safety fallback. */
internal fun sidebarPaneBounds(
  host: IntRect,
  features: List<DisplayFeature>,
  direction: LayoutDirection,
  density: Density,
): SidebarPaneBounds? {
  with(density) {
    if (host.height < 320.dp.roundToPx()) return null
    // Width alone may split only the whole safe host, never a reduced fold fallback.
    if (host.width >= 840.dp.roundToPx() && foldSafeRegion(host, features, direction) == host) {
      val sidebarWidth = 360.dp.roundToPx()
      return if (direction == LayoutDirection.Ltr) {
        SidebarPaneBounds(host.copy(right = host.left + sidebarWidth), host.copy(left = host.left + sidebarWidth))
      } else {
        SidebarPaneBounds(host.copy(left = host.right - sidebarWidth), host.copy(right = host.right - sidebarWidth))
      }
    }
  }
  val separator =
    features.filterIsInstance<FoldingFeature>().singleOrNull {
      (it.isSeparating || it.occlusionType == FoldingFeature.OcclusionType.FULL) &&
        it.orientation == FoldingFeature.Orientation.VERTICAL &&
        it.bounds.left > host.left && it.bounds.right < host.right &&
        it.bounds.top <= host.top && it.bounds.bottom >= host.bottom
    } ?: return null
  val left = host.copy(right = separator.bounds.left)
  val right = host.copy(left = separator.bounds.right)
  val panes = if (direction == LayoutDirection.Ltr) SidebarPaneBounds(left, right) else SidebarPaneBounds(right, left)
  with(density) {
    // Reserve a usable navigation header and a phone-width destination, not a fixed drawer width.
    if (panes.start.width < 280.dp.roundToPx() || panes.end.width < 320.dp.roundToPx()) {
      return null
    }
  }
  if (foldSafeRegion(left, features, direction) != left || foldSafeRegion(right, features, direction) != right) return null
  return panes
}

@Composable
internal fun SidebarNavigationShell(
  drawerState: DrawerState,
  sidebarPanes: SidebarPaneBounds? = null,
  sidebarBand: IntRect? = null,
  gesturesEnabled: Boolean = true,
  drawerContent: @Composable () -> Unit,
  content: @Composable () -> Unit,
) {
  val currentSidebar by rememberUpdatedState(drawerContent)
  val sidebar = remember { movableContentOf { currentSidebar() } }

  ModalNavigationDrawer(
    drawerState = drawerState,
    gesturesEnabled = sidebarPanes == null && gesturesEnabled,
    drawerContent = {
      // Discard predictive-Back mechanics, never the destination's layout ancestry.
      key(drawerState) {
        ModalDrawerSheet(
          drawerState = drawerState,
          modifier =
            Modifier
              .widthIn(max = 360.dp)
              .fillMaxWidth()
              .layout { measurable, constraints ->
                // Keep Material's real width anchors; only the stationary vertical band changes.
                val height = sidebarBand?.height ?: constraints.maxHeight
                val sheet = measurable.measure(Constraints.fixed(constraints.maxWidth, height))
                layout(sheet.width, constraints.maxHeight) {
                  sheet.place(0, sidebarBand?.top ?: 0)
                }
              }.recalculateWindowInsets()
              .clipToBounds()
              .testTag("sidebar-drawer"),
        ) {
          // The closed empty sheet retains real measured anchors in permanent mode.
          if (sidebarPanes == null) sidebar()
        }
      }
    },
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      Layout(
        content = {
          // Keep the focused destination attached to the same parents across mode changes.
          Box(Modifier.recalculateWindowInsets().clipToBounds()) { content() }
          if (sidebarPanes != null) {
            Box(Modifier.recalculateWindowInsets().clipToBounds().testTag("sidebar-permanent")) { sidebar() }
          }
        },
        modifier = Modifier.fillMaxSize(),
      ) { measurables, constraints ->
        val destinationBounds = sidebarPanes?.end ?: IntRect(0, 0, constraints.maxWidth, constraints.maxHeight)
        val destinationPlaceable =
          measurables[0].measure(Constraints.fixed(destinationBounds.width, destinationBounds.height))
        val sidebarPlaceable =
          sidebarPanes?.let { measurables[1].measure(Constraints.fixed(it.start.width, it.start.height)) }
        layout(constraints.maxWidth, constraints.maxHeight) {
          destinationPlaceable.place(destinationBounds.left, destinationBounds.top)
          sidebarPanes?.let { sidebarPlaceable?.place(it.start.left, it.start.top) }
        }
      }
    }
  }
}
