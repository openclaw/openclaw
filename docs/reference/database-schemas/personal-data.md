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

## iOS widget projection cache

The widget cache is a separate, reconstructible SQLite projection. Its storage
design was accepted on September 10, 2026 in
[the widget work](https://github.com/openclaw/openclaw/pull/142976).
This increment provides storage APIs only: no status population, lifecycle
call sites, widget provider, or control registration uses them yet.

The app is the sole writer. The extension's reader opens an existing database
read-only, without creating directories, changing permissions, taking the
canonical native-state handle lease, or repairing storage. The existing native
state schema, bootstrap allowlist, protection policy and handle lease are unchanged.

Admission rejects any `-wal` or `-shm` entry, including dangling links, before
opening or creating the cache. Each existing handle uses a private pager and
reads its 100-byte main-file header through SQLite's own file object before SQL.
An independent file descriptor is not used: closing one can release another
SQLite connection's POSIX locks. Only the known rollback-format header proceeds
to SQL schema and quota validation. These checks assume the sole writer never
converts journal mode or replaces a live cache; they do not prevent arbitrary
concurrent filesystem replacement. Local Apple SQLite 3.51.0 checks do not
qualify the unavailable iOS 18 runtime.

`WidgetCache/widget-cache.sqlite` belongs to the dedicated, build-specific
`group.<app-bundle-id>.widgets` App Group. It does not share the auth/identity
container or grant Keychain access. The app requests complete file protection
at SQLite creation and on the cache directory, excludes both directory and
database from backup, and uses DELETE journaling. Signed entitlement access,
locked-device reads and actual database/journal protection still require native
device proof.

Cache format 1 uses application ID `0x4F435743` and two STRICT tables:

- `widget_meta`: one writer epoch and monotonically issued publication ticket.
- `widget_snapshots`: selection and owner digests, admission ID, latest-issued
  ticket, admission/deadline times, payload byte count and a closed JSON payload.

Selection keys hash the exact UTF-8 Gateway/profile/agent/session/generation/run
tuple; hashes are lookup indexes, not authentication. Identifier byte limits
are 4096/512/64/2048/512/1024 respectively. JSON preserves escaped identifiers
without relying on SQLite C-string identity semantics. The payload contains
only agent/session/generation/run identity, a label bounded to 96 characters and
384 UTF-8 bytes, kind, state, source fact time and separate observation time.
No credentials, transcripts, message bodies, endpoint URLs or error details are
stored. Consumers must still authenticate the exact owner before publishing or
opening a native action.

All admitted rows, including unknown status, count toward 64 rows and 128 KiB
of actual encoded payload plus stored key bytes. Writes enforce both limits in
one immediate transaction, evicting the oldest admission first with selection
key as the tie-breaker. Readers check bounds before decoding. The 256-page,
4096-byte page ceiling bounds the database to 1 MiB; it is not a combined
database/journal/filesystem disk guarantee.

Admission fixes a 24-hour read deadline. A valid source fact may shorten it.
Polling, observation changes, unknown-to-known transitions and unrelated
invalidation never extend that deadline. Five minutes marks a fact stale for
presentation, not a refresh SLA. Expired rows are ineligible even while the app
is suspended; physical pruning happens only when the app runs.
The shared row decoder rejects negative admission times, nonpositive intervals
and persisted intervals longer than 24 hours for both read and write eligibility.
It does not clamp deadlines or physically delete rejected rows or files.

Before asynchronous work, the writer issues a persisted per-selection ticket.
Publication revalidates the complete epoch/admission/ticket/deadline permit
inside `BEGIN IMMEDIATE` and updates only an existing admission. A newer issued
ticket fences an older callback even before the newer result arrives.
Invalidation rotates the epoch and deletes affected rows atomically. Writer
reopen also rotates the epoch. Future Forget/reset/logout/revocation call sites
must invoke this owner before allowing replacement work; this cache does not
infer those events or fall back to the current conversation.

Unknown/newer formats, corruption, lock contention, permission failures and
ordinary I/O errors return unavailable without deletion. Reconstruction is
deferred until an owner can positively identify the cache and prove exclusive
recovery with every affected handle closed. No automatic reconstruction path
or compatibility importer is installed. Rollback leaves this dedicated cache
unused; never reset the canonical native database to repair a widget.
Invalidation does not promise immediate physical erasure or removal of OS-held
widget snapshots.
