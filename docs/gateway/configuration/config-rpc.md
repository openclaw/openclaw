---
summary: "Writing config over the gateway API: config.get, config.patch, config.apply, and replacePaths"
title: "Config RPC (programmatic updates)"
sidebarTitle: "Config RPC (programmatic updates)"
read_when:
  - Writing config from tooling instead of by hand
  - Choosing between config.patch and config.apply
  - Handling baseHash, replacePaths, and deferred reload responses
---

## Config RPC (programmatic updates)

For tooling that writes config over the gateway API, prefer this flow:

- `config.schema.lookup` to inspect one subtree (shallow schema node + child
  summaries)
- `config.get` to fetch the current snapshot plus `hash`
- `config.patch` for partial updates (JSON merge patch: objects merge, `null`
  deletes, arrays replace when explicitly confirmed with `replacePaths` if
  entries would be removed)
- `config.apply` only when you intend to replace the entire config
- `update.run` for explicit self-update plus restart; include `continuationMessage` when the post-restart session should run one follow-up turn
- `update.status` to inspect the latest update restart sentinel and verify the running version after a restart

Agents should treat `config.schema.lookup` as the first stop for exact
field-level docs and constraints. Use [Configuration reference](/gateway/configuration-reference)
when they need the broader config map, defaults, or links to dedicated
subsystem references.

<Note>
Control-plane writes (`config.apply`, `config.patch`, `update.run`) are
rate-limited to 30 requests per 60 seconds, per method, per
`deviceId+clientIp`; see [Rate limiting](/gateway/security/rate-limiting). Restart
requests coalesce and then enforce a 30-second cooldown between restart cycles.
`update.status` is read-only but admin-scoped because the restart sentinel can
include update step summaries and command output tails.
</Note>

Example partial patch:

```bash
openclaw gateway call config.get --params '{}'  # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{ channels: { telegram: { groups: { \"*\": { requireMention: false } } } } }",
  "baseHash": "<hash>"
}'
```

`config.patch` records explicitly supplied values in the config file even when
they equal the current runtime defaults. Unchanged runtime defaults stay omitted. Its
successful response includes `changedPaths`, the effective runtime paths changed
after validation and secret restoration, or `[]` for a no-op. These paths contain
no configuration values; clients can use them to distinguish a channel change
from an unrelated write even when secret values are redacted.

Both `config.apply` and `config.patch` accept `raw`, `baseHash`, `sessionKey`,
`note`, and `restartDelayMs`. `baseHash` is required for both methods once a
config file already exists (a first write with no existing config skips the check).

For hot-applied changes, these RPCs wait until the active Gateway applies the
exact write. Channel or plugin reloads may defer for unrelated active work.
Policy-only writes covered by a plugin's dynamic-read contract, such as Discord
allowlists and DM/group policies, publish without a channel restart or drain
wait. Writes that also contain restart-required settings remain one deferred
transaction. If
the file watcher takes over the same unapplied write during that wait, the RPC stays pending
through replay; persistence alone is not an application acknowledgment. Shutdown,
supersession by different content, or failed application returns `UNAVAILABLE`
with recovery guidance. `config.set` acknowledges persistence only.

`channels.status` reports active-work deferrals in `statusIssues`, alongside
channel policy diagnostics shown in the Control UI and `openclaw channels status`.
`channels.start` also returns a diagnostic when that channel's reload is deferred;
manual stop/start continues to use the published runtime configuration. Wait for
active work to finish and refresh status. These diagnostics describe deferred
channel reloads, not every persisted-but-unapplied configuration state.

Once a reload has committed, it finishes its model and channel work before a
newer config is applied. If that work needs restart recovery, the RPC returns
`UNAVAILABLE`; wait for the Gateway to restart, then use `config.get` to verify
the active revision.

`config.patch` also accepts `replacePaths`, an array of config paths whose array
replacement or deletion is intentional. If a patch removes existing array entries
or deletes an array, the Gateway rejects the write unless that exact array path
appears in `replacePaths`. Deleting a containing object requires its contained
array paths, including empty arrays. Deleting a whole array requires only its own
path, not paths to arrays nested inside its entries. Use exact record keys, such
as `agents.entries.main.skills`. For ID-merged entry updates, nested array paths
use `[]`, such as `models.providers.custom.models[].input`. Parent paths and `*`
wildcards do not authorize descendant arrays. This prevents truncated
`config.get` snapshots from silently clobbering routing or allowlist arrays. Use
`config.apply` when you intend to replace the full config.

Arrays of objects with stable `id` fields merge by ID unless their path appears
in `replacePaths`. These updates preserve authored fields in untouched entries;
runtime defaults, such as model catalog compatibility and context budgets, are
not saved into sibling entries. Explicitly configured values remain authoritative.
