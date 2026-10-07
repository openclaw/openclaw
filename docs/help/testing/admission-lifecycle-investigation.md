---
summary: "Isolated transcript admission lifecycle investigation for issue 166446"
title: "Admission lifecycle investigation"
---

This investigation is based on upstream revision
`d9813e3489766284c105907f30065a83ff798a11`.

The added fixture resolves a synthetic persisted target through
`resolveAgentRunSessionTarget`, installs the real durable admission callback,
and persists through `createUserTurnTranscriptRecorder.persistApproved` before
awaiting the recorder persistence waiter. This proves later self-persistence identity,
not an outstanding runtime-write/provider-dispatch race. Ordinary, child, and
requester-settle-shaped keys are covered, but this is not a live Telegram,
spawn, or announcement reproduction. Logs contain only field equality booleans.

The manual-only workflow also runs the existing provider-dispatch rejection
contract. No comparison is relaxed, no rejection is caught or suppressed, and
no production repair is proposed until the incident mismatch is identified.

## Scoped diagnostic improvement

The rejecting callback now includes only `agentIdMatches`, `sessionIdMatches`,
`sessionKeyMatches`, and `storePathMatches` in the exception. Comparisons remain
strict and fail closed; the recorder waiter still rejects before dispatch.
No actual identifier, key, path, message, or admission receipt is serialized.
This is diagnostic coverage, not a repair of the reported production incident.

The expanded isolated lifecycle fixture starts with persisted history, resolves
an uppercase supplied key to the existing canonical key, installs the callback,
and holds the real database write lane while another transcript append queues.
The runtime writer reports its real appended anchor to the recorder inside the
lane. The waiter must settle detached admission behind both writes without
changing identity. This does not exercise live Telegram, spawn, or announcement
entry points and must not be labeled an incident reproduction.

Release-note context: delayed durable admission failures now identify the
mismatching identity field with privacy-safe equality booleans. Release-owned
changelogs are intentionally unchanged; this note belongs in the PR evidence.

## Composed runtime dispatch coverage

The provider suite also composes the guarded SessionManager's real runtime
message write, its recorder notification, the durable admission callback,
recorder waiter, and provider dispatch gate. Matching ownership dispatches;
deliberately differing prepared session/key/store bindings reject without a
provider call and surface the boolean error in the runtime assistant failure.
An agent mismatch is induced by mutating the retained prepared target after
preparation; otherwise conflicting physical-store ownership is rejected earlier.
This is an explicit callback mutation probe, not a reachable incident producer
or a root-cause repair. Runtime output reports only the diagnostic and zero
provider calls. The provider stream is mocked; no paid API or production Gateway
is used. Pre-persisted replay coverage remains a separate lifecycle contract.

The manual workflow explicitly fetches its immutable baseline before reading
the source blob, so later branch/main dispatches do not depend on shallow depth.
