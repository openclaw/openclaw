---
summary: "Share selected OpenClaw sessions through paired nodes or outbound Gateway reads"
read_when:
  - Sharing personal OpenClaw sessions with a team Gateway
  - Pairing a node that exposes only session listings and transcripts
  - Configuring attribution for sessions from another Gateway
title: "Session Share plugin"
---

The bundled `session-share` plugin lets teammates read selected sessions from another OpenClaw Gateway in the Control UI. The source operator chooses session groups to publish and can narrow them by person. A node host on the source machine reads those sessions and connects to the receiver Gateway as a paired device.

Session Share is disabled by default. It publishes a read-only **OpenClaw sessions** catalog, not a second way to run agents on the source machine. For sanitized snapshots of external coding sessions without a paired node, see [Beam](/plugins/beam).

## Before you begin

Both machines need OpenClaw with the Session Share plugin. Run the source node host as the same OS user and with the same `OPENCLAW_STATE_DIR` and configuration as the source Gateway. Set `OPENCLAW_CONFIG_PATH` too when the source uses a custom config location. The node reads the configured `session.store`, including custom paths and per-agent templates. The receiver needs a reachable, authenticated Gateway endpoint and permission to approve device pairing.

Use the command allowlist below for a sessions-only connection. Without an allowlist, a normal node host can advertise other capabilities.

## Choose sessions on the source

Enable the plugin on the source and choose the exact session group names to publish:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: {
          share: { groups: ["Team"] },
        },
      },
    },
  },
}
```

In the source Control UI, move the sessions you want to share into the **Team** group. Group names match the session category exactly. To narrow those groups to sessions owned by or including a person as a participant, add the person's **full source-local profile ID**:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: { share: { groups: ["Team"], involvingProfileId: "<source-profile-id>" } },
      },
    },
  },
}
```

`share.involvingProfileId` matches the canonical human owner (including a trusted creator only when no owner is assigned) or a profile participant. A recorded mention alone never qualifies. This publication filter is distinct from Activity filters. Merged profile IDs resolve to the same person; personal hide/show choices do not change this selection. Names, email addresses, GitHub logins, shortened Activity URL IDs, remote attribution IDs, and unqualified channel sender IDs do not select a person. Unknown profile IDs publish nothing. There is no `involvingMe`: a source node has no authenticated viewer to bind it to.

A valid, nonempty `share.groups` selection is always required. The optional person selector combines with groups using **AND**: the session must be in one of the exact `groups` **and** match the selected owner or participant. Group names within `groups` combine with **OR**. Missing, empty, or malformed groups publish nothing, including with a person selector. Removing `involvingProfileId` while retaining groups intentionally returns to group-only publication; an empty or malformed person value publishes nothing.

Subagents, incognito sessions, drafts, and adopted rows from other session catalogs are never published, even when they belong to a selected group. This also excludes named or resumed sessions with recorded spawn lineage; a user-created fork remains eligible.

With the default hybrid reload mode, the source Gateway applies plugin configuration automatically. Start or restart the source node host after changing plugin configuration. Changing filters or removing a session's matching group or person involvement revokes new and in-flight transcript reads; a receiver that already read text may retain that text.

## Outbound Gateway pull

A receiver can initiate an outbound WSS connection to a source Gateway instead
of accepting an inbound source node. No listener or tunnel is added on the
receiver. On the source, opt in with `share.gateway: true`, select `share.groups`,
and set `share.involvingProfileId`. Add the exact approved reader device IDs to
`share.gatewayDeviceIds`. Missing or empty device grants publish nothing over
Gateway RPC. The device reads sessions matching both the groups and canonical
person; it does not become that person. Requests cannot change these filters.
Merged profile IDs remain supported; unknown or removed people publish nothing.

