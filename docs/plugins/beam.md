---
summary: "Publish coding sessions for shared viewing and live Team continuation"
read_when:
  - Sharing a Claude Code, Codex, or Grok Bot session with trusted Gateway operators
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

The `beam` skill in [openclaw/agent-skills](https://github.com/openclaw/agent-skills) handles local transcript discovery, redaction, Cloudflare Access login, and upload for Claude Code, Codex, and exported Grok Bot conversations.

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

`source` names the originating assistant. The Beam skill sends `claude`, `codex`, or `grokbot`. Beam stores that identifier in lowercase and returns it on the catalog session. The `/beam/<slug>` viewer and Team continuation follow the same path for every source. A mirrored catalog sends its catalog id instead, so the field stays a short identifier rather than a closed list of product names. Missing values, spaces, slashes, and identifiers longer than 32 characters are rejected. Grok Bot is not a local session catalog, so `mirror.catalogs` does not include `grokbot`.

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
- It accepts text-only normalized transcript items, not HTML, scripts, archives, attachments, or server-fetched URLs.
- The official skill removes raw tool results, reasoning, prompts, local paths, credentials, cookies, and auth material before upload.
- The receiver treats every transcript as untrusted text. The first message in the Beam composer is the explicit operator action that copies it into a new session.
- Requests are rate-limited and concurrency-limited before the body is read.

## Mirroring

Beam can also act as the sender: an opt-in mirror that continuously publishes this machine's active local coding sessions (Claude Code, Codex, and other registered session catalogs) to a remote Beam receiver, such as a shared team Gateway. Teammates then watch near-live session transcripts in the remote Control UI without any access to the source machine.

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

- `endpoint` (required): the final remote receiver URL. Changing it starts fresh delivery to that receiver, including unchanged active sessions; pending terminal retries for the previous receiver are discarded, leaving its rows to expire normally. Redirect responses (301, 302, 303, 307, and 308) are not followed; configure the destination URL directly. After a redirect, repeated polls are suppressed for the current mirror service instance. A Gateway restart checks the configured endpoint once again so a receiver corrected at the same URL can recover. HTTPS is enforced for non-loopback hosts; plaintext `http://` is accepted only for `localhost`/`127.0.0.1`/`::1` development.
- `token`: Gateway credential for the remote receiver, sent as `Authorization: Bearer`. Accepts a plain string or a secret reference; the Gateway prepares secret references before the mirror starts, rather than resolving them on every poll. An unavailable configured token disables only outbound mirroring; the receiver and session catalog remain available. After restoring the credential, run `openclaw secrets reload`. Omitting `token` still supports receivers that do not require a bearer credential. Deployments fronted by an identity-aware proxy need an ingress that accepts this bearer credential.
- `catalogs` (required): the session catalog ids to mirror, as explicit per-catalog consent — an omitted or empty list mirrors nothing. The local `beam` receiver catalog is always excluded so two mirrored Gateways cannot re-mirror each other's rows.
- `pollSeconds` (default 30, minimum 10): how often the mirror scans local catalogs.
- `activeWindowMinutes` (default 180): sessions with newer activity than this window count as live and stay mirrored; when a session goes idle past the window the running mirror service retries its final `completed` update until the receiver accepts it or the seven-day retention window ends. Retry state is process-local: a Gateway restart clears pending terminal retries, so the remote row remains live until its normal seven-day retention expires.

The mirror uploads user and agent message text, replacing structured reasoning, tool calls, tool results, and raw payloads with compact counts. Titles and messages preserve their original text, including credentials, before clipping. `logging.redactPatterns` applies to logs and diagnostics, not mirrored content. The manual beam skill separately strips setup wrappers, local paths, contact identifiers, and opaque values; automatic mirroring does not apply those rules. Enable it only for catalogs whose visible message text you intend to share.

The mirror converts newest-first catalog pages into chronological uploads before applying the receiver limits (200 items, 56 KiB), dropping oldest entries first. It marks the upload `truncated` whenever older pages remain, the source reports truncation, or text or items were clipped. Claude catalog pages count individual text, reasoning, and tool blocks and bound their text size. Sessions on paired nodes are not mirrored; the mirror shares only sessions from this Gateway's machine, newest 32 first. A listed session that leaves the active window receives its final completed update even when its catalog has more pages; an absent session is finalized only after a complete, successful host listing.

When browsing Claude sessions on paired nodes, update those nodes alongside the Gateway. Older node builds without block-resume metadata report an update-required error when a mixed row spans pages.

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
