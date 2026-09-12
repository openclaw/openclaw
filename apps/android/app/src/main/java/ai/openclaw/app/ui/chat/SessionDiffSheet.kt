package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.SessionDiffFile
import ai.openclaw.app.chat.SessionDiffLine
import ai.openclaw.app.chat.SessionDiffLineKind
import ai.openclaw.app.chat.SessionDiffSnapshot
import ai.openclaw.app.chat.parseSessionDiffPatch
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.foldAwareSheet
import android.graphics.Paint
import android.graphics.Typeface
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.rememberScrollableState
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.ScrollAxisRange
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.horizontalScrollAxisRange
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlin.math.abs

private data class SessionDiffRowKey(
  val path: String,
  val index: Int,
) : java.io.Serializable

internal data class SessionDiffFileView(
  val file: SessionDiffFile,
  val lines: List<SessionDiffLine>,
)

internal fun prepareSessionDiffFiles(snapshot: SessionDiffSnapshot): List<SessionDiffFileView> =
  snapshot.files.map { file ->
    SessionDiffFileView(
      file,
      file.patch
        ?.let(::parseSessionDiffPatch)
        .orEmpty(),
    )
  }

@Composable
internal fun SessionDiffSheet(
  viewModel: MainViewModel,
  opening: ChatModelPickerSession,
  admit: () -> Boolean,
  onDismiss: () -> Unit,
  onReference: (String) -> Unit,
) {
  var refresh by remember { mutableIntStateOf(0) }
  var snapshot by remember { mutableStateOf<SessionDiffSnapshot?>(null) }
  var files by remember { mutableStateOf<List<SessionDiffFileView>>(emptyList()) }
  var loading by remember { mutableStateOf(true) }
  var error by remember { mutableStateOf<String?>(null) }

  fun isCurrent() = !opening.geometry.revoked && viewModel.isCurrentChatComposerOwner(opening.composerOwner)

  LaunchedEffect(opening, refresh) {
    val gatewayRevision = viewModel.gatewayCatalogRevision.value
    loading = true
    error = null
    snapshot = null
    files = emptyList()
    try {
      val gateway = opening.composerOwner.gatewayStableId ?: error(nativeString("Connect to a Gateway to review changes."))
      if (!isCurrent()) return@LaunchedEffect
      val result =
        viewModel.loadSessionDiff(
          sessionKey = opening.sessionKey,
          agentId = opening.composerOwner.agentId,
          expectedGatewayStableId = gateway,
        )
      val prepared = withContext(Dispatchers.Default) { prepareSessionDiffFiles(result) }
      if (isCurrent() && viewModel.gatewayCatalogRevision.value == gatewayRevision) {
        snapshot = result
        files = prepared
      } else if (isCurrent()) {
        error = nativeString("The connection changed. Refresh to load a new snapshot.")
      }
    } catch (failure: Exception) {
      currentCoroutineContext().ensureActive()
      if (isCurrent()) {
        error =
          if (failure is CancellationException) {
            nativeString("The connection changed. Refresh to load a new snapshot.")
          } else {
            failure.message ?: nativeString("Couldn’t load changes. Try refreshing.")
          }
      }
    } finally {
      if (isCurrent()) loading = false
    }
  }

  Dialog(
    onDismissRequest = onDismiss,
    properties =
      DialogProperties(
        usePlatformDefaultWidth = false,
        dismissOnClickOutside = false,
        decorFitsSystemWindows = false,
      ),
  ) {
    SessionDiffContent(
      snapshot = snapshot,
      files = files,
      loading = loading,
      error = error,
      onRefresh = { if (admit()) refresh++ },
      onClose = onDismiss,
      onReference = { reference -> if (isCurrent() && admit()) onReference(reference) },
      modifier =
        Modifier
          .fillMaxSize()
          .foldAwareSheet(opening.geometry)
          .background(ClawTheme.colors.surface)
          .windowInsetsPadding(WindowInsets.safeDrawing),
    )
  }
}

