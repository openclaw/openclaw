package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkEntry
import ai.openclaw.wear.shared.WearReplyText
import ai.openclaw.wear.shared.WearReplyTextPage
import ai.openclaw.wear.shared.WearReplyTextStatus
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.BasicSwipeToDismissBox
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.minimumInteractiveComponentSize
import kotlinx.coroutines.CancellationException

internal data class WearOpenReply(
  val message: WearChatMessage? = null,
  val talkEntry: WearRealtimeTalkEntry? = null,
  val target: WearReplyTarget?,
  val localText: String?,
  val supported: Boolean,
)

@Composable
internal fun ReplyPreview(
  text: String,
  truncated: Boolean,
  onOpen: (() -> Unit)?,
) {
  var overflows by remember(text) { mutableStateOf(false) }
  Text(
    text = text,
    color = OpenClawWearTheme.colors.text,
    fontSize = 13.sp,
    lineHeight = 17.sp,
    maxLines = 8,
    overflow = TextOverflow.Ellipsis,
    onTextLayout = { overflows = it.hasVisualOverflow },
  )
  if (onOpen != null && (truncated || overflows)) {
    Text(
      text = stringResource(R.string.read_full_reply),
      color = OpenClawWearTheme.colors.primary,
      fontSize = 13.sp,
      textAlign = TextAlign.Center,
      modifier =
        Modifier
          .fillMaxWidth()
          .clickable(role = Role.Button, onClick = onOpen)
          .minimumInteractiveComponentSize()
          .padding(vertical = 12.dp),
    )
  }
}

@Composable
internal fun ReplyReader(
  reply: WearOpenReply,
  readReply: suspend (WearReplyTarget, Int, String?) -> WearReplyTextPage,
  onDismiss: () -> Unit,
) {
  BackHandler(onBack = onDismiss)
  val list = rememberTransformingLazyColumnState()
  var offsets by remember { mutableStateOf(listOf(0)) }
  var revision by remember { mutableStateOf<String?>(null) }
  var retry by remember { mutableIntStateOf(0) }
  var page by remember { mutableStateOf<WearReplyTextPage?>(null) }
  val offset = offsets.last()
  LaunchedEffect(offset, retry) {
    page = null
    list.requestScrollToItem(0)
    page =
      try {
        when {
          reply.localText != null -> WearReplyText.page(reply.localText, "loaded", offset, revision)
          !reply.supported -> WearReplyTextPage(WearReplyTextStatus.Unsupported)
          reply.target == null -> WearReplyTextPage(WearReplyTextStatus.Unavailable)
          else -> readReply(reply.target, offset, revision)
        }
      } catch (err: CancellationException) {
        throw err
      } catch (_: Throwable) {
        WearReplyTextPage(WearReplyTextStatus.Failed)
      }
    if (page?.status == WearReplyTextStatus.Ready) revision = page?.revision
  }
  BasicSwipeToDismissBox(onDismissed = onDismiss) { isBackground ->
    if (!isBackground) {
      WearPage(pageLabel = stringResource(R.string.read_full_reply), listState = list) {
        item { SecondaryButton(stringResource(R.string.close), true, onDismiss) }
        val loaded = page
        if (loaded?.status == WearReplyTextStatus.Ready) {
          // Paragraphs remain uncapped; the Wear list owns touch, rotary and accessibility scrolling.
          loaded.text.split('\n').forEachIndexed { index, paragraph ->
            item(key = "paragraph:$offset:$index") {
              Text(
                text = paragraph,
                color = OpenClawWearTheme.canvasColors.text,
                fontSize = 13.sp,
                lineHeight = 17.sp,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
              )
            }
          }
          if (offsets.size > 1) {
            item {
              SecondaryButton(stringResource(R.string.reply_previous_page), true) { offsets = offsets.dropLast(1) }
            }
          }
          loaded.nextOffset?.let { next ->
            item {
              SecondaryButton(stringResource(R.string.reply_next_page), true) { offsets = offsets + next }
            }
          }
          item { SecondaryButton(stringResource(R.string.close), true, onDismiss) }
        } else {
          item {
            Text(
              text =
                stringResource(
                  when (loaded?.status) {
                    null -> R.string.reply_loading
                    WearReplyTextStatus.Unsupported -> R.string.reply_unsupported
                    WearReplyTextStatus.TooLarge -> R.string.reply_too_large
                    WearReplyTextStatus.Changed -> R.string.reply_changed
                    WearReplyTextStatus.Unavailable -> R.string.reply_unavailable
                    else -> R.string.reply_failed
                  },
                ),
              color = OpenClawWearTheme.canvasColors.text,
              fontSize = 13.sp,
              modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp),
            )
          }
          if (loaded != null && loaded.status in listOf(WearReplyTextStatus.Failed, WearReplyTextStatus.Changed, WearReplyTextStatus.Unavailable)) {
            item {
              SecondaryButton(stringResource(R.string.retry), true) {
                revision = null
                offsets = listOf(0)
                retry++
              }
            }
          }
        }
      }
    }
  }
}
