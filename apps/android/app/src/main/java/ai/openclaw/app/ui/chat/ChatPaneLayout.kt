package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.TabletopPaneBounds
import ai.openclaw.app.ui.foldSafeRegion
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.recalculateWindowInsets
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import androidx.window.layout.DisplayFeature

@Composable
internal fun ChatPaneLayout(
  tabletopPanes: TabletopPaneBounds?,
  features: List<DisplayFeature>,
  minimumInputHeight: Dp,
  minimumHeaderHeight: Dp,
  minimumReaderHeight: Dp,
  touchTarget: Dp,
  modifier: Modifier = Modifier,
  header: @Composable (compact: Boolean, tabletop: Boolean) -> Unit,
  transcript: @Composable () -> Unit,
  status: @Composable () -> Unit,
  composer: @Composable (compact: Boolean, tabletop: Boolean) -> Unit,
  scrollToLatest: @Composable (available: Boolean) -> Unit,
) {
  SubcomposeLayout(modifier.fillMaxSize()) { constraints ->
    val width = constraints.maxWidth
    val height = constraints.maxHeight
    val padding = 10.dp.roundToPx()
    val gap = 8.dp.roundToPx()
    val inputFloor = minimumInputHeight.roundToPx()
    val headerFloor = minimumHeaderHeight.roundToPx()
    val readerFloor = minimumReaderHeight.roundToPx()
    val statusFloor = touchTarget.roundToPx()
    val widthFloor = 320.dp.roundToPx()
    layout(width, height) {
      // This host is already inside scaffold/IME padding. Translate window facts only here.
      val origin = coordinates?.positionInWindow()?.round() ?: IntOffset.Zero
      val host = IntRect(origin, IntSize(width, height))
      val upper = tabletopPanes?.upper?.intersect(host)
      val lower = tabletopPanes?.lower?.intersect(host)
      val tabletop =
        upper != null && lower != null &&
          upper.width >= widthFloor && lower.width >= widthFloor &&
          upper.height >= headerFloor + readerFloor + statusFloor + padding * 2 + gap * 2 &&
          lower.height >= inputFloor + padding * 2
      val fallback = if (tabletop) host else foldSafeRegion(host, features, layoutDirection)
      val upperBounds = (if (tabletop) checkNotNull(upper) else fallback).translate(-origin)
      val lowerBounds = (if (tabletop) checkNotNull(lower) else fallback).translate(-origin)
      val lowerHeight = lowerBounds.height - if (tabletop) padding * 2 else 0
      val compact = lowerHeight < inputFloor + statusFloor * 2 + padding * 2 + gap * 2
      val inset = if (tabletop || !compact) padding else 0
      val spacing = if (tabletop || !compact) gap else 0
      val jumpGap = 16.dp.roundToPx()
      subcompose(Unit) {
        SubcomposeLayout { _ ->
          val upperHeight = (upperBounds.height - inset * 2).coerceAtLeast(0)
          val lowerAvailable = (lowerBounds.height - inset * 2).coerceAtLeast(0)
          val headerLimit = if (tabletop) headerFloor else (upperHeight - inputFloor).coerceAtLeast(0)
          val headerPlaceable =
            subcompose("header") { Box { header(compact, tabletop) } }
              .single()
              .measure(Constraints(minWidth = upperBounds.width, maxWidth = upperBounds.width, maxHeight = headerLimit))
          val headerGap = if (headerPlaceable.height > 0) spacing else 0
          // The input gets its real remaining height before transcript or auxiliary content.
          val composerSpace =
            if (tabletop) lowerAvailable else (lowerAvailable - headerPlaceable.height - headerGap - spacing).coerceAtLeast(0)
          val composerLimit =
            if (!tabletop && composerSpace >= inputFloor + statusFloor + jumpGap) composerSpace - statusFloor - jumpGap else composerSpace
          val composerPlaceable =
            subcompose("composer") { Box(Modifier.clipToBounds()) { composer(compact, tabletop) } }
              .single()
              .measure(Constraints(minWidth = lowerBounds.width, maxWidth = lowerBounds.width, maxHeight = composerLimit))
          val statusLimit =
            if (tabletop) (upperHeight - headerPlaceable.height - headerGap - readerFloor - spacing).coerceAtLeast(0) else 0
          val statusPlaceable =
            subcompose("status") {
              Box(Modifier.clipToBounds().verticalScroll(rememberScrollState())) {
                if (tabletop) Column { status() }
              }
            }.single().measure(Constraints(minWidth = upperBounds.width, maxWidth = upperBounds.width, maxHeight = statusLimit))
          val statusGap = if (statusPlaceable.height > 0) spacing else 0
          val readerHeight =
            (
              upperHeight - headerPlaceable.height - headerGap - statusPlaceable.height - statusGap -
                if (tabletop) 0 else composerPlaceable.height + spacing
            ).coerceAtLeast(0)
          val readerPlaceable =
            subcompose("reader") { Box(Modifier.recalculateWindowInsets().clipToBounds()) { transcript() } }
              .single()
              .measure(Constraints.fixed(upperBounds.width, readerHeight))
          val jumpAvailable = readerHeight >= statusFloor + jumpGap
          val scrollToLatestPlaceable =
            subcompose("scrollToLatest") { Box { scrollToLatest(jumpAvailable) } }.single().measure(Constraints())
          layout(width, height) {
            val composerTop = lowerBounds.bottom - inset - composerPlaceable.height
            headerPlaceable.place(upperBounds.left, upperBounds.top + inset)
            readerPlaceable.place(upperBounds.left, upperBounds.top + inset + headerPlaceable.height + headerGap)
            statusPlaceable.place(upperBounds.left, upperBounds.bottom - inset - statusPlaceable.height)
            composerPlaceable.place(lowerBounds.left, composerTop)
            val readerTop = upperBounds.top + inset + headerPlaceable.height + headerGap
            val aboveComposerTop =
              if (tabletop) {
                readerTop + readerHeight - scrollToLatestPlaceable.height - 16.dp.roundToPx()
              } else {
                composerTop - scrollToLatestPlaceable.height - 16.dp.roundToPx()
              }
            val overlayBounds = if (tabletop) upperBounds else lowerBounds
            scrollToLatestPlaceable.place(
              if (jumpAvailable) overlayBounds.left + (overlayBounds.width - scrollToLatestPlaceable.width) / 2 else -scrollToLatestPlaceable.width,
              if (jumpAvailable) aboveComposerTop else -scrollToLatestPlaceable.height,
            )
          }
        }
      }.single().measure(Constraints.fixed(width, height)).place(0, 0)
    }
  }
}