/** Native, viewport-only code rows keep long patches out of Android text layout. */
@Composable
internal fun SessionDiffContent(
  snapshot: SessionDiffSnapshot?,
  files: List<SessionDiffFileView>,
  loading: Boolean,
  error: String?,
  onRefresh: () -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
  onReference: (String) -> Unit,
) {
  var collapsed by remember { mutableStateOf(emptySet<String>()) }
  var showLineNumbers by remember { mutableStateOf(false) }
  Column(modifier.background(ClawTheme.colors.surface)) {
    Row(
      Modifier.fillMaxWidth().padding(start = ClawTheme.spacing.sm),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(nativeString("Review changes"), style = ClawTheme.type.section, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
      ClawPlainIconButton(Icons.Default.Refresh, nativeString("Refresh changes"), onRefresh, enabled = !loading)
      ClawPlainIconButton(Icons.Default.Close, nativeString("Close review"), onClose)
    }
    Row(
      Modifier.fillMaxWidth().padding(horizontal = ClawTheme.spacing.sm),
      horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        nativeString("Uncommitted"),
        color = ClawTheme.colors.text,
        style = ClawTheme.type.label,
        modifier = Modifier.padding(horizontal = ClawTheme.spacing.sm, vertical = ClawTheme.spacing.sm),
      )
      Text(
        snapshot?.branch.orEmpty(),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      snapshot?.let {
        Text(verbatimText("+${it.additions}").resolveNativeTextResource(), style = ClawTheme.type.mono, color = ClawTheme.colors.success)
        Text(verbatimText("−${it.deletions}").resolveNativeTextResource(), style = ClawTheme.type.mono, color = ClawTheme.colors.danger)
      }
    }
    HorizontalDivider(color = ClawTheme.colors.border)
    when {
      loading -> {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
          CircularProgressIndicator(color = ClawTheme.colors.textMuted, modifier = Modifier.size(28.dp))
        }
      }

      error != null -> {
        Column(Modifier.padding(ClawTheme.spacing.sm)) {
          Text(error, style = ClawTheme.type.body, color = ClawTheme.colors.danger)
          TextButton(onClick = onRefresh) { Text(nativeString("Try again")) }
        }
      }

      snapshot != null -> {
        SessionDiffFiles(
          snapshot,
          files,
          collapsed,
          { path -> collapsed = if (path in collapsed) collapsed - path else collapsed + path },
          showLineNumbers,
          { showLineNumbers = it },
          Modifier.weight(1f),
          { selection -> onReference(selection.chatReference()) },
        )
      }
    }
  }
}

