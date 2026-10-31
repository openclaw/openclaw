# Pairing allowlist read attribution

## Acceptance rule, registered before measurement

Use current-main source and an isolated Gateway with synthetic state, loopback
transports and bundled channel owners. Never read operator state or logs. The
first target is the remaining `channel_pairing_allow_entries` SELECT, observed
at 58.7 per 15 minutes after the iMessage lazy-read change.

Reuse `scripts/perf/plugin-state-polling.mts --messages 0 --seconds 60` for an
empty Reef inbox and `--messages 18 --seconds 60` for pending reviews. Use
`scripts/bench-ingress-polling.mts --idle-seconds 60 --sparse-events 0` for the
iMessage idle control. Count all-thread SQL, worker requests, and main-thread
SQL with the frozen v3.1.4 observer, verified against its frozen hashes. Keep
boot, the 40-second Reef settle window, steady state and shutdown separate.
Profile the real Gateway with `--cpu-prof` per thread. Report statements per
poll, per minute and per 15 minutes; record errors and unexpected relay calls.

Use `scripts/perf/pairing-channel-attribution.mts --channel <channel> --seconds 60
--ingress --profile` for Discord, Telegram, Slack, Signal, Matrix, Mattermost,
WhatsApp and Zalo through the existing synthetic Crabline transport. Keep boot,
60-second idle, a status RPC, ingress and shutdown separate. Configure pairing
with an empty allowlist before ingress; record setup failures separately from
zero reads. Injection alone is attribution, not proof of refused admission.

The same driver accepts `--channel msteams` through the existing local Bot
Framework QA adapter and private runtime preload, with the same phases and
pairing policy. The driver also accepts IRC (loopback TCP), Nostr (signed and
encrypted WebSocket events), Nextcloud Talk (signed webhook plus authenticated
local room API), and Feishu (HTTPS discovery plus native WebSocket with fixture
CA). LINE and SMS use signed ingress with an empty **allowlist** policy; this
narrower path avoids their fixed external challenge-reply endpoints. All use
synthetic identities and retain provider listeners until Gateway shutdown.
Google Chat and Zalo User have authentication boundaries that the credential-free
fixture cannot cross; report those gaps without weakening verification.

Inventory every bundled pairing consumer by channel, caller and trigger before
proposing a change. Distinguish source-only attribution and owner tests from
real-Gateway transport evidence; an unexercised channel is an explicit gap.

A proposed deletion must remove discarded work or reuse the existing owner's
recorded fact without weakening ingress admission, revocation, one-shot approval
consumption or external-effect authority. No schema, freshness probe, generation,
or new cache is authorized by this attribution task. Stop after posting the
measured attribution and design for coordinator approval.

After approval, require a count regression red on base, refused ingress after
allow-entry revocation, affected owner suites and PostgreSQL review. Counts use
three alternating baseline/candidate pairs when load is below 64 and internal
free space at least 12 GiB, otherwise one pair with the limit stated. A wall-time
or CPU-speed claim needs the timing lock, load below 24 and at least five
interleaved samples per arm, with cold/warm median, p95 and range separate.
Every user-facing metric must hold or improve; any adverse 20% cell stops the
change. Runtime MAIN must remain zero and total work must not increase.

After design approval, the Reef count target is two pairing SELECTs/requests
per 30-second tick becoming one (four/minute to two/minute). No production
change or measured saving is claimed by this preregistration.

## Approved cutover and deterministic owner proof

The October 25 design decision approved one invocation-local pairing inventory
inside the existing Reef friend-manager mutation lock. Reconciliation now owns
optional candidate surfacing. Both relay listings and fresh surface-phase trust
snapshots remain; the standalone surfacing method is removed. Every resolved
removal, including `false`, removes its entry from the local inventory. Current
one-shot consumption still gates relay acceptance and trust pinning; persisted
trust revisions and ingress authority remain unchanged.

The accepted edge is that approvals added after the initial inventory read may
wait until the next 30-second tick. Explicit approval notification reconciles
fresh. Other manager mutations queue through the second fetch and surfacing.

The empty and pending tick regressions failed on the original two-call lifecycle
with two pairing reads, then passed with one. Each retains two relay listings.
All 106 tests in the six affected Reef owner suites passed, including token/trust
revocation, revision-checked commits, independent relay objects and cancellation
of either relay fetch. Actual SQLite and PostgreSQL owner probes also passed for
empty, pending, accepted and revoked-token scenarios; PostgreSQL canonical schema,
migration and trigger conformance passed with zero unexplained differences.

This proves one fewer invocation of the unchanged pairing SELECT and state-read
worker request per tick. It does not measure whole-Gateway totals or latency.
The earlier channel matrix is diagnostic attribution only: 14 completed idle/status
windows, 13 completed injections and 11 pairing-mode ingress cases; LINE/SMS used
allowlist policy, Mattermost injection and Zalo readiness failed, and Google Chat
and Zalo User lacked authentication. Reconnect and active verification were not
covered. The deterministic-owner proof route applies while the supported
exact-head Gateway build fix is unmerged; no adapted build is acceptance evidence.
