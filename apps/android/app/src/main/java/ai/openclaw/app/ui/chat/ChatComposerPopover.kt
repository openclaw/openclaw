package ai.openclaw.app.ui.chat

import ai.openclaw.app.ui.AppDialog
import ai.openclaw.app.ui.FoldAwareSheetState
import ai.openclaw.app.ui.OverlayWindowGeometry
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.foldAwareSheet
import ai.openclaw.app.ui.rememberOverlayWindowGeometry
import ai.openclaw.app.ui.sampleOverlayWindowGeometry
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.changedToUpIgnoreConsumed
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider

/** Search remains an IME target; the existing picker opening still owns native-window admission. */
@Composable
internal fun ChatComposerPopover(
  geometry: FoldAwareSheetState,
  title: String,
  composerAnchor: LayoutCoordinates?,
  admit: () -> Boolean,
  onDismiss: () -> Unit,
  maximumWidth: Dp = 440.dp,
  horizontalAlignment: Alignment.Horizontal = Alignment.End,
  shape: Shape = RoundedCornerShape(14.dp),
  content: @Composable (admit: () -> Boolean) -> Unit,
) {
  key(geometry) {
    AppDialog(
      onDismissRequest = onDismiss,
      properties =
        DialogProperties(
          dismissOnBackPress = false,
          dismissOnClickOutside = false,
          usePlatformDefaultWidth = false,
          decorFitsSystemWindows = false,
        ),
    ) {
      val destination = LocalView.current
      val currentAnchor by rememberUpdatedState(composerAnchor)
      val currentAdmit by rememberUpdatedState(admit)
      val currentDismiss by rememberUpdatedState(onDismiss)
      var anchorBounds by remember { mutableStateOf<IntRect?>(null) }
      var placedAnchor by remember { mutableStateOf<IntRect?>(null) }
      var cardBounds by remember { mutableStateOf(Rect.Zero) }

      fun retireUnsafeAnchor() {
        geometry.revoke()
        currentDismiss()
      }

      fun liveAnchorBounds(): IntRect? =
        composerPopoverAnchorBounds(
          currentAnchor,
          sampleOverlayWindowGeometry(geometry.activity, geometry.activityView, destination),
        )

      fun admitAction(): Boolean {
        if (geometry.revoked) return false
        val current = liveAnchorBounds()
        if (current == null || current != placedAnchor) {
          retireUnsafeAnchor()
          return false
        }
        return currentAdmit()
      }

      rememberOverlayWindowGeometry(geometry.activity, geometry.activityView, destination) { mapping ->
        if (!geometry.revoked && mapping != null) {
          val next = composerPopoverAnchorBounds(currentAnchor, mapping)
          if (next == null) retireUnsafeAnchor() else anchorBounds = next
        }
      }
      SideEffect {
        (destination.parent as? DialogWindowProvider)?.window?.setDimAmount(0f)
      }
      BackHandler { if (admitAction()) currentDismiss() }

      Box(
        Modifier.fillMaxSize().pointerInput(geometry) {
          awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val initialBounds = cardBounds
            if (!initialBounds.contains(down.position)) {
              down.consume()
              var tap = !initialBounds.isEmpty
              do {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                if (event.changes.size != 1 || cardBounds != initialBounds) tap = false
                for (change in event.changes) {
                  if (change.isConsumed || initialBounds.contains(change.position) ||
                    (change.position - down.position).getDistance() > viewConfiguration.touchSlop
                  ) {
                    tap = false
                  }
                  change.consume()
                }
                if (event.changes.all { !it.pressed } && tap &&
                  event.changes.single().changedToUpIgnoreConsumed() && admitAction()
                ) {
                  currentDismiss()
                }
              } while (event.changes.any { it.pressed })
            }
          }
        },
      ) {
        Layout(
          modifier =
            Modifier
              .fillMaxSize()
              .windowInsetsPadding(WindowInsets.safeDrawing)
              .foldAwareSheet(geometry),
          content = {
            Surface(
              modifier =
                Modifier
                  .onGloballyPositioned { cardBounds = it.boundsInRoot() }
                  .drawWithContent { if (!geometry.revoked && liveAnchorBounds() == placedAnchor) drawContent() }
                  .semantics {
                    paneTitle = title
                    dismiss {
                      if (admitAction()) {
                        currentDismiss()
                        true
                      } else {
                        false
                      }
                    }
                  },
              shape = shape,
              color = ClawTheme.colors.surfaceRaised,
              contentColor = ClawTheme.colors.text,
              border = BorderStroke(1.dp, ClawTheme.colors.border),
              shadowElevation = 12.dp,
            ) {
              content(::admitAction)
            }
          },
        ) { measurables, constraints ->
          val width = constraints.maxWidth
          val height = constraints.maxHeight
          layout(width, height) {
            val anchor = anchorBounds ?: return@layout
            val origin = coordinates?.positionInWindow()?.round() ?: return@layout
            val localAnchor = anchor.translate(-origin)
            val gap = 6.dp.roundToPx()
            val margin = minOf(12.dp.roundToPx(), width / 2)
            val above = (localAnchor.top - gap).coerceIn(0, height)
            val below = (height - localAnchor.bottom - gap).coerceIn(0, height)
            val minimumHeight = minOf(160.dp.roundToPx(), height)
            val availableHeight =
              when {
                above >= minimumHeight -> above
                below >= minimumHeight -> below
                else -> height
              }
            val cardWidth = minOf(maximumWidth.roundToPx(), width - 2 * margin)
            val card =
              measurables.single().measure(
                Constraints(
                  minWidth = cardWidth,
                  maxWidth = cardWidth,
                  maxHeight = minOf(440.dp.roundToPx(), availableHeight),
                ),
              )
            val left =
              (localAnchor.left + horizontalAlignment.align(card.width, localAnchor.width, layoutDirection))
                .coerceIn(margin, width - card.width - margin)
            val top =
              when {
                above >= minimumHeight -> localAnchor.top - gap - card.height
                below >= minimumHeight -> localAnchor.bottom + gap
                else -> height - card.height
              }.coerceIn(0, height - card.height)
            placedAnchor = anchor
            card.place(left, top)
          }
        }
      }
    }
  }
}

private fun composerPopoverAnchorBounds(
  anchor: LayoutCoordinates?,
  mapping: OverlayWindowGeometry?,
): IntRect? {
  if (anchor?.isAttached != true || mapping == null || anchor.boundsInWindow().isEmpty) return null
  return IntRect(anchor.positionInWindow().round() + mapping.activityToOverlay, anchor.size)
}