@Composable
private fun SessionDiffFiles(
  snapshot: SessionDiffSnapshot,
  files: List<SessionDiffFileView>,
  collapsed: Set<String>,
  toggle: (String) -> Unit,
  showLineNumbers: Boolean,
  setLineNumbers: (Boolean) -> Unit,
  modifier: Modifier,
  onReference: (SessionDiffSelection) -> Unit,
) {
  val context = LocalContext.current
  val density = LocalDensity.current
  val monoStyle = ClawTheme.type.mono
  val codeColor = ClawTheme.colors.codeText
  val fontSize = with(density) { monoStyle.fontSize.toPx() }
  val codePaint =
    remember(fontSize, codeColor) {
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE
        textSize = fontSize
        color = codeColor.toArgb()
      }
    }
  val gutterDigits =
    remember(files) {
      maxOf(
        5,
        files.maxOfOrNull { view ->
          view.lines.maxOfOrNull { line ->
            maxOf(line.oldLine?.toString()?.length ?: 0, line.newLine?.toString()?.length ?: 0)
          } ?: 0
        } ?: 0,
      )
    }
  val numberWidth =
    remember(codePaint, gutterDigits) {
      codePaint.measureText("${"0".repeat(gutterDigits)} ${"0".repeat(gutterDigits)} ")
    }
  val revealedNumberWidth by animateFloatAsState(
    targetValue = if (showLineNumbers) numberWidth else 0f,
    animationSpec = tween(durationMillis = 200),
  )
  val gutterWidth = revealedNumberWidth + codePaint.measureText("+ ")
  val contentWidth by produceState(0f, files, codePaint) {
    // Use the same native shaping for scroll bounds and drawing: Unicode glyphs
    // need not occupy one ASCII cell, even with a monospace primary typeface.
    value =
      withContext(Dispatchers.Default) {
        val paint = Paint(codePaint)
        files.maxOfOrNull { file -> file.lines.maxOfOrNull { paint.measureText(it.text.replace("\t", "    ")) } ?: 0f } ?: 0f
      }
  }
  var viewportWidth by remember { mutableIntStateOf(0) }
  var horizontalOffset by remember(files) { mutableFloatStateOf(0f) }
  val currentShowLineNumbers by androidx.compose.runtime.rememberUpdatedState(showLineNumbers)
  val maxOffset = (contentWidth - (viewportWidth - gutterWidth).coerceAtLeast(0f)).coerceAtLeast(0f)
  val horizontalScroll =
    rememberScrollableState { delta ->
      val previous = horizontalOffset
      horizontalOffset = (previous - delta).coerceIn(0f, maxOffset)
      previous - horizontalOffset
    }
  LaunchedEffect(maxOffset) { horizontalOffset = horizontalOffset.coerceAtMost(maxOffset) }
  val listState = rememberLazyListState()
  var selection by remember(files, collapsed) { mutableStateOf<SessionDiffSelection?>(null) }
  var selecting by remember(files, collapsed) { mutableStateOf(false) }
  var activeHandle by remember(files, collapsed) { mutableStateOf<Pair<Boolean, Boolean>?>(null) }
  var handleDragPosition by remember { mutableStateOf(Offset.Zero) }
  val haptic = LocalHapticFeedback.current
  val pulse = remember { Animatable(0.16f) }
  var selectionPulse by remember { mutableIntStateOf(0) }
  LaunchedEffect(selectionPulse) {
    if (selectionPulse > 0) {
      pulse.snapTo(0.38f)
      pulse.animateTo(0.16f, tween(350))
    }
  }

  fun lineAt(position: Offset): Pair<SessionDiffFileView, Int>? {
    val item = listState.layoutInfo.visibleItemsInfo.firstOrNull { position.y >= it.offset && position.y < it.offset + it.size }
    val key = item?.key as? SessionDiffRowKey ?: return null
    return files.firstOrNull { it.file.path == key.path }?.let { it to key.index }
  }

  fun beginSelection(
    view: SessionDiffFileView,
    index: Int,
    dragging: Boolean,
  ) {
    val started = SessionDiffSelection.start(view, index) ?: return
    selection = started
    selecting = dragging
    activeHandle = null
    selectionPulse++
    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
  }
  Box(
    modifier.pointerInput(files, collapsed) {
      awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Final)
        if (waitForUpOrCancellation(PointerEventPass.Final) != null) selection = null
      }
    },
  ) {
    LazyColumn(
      Modifier
        .fillMaxSize()
        .pointerInput(files, collapsed) {
          awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            // Eligibility belongs to pointer-down, never to reaching the edge mid-pan.
            val canReveal = horizontalOffset == 0f
            val canHide = currentShowLineNumbers
            val gutterSwipeDistance = 64.dp.toPx()
            var gutterTarget: Boolean? = null
            var changedGutters = false
            while (true) {
              val event = awaitPointerEvent(PointerEventPass.Initial)
              val change = event.changes.firstOrNull { it.id == down.id } ?: break
              if (change.isConsumed || selecting) break
              val distance = change.position - down.position
              if (gutterTarget == null) {
                if (abs(distance.x) > viewConfiguration.touchSlop && abs(distance.x) > abs(distance.y)) {
                  if (distance.x < 0f) {
                    if (!canHide) break
                    gutterTarget = false
                  } else {
                    if (!canReveal) break
                    gutterTarget = true
                  }
                } else if (abs(distance.y) > viewConfiguration.touchSlop) {
                  break
                }
              }
              gutterTarget?.let { target ->
                // Claim at touch slop so panning cannot steal a pending gutter swipe,
                // but require deliberate travel before changing visibility.
                change.consume()
                val directedDistance = if (target) distance.x else -distance.x
                if (!changedGutters && directedDistance >= gutterSwipeDistance) {
                  setLineNumbers(target)
                  changedGutters = true
                }
              }
              if (!change.pressed) break
            }
          }
        }.pointerInput(files, collapsed) {
          awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            val (view, index) = lineAt(down.position) ?: return@awaitEachGesture
            awaitLongPressOrCancellation(down.id) ?: return@awaitEachGesture
            beginSelection(view, index, true)
            if (!selecting) return@awaitEachGesture
            try {
              while (true) {
                // Selection owns the pointer before child tap and scroll handlers.
                val event = awaitPointerEvent(PointerEventPass.Initial)
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (change.isConsumed) break
                change.consume()
                lineAt(change.position)?.let { (targetView, targetIndex) ->
                  selection?.takeIf { it.view === targetView }?.let { selection = it.extend(targetIndex) }
                }
                if (!change.pressed) {
                  selecting = false
                  break
                }
              }
            } finally {
              if (selecting) {
                selecting = false
                selection = null
              }
            }
          }
        }.fillMaxWidth()
        .onSizeChanged { viewportWidth = it.width }
        .scrollable(horizontalScroll, Orientation.Horizontal, enabled = !selecting)
        .semantics { horizontalScrollAxisRange = ScrollAxisRange({ horizontalOffset }, { maxOffset }) },
      state = listState,
      userScrollEnabled = !selecting,
    ) {
      val unavailable =
        when (snapshot.unavailableReason) {
          "not_git" -> nativeString("This conversation’s workspace is not a Git repository.")
          "unknown_session" -> nativeString("This conversation is no longer available. Reopen it and try again.")
          "workspace_stopped" -> nativeString("The workspace is stopped. Showing its saved changes, if available.")
          null -> null
          else -> nativeString("Changes are unavailable for this workspace. Try refreshing.")
        }
      if (unavailable != null) item { DiffNotice(unavailable) }
      if (snapshot.truncated) item { DiffNotice(nativeString("Large diff: some files or patches were omitted from this snapshot.")) }
      if (files.isEmpty() && unavailable == null) item { DiffNotice(nativeString("No changes in this snapshot.")) }
      files.forEach { view ->
        val file = view.file
        item(key = "header:${file.path}", contentType = "file") {
          Row(Modifier.fillMaxWidth().background(ClawTheme.colors.surfaceRaised), verticalAlignment = Alignment.CenterVertically) {
            val expandedLabel = if (file.path in collapsed) nativeString("Collapsed") else nativeString("Expanded")
            Row(
              Modifier
                .weight(1f)
                .heightIn(min = ClawTheme.spacing.touchTarget)
                .clickable(role = Role.Button) { toggle(file.path) }
                .semantics { stateDescription = expandedLabel }
                .padding(ClawTheme.spacing.xxs),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs),
            ) {
              Icon(
                if (file.path in collapsed) Icons.Default.ChevronRight else Icons.Default.ExpandMore,
                contentDescription = null,
                modifier = Modifier.size(ClawTheme.spacing.icon),
                tint = ClawTheme.colors.textMuted,
              )
              Column(Modifier.weight(1f)) {
                Text(file.path, style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (file.oldPath != null) {
                  Text(
                    file.oldPath,
                    style = ClawTheme.type.caption,
                    color = ClawTheme.colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                  )
                }
              }
              Text(verbatimText("+${file.additions}").resolveNativeTextResource(), style = ClawTheme.type.caption, color = ClawTheme.colors.success)
              Text(verbatimText("−${file.deletions}").resolveNativeTextResource(), style = ClawTheme.type.caption, color = ClawTheme.colors.danger)
            }
            ClawPlainIconButton(
              Icons.Default.ContentCopy,
              nativeString("Copy patch"),
              { file.patch?.let { patch -> copyChatText(context, patch) } },
              enabled = file.patch != null,
            )
          }
        }
        if (file.path !in collapsed) {
          if (file.binary || view.lines.isEmpty()) {
            item(key = "notice:${file.path}") {
              DiffNotice(if (file.binary) nativeString("Binary file changed") else nativeString("No text patch available"))
            }
          }
          itemsIndexed(view.lines, key = { index, _ -> SessionDiffRowKey(file.path, index) }, contentType = { _, _ -> "line" }) { index, line ->
            SessionDiffCodeRow(
              line,
              horizontalOffset,
              codePaint,
              gutterDigits,
              numberWidth,
              revealedNumberWidth,
              gutterWidth,
              showLineNumbers,
              { setLineNumbers(!showLineNumbers) },
              selection?.let { it.view === view && it.contains(index) } == true,
              pulse.value,
              {
                beginSelection(view, index, false)
              },
            )
          }
          if (file.truncated) item(key = "truncated:${file.path}") { DiffNotice(nativeString("This file’s patch was truncated.")) }
        }
      }
    }
    BackHandler(enabled = selection != null) { selection = null }
    selection?.let { selected ->
      for (start in listOf(true, false)) {
        val index = if (start) selected.firstIndex else selected.lastIndex
        val rowKey = SessionDiffRowKey(selected.view.file.path, index)
        val visible by remember(listState, rowKey) {
          derivedStateOf { listState.layoutInfo.visibleItemsInfo.any { it.key == rowKey } }
        }
        if (visible) {
          for (left in listOf(true, false)) {
            // Keep the dragged handle's pointer node stable as its siblings disappear.
            key(start, left) {
              if (!selecting || activeHandle == (start to left)) {
                val handlePosition = {
                  listState.layoutInfo.visibleItemsInfo.firstOrNull { it.key == rowKey }?.let { item ->
                    Offset(if (left) 24f * density.density else viewportWidth - 24f * density.density, (item.offset + if (start) 0 else item.size).toFloat())
                  }
                }
                SessionDiffSelectionHandle(
                  start,
                  left,
                  handlePosition,
                  onStart = { position ->
                    activeHandle = start to left
                    selecting = true
                    handleDragPosition = position
                  },
                  onDrag = { delta ->
                    handleDragPosition += delta
                    lineAt(handleDragPosition)?.let { (view, index) ->
                      selection?.takeIf { it.view === view }?.let { selection = it.moveEdge(index, start) }
                    }
                  },
                  onEnd = {
                    selecting = false
                    activeHandle = null
                  },
                  onStep = { delta -> selection = selection?.stepEdge(start, delta) },
                )
              }
            }
          }
        }
      }
    }
    selection?.takeIf { !selecting }?.let { selected ->
      val intersectsViewport by remember(selected, listState) {
        derivedStateOf {
          val layout = listState.layoutInfo
          layout.visibleItemsInfo.any { item ->
            val key = item.key as? SessionDiffRowKey
            key?.path == selected.view.file.path && selected.contains(key.index) &&
              item.offset < layout.viewportEndOffset && item.offset + item.size > layout.viewportStartOffset
          }
        }
      }
      if (intersectsViewport) {
        SessionDiffSelectionMenu(
          selected,
          listState,
          onReference = {
            selection = null
            onReference(selected)
          },
          onCopy = {
            copyChatText(context, selected.text)
            selection = null
          },
        )
      }
    }
  }
}

