## PRD Updated

### Location

prd/issue-3.md

### Changes Made

- Verified prior review feedback was incorporated (simplified architecture via `agentCommand` callback + embedded/ACP delta bridging, no runner-internal plumbing).
- Added explicit Stage 2 acceptance criteria for non-streaming model behavior and no-duplicate completion flush semantics.
- Added two Stage 2 test cases to cover non-streaming single-final-chunk behavior and stream/end deduplication.
- Added a specific risk/mitigation for duplicate speech when stream and completion paths overlap.

### Remaining Concerns

None.