On the receiver, configure a source under `gateways`:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: {
          gateways: {
            team: {
              url: "wss://team.example.com",
              label: "Team",
              deviceIdentityKey: "session-share:team",
              deviceToken: { source: "env", provider: "default", id: "TEAM_DEVICE_TOKEN" },
              cloudflareAccess: {
                clientId: { source: "env", provider: "default", id: "TEAM_ACCESS_ID" },
                clientSecret: { source: "env", provider: "default", id: "TEAM_ACCESS_SECRET" },
              },
            },
          },
        },
      },
    },
  },
}
```

Credentials must use SecretRefs and remain on the receiver Gateway. The client
requests exactly `operator.session-share.read` and does not modify shared device-auth
storage. Preprovision a dedicated named, non-primary device identity and approve
its exact singleton publication-read token through the source's existing device
pairing owner. Broad operator tokens are rejected even when the client requests
only the publication scope. Do not reuse a human operator's device identity:
the device store keeps one token per role.

`deviceIdentityKey` selects that existing identity from the receiver's credential
store. Missing identities fail closed; this feature creates no identities,
pairing requests, or credentials and never falls back to the primary identity or
cached operator token. A Cloudflare service token admits the WSS connection at
the edge; it does not authorize OpenClaw session access. Both layers must succeed.

Changing the source URL, identity selector, credential references or their provider
configuration retires that outbound connection until the service restarts.
Unrelated configuration reloads do not retire it. Source filter/device-grant and
token changes are checked before disclosure; an already delivered transcript
cannot be recalled.

Gateway sources appear alongside paired nodes in the existing read-only session
catalog. Each catalog poll requests a fresh filtered page from the source.
Reads recheck the same source group and canonical-profile boundary. Disconnects,
reconnects, and configuration replacement invalidate in-flight replies. These
connections expose no steering or other mutation operation.

## Enable the receiver and pair the source

On the receiver Gateway:

```bash
openclaw plugins enable session-share
openclaw devices join-code
```

The enable command applies the running Gateway's plugin lifecycle without restarting it. Keep the join URL private. On the source machine, use that URL with exactly the two read-only commands:

```bash
openclaw connect <join-url> --service \
  --commands openclaw.sessions.list.v1,openclaw.sessions.read.v1
```

Omit `--service` to run in the foreground. With `--service`, the allowlist is saved in the source node's durable machine state and remains in effect when the service restarts.

Approve the source device on the receiver:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw nodes list
```

