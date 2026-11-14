# Archive sessions while preserving exceptions

Archiving preserves transcripts; a cleanup request does not authorize deletion.

1. List sessions through the typed tools, following pagination. Resolve requested
   exceptions to exact identities and preserve their pinned state. Report any
   visibility limits rather than changing access to expand the cleanup.
2. Archive only non-exempt targets in the requested scope, using the tool’s current
   identity preconditions and bounded batches where supported. Inspect each
   result; reconcile uncertain outcomes before retrying.
3. List again to verify the retained exceptions and actual archive count. Report
   protected targets and other failures separately. A deferred archive of the
   current conversation remains pending until completion, not a verified success.
