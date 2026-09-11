package ai.openclaw.app.chat

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionDiffTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun snapshotPreservesUnavailableAndIncompleteResultsInsteadOfTreatingThemAsClean() {
    val unavailable =
      parseSessionDiff(
        json,
        """{"sessionKey":"session","files":[],"additions":0,"deletions":0,"unavailableReason":"workspace_stopped"}""",
      )
    assertEquals("workspace_stopped", unavailable.unavailableReason)
    val snapshot =
      parseSessionDiff(
        json,
        """
        {"sessionKey":"session","branch":"feature","baseRef":"main","aheadCount":1,
         "commits":[{"sha":"abc123","subject":"Rename asset"}],
         "mergeBase":{"sha":"def456","subject":"Base"},"additions":0,"deletions":0,"truncated":true,
         "files":[{"path":"new.png","oldPath":"old.png","status":"renamed","binary":true,
         "truncated":true,"additions":0,"deletions":0}],"futureField":true}
        """.trimIndent(),
      )
    assertTrue(snapshot.truncated)
    assertTrue(snapshot.files.single().binary)
    assertTrue(snapshot.files.single().truncated)
    assertEquals("old.png", snapshot.files.single().oldPath)
    assertNull(snapshot.files.single().patch)
    assertEquals("feature", snapshot.branch)
    assertEquals("renamed", snapshot.files.single().status)
  }

  @Test(expected = SerializationException::class)
  fun malformedResponseDoesNotBecomeAnEmptySuccessfulDiff() {
    parseSessionDiff(json, """{"sessionKey":"session"}""")
  }

  @Test
  fun patchKeepsSeparateLineNumbersAndHunkBoundariesWithoutRenderingGitHeaders() {
    val lines =
      parseSessionDiffPatch(
        """
        diff --git a/example.txt b/example.txt
        --- a/example.txt
        +++ b/example.txt
        @@ -2,3 +2,4 @@ section
         unchanged
        -old
        +new
        +extra
         tail
        @@ -20 +21 @@
        -previous
        \ No newline at end of file
        +replacement
        \ No newline at end of file
        """.trimIndent(),
      )
    assertEquals(
      listOf(
        SessionDiffLine(SessionDiffLineKind.Hunk, "@@ -2,3 +2,4 @@ section"),
        SessionDiffLine(SessionDiffLineKind.Context, "unchanged", 2, 2),
        SessionDiffLine(SessionDiffLineKind.Deletion, "old", oldLine = 3),
        SessionDiffLine(SessionDiffLineKind.Addition, "new", newLine = 3),
        SessionDiffLine(SessionDiffLineKind.Addition, "extra", newLine = 4),
        SessionDiffLine(SessionDiffLineKind.Context, "tail", 4, 5),
        SessionDiffLine(SessionDiffLineKind.Hunk, "@@ -20 +21 @@"),
        SessionDiffLine(SessionDiffLineKind.Deletion, "previous", oldLine = 20),
        SessionDiffLine(SessionDiffLineKind.NoNewline, "\\ No newline at end of file"),
        SessionDiffLine(SessionDiffLineKind.Addition, "replacement", newLine = 21),
        SessionDiffLine(SessionDiffLineKind.NoNewline, "\\ No newline at end of file"),
      ),
      lines,
    )
  }

  @Test
  fun newAndDeletedFilesRetainEmptyLinesAndDoNotCreateRowsForTrailingPatchNewline() {
    assertEquals(
      listOf(
        SessionDiffLine(SessionDiffLineKind.Hunk, "@@ -0,0 +1,2 @@"),
        SessionDiffLine(SessionDiffLineKind.Addition, "", newLine = 1),
        SessionDiffLine(SessionDiffLineKind.Addition, "+literal", newLine = 2),
      ),
      parseSessionDiffPatch("@@ -0,0 +1,2 @@\n+\n++literal\n"),
    )
    assertEquals(
      SessionDiffLine(SessionDiffLineKind.Deletion, "", oldLine = 1),
      parseSessionDiffPatch("@@ -1 +0,0 @@\n-\n").last(),
    )
    assertTrue(parseSessionDiffPatch("Binary files a/image.png and b/image.png differ\n").isEmpty())
  }
}