@Composable
private fun SessionDiffSelectionHandle(
  start: Boolean,
  left: Boolean,
  position: () -> Offset?,
  onStart: (Offset) -> Unit,
  onDrag: (Offset) -> Unit,
  onEnd: () -> Unit,
  onStep: (Int) -> Unit,
) {
  val radius = with(LocalDensity.current) { 24.dp.toPx() }
  val appearance = remember { Animatable(0f) }
  LaunchedEffect(Unit) { appearance.animateTo(1f, tween(200)) }
  val latestPosition by androidx.compose.runtime.rememberUpdatedState(position)
  val latestStart by androidx.compose.runtime.rememberUpdatedState(onStart)
  val latestDrag by androidx.compose.runtime.rememberUpdatedState(onDrag)
  val latestEnd by androidx.compose.runtime.rememberUpdatedState(onEnd)
  val color = ClawTheme.colors.accent
  val label =
    when {
      start && left -> nativeString("Selection start, left")
      start -> nativeString("Selection start, right")
      left -> nativeString("Selection end, left")
      else -> nativeString("Selection end, right")
    }
  Canvas(
    Modifier
      // Put touch targets outside the range so even one-line selections have
      // independent start/end handles on each side.
      .layout { measurable, constraints ->
        val handle = measurable.measure(constraints)
        layout(handle.width, handle.height) {
          position()?.let { anchor ->
            handle.place((anchor.x - radius).toInt(), (anchor.y - if (start) 2 * radius else 0f).toInt())
          }
        }
      }.size(48.dp)
      .semantics {
        contentDescription = label
        customActions =
          listOf(
            CustomAccessibilityAction(nativeString("Move up")) {
              onStep(-1)
              true
            },
            CustomAccessibilityAction(nativeString("Move down")) {
              onStep(1)
              true
            },
          )
      }.pointerInput(start) {
        detectDragGestures(
          onDragStart = { latestPosition()?.let { latestStart(it) } },
          onDrag = { change, delta ->
            change.consume()
            latestDrag(delta)
          },
          onDragEnd = { latestEnd() },
          onDragCancel = { latestEnd() },
        )
      },
  ) {
    val edge = Offset(center.x, if (start) size.height else 0f)
    val knob = edge + Offset(0f, if (start) -10.dp.toPx() else 10.dp.toPx())
    // Animate ink only: the gesture target stays full-sized and stable.
    scale(appearance.value, pivot = edge) {
      drawLine(color, edge, knob, 2.dp.toPx())
      drawCircle(color, 6.dp.toPx(), knob)
    }
  }
}

