package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.SessionDiffLine
import ai.openclaw.app.chat.SessionDiffLineKind

/** A reference names one side of one hunk, never omitted source or mixed coordinates. */
internal data class SessionDiffSelection(
  val view: SessionDiffFileView,
  val anchor: Int,
  val extent: Int,
  val bounds: IntRange,
  val before: Boolean,
) {
  private fun number(line: SessionDiffLine) = if (before) line.oldLine else line.newLine

  private val path: String
    get() = if (before) view.file.oldPath ?: view.file.path else view.file.path

  fun contains(index: Int): Boolean = index in minOf(anchor, extent)..maxOf(anchor, extent) && number(view.lines[index]) != null

  fun extend(index: Int) = copy(extent = index.coerceIn(bounds))

  val firstIndex: Int
    get() = (minOf(anchor, extent)..maxOf(anchor, extent)).first { number(view.lines[it]) != null }

  val lastIndex: Int
    get() = (minOf(anchor, extent)..maxOf(anchor, extent)).last { number(view.lines[it]) != null }

  fun moveEdge(
    index: Int,
    start: Boolean,
  ): SessionDiffSelection =
    if (start) {
      val target = index.coerceIn(bounds.first, lastIndex)
      copy(anchor = (target..lastIndex).first { number(view.lines[it]) != null }, extent = lastIndex)
    } else {
      val target = index.coerceIn(firstIndex, bounds.last)
      copy(anchor = firstIndex, extent = (firstIndex..target).last { number(view.lines[it]) != null })
    }

  fun stepEdge(
    start: Boolean,
    delta: Int,
  ): SessionDiffSelection {
    val candidates = bounds.filter { number(view.lines[it]) != null }
    val current = candidates.indexOf(if (start) firstIndex else lastIndex)
    return moveEdge(candidates[(current + delta).coerceIn(candidates.indices)], start)
  }

  private val lines: List<SessionDiffLine>
    get() = view.lines.slice(minOf(anchor, extent)..maxOf(anchor, extent)).filter { number(it) != null }

  val reference: String
    get() {
      val selected = lines
      return "$path:${number(selected.first())}-${number(selected.last())}"
    }

  fun chatReference(): String {
    val side = if (before) "Before" else "After"
    val code = text
    // A selected Markdown fence must not close the surrounding code block.
    val fence = "`".repeat(maxOf(3, (Regex("`+").findAll(code).maxOfOrNull { it.value.length } ?: 0) + 1))
    val language =
      path
        .substringAfterLast('/')
        .substringAfterLast('.', "")
        .lowercase()
        .takeIf { it.matches(Regex("[a-z0-9]+")) }
        .orEmpty()
    return "$reference ($side | Uncommitted)\n$fence$language\n$code\n$fence"
  }

  val text: String
    get() = lines.joinToString("\n") { it.text }

  companion object {
    fun start(
      view: SessionDiffFileView,
      index: Int,
    ): SessionDiffSelection? {
      val line = view.lines[index]
      if (line.oldLine == null && line.newLine == null) return null
      val first = (index downTo 0).firstOrNull { view.lines[it].kind == SessionDiffLineKind.Hunk }?.plus(1) ?: 0
      val last =
        (index + 1 until view.lines.size)
          .firstOrNull { view.lines[it].kind == SessionDiffLineKind.Hunk }
          ?.minus(1) ?: view.lines.lastIndex
      return SessionDiffSelection(view, index, index, first..last, line.kind == SessionDiffLineKind.Deletion)
    }
  }
}
