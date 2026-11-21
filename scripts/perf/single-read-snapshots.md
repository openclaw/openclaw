# Single-statement pending-input reads

The pending-input lookup by ID already returns its bounded payload and current
session ID in one SELECT. Its explicit read transaction does not add consistency.
Listings still need one snapshot for their count and page queries.

## Acceptance rule

Before changing the production path, run the existing pending-input-history suite
with its count-free context case extended to the ID lookup. Both modes must return
an empty page initially and observe a later committed input. The ID lookup must
fall from three statements (BEGIN, SELECT, COMMIT) to one SELECT; context remains
one SELECT. The worker request count and MAIN work must not increase.

Run the frozen standard Gateway census on baseline and candidate, keeping cold,
warm, idle and restart phases separate. Record per-operation SQL and request
counts. Use three alternating pairs when the host permits; otherwise use one pair
or the campaign's source-attribution fallback. The standard census does not by
itself prove the ID path: retain a real Gateway message-get reproduction of an
accepted pending input before claiming a user-flow saving.

For latency or CPU comparisons, interleave at least five samples per arm under
the campaign timing lock. Record median, p95 and range for each phase. All
user-facing metrics must hold or improve; a 20% regression in any cell stops the
change. Counts-only evidence makes no latency or CPU claim.

Retain empty/missing input behavior, consumed-input filtering, bounded payloads,
current-session identity and newly committed input visibility. No schema,
retention, authority, admission, or worker-routing change is intended.