@Composable
private fun SessionDiffSelectionMenu(
  selection: SessionDiffSelection,
  listState: LazyListState,
  onReference: () -> Unit,
  onCopy: () -> Unit,
) {
  val gap = with(LocalDensity.current) { 8.dp.roundToPx() }
  val expansion = remember { Animatable(0f) }
  LaunchedEffect(Unit) { expansion.animateTo(1f, tween(200)) }
  Surface(
    modifier =
      Modifier
        .layout { measurable, constraints ->
          val menu = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
          layout(constraints.maxWidth, constraints.maxHeight) {
            // Read scrolling geometry during placement in the same Compose
            // tree as the code, not through a separately updated popup window.
            val viewport = listState.layoutInfo
            val rows = viewport.visibleItemsInfo
            val top =
              rows.firstOrNull { it.key == SessionDiffRowKey(selection.view.file.path, selection.firstIndex) }?.offset
                ?: viewport.viewportStartOffset
            val bottom =
              rows
                .firstOrNull { it.key == SessionDiffRowKey(selection.view.file.path, selection.lastIndex) }
                ?.let { it.offset + it.size } ?: viewport.viewportEndOffset
            val above = bottom + gap + menu.height > viewport.viewportEndOffset
            val y = if (above) (top - gap - menu.height).coerceAtLeast(viewport.viewportStartOffset) else bottom + gap
            val x = (constraints.maxWidth - menu.width) / 2
            menu.placeWithLayer(x, y) {
              scaleX = expansion.value
              scaleY = expansion.value
              transformOrigin = TransformOrigin(0.5f, if (above) 1f else 0f)
            }
          }
        }.semantics { paneTitle = nativeString("Selection actions") },
    color = ClawTheme.colors.surfaceRaised,
    shape =
      androidx.compose.foundation.shape
        .RoundedCornerShape(12.dp),
    shadowElevation = 6.dp,
  ) {
    Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp)) {
      TextButton(onClick = onReference) {
        Icon(Icons.Default.ChatBubbleOutline, null, Modifier.size(16.dp))
        Text(nativeString("To chat"), Modifier.padding(start = 6.dp))
      }
      TextButton(onClick = onCopy) {
        Icon(Icons.Default.ContentCopy, null, Modifier.size(16.dp))
        Text(nativeString("Copy"), Modifier.padding(start = 6.dp))
      }
    }
  }
}

