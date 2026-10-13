---
summary: "Share selected OpenClaw sessions read-only with a paired team Gateway"
read_when:
  - Sharing personal OpenClaw sessions with a team Gateway
  - Pairing a node that exposes only session listings and transcripts
  - Configuring attribution for sessions from another Gateway
title: "Session Share plugin"
---

The bundled `session-share` plugin lets teammates read selected sessions from another OpenClaw Gateway in the Control UI. The source operator chooses session groups to publish. A node host on the source machine reads those sessions and connects to the receiver Gateway as a paired device.

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

In the source Control UI, move the sessions you want to share into the **Team** group. Group names match the session category exactly. An omitted or empty `share.groups` publishes nothing. Subagents, incognito sessions, drafts, and adopted rows from other session catalogs are never published, even when they belong to a selected group. This also excludes named or resumed sessions with recorded spawn lineage; a user-created fork remains eligible.

With the default hybrid reload mode, the source Gateway applies plugin configuration automatically. Start or restart the source node host after changing plugin configuration. Moving a session out of a shared group revokes new transcript reads immediately; a receiver that already read text may retain that text.

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

Catalog listings, searches, and pagination use one complete snapshot per requested paired node. The receiver retains at most 32 node snapshots and runs at most four refreshes concurrently. Discovery alone does not invoke nodes. At capacity, a new host returns a loading result immediately. A later catalog request can admit it after work settles and an idle, less recently requested snapshot can be replaced. The receiver refreshes it in the background every 30 seconds, with one refresh at a time per node and a five-minute budget for all source pages (at most 30 seconds per invocation). A snapshot is limited to 10,000 sessions and 16 MiB of serialized pages. Exceeding either limit fails the refresh explicitly without publishing a partial catalog; reduce the shared groups on the source node. A failed refresh backs off from 30 seconds to at most five minutes. Snapshots older than 60 seconds are unavailable until a refresh succeeds; transcript reads always recheck sharing on the source.

A cold listing returns an explicit loading host immediately. Progressive callers receive the snapshot through the catalog's normal host update; other callers can refresh the catalog. Unavailable or expired snapshots return no rows, including while a refresh is running. Warm callers receive a complete page from the snapshot without waiting for the source. Configuration changes, observed node disconnections or reconnections, and service retirement invalidate snapshots and pending publications. The receiver checks node connections during catalog requests, background discovery, and before publishing a refresh. There is no remote share-change subscription: source changes reach the receiver on the next successful background refresh. Updating the receiver requires no configuration or stored-state migration.

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

Sharing a session exposes its user and assistant conversation text and catalog metadata, which may include workspace paths or branch names. Included text is not secret-masked. Review credentials and other sensitive content before publishing. Choose groups deliberately and treat received transcripts as untrusted text.

## Troubleshooting

To undo the sessions-only setup, use `openclaw node run --all-commands` in the foreground or `openclaw node install --force --all-commands` for the service; this forgets the saved allowlist and restores the full default node surface.

**The source node fails with no allowed commands**

Enable `session-share` on the source, set a non-empty `share.groups`, restart the node host, and check the exact command IDs. Unknown or unavailable commands are not advertised.

**The node connects but no OpenClaw sessions host appears**

Enable the plugin on the receiver and confirm that it applied. In `openclaw nodes list`, the source must declare both session commands and be approved for them.

**The host appears but a session is missing**

Check its group on the source, the exact `share.groups` spelling, and whether it is a subagent, incognito, a draft, or adopted from another catalog. Subagent keys and recorded spawn lineage stay excluded even if the session was previously visible. Verify that the source node uses the same user and state directory as the source Gateway. On a role-restricted receiver, check the viewer's profile and permission to view others' sessions.

**A transcript read fails after a row was visible**

Refresh the catalog. The source may be offline, the session may have been deleted, or its group may no longer be shared. Reconnect the source node for an offline-host error; do not broaden its command allowlist.

**Catalog refreshes sometimes take 30 seconds**

When receiver diagnostics and warning logs are enabled, `gateway/session-catalog` logs background refreshes that take at least one second, at most once per minute. These refreshes do not delay catalog list responses. A `TIMEOUT` with `nodeCommandDispatched: false` occurred before dispatch; `true` means the receiver dispatched the command, so inspect the source node and its connection. It does not prove that the source handler started. An absent field leaves dispatch unknown. These records include bounded node error codes and durations, without node identifiers, request parameters, or error messages.

**Names do not link to local profiles**

Check the configured node ID and `linkGitHubIdentities`. Both profiles need the same verified numeric GitHub account ID; matching names or unverified logins do not link them.

## Related

- [Connect a node](/cli/connect)
- [Node command allowlists](/nodes#restrict-the-node-command-surface)
- [Team setup](/start/teams)
- [Beam](/plugins/beam)
- [User model](/concepts/user-model)
