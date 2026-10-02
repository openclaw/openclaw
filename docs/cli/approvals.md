---
summary: "CLI reference for `openclaw approvals` and `openclaw exec-policy`"
read_when:
  - You want to edit exec approvals from the CLI
  - You need to manage allowlists on gateway or node hosts
  - You need to list or resolve a pending approval without a chat surface
  - An agent cannot run commands and you need to distinguish tool access from approvals
title: "Approvals"
---

# `openclaw approvals`

Manage exec approvals for the **local host**, **gateway host**, or a **node host**. With no target flag, commands read/write the local approvals document in shared SQLite state. Use `--gateway` to target the gateway, or `--node <id|name|ip>` to target a specific node.

Alias: `openclaw exec-approvals`

Related: [Exec approvals](/tools/exec-approvals), [Nodes](/nodes)

## Common commands

```bash
openclaw approvals get
openclaw approvals get --node <id|name|ip>
openclaw approvals get --gateway
openclaw approvals pending
openclaw approvals resolve <id> <allow-once|allow-always|deny>
```

`get` shows the effective exec policy for the target: the requested `tools.exec` policy, the host approvals-file policy, and the merged effective result. Nodes with a host-native policy, such as the Windows companion, show that policy directly instead of applying OpenClaw approvals-file policy math.

For file-backed nodes, the merged view requires a host-resolved policy snapshot. Older nodes show the effective policy as unavailable instead of assuming the Gateway's requested policy also applies on the host.

<Note>
Per-session `/exec` overrides are not included. Run `/exec` in the relevant session to inspect its current defaults.
</Note>

Precedence:

- The host approvals document is the enforceable source of truth.
- Requested `tools.exec` policy can narrow or broaden intent, but the effective result is derived from host rules.
- `--node` combines the node host approvals document with gateway `tools.exec` policy (both apply at runtime).
- If gateway config is unavailable, the CLI falls back to the node approvals snapshot and notes that the final runtime policy could not be computed.

## Pending approvals

List pending exec, plugin, and OpenClaw system-agent approvals from the Gateway:

```bash
openclaw approvals pending
openclaw approvals pending --json
```

Complete enumeration and the matching operator-wide `resolve` flow use `operator.admin` because approval records otherwise retain requester/reviewer filtering. Resolution also requests the dedicated `operator.approvals` scope. The standard CLI operator grant includes both scopes; a restricted third-party client should not request admin merely to emulate this command.

Human output shows the approval kind, agent/session attribution, request age, time until expiry, a shortened command or summary, and a shell-neutral `id64_<base64url>` id token. A `Full request text` block always follows the compact table with every complete token and a losslessly escaped request, so terminal-width shortening cannot hide a suffix or the token needed for resolution. Copy the complete token into `resolve`. Unsafe terminal characters in other fields are shown as visible Unicode escapes. JSON output returns normalized entries under `approvals`, preserving the original raw `id`, `summary`, `createdAtMs`, and `expiresAtMs` for scripts; raw ids remain accepted by `resolve` unless they use the reserved `id64_` display-token prefix.

If a supplied `id64_` value matches both a literal raw id and the decoded display token for another approval, the CLI rejects it as ambiguous instead of risking resolution of the wrong request.

Resolve one approval by its full id:

```bash
openclaw approvals resolve <id> allow-once
openclaw approvals resolve <id> allow-always
openclaw approvals resolve <id> deny --reason "Not expected during maintenance"
```

For exec requests, `allow-always` means **always allow here**: the generated
grant is tied to the command's exact arguments and current working directory.
The same command from another directory requires a separate approval.

