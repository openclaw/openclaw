# Archive sessions while preserving exceptions

Use for requested session cleanup, not session deletion. Archive operations keep
transcripts; deletion is a separate destructive operation and is not implied.

1. Discover the available session tools and their current schemas. List active
   sessions, following pagination, and inspect the caller's visibility scope.
   A restricted list does not establish global completeness.
2. Resolve every requested exception to an exact session key and current session
   ID. Preserve the exceptions' existing pinned state. Do not change access or
   visibility configuration merely to expand the cleanup; report the visible
   scope and any unavailable targets.
3. Archive only the requested non-exempt sessions through the typed session
   mutation tool. Use its current identity/concurrency preconditions (for example,
   `expectedSessionId`) and bounded batches where supported. Keep the current
   conversation separate so deferred completion and partial failures are clear.
4. Inspect each target result. A platform-protected-session refusal is a retained
   exception, not a successfully archived session. Reconcile uncertain results
   before retrying them; do not infer every target succeeded from batch success.
5. Archive the current conversation only when it is in scope. A scheduled or
   deferred response is pending until the operation actually completes; do not
   count it as verified archived while the current run is still active.
6. List unarchived sessions again, following pagination. Verify exact exception
   identities and pin states, and investigate unexpected remaining targets.
   Account separately for protected targets, visibility gaps, and the current
   conversation's deferred archive. If the task explicitly authorized a temporary
   visibility change, restore only that inspected setting through its owner and
   verify it without overwriting unrelated changes.

Report the verified archive count, preserved exceptions, pending current-chat
archive, and concrete blockers separately. State the verified scope and that
archiving preserved transcripts; do not claim globally complete cleanup from a
visibility-limited result.