Check that the pairing request and connected node declare only `openclaw.sessions.list.v1` and `openclaw.sessions.read.v1`, with the `openclaw-sessions` capability. The catalog only recognizes nodes advertising both commands. See [Connect](/cli/connect) for join-code expiry and [Nodes](/nodes#restrict-the-node-command-surface) for the command allowlist.

## Read shared sessions

Open the receiver Control UI. Shared rows appear under the source node's heading in **OpenClaw sessions**. Selecting a row opens its transcript view-only. Only user and assistant conversation text is shared. Thinking, tool calls, and tool results are omitted. The receiver cannot continue, archive, or open a terminal for that session.

Publication is shared with the receiver's permitted viewers, not just the named owner. Viewers need `operator.read`; on role-restricted Gateways, their profile's role must also permit viewing others' sessions (`sessions.others: "view"`, `"suggest"`, or `"write"`). Owner-only and unprofiled restricted viewers cannot see published rows. See [Operator scopes](/gateway/operator-scopes).

The catalog refreshes by polling, not a live transcript stream. The source node must remain connected for listings and reads. Long transcripts are paginated; individual text fields are clipped when necessary and are not secret-masked.

Catalog listings, searches, and pagination refresh one complete snapshot per requested paired node before publishing rows. Concurrent requests share an in-flight refresh. The receiver retains at most 32 node snapshots and runs at most four refreshes concurrently. Discovery alone does not invoke nodes. At capacity, a new host returns a loading result immediately. A later catalog request can admit it after work settles and an idle, less recently requested snapshot can be replaced. Background refreshes run every 30 seconds, with one refresh at a time per node and a five-minute budget for all source pages (at most 30 seconds per invocation). A snapshot is limited to 10,000 sessions and 16 MiB of serialized pages. Exceeding either limit fails the refresh explicitly without publishing a partial catalog; reduce the shared groups on the source node. Failed background refreshes back off from 30 seconds to at most five minutes. An explicit catalog request starts a fresh read; transcript reads always recheck sharing on the source.

Progressive callers receive a loading host immediately, followed by the completed snapshot through the catalog's normal host update. Other callers wait for the refresh. Previous rows are withdrawn while refreshing and after failure. **Show more** rechecks the entire expanded window; a failed refresh offers **Retry** without expanding it further. Configuration changes, observed node disconnections or reconnections, and service retirement invalidate snapshots and pending publications. The receiver checks node connections during catalog requests, background discovery, and before publishing a refresh. There is no remote share-change subscription: source changes reach the receiver on its next refresh. Updating the receiver requires no configuration or stored-state migration.

The source reads its session metadata inventory in a background worker and reuses it across pages and refreshes while the database revision is unchanged. Writes from the source Gateway, database replacement, and configuration changes invalidate that inventory. Every page still prepares current creator identities and rechecks whether its selected sessions remain shared before publication.

Listings leave cold transcript archives untouched and use any stored title metadata. To read cold history, open the session on the source Gateway first so its normal history owner restores the archive. Each source page also bounds raw transcript reads to 8 MiB; a single larger entry returns an explicit error instead of being silently skipped. Inspect that entry on the source Gateway.

## Attribute the source node

Receiver-side identity settings are optional and keyed by the node ID shown by `openclaw nodes list`:

```json5
{
  plugins: {
    entries: {
      "session-share": {
        enabled: true,
        config: {
          nodes: {
            "<nodeId>": {
              owner: "github:octocat",
              linkGitHubIdentities: true,
            },
          },
        },
      },
    },
  },
}
```

`owner` accepts `github:<login>` or `profile:<profileId>`. A GitHub login resolves case-insensitively to a local profile with a verified GitHub identity. The bound owner provides default attribution when a row has no portable human creator; it does not overwrite a portable human identity or grant ownership-based access.

`linkGitHubIdentities` defaults to `false`. When enabled, remote creators and message senders with a verified numeric GitHub account ID are displayed as the receiver's local profile with the same verified account ID. Login text alone is not enough to link a remote sender. Unmatched identities remain remote with their display labels.

Without node-specific settings, attribution stays remote. Source-local profile IDs are namespaced as remote identities, never interpreted directly as profiles on the receiver. Source and receiver settings may coexist in one plugin configuration.

## Security boundary

The source chooses what to publish; the receiver trusts the paired device for the identity claims attached to that publication. Attribution is display metadata and never grants access.

With the two-command allowlist, the node exposes no shell execution, filesystem browsing, terminal uploads, plugin tools, MCP servers, skills, worker hosting, or computer use. Both commands are read-only, and every transcript read rechecks whether the session is still shared. The receiver does not need access to the source Gateway's HTTP endpoint or authentication credentials.

Sharing a session exposes its user and assistant conversation text and catalog metadata, which may include workspace paths or branch names. Included text is not secret-masked. Review credentials and other sensitive content before publishing. Choose publication filters deliberately and treat received transcripts as untrusted text.

## Troubleshooting

To undo the sessions-only setup, use `openclaw node run --all-commands` in the foreground or `openclaw node install --force --all-commands` for the service; this forgets the saved allowlist and restores the full default node surface.

**The source node fails with no allowed commands**

Enable `session-share` on the source, set a non-empty `share.groups` and optionally an exact `share.involvingProfileId`, restart the node host, and check the exact command IDs. Unknown or unavailable commands are not advertised.

**The node connects but no OpenClaw sessions host appears**

Enable the plugin on the receiver and confirm that it applied. In `openclaw nodes list`, the source must declare both session commands and be approved for them.

If node discovery fails, the catalog reports the error instead of an empty listing. Check the receiver's node connection and retry the catalog; other session catalogs remain available.

**The host appears but a session is missing**

Check its group and canonical person involvement on the source, the exact selector values, and whether it is a subagent, incognito, a draft, or adopted from another catalog. Subagent keys and recorded spawn lineage stay excluded even if the session was previously visible. Verify that the source node uses the same user and state directory as the source Gateway. On a role-restricted receiver, check the viewer's profile and permission to view others' sessions.

**A transcript read fails after a row was visible**

Refresh the catalog. The source may be offline, the session may have been deleted, or it may no longer match the publication filters. Reconnect the source node for an offline-host error; do not broaden its command allowlist.

**Catalog refreshes sometimes take 30 seconds**

When receiver diagnostics and warning logs are enabled, `gateway/session-catalog` logs refreshes that take at least one second, at most once per minute. Progressive callers see a loading host while these refreshes run. A `TIMEOUT` with `nodeCommandDispatched: false` occurred before dispatch; `true` means the receiver dispatched the command, so inspect the source node and its connection. It does not prove that the source handler started. An absent field leaves dispatch unknown. These records include bounded node error codes and durations, without node identifiers, request parameters, or error messages.

**Names do not link to local profiles**

Check the configured node ID and `linkGitHubIdentities`. Both profiles need the same verified numeric GitHub account ID; matching names or unverified logins do not link them.

## Related

- [Connect a node](/cli/connect)
- [Node command allowlists](/nodes#restrict-the-node-command-surface)
- [Multiplayer](/start/multiplayer)
- [Beam](/plugins/beam)
- [User model](/concepts/user-model)