@Composable
private fun DiffNotice(message: String) {
  Text(message, Modifier.fillMaxWidth().padding(ClawTheme.spacing.sm), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
}

@Composable
private fun SessionDiffCodeRow(
  line: SessionDiffLine,
  offset: Float,
  codePaint: Paint,
  gutterDigits: Int,
  numberWidth: Float,
  revealedNumberWidth: Float,
  gutterWidth: Float,
  showLineNumbers: Boolean,
  toggleLineNumbers: () -> Unit,
  isSelected: Boolean,
  selectionAlpha: Float,
  selectLine: () -> Unit,
) {
  val colors = ClawTheme.colors
  val style = ClawTheme.type.mono
  val density = LocalDensity.current
  val rowHeight = with(density) { style.lineHeight.toDp() }
  val gutterPaint = remember(codePaint, colors.textMuted) { Paint(codePaint).apply { color = colors.textMuted.toArgb() } }
  val sign =
    when (line.kind) {
      SessionDiffLineKind.Addition -> "+"
      SessionDiffLineKind.Deletion -> "−"
      else -> " "
    }
  val toggleLabel = if (showLineNumbers) nativeString("Hide line numbers") else nativeString("Show line numbers")
  val numbersState = if (showLineNumbers) nativeString("Line numbers shown") else nativeString("Line numbers hidden")
  Canvas(
    Modifier
      .fillMaxWidth()
      .height(rowHeight)
      .semantics {
        customActions =
          listOf(
            CustomAccessibilityAction(toggleLabel) {
              toggleLineNumbers()
              true
            },
          )
        selected = isSelected
        if (line.oldLine != null || line.newLine != null) {
          onLongClick(label = nativeString("Select lines")) {
            selectLine()
            true
          }
        }
        stateDescription = numbersState
        val numbers = if (showLineNumbers) "${line.oldLine ?: ""} ${line.newLine ?: ""} " else ""
        text = AnnotatedString("$numbers$sign ${line.text}")
      },
  ) {
    val background =
      when (line.kind) {
        SessionDiffLineKind.Addition -> colors.successSoft
        SessionDiffLineKind.Deletion -> colors.dangerSoft
        SessionDiffLineKind.Hunk, SessionDiffLineKind.NoNewline -> colors.surfaceRaised
        else -> colors.codeBg
      }
    drawRect(colors.codeBg)
    drawRect(background)
    if (isSelected) drawRect(colors.accent.copy(alpha = selectionAlpha))
    val numbers =
      "${line.oldLine?.toString().orEmpty().padStart(gutterDigits)} " +
        "${line.newLine?.toString().orEmpty().padStart(gutterDigits)} "
    val baseline = (size.height - codePaint.fontMetrics.bottom - codePaint.fontMetrics.top) / 2f
    clipRect(right = revealedNumberWidth) {
      drawIntoCanvas { it.nativeCanvas.drawText(numbers, revealedNumberWidth - numberWidth, baseline, gutterPaint) }
    }
    drawIntoCanvas { it.nativeCanvas.drawText("$sign ", revealedNumberWidth, baseline, gutterPaint) }
    // Let Android shape intact text, including surrogate pairs and combining
    // sequences. Canvas clipping avoids a giant Compose text-layout surface.
    clipRect(left = gutterWidth) {
      drawIntoCanvas { it.nativeCanvas.drawText(line.text.replace("\t", "    "), gutterWidth - offset, baseline, codePaint) }
    }
  }
}
