package ai.openclaw.app.chat

enum class SessionDiffLineKind {
  Context,
  Addition,
  Deletion,
  Hunk,
  NoNewline,
}

data class SessionDiffLine(
  val kind: SessionDiffLineKind,
  val text: String,
  val oldLine: Int? = null,
  val newLine: Int? = null,
)

private val sessionDiffHunkHeader = Regex("^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@.*$")

/** Parses only patch hunks; file metadata belongs to the snapshot's file header. */
fun parseSessionDiffPatch(patch: String): List<SessionDiffLine> =
  buildList {
    var oldLine = 0
    var newLine = 0
    var inHunk = false
    for (line in patch.lineSequence()) {
      val header = sessionDiffHunkHeader.matchEntire(line)
      if (header != null) {
        val oldStart = header.groupValues[1].toIntOrNull()
        val newStart = header.groupValues[2].toIntOrNull()
        inHunk = oldStart != null && newStart != null
        if (oldStart != null && newStart != null) {
          oldLine = oldStart
          newLine = newStart
          // Keep every hunk boundary visible so omitted context never looks contiguous.
          add(SessionDiffLine(SessionDiffLineKind.Hunk, line))
        }
        continue
      }
      if (!inHunk) continue
      when {
        line.startsWith("+") -> add(SessionDiffLine(SessionDiffLineKind.Addition, line.drop(1), newLine = newLine++))
        line.startsWith("-") -> add(SessionDiffLine(SessionDiffLineKind.Deletion, line.drop(1), oldLine = oldLine++))
        line.startsWith(" ") -> add(SessionDiffLine(SessionDiffLineKind.Context, line.drop(1), oldLine++, newLine++))
        line == "\\ No newline at end of file" -> add(SessionDiffLine(SessionDiffLineKind.NoNewline, line))
        else -> inHunk = false
      }
    }
  }
