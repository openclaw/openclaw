---
title: "Earlier warm transcript display"
summary: "Presentation timing for displaying the last-viewed conversation earlier without a second cache or new authority"
read_when:
  - Evaluating earlier transcript display on Control UI reload
  - Reviewing browser transcript retention and offline privacy tradeoffs
---

# Earlier warm transcript display

Present the existing scoped transcript
snapshot earlier, after local admission, while the Gateway revalidates it. Keep
HTML-only first paint generic: reading browser-owned transcripts requires
JavaScript. A second DOM cache would duplicate persistence and invalidation.

## Existing behavior and proposed change

The [warm reload contract](/web/control-ui/offline-and-reconnect#warm-reload)
already restores conversations before reconnection. Under `ui/src/`,
`app/boot-record.ts` and `app/bootstrap-warm-boot.ts` admit the account;
`pages/chat/session-snapshot-*` own storage and prewarming;
`pages/chat/chat-pane-snapshot-hydration.ts` restores the pane.

Start that scoped read when admission and the exact route are known. Let the
normal renderer replace the static frame, then reconcile live history in place.
Do not delay connection/history requests on IndexedDB or eagerly load chat on
other routes. This changes presentation timing, not ownership.

## Identity and revalidation

Within the browser origin, key by normalized Gateway credential URL scope
(including ingress path/query), server-issued recovery scope for viewer/access
context, and canonical agent/session key. A replacement Gateway must not inherit
the previous recovery identity. Preserve physical session ID, cursor, and history
metadata; display names and host aliases cannot establish identity.

Mark the early preview **Saved conversation · reconnecting** and keep it inert:
no sends, approvals, plugin execution, or authenticated media fetches. Normal
owners may resume existing offline drafting/queuing after mounting; live effects
still require current Gateway authority. Render through normal sanitization;
defer remote resources and active content until admitted.

Revalidate through existing history cursors/receipts after checking current
access; missing or expired cursors fetch fresh history. Authentication rejection,
identity/access change, deletion/reset, or authoritative loss of visibility retires
the preview and scoped snapshot. Network failure may retain the marked stale
view. Preserve delayed-read guards and cross-tab invalidation.

## Privacy, bounds, and failure behavior

Anyone with the browser profile, compromised same-origin code, or disk access can
read retained text. Encryption with a locally stored key does not solve this.
Remote sign-out/revocation is unknowable while offline: requiring fresh
authentication avoids displaying that copy, but loses network-independent reload.

**Forget this browser** and credential replacement must retire admission before
asynchronous deletion and notify other tabs. Do not claim secure disk erasure.
Keep Incognito excluded, pairing/provider-replay redaction, and no added tokens,
tickets, attachment bytes, or HTML snapshots.

Keep current bounds: roughly 80 rows plus complete history-entry groups,
20 conversations, and 24 Mi total character weight—not disk bytes. Boot/roster
admission expires after 30 days; transcripts have no independent TTL. Changing
retention needs a separate decision. Storage denial, eviction, corruption, or
blocked upgrades fall back to the generic frame and live read.

Reuse the schema/projection version; version any changed projection and discard
incompatible records rather than guessing ownership. Draft/outbox durability
stays separate.

## Implementation and proof

Bootstrap starts the snapshot read for the resolved literal/main route, or the
last session only on the default landing and matching-agent short routes. Other
pages do not prewarm the transcript database. The route loader still owns name
and short-ID resolution; a speculative read cannot select a conversation.

An ambiguous dashboard name may prewarm the last-viewed dashboard for the same
agent. Only the route's exact cache key can consume that candidate. A name that
resolves elsewhere leaves one unused scoped read; it never changes selection
or delays connection/history. Forced literal keys and other agents stay exact.

The pane publishes scoped saved rows without waiting for the first connect
request or route revalidation. Cached board startup retains its separate timing.
History requests use a cursor that has already arrived, but never wait for
IndexedDB. A live response retires pending snapshot publication before applying
its own rows, preserving the existing reconciliation and identity checks.

The header labels retained content as **Saved conversation** alongside connection
status until live history is available. Remote media and active transcript content
wait for the live connection and any pending route validation. Local drafts keep
their existing image previews and persistence.

### Measurement contract

Use the committed Control UI cold-load benchmark against production builds on the
same machine. The workload is its 240-message, 390-session synthetic fixture,
with ten interleaved base/head pairs separately for localhost (zero delivery
latency) and the remote `live-fast` profile (100 ms HTTP latency, 10 Mbps).
Record visible transcript, enabled composer, live history, connection dispatch,
renderer CPU, and host load. On a noisy host include base/base controls.

A clean win means earlier saved content, median regressions no larger than 5%,
and no worse p95 (sub-1% movement is noise). The remote transcript target is
300 ms; missing it does not justify weakening admission or correctness.
Separate diagnostic filmstrips check duplicate row keys, cached-to-live row
retention, visible-anchor displacement, and layout shifts. Full-page CLS includes
sidebar and details updates; report it separately from transcript handoff.

This implementation chooses earlier stale display under existing local admission,
without new persistence or broader retention.

Measure cold/warm local/remote filmstrips, transcript paint, fresh-history/composer
readiness, CLS, and cache CPU. Cover account switches, revocation, reset/deletion,
cross-tab forgetting, Incognito, storage failure, and live history winning the
race. Earlier paint must not delay readiness.

### October 24 measurements

Twenty interleaved base/head pairs on the same shared Mac used the production
Gateway HTTP handler with synthetic RPCs and the fixture above. The remote
profile modeled 100 ms HTTP latency, 10 Mbps, and the existing `live-fast` RPC
latencies; it was not an Internet deployment measurement.

| Warm reload milestone        | Base median / p95 | Head median / p95 |
| ---------------------------- | ----------------- | ----------------- |
| Local visible transcript     | 212.5 / 265.6 ms  | 203.7 / 235.4 ms  |
| Local enabled composer       | 207.8 / 232.1 ms  | 201.9 / 234.8 ms  |
| Remote visible transcript    | 509.3 / 515.0 ms  | 304.7 / 322.4 ms  |
| Remote enabled composer      | 250.7 / 256.9 ms  | 247.8 / 260.0 ms  |
| Remote live history response | 966.3 / 979.1 ms  | 940.8 / 945.7 ms  |

The remote median misses the 300 ms target by 4.7 ms. A base/base control showed
noisy tails (script CPU p95 +7.8%, task CPU p95 +16.2%); twenty-pair CPU results
were within that noise: local script median +1.4%, remote script median -1.3%.
The diagnostic handoff retained the visible anchor within 0.04 px, had no
duplicate row keys, and recorded zero CLS during live adoption. Whole-page CLS
remained about 0.112 because earlier virtualizer, sidebar, and details updates
still move content. Zero whole-page CLS is not established by this change.

The final production artifact, including workspace-icon admission, is 281,367 B
gzip with seven JavaScript requests and one CSS request (base: 281,184 B).
Chat boot is 1,274,888 B (+91 B); New Session is 771,094 B (+206 B). The
183 B startup increase includes the route-aware prewarm selection.

Cached widgets keep their normal shell and learned height before admission;
their active content and controls wait. Dashboard board-and-transcript restoration
keeps its existing simultaneous timing, while ordinary chat yields for the composer.

After integrating current main to resolve the startup-baseline conflict, the
combined production artifact measures 281,702 B startup gzip (7 JavaScript
requests and 1 CSS request), 1,271,675 B chat boot, and 767,609 B New Session.
The startup baseline records that measured value: +403 B against incoming main’s
281,299 B baseline. This retains the shared-clock CPU improvement alongside the
earlier transcript display. UI types and the strict comparison against the built
original base pass. The timing pairs above predate this main integration.