For approvals raised by an automation (cron) run, `allow-always` mints a
scoped standing grant instead of a JSON allowlist entry (see
[Standing grants for automations](/tools/exec-approvals#standing-grants-for-automations)).
By default the grant lives until revoked; `--expires-in-days <n>` freezes an
explicit lifetime instead of the configured `tools.exec.grantExpiryDays`
default:

```bash
openclaw approvals resolve <id> allow-always --expires-in-days 30
```

## Standing grants

Standing grants minted by allow-always on automation approvals are listed and
revoked from the same command group:

```bash
openclaw approvals grants list
openclaw approvals grants list --json
openclaw approvals grants revoke <grant-id>
```

The list shows the owning automation, the exact command, the use count, and
each grant's state (until revoked, expires in N days, expired, or revoked).
Revocation is idempotent and takes effect at the next occurrence's spawn
boundary — that occurrence prompts again. Editing or deleting the automation
invalidates its grants without needing an explicit revoke.

The CLI reads the unified approval record to select its kind, checks the requested decision against the record's allowed decisions, and then calls the unified resolver. A first successful decision exits `0`. Repeating the recorded decision also exits `0` and reports `already resolved (same decision)`. A conflicting decision, missing approval, expired approval, or decision unavailable for that approval kind prints a clear error and exits non-zero.

`--reason` adds a local note to the CLI confirmation. The current Gateway approval record has no free-text resolution-reason field, so this note is not persisted or sent to other approval surfaces.

## Replace approvals from a file

```bash
openclaw approvals set --file ./exec-approvals.json
openclaw approvals set --stdin <<'EOF'
{ version: 1, defaults: { security: "full", ask: "off", askFallback: "full" } }
EOF
openclaw approvals set --node <id|name|ip> --file ./exec-approvals.json
openclaw approvals set --gateway --file ./exec-approvals.json
```

`set` accepts JSON5, not only strict JSON. Use either `--file` or `--stdin`, not both.

Host-native Windows nodes use their own policy shape:

```bash
openclaw approvals set --node <id|name|ip> --stdin <<'EOF'
{
  defaultAction: "deny",
  rules: [{ pattern: "hostname", action: "allow" }]
}
EOF
```

The CLI reads the node's current hash first and sends it with the update, so concurrent local edits are rejected instead of overwritten. `rules` is required because this operation replaces the node's complete rule list; `defaultAction` is optional. A node that reports its native policy as disabled cannot be configured remotely; enable or configure the policy on that host first. Host-native policies do not support the `allowlist add|remove` helpers.

## "Never prompt" / YOLO example

Set the host approvals defaults to `full` + `off` for a host that should never stop on exec approvals:

```bash
openclaw approvals set --stdin <<'EOF'
{
  version: 1,
  defaults: {
    security: "full",
    ask: "off",
    askFallback: "full"
  }
}
EOF
```

For nodes that expose an OpenClaw approvals document, use the same body with `openclaw approvals set --node <id|name|ip> --stdin`. Host-native nodes require their owner-specific shape shown above.

This changes the **host approvals document** only. To keep the requested OpenClaw policy aligned, also set:

```bash
openclaw config set tools.exec.host gateway
openclaw config set tools.exec.mode full
```

`tools.exec.host=gateway` is explicit here because `host=auto` still means "sandbox when available, otherwise gateway": YOLO is about approvals, not routing. Use `gateway` (or `/exec host=gateway`) when you want host exec even with a sandbox configured.

Omitted `askFallback` defaults to `deny`. Set `askFallback: "full"` explicitly when upgrading a no-UI host that should keep never-prompt behavior.

Local shortcut for the same intent, on the local machine only:

```bash
openclaw exec-policy preset yolo
```

## Allowlist helpers

```bash
openclaw approvals allowlist add "~/path/to/**/bin/rg"
openclaw approvals allowlist add --agent main --node <id|name|ip> "/usr/bin/uptime"
openclaw approvals allowlist add --agent "*" "/usr/bin/uname"

openclaw approvals allowlist remove "~/path/to/**/bin/rg"
```

Adding an existing pattern or removing a missing one succeeds without writing.
With `--json`, these commands return the unchanged, redacted approvals snapshot.

## Common options

`get`, `set`, and `allowlist add|remove` all support:

- `--node <id|name|ip>` (resolves id, name, IP, or id prefix; same resolver as `openclaw nodes`)
- `--gateway`
- shared node RPC options: `--url`, `--token`, `--timeout`, `--json`

No target flag means the local approvals row in the shared state database.

`allowlist add|remove` also supports `--agent <id>` (defaults to `"*"`, applying to all agents).

`pending` and `resolve` always use the Gateway because pending requests are live Gateway state. They support the shared Gateway connection options `--url`, `--token`, and `--timeout`; `pending` also supports `--json`.

## `openclaw exec-policy`

`openclaw exec-policy show` explains an agent's terminal tool policies and shows
command approvals separately. Inspection never changes permissions. `preset`
and `set` synchronize requested `tools.exec.*` config with the local host
approvals document.

```bash
openclaw exec-policy show
openclaw exec-policy show --agent main
openclaw exec-policy show --session agent:main:main
openclaw exec-policy show --agent main --verbose
openclaw exec-policy show --agent main --json

openclaw exec-policy preset yolo
openclaw exec-policy preset cautious --json

openclaw exec-policy set --host gateway --security full --ask off --ask-fallback full --json
```

### Inspect terminal access

Without `--session`, `show` works offline. It reports definitive exclusions from
local tool profiles and policies. A locally allowed tool's execution access is
**unverified**; model, channel, sandbox, session, and runtime restrictions may
still affect availability.

The report leads with the agent and terminal-access status, followed by profile
inheritance, findings for `exec` and `process`, local command approvals, and a
next step. An agent profile overrides the global profile. For example,
`agents.entries.main.tools.profile: "messaging"` excludes terminal tools even if
`tools.profile` is `"full"`. Command approval settings do not grant tool access.
Intentionally restrictive profiles are valid configuration.

- `--agent <id>` selects the agent to inspect. Without `--session`, the agent
  must be configured locally. With a single configured
  agent, selection is automatic. With multiple agents, an untargeted report
  asks you to select an agent or an agent-qualified session key before inspecting
  tool availability. With no configured agents, it explains how to add one.
  Both cases still show a compact summary of all local command approval scopes.
- `--session <key>` fetches a read-only tool preview for an **existing** session
  from its saved settings through the Gateway. Use the full session key; for a
  shared key such as `global`, the Gateway resolves its agent; pass `--agent`
  when the Gateway needs an explicit selection. The agent need not exist in the
  CLI machine's configuration. Conflicting agent and session targets are rejected.
- `--verbose` adds policy sources and the complete requested/host/effective
  approval tables for all scopes.
- `--json` preserves all approval fields and scopes. With a selected agent, it
  adds `toolAccess`, separating `local` findings from the optional `live` result.
  `local` is omitted when the agent is not configured on the CLI machine. If a
  failed session inspection could not resolve an agent, `agentId` is also omitted.
  An untargeted multi-agent or empty-roster report instead adds
  `toolAccessSelectionRequired` with `agentIds` and a `hint`; it makes no tool
  availability claim.

The session preview supports the shared Gateway connection options (`--url`,
`--port`, `--token`, `--password`, `--timeout`). If the Gateway or session cannot
be inspected, the report says **UNVERIFIED** and retains any available local
findings. Missing local tool policy is labeled unavailable, never allowed. An
unavailable inspection is not evidence that tools are allowed or denied.

A successful fetch reports **PREVIEW** unless the checked policies establish
an exclusion. Included tools are not guaranteed to execute, and a tool missing
from the preview is not necessarily disabled. The preview may be cached; saved
changes can take time to appear, and an active run can use different authority,
credentials, discovery, or policy. Verify execution in a run; command approvals
still apply.

JSON retains the wire names `live`, `checked: "live-session"`, and tool statuses
`available`/`unavailable`. These describe the fetched session preview.
`live.status: "verified"` means the preview was retrieved successfully, not that
execution was verified. `excluded` identifies a checked policy exclusion;
`unavailable` alone does not establish one. The CLI translates an older Gateway's
explicit `deniedBySession` flag to `excluded` with a `session` reason.

Command approvals remain labeled **local**, including during session inspection.
They do not describe remote host approvals or per-session `/exec` overrides.
Use `openclaw approvals get --gateway` or `--node <id|name|ip>` for those host
policies, and `/exec` in the session for its current defaults.

When adding terminal tools to `alsoAllow` would address the checked restrictions,
the report suggests the exact configuration path and tool names. Append them to
existing entries; preserve command approval requirements. When another policy
still blocks access, review the reported exclusions before enabling tools. A
tool merely missing from the preview does not prompt an `alsoAllow` recipe.
Changes use the existing config commands or the agent's Tools panel and Save
controls. Check the updated preview and verify execution in a run.

### Synchronize local command approvals

Presets (`yolo`, `cautious`, `deny-all`) apply `host`, `security`, `ask`, and `askFallback` together. `set` applies only the flags you pass; each accepted value is validated (`--host auto|sandbox|gateway|node`, `--security deny|allowlist|full`, `--ask off|on-miss|always`, `--ask-fallback deny|allowlist|full`).

`show`, `preset`, and `set` accept `--json` and return the requested, host, and
effective command approval facts as one JSON object. `preset` and `set` do not
change tool profiles or tool allow/deny rules.

Scope:

- Updates the local config file and local approvals document together; does not push policy to the gateway or a node host.
- `--host node` is rejected: node exec approvals are fetched from the node at runtime, so local `exec-policy` cannot synchronize them. Use `openclaw approvals set --node <id|name|ip>` instead.
- `exec-policy show` marks `host=node` scopes as node-managed at runtime instead of deriving an effective policy from the local approvals document.

For remote host approvals, use `openclaw approvals set --gateway` or `openclaw approvals set --node <id|name|ip>` directly.

## Notes

- The node host must advertise `system.execApprovals.get/set` (macOS app, headless node host, or Windows companion).
- Generated grants became directory-bound in `2026.8.1`. After upgrading from `2026.7.1` or earlier, run `openclaw doctor --fix` if the update did not already do so. Doctor removes only inactive generated grants; manual allowlist rules stay in place. Rerun affected workflows to approve them in the intended directory.
- Approvals are stored per host in
  `$OPENCLAW_STATE_DIR/state/openclaw.sqlite#exec_approvals_config`, or
  `~/.openclaw/state/openclaw.sqlite#exec_approvals_config` when the variable is
  unset. The suffix identifies the singleton SQLite row.

## Related

- [CLI reference](/cli)
- [Exec approvals](/tools/exec-approvals)
