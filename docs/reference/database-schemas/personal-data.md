---
summary: "Where personal GitHub connections, personal model accounts, and Apple companion journals live"
read_when:
  - "Checking where per-person credentials and selections are stored"
  - "Understanding Apple companion delivery journals and their migration behaviour"
title: "Per-person and companion storage"
---

## Personal GitHub connections and publication

Personal GitHub connection state uses the existing `secret_store_entries` identity scope, with the canonical authenticated profile as `scope_id` and the fixed private name `github-connection`. It is not a generic identity-secret API or a profile preference. One bounded record owns selection, pending device authorization, and refresh recovery. Personal managed CLI credentials use a separate `credentials/github/personal/<opaque-profile-id>` directory, outside older system/agent cleanup roots.

Personal publication uses the lazy, same-version `github_personal_publication_requests` table. It records the requesting profile, selected connection generation and account, immutable target/workspace snapshot, idempotency, and outcome; it contains no tokens. Reading status does not create the table. Existing system and agent requests remain in their original table.

Local shared and personal publication records use the first-use `github_publication_session_lifecycles` companion table to bind each request to its admitted session lifecycle revision. The key is the publication kind and request ID; the binding commits in the same transaction as the request. An explicit `NULL` records that the session had no revision at admission. A missing binding cannot authorize unfinished publication and is never filled from the current session. Terminal receipt history remains readable.

The companion table leaves the numeric shared schema version, both existing local request-table definitions, and their receipt digests unchanged. Older schema validators treat those request tables as optional and reject additional columns even when nullable, so the lifecycle binding uses a separate table that older readers ignore.

Older builds ignore both the personal request table and identity-scoped credential rows instead of executing a personal request as System. Re-upgrade still enforces original authorization expiry. Unfinished personal publication requires fresh confirmation by the same authenticated owner after a Gateway restart; remote-result reconciliation reuses the original request markers.

Disconnect removes usable local credentials and retains a secret-free disconnected selection to fence stale work. Profile merges preserve target state, including an explicit disconnection; a source connection transfers only when the target has no state, with new selection authority. Credentials stranded by a profile merge performed on an older build require reconnect, not runtime adoption through aliases.

Personal publication receipts remain for the logical session's lifetime. Archive/reset preserves receipts and invalidates incompatible unfinished work. An already-dispatched GitHub operation can still record its observed result, without gaining authority for another operation. Permanent session deletion fences execution and removes its personal receipts and lifecycle bindings. There is no timed idempotency expiry, and deleting local state does not undo an already-created GitHub commit or pull request.

See the accepted [personal GitHub ownership and publication design](https://github.com/openclaw/openclaw/issues/133590) and the operator-facing [GitHub connections guide](/concepts/user-model#github-connections).

## Personal model accounts

Personal model accounts use the existing `secret_store_entries` identity scope, keyed by the canonical Gateway profile. A versioned `model-accounts` record owns provider selections, while each `model-account:<profile-id>` record owns one inline OAuth or token credential and its usage state. Each record retains the existing 64 KiB secret-store limit; connecting more accounts or merging profiles does not combine credentials under one size limit. This adds no table, column, index, or schema version. Generic secret-list/read methods and profile preferences do not expose these records.

The credential and its selected link commit in one synchronous transaction after the Gateway revalidates the initiating authorization. Runtime loads only an explicitly selected credential and routes refresh and usage updates to that same owner. Shared and agent-local auth saves exclude the reserved personal-profile namespace, including runtime snapshots and CLI mirrors.

Unlink records an explicit disconnected selection and retains credentials used by existing session pins. A verified identity merge transfers only the live source's records, preserving the target's selections and disconnections while retaining old credential IDs for pinned sessions. Credentials stranded on an alias by an older build are not adopted at runtime. A compatible downgrade leaves private records outside the older shared-account pool; re-upgrade can use retained records, while accounts stranded by older identity merges need reconnecting.

See [Per-person model accounts](/concepts/multi-user#per-person-model-accounts) for connection, cancellation, session billing, and unlink behavior.

## Apple companion delivery journals

Companion Watch chat has separate app-local storage. It does not change the
Gateway control-plane or per-agent database schema, and `openclaw doctor`
does not migrate it. Open the updated iPhone and Watch apps to use the new
delivery protocol. See [Watch voice and chat](/platforms/ios#apple-watch-voice-and-chat)
for delivery statuses and recovery.

The iPhone's existing `client-state.sqlite` owns `watch_message_journal`.
The named GRDB migration `client-state-watch-message-journal-v9` adds that table
and a nullable `watch_route_generation TEXT` column to
`gateway_routing_identity`. The generation changes after Forget and re-pairing;
a late callback or queued command from the old pairing cannot become new work.
Admission, accepted run identity and terminal receipt state share one journal
owner, separate from the general chat outbox.
The journal's nullable `command_fingerprint BLOB` stores SHA-256 of each
admitted command's canonical bytes. Dismiss preserves this hash, so reusing an
ID with changed content or submission time cannot return the original result
after its command text is cleared. The hash expires with the row or is removed
by Forget; legacy imports have no command fingerprint.
The migration is registered by shared Apple client storage, so the Mac client
also sees the additive schema; it does not process companion Watch delivery.

The additive `client-state-watch-message-legacy-receipts-v1` migration creates
`watch_message_legacy_imports`. It stores SHA-256 hashes of exact legacy command
IDs and imported content, never the text or Gateway ID. A nullable content hash
records the older app's ID-only recent-message suppression policy; it is not
proof of a matching body or successful execution.

Old Watch UserDefaults are decoded and reconciled in one SQLite transaction
whenever the phone prepares its journal. Imported rows and their hash receipts
commit together before cleanup checks that both source blobs are unchanged.
This also recovers messages written by an older app after downgrade. Unprovable
queued text becomes **Needs review**, never an automatic send. Conflicting IDs
or unseen messages associated with a previously forgotten Gateway preserve the
source and surface a recovery error instead of discarding or retargeting text.

Imported text remains until explicit discard or Gateway Forget. Its hash-only
receipt has no timed expiry and survives both actions, so an identical old
snapshot cannot resurrect deleted text. This storage grows per legacy ID and is
removed only by a full onboarding reset, which clears the old UserDefaults
before deleting client state. New commands and their reply replay instead have
an immutable 48-hour deadline. Dismiss hides a completed card without changing
its receipt, acknowledgment state or deadline; active deliveries cannot be
discarded or dismissed.
Expired copies are pruned when delivery state is next used, including opening
the phone's delivery list. An idle or suspended app does not promise immediate
wall-clock erasure.

The Watch owns its outbound commands and received results in its own SQLite
journal. A 90-second speech timeout does not remove this delivery state or
cancel the remote run. Both apps commit before issuing their application-level
admission or terminal receipt. A permanent rejection is explicitly not an
admission and creates no phone journal row. If dispatch became ambiguous before an accepted run was recorded,
recovery reports uncertainty rather than automatically executing the message
again. The phone retains its current WAL policy: this is app-termination
recovery, not a claim of power-loss durability.

Forget removes phone journal rows in the existing irreversible removal
transaction, including rows imported without a routing parent. The phone first
accounts for retained legacy source and refuses removal if that cannot be done
safely. The additive
schema leaves the old reader's explicit routing updates intact, and a deletion
trigger keeps its Forget path effective after downgrade. An older app cannot
offer the new receipt protocol. Do not remove migration markers or reset
`client-state.sqlite` to downgrade: that file also contains other user-owned
client state.

The [accepted design](https://github.com/openclaw/openclaw/issues/136617) records
the schema, migration, ownership, retention and validation boundaries.
