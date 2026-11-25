---
summary: "Publish coding sessions for shared viewing and live Team continuation"
read_when:
  - Sharing a Claude Code or Codex session with trusted Gateway operators
  - Continuing a beamed conversation with a Team agent
  - Configuring an authenticated session-ingest endpoint without connecting a node
  - Auditing what Beam stores and exposes
title: "Beam plugin"
---

The bundled `beam` plugin receives a sanitized coding-session snapshot over authenticated HTTP and presents it in the Control UI's existing external-session catalog. The source computer sends text out; OpenClaw never connects back to that computer and receives no filesystem, terminal, tool, or node capability.

Beam ships with OpenClaw but is disabled by default. When enabled, it registers:

- `POST /api/v1/beam/sessions`
- the **Beam** session catalog in the Control UI sidebar

## Enable

```bash
openclaw plugins enable beam
```

Enablement applies to a running Gateway automatically. If it is offline, start
it to use Beam. See [Apply changes and inspect](/plugins/manage-plugins#apply-changes-and-inspect).

Before configuring an outbound mirror, check the installed cleaner:

```bash
openclaw beam doctor --json
```

The command verifies the native cleaner for this machine and exits with status
1 if the executable is missing or fails verification. Receiving and viewing
snapshots work independently of the sender's cleaner.

Equivalent config:

```json5
{
  plugins: {
    entries: {
      beam: { enabled: true },
    },
  },
}
```

Disable the plugin when the ingest route is not needed:

```bash
openclaw plugins disable beam
```

## Authentication

The receiver uses normal Gateway HTTP authentication. It is not an anonymous upload endpoint.

- With `gateway.auth.mode: "trusted-proxy"`, send requests through the configured identity-aware proxy. Beam records the verified uploader's OpenClaw profile ID, when available; it does not retain proxy identity headers or credentials.
- With token or password auth, send `Authorization: Bearer <gateway-token-or-password>`.
- Do not enable Beam with `gateway.auth.mode: "none"` unless another private ingress fully authenticates every request.

A Cloudflare Access-protected deployment can authenticate a local CLI without exposing a GitHub token:

```bash
cloudflared access login https://gateway.example.com
cloudflared access curl https://gateway.example.com/api/v1/beam/sessions \
  -H 'Content-Type: application/json' \
  --data-binary @sanitized-beam.json
```

The `beam` skill in [openclaw/agent-skills](https://github.com/openclaw/agent-skills) handles local transcript discovery, redaction, Cloudflare Access login, and upload for Claude Code and Codex.

## Request

```http
POST /api/v1/beam/sessions
Content-Type: application/json
```

```json
{
  "version": 1,
  "beamId": "0123456789abcdef0123456789abcdef",
  "source": "claude",
  "sourceModel": { "provider": "anthropic", "model": "claude-opus-4-1" },
  "title": "Fix the upload flow",
  "updatedAt": "2026-07-20T12:00:00.000Z",
  "completed": false,
  "items": [
    { "type": "userMessage", "text": "Fix the upload flow." },
    { "type": "agentMessage", "text": "Implemented and tested." },
    { "type": "other", "text": "3 read, 2 write, 1 execute; raw tool outputs dropped: 4" }
  ]
}
```

Send `items` in conversation order, oldest first. Beam preserves that order in storage and displays questions before their replies. Its session-catalog API returns newest-first pages, matching the other coding-session catalogs.

The schema is closed. Beam rejects unknown fields, invalid item types, empty text, more than 200 items, item text over 6,000 characters, non-JSON requests, and bodies over 56 KiB.

A successful upload returns the stable Beam id and a relative Control UI URL:

```json
{
  "ok": true,
  "publicationId": "abcdef0123456789abcdef0123456789",
  "beamId": "0123456789abcdef0123456789abcdef",
  "url": "/beam/fix-the-upload-flow-0123456789ab"
}
```

Restricted Visitor uploads additionally return `"canView": true`: the current publishing Visitor can open their own retained snapshot while their invitation remains active. The URL is not public access or authorization, and other guests cannot use it to read the snapshot. Other successful receipts may omit `canView`.

The returned URL uses the session title slug followed by a 12-character lowercase
hexadecimal id prefix, matching regular session links. The id remains authoritative:
bare-id links and links with an older title still resolve, and the browser replaces
the name with the current title without adding history. Titles that produce no slug
use the bare id. A configured Control UI base path prefixes the route, for example
`/openclaw/beam/fix-the-upload-flow-0123456789ab`. Longer prefixes through the full
32-character Beam id also work. Named links shipped in the 2026.8.2 receiver;
update the Beam skill before updating the receiver so its response validator
accepts them.

Uploading the same `beamId` updates the existing catalog row when its `updatedAt` is newer. Equal-timestamp uploads may refresh the same state or mark a live row completed, but cannot regress a completed row to live. Older uploads and equal-timestamp completion regressions still return the normal `200` success response, but OpenClaw ignores them. Only accepted updates refresh retention and uploader attribution.

`sourceModel` is optional. Automatic mirrors include the latest model reported by the source catalog. Older clients and snapshots remain valid without it.

## Read a portable snapshot

Authenticated clients can discover the receiver with `GET /api/v2/beam/capabilities`.
Use the advertised operations for the current caller. An operator can read the
shared snapshots. A verified Visitor with a current invitation can read their
own publications. The Gateway checks access when each read starts. A read already
in progress can finish after an invitation changes. The next read uses the new
access decision.

For a known full Beam ID, request `GET /api/v2/beam/snapshots/{beamId}/head`.
It returns a strong ETag in `revision`, a SHA-256 `digest`, and, for a publication
with an assigned generation, an opaque `publicationId` and relative `apiUrl`.
Append `/snapshot` to that machine link to read the chronological v2 packet.
Resolve links against the exact request URL so a reverse proxy can mount the
Gateway under a path. For example, `../../publications/{id}` returned by
`/team/api/v2/beam/snapshots/{beamId}/head` resolves under `/team/api/v2/beam/`.
An independently configured Control UI base such as `/console` appears in
the view link under `/team/console/`.

Rows from receivers that predate publication generations return `legacy_unbound`
and a `snapshotUrl`. Read it with `If-Match` set to the advertised revision.
Receiver reads never assign a generation or claim an ownerless row.

The `Beam-Digest` response header covers the exact JSON bytes. Opening a link
performs a read only. A link to a deleted generation cannot read a later
publication with the same Beam ID.

### Publish a portable packet

Send the reviewed v2 JSON bytes unchanged with `PUT /api/v2/beam/snapshots/{beamId}`.
Provide a fresh UUID in `Idempotency-Key`. Create with `If-None-Match: *`, or replace
the selected revision with `If-Match`. The receipt returns the accepted digest and
`applied` or `unchanged`. Keep the UUID and original bytes when retrying the same
operation. A changed body or precondition with the same UUID returns a conflict.
The receiver keeps up to 10,000 write receipts for seven days. A restricted Visitor
can hold 400 receipts in that window. Replaying an accepted request uses its existing
receipt. At the Visitor limit, the receiver returns the seconds until the earliest
receipt expires in `Retry-After`. Keep the same operation UUID for that retry.
Both API versions share the same per-IP upload limits.

An accepted v1 write may supersede a v2 revision even at the same source timestamp.
Inspect the current head on a precondition failure. Packet-local speaker labels
identify participants only within the imported packet and confer no Gateway identity.
The bundled receiver uses the [standalone Beam packet schema and validator](https://github.com/openclaw/beam/tree/a4272c5bde4e52cdf87a1534447a6b98f3fb4a7b/schema).

### Release the reviewed revision

Only the verified original publisher with current write permission sees `canRelease: true`.
Send `POST {apiUrl}/release` with the same strong `If-Match`, a fresh UUID in
`Idempotency-Key`, and `{"digest":"sha256:…"}` for the accepted bytes. The receiver
commits the release and its receipt together. Keep the operation UUID across timeouts.
An authorized retry of the same release can recover its receipt after the snapshot expires.

Read `GET {apiUrl}/destination` to inspect the bound conversation. An unbound
release can create a destination while the snapshot is retained. A missing or changed
destination requires reconciliation. A ready response contains an opaque reference
after the Gateway verifies ordinary read access and the original catalog binding.

### Send an instruction to the destination

After release, send `POST {apiUrl}/continue` with a new UUID in both
`Idempotency-Key` and `requestId`. Supply a nonempty `instruction` of up to
48 KiB and an optional `agent` when choosing the initial destination. The entire
request must fit the advertised HTTP body limit. Subsequent instructions use the
original destination and the Gateway's ordinary send authorization.

Read `GET {apiUrl}/requests/{requestId}` after a timeout. A `pending` receipt
means a claim exists. `accepted` means the Gateway accepted the turn. A
`needs_reconciliation` outcome requires inspecting the existing conversation.
Keep the original UUID. Outcome receipts last seven days. Each publication can
accept 2,048 distinct request IDs. Once full, open the bound Team conversation to
send further messages. Shared Gateway credentials use one common replay domain.
Verified person accounts have distinct replay domains.

## Continue on the Team Gateway

Publishing alone shares a read-only snapshot. To move the logical conversation, use the updated Beam skill's `handoff` command with the exact source session. The sender durably retires that Beam identity before network dispatch, obtains the receiver's `publicationId`, and explicitly releases that generation with `handoffId`. Release requires the original verified publisher; shared-token and older ownerless snapshots cannot be claimed through this route. A lost acknowledgment can retry the same generation but cannot recreate an expired publication.

After release, send a message in the Beam composer or use the skill's `continue` command with your existing authenticated remote OpenClaw profile. The first continuation binds one ordinary Team conversation for the selected agent. Its bounded, sanitized source history seeds the conversation once. New messages run there with the destination's own account and tools. The source runtime session ID does not need to survive this handoff.

Reopening the original Beam link resolves the existing conversation through a read-only lookup, subject to current publisher access and ordinary destination read permissions. Retrying continuation uses that same logical conversation. Neither path imports history again or chooses another agent. Released sources reject later snapshot writes with `409` and an ownership receipt, without changing history or extending retention. Source Beam `read` and `continue` commands route to the authoritative Team conversation through normal authentication. Beam does not stop the original local harness; independent local turns after release are not Team turns.

Model preferences resolve through the destination's configured aliases and provider-declared model/version equivalence. OpenClaw selects the available canonical destination model under normal policy. An unavailable preference leaves model selection unset so the destination's configured default resolves normally. Source credentials and account selections never transfer. A denied destination model or expired authority cannot grant access through this handoff.

Copied history remains untrusted reference material. Only new operator messages authorize actions. Initialization errors are visible. A proven pre-commit failure or completed rollback may retry the same destination; uncertain, pending, deleted or mismatched destinations require reconciliation instead of silently creating another conversation.

## Storage and visibility

Beam stores sanitized payloads in OpenClaw's shared SQLite-backed plugin state:

- at most 500 sessions
- seven-day retention refreshed by each accepted update
- oldest-entry eviction for staff uploads when the catalog reaches its bound
- at most 20 live rows per verified publisher for restricted Visitor creation; existing owned rows can still be refreshed
- restricted Visitor creation is rejected at the shared 500-row cap, rather than evicting an existing snapshot
- server receipt time controls catalog ordering; clients cannot move themselves ahead with a forged timestamp

Ownership release and destination binding persist separately as SQLite-backed plugin metadata, without retaining transcript items. Snapshot expiry, eviction and archive cannot restore source ownership or allocate a replacement destination. After a destination exists, the Beam link can resolve it after snapshot removal. A snapshot that expires before destination creation cannot be imported later; the source remains retired and needs reconciliation. Retention does not bypass invitation or destination access checks.

The sidebar reuses an in-memory metadata inventory rather than loading every
transcript on each poll. Uploads and deletions invalidate that inventory immediately;
the next list shares one reload from the store. A plugin service preloads the inventory
and refreshes it every 30 seconds to pick up changes made by other processes.
Expired entries are hidden on every list. Transcript reads and continuation always
read the underlying store. No stored-data migration is needed on update.

The catalog is intentionally shared across the Gateway operator domain. Every client with `operator.read` can view every beamed session. Staff with `operator.write` or `operator.admin` can upload and update any row. Shared-catalog continuation requires staff write access. The original restricted publisher can also continue their own Beam through the returned link, subject to their current Visitor grant and the normal Team session-creation and agent policies.

A restricted guest with `operator.sessions.write`, a durable verified OpenClaw profile, and a current Visitor Access invitation can publish a new row or refresh only a row they initially published. The receiver records the immutable initial publisher separately from mutable uploader attribution; neither field is accepted from the request body. Staff updates preserve that owner. Older live rows without an initial publisher cannot be claimed by a guest, even when their uploader attribution matches. Deletion or expiry ends that retained row; re-upload creates a new row under the normal creation rules.

Guest publication does not grant shared catalog listing, foreign or ownerless snapshot access, or deletion. The returned Beam link uses separate `beam.owned.list`, `beam.owned.read`, and `beam.owned.continue` methods, admitted with the existing `operator.sessions.write` scope and a current verified Visitor grant. They expose only rows whose immutable initial publisher matches the authenticated profile and omit uploader profile attribution. The publisher can type and send directly on that page: the first send transparently adopts the retained snapshot into a normal Team session through the same continuation owner as the shared catalog. The source remains unchanged, failed adoption keeps the draft, and subsequent chat uses ordinary Team session permissions. This narrow source access grants no Home access. Staff continue using the shared operator catalog. Current identity, role, transport, and the original Visitor grant are rechecked after awaited work and at state-write admission. Revoking and reinviting a visitor cannot revive an in-flight request captured under the old grant. Ownership and both creation quotas are checked in one worker-owned state transaction. Limit refusals return `429`; foreign or ownerless retained-row updates return `403`. Stale uploads to an owned row keep the normal success receipt without refreshing retention.

Uploader attribution alone does not change access. OpenClaw operator scopes are not tenant isolation; use a separate Gateway when sessions must be isolated between teams or machines.

Ownership needs no SQL schema migration or backfill. Older retained rows remain ownerless. Rolling back to an older receiver restores its staff-only upload behavior; an accepted upload by that older receiver can discard the new ownership field. After upgrading again, those ownerless rows remain unavailable for guest refresh until deletion or expiry permits a new row. Rollback does not change the seven-day retention or staff eviction policy.

The bound conversation belongs to its authenticated creator and follows ordinary session sharing, sandbox, tool, and model policy. Source publication ownership does not grant destination membership. Deleting or expiring an unreleased publication ends discovery through its Beam link; re-uploading creates a new publication lifecycle. Once released and bound, the retained binding keeps the Beam link pointed at the same authorized conversation even after snapshot deletion or expiry, and further source uploads remain rejected. Deleting the snapshot never deletes the destination conversation.

User turns are attributed to the verified publisher of the current snapshot, using their current profile name and avatar, including merged profiles. Beam's upload format does not identify individual authors within a multi-user transcript. The uploader reference shares the snapshot's seven-day retention and is replaced on each upload. Shared-token uploads, failed profile resolution, and older snapshots without a recorded uploader display **User**; they never inherit the viewer's identity or a previous uploader's identity. Reupload an older snapshot through personal authentication to attribute it.

### Delete

Any operator with `operator.write` can delete a Beam from its sidebar row menu.
After confirmation, the sidebar hides the row while deletion finishes. If deletion
fails, the row returns and an error appears. Successful deletion is permanent.
For an unreleased source, re-uploading the same `beamId` recreates the
row, whether through the manual skill or a still-active mirror's next upload.
Mirrors skip unchanged snapshots, so recreation does not necessarily happen on
the next poll. A released source cannot be recreated by uploading. Deleting its snapshot preserves the conversation binding and does not delete the destination conversation.

## Security boundary

Beam publication is not remote control.

- The logical conversation continues in a Gateway-owned session. Beam itself has no filesystem, terminal, tool, or node capability.
- Transcript items contain normalized text. A v2 publisher can also include one reviewed PNG by sending its bytes in the [screenshot envelope](#share-a-screenshot).
- The official skill removes raw tool results, reasoning, prompts, local paths, credentials, cookies, and auth material before upload.
- The receiver treats every transcript as untrusted text. The first message in the Beam composer is the explicit operator action that copies it into a new session.
- Requests are rate-limited and concurrency-limited before the body is read.

## Mirroring

Beam can also act as the sender: an opt-in mirror that continuously publishes this machine's active local coding sessions (including Claude Code and Pi sessions with a verified local source) to a remote Beam receiver, such as a shared team Gateway. Teammates then watch near-live session transcripts in the remote Control UI without any access to the source machine.

```json5
{
  plugins: {
    entries: {
      beam: {
        enabled: true,
        config: {
          mirror: {
            endpoint: "https://team.example.com/api/v1/beam/sessions",
            token: { source: "env", provider: "default", id: "BEAM_TEAM_TOKEN" },
            catalogs: ["claude", "codex"],
          },
        },
      },
    },
  },
}
```

- `endpoint` (required): the final remote receiver URL. Changing a v1 endpoint starts fresh delivery to that receiver, including unchanged active sessions. Pending v1 terminal retries for the previous receiver are discarded, leaving its rows to expire normally. A new v2 endpoint requires its own explicit enrollment. Redirect responses (301, 302, 303, 307, and 308) are not followed; configure the destination URL directly. After a redirect, repeated polls are suppressed for the current mirror service instance. A Gateway restart checks the configured endpoint once again so a receiver corrected at the same URL can recover. HTTPS is enforced for non-loopback hosts; plaintext `http://` is accepted only for `localhost`/`127.0.0.1`/`::1` development.
- `token`: Gateway credential for the remote receiver, sent as `Authorization: Bearer`. Accepts a plain string or a secret reference; the Gateway prepares secret references before the mirror starts, rather than resolving them on every poll. An unavailable configured token disables only outbound mirroring; the receiver and session catalog remain available. After restoring the credential, run `openclaw secrets reload`. Omitting `token` still supports receivers that do not require a bearer credential. Deployments fronted by an identity-aware proxy need an ingress that accepts this bearer credential.
- `catalogs` (required): the session catalog ids to mirror, as explicit per-catalog consent — an omitted or empty list mirrors nothing. The local `beam` receiver catalog is always excluded so two mirrored Gateways cannot re-mirror each other's rows.
- `pollSeconds` (default 30, minimum 10): how often the mirror scans local catalogs.
- `activeWindowMinutes` (default 180): sessions with newer activity than this window count as live and stay mirrored; when a session goes idle past the window the running mirror service retries its final `completed` update until the receiver accepts it or the seven-day retention window ends. The v1 mirror keeps terminal retries in memory. After a Gateway restart, an undelivered v1 row remains live until its normal retention expires. The v2 mirror retains the confirmed enrollment and its pending update in SQLite. After restart, it reselects the authorized source and retries the original request.

The v1 mirror keeps the original publication ID when the producer confirms that host and thread identify the same native session across agents and source homes. Every read stays bound to the selected agent and home. Conflicting selections, rebindable aliases, imported copies, and unclassified sources require explicit selection. A previously released publication stays released.

The upload keeps its original v1 publication ID across upgrades. Claude and Pi reads bind to one selected local file and skip conflicting IDs. A Codex home can move between historical aliases. Use explicit v2 enrollment for automatic updates to a new independent Codex publication.

The mirror sends visible user and agent messages through the packaged native Beam cleaner. Tool calls, tool results and reasoning contribute counts only. Titles and text use the same redaction as standalone Beam. If the cleaner is missing or fails, the mirror withholds the upload. Source and participant identifiers stay on the sending machine. V2 packets carry packet-local speaker aliases.

### Enroll a v2 publication

For a Codex source, install the official Codex plugin on the source Gateway with `openclaw plugins install codex`. The plugin registers the `codex` catalog and uses its managed app-server to read native threads. The receiving Gateway needs only its bundled Beam plugin enabled. See [Codex harness setup](/plugins/codex-harness).

Set the mirror endpoint to the Team Gateway's final `/api/v2/beam` URL and add the source catalog to `mirror.catalogs`. Its authenticated capabilities must advertise both `publish` and `release` for the configured publisher. A shared write-only credential or a receiver without publisher-specific release support cannot enroll a mirror. List native sources with the authenticated `sessions.catalog.list` Gateway method. As an administrator on the **source Gateway**, explicitly create an independent publication with the selected row's five identifiers:

```bash
openclaw gateway call beam.mirror.enroll --params '{"source":{"catalogId":"codex","hostId":"gateway:local","threadId":"NATIVE_THREAD","agentId":"main","sourceHomeId":"SOURCE_HOME"}}'
```

A successful response contains the Beam ID and the receiver-issued `head.publicationId` and `head.revision`. Use this publication ID as `confirmGeneration` when confirming an enrollment. Later service polls update only this generation. The source retains its enrollment, receipts and an unacknowledged update in plugin SQLite across restarts and disable/re-enable. Released publications and generation conflicts remain fenced.

When the receiver bearer token rotates, configure the new token for the same publisher and reload secrets. Repeat `beam.mirror.enroll` with the original `source` and its stored `confirmGeneration`. The receiver must prove this credential owns the still-writable generation. Reauthorization reads its head and updates the local credential binding. Pending writes keep their original request and precondition. A teammate, released generation, or different receiver leaves the binding unchanged. Cloudflare Access credentials supplied separately by a gateway-side proxy can rotate at that proxy without changing the Beam bearer binding.

If the first response was lost, repeat the command to see its unconfirmed Beam ID and expected digest. Inspect the publication and its generation on the intended Team Gateway. To adopt that existing publication, explicitly repeat enrollment with its exact `confirmGeneration` next to `source`. A missing row, mismatched digest or differing generation leaves the source unconfirmed. The service never retries an initial create.

The mirror converts newest-first catalog pages into chronological uploads before applying the receiver limits (200 items, 56 KiB), dropping oldest entries first. It marks the upload `truncated` whenever older pages remain, the source reports truncation, or text or items were clipped. Claude catalog pages count individual text, reasoning, and tool blocks and bound their text size.

The mirror shares sessions from this Gateway’s machine. The v2 poller rotates through acknowledged enrollments and reselects each exact source locally. Each poll can update up to 32 active and 32 completed sessions. An unacknowledged update keeps its original request and can be retried after restart even when the source has gone idle. Older enrollments acquire their local locator as the service pages through eligible sources. The v1 poller selects the newest 32 active sessions and finalizes an inactive session after confirming its exact source.

When browsing Claude sessions on paired nodes, update those nodes alongside the Gateway. Older node builds without block-resume metadata report an update-required error when a mixed row spans pages.

## Share a screenshot

With a Beam CLI that supports screenshot publishing, send a reviewed v2 packet and one PNG through the same Gateway link:

```sh
beam bundle create task.beam.json --attach screenshot.png --out task.beam.zip
beam share task.beam.zip --to https://gateway.example
```

Open the returned snapshot link to view or download the image. The Gateway advertises `publishScreenshot` only to callers with publishing access. Each PNG can contain up to 512 KiB and 16,777,216 pixels. The screenshot is part of the reviewed publication and retains its original metadata. Its visibility and seven-day lifetime follow the snapshot. Sharing the packet alone removes the screenshot. Handing off the same packet keeps the existing preview. Pull and continuation use the original text packet.

## Troubleshooting

**`404 Not Found`** The Beam plugin is disabled, runtime application failed, or the request is reaching another Gateway. Check the enablement result and [inspect the plugin](/plugins/manage-plugins#apply-changes-and-inspect).

**`401 Unauthorized`** The request did not satisfy Gateway HTTP auth. Check the bearer credential or trusted-proxy/Access session.

**`405 Method Not Allowed`** The receiver accepts only `POST`.

**`413 Payload Too Large`** The serialized request exceeded 56 KiB. The official skill drops older sanitized messages until the snapshot fits.

**`429 Too Many Requests`** The authenticated client exceeded the bounded request or concurrency limit. Retry after the current minute window.

**`beam mirror upload blocked ... receiver returned redirect`** The configured mirror endpoint returned a redirect. Beam does not follow redirects and suppresses repeated attempts for the current service instance; set `mirror.endpoint` to the final receiver URL. A Gateway restart checks the configured endpoint once again.

## Related

- [Control UI](/web/control-ui)
- [Control UI URLs](/web/urls)
- [Operator scopes](/gateway/operator-scopes)
- [Trusted proxy auth](/gateway/trusted-proxy-auth)
- [Plugin management](/plugins/manage-plugins)
