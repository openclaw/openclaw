---
title: "Earlier warm transcript display"
summary: "Design proposal for displaying the last-viewed conversation earlier without a second cache or new authority"
read_when:
  - Evaluating earlier transcript display on Control UI reload
  - Reviewing browser transcript retention and offline privacy tradeoffs
---

# Earlier warm transcript display

**Proposal only; no implementation.** Present the existing scoped transcript
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

## Decision and proof

The decision is earlier stale display under existing local admission versus
fresh authentication before showing saved text. Recommend earlier display,
without new persistence or broader retention.

Measure cold/warm local/remote filmstrips, transcript paint, fresh-history/composer
readiness, CLS, and cache CPU. Cover account switches, revocation, reset/deletion,
cross-tab forgetting, Incognito, storage failure, and live history winning the
race. Earlier paint must not delay readiness.
