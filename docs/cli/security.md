---
summary: "CLI reference for `openclaw security` (audit and fix common security footguns)"
read_when:
  - You want to run a quick security audit on config/state
  - You want to apply safe “fix” suggestions (chmod, tighten defaults)
title: "security"
---

# `openclaw security`

Security tools (audit + optional fixes).

Related:

- Security guide: [Security](/gateway/security)

## Audit

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
openclaw security audit --json
```

The audit warns when multiple DM senders share the main session and recommends **secure DM mode**: `session.dmScope="per-channel-peer"` (or `per-account-channel-peer` for multi-account channels) for shared inboxes.
This is for cooperative/shared inbox hardening. A single Gateway shared by mutually untrusted/adversarial operators is not a recommended setup; split trust boundaries with separate gateways (or separate OS users/hosts).
It also warns when small models (`<=300B`) are used without sandboxing and with web/browser tools enabled.
For webhook ingress, it warns when `hooks.defaultSessionKey` is unset, when request `sessionKey` overrides are enabled, and when overrides are enabled without `hooks.allowedSessionKeyPrefixes`.
It also warns when sandbox Docker settings are configured while sandbox mode is off, when `gateway.nodes.denyCommands` uses ineffective pattern-like/unknown entries, when `gateway.nodes.allowCommands` explicitly enables dangerous node commands, when global `tools.profile="minimal"` is overridden by agent tool profiles, when open groups expose runtime/filesystem tools without sandbox/workspace guards, and when installed extension plugin tools may be reachable under permissive tool policy.
It also warns when sandbox browser uses Docker `bridge` network without `sandbox.browser.cdpSourceRange`.
It also warns when existing sandbox browser Docker containers have missing/stale hash labels (for example pre-migration containers missing `openclaw.browserConfigEpoch`) and recommends `openclaw sandbox recreate --browser --all`.
It also warns when npm-based plugin/hook install records are unpinned, missing integrity metadata, or drift from currently installed package versions.
It warns when Discord allowlists (`channels.discord.allowFrom`, `channels.discord.guilds.*.users`, pairing store) use name or tag entries instead of stable IDs.
It warns when `gateway.auth.mode="none"` leaves Gateway HTTP APIs reachable without a shared secret (`/tools/invoke` plus any enabled `/v1/*` endpoint).

## Skill security

Community skills (installed from ClawHub) are subject to additional security enforcement:

- **SKILL.md scanning**: content is scanned for prompt injection patterns, capability inflation, and boundary spoofing before entering the system prompt. Skills with critical findings are blocked from loading.
- **Capability enforcement**: community skills must declare `capabilities` (e.g., `shell`, `network`) in frontmatter. Undeclared dangerous tool usage is blocked at runtime by the before-tool-call hook — a hard code gate that prompt injection cannot bypass.
- **Command dispatch gating**: community skills using `command-dispatch: tool` can't dispatch to dangerous tools without the matching capability.
- **Audit logging**: all security events are tagged with `category: "security"` and include session context for forensics. View in the web UI Logs tab using the Security filter.

See `openclaw skills check` for a runtime security overview, `openclaw skills info <name>` for per-skill details, and [Skills — Tool enforcement matrix](/tools/skills#tool-enforcement-matrix) for the complete tool-by-tool breakdown.

### Tool enforcement matrix

Every tool falls into one of three tiers when community skills are loaded:

**Always denied** — blocked unconditionally, no capability can override:

| Tool | Reason |
|------|--------|
| `gateway` | Control-plane reconfiguration (restart, shutdown, auth changes) |
| `nodes` | Cluster node management (add/remove compute, redirect traffic) |

**Capability-gated** — blocked by default, allowed if the skill declares the matching capability:

| Capability | Tools | What it unlocks |
|------------|-------|-----------------|
| `shell` | `exec`, `process`, `lobster` | Run shell commands and manage processes |
| `filesystem` | `write`, `edit`, `apply_patch` | File mutations (read is always allowed) |
| `network` | `web_fetch`, `web_search` | Outbound HTTP requests |
| `browser` | `browser` | Browser automation |
| `sessions` | `sessions_spawn`, `sessions_send`, `subagents` | Cross-session orchestration |
| `messaging` | `message` | Send messages to configured channels |
| `scheduling` | `cron` | Schedule recurring jobs |

**Always allowed** — safe read-only or output-only tools, no capability required:

| Tool | Why safe |
|------|---------|
| `read` | Read-only file access |
| `memory_search`, `memory_get` | Read-only memory access |
| `agents_list` | List agents (read-only) |
| `sessions_list`, `sessions_history`, `session_status` | Session introspection (read-only) |
| `canvas` | UI rendering (output-only) |
| `image` | Image generation (output-only) |
| `tts` | Text-to-speech (output-only) |

A community skill with no capabilities declared gets access only to the always-allowed tier. Declare capabilities in SKILL.md frontmatter:

```yaml
metadata:
  openclaw:
    capabilities: [shell, filesystem, network]
```

## JSON output

Use `--json` for CI/policy checks:

```bash
openclaw security audit --json | jq '.summary'
openclaw security audit --deep --json | jq '.findings[] | select(.severity=="critical") | .checkId'
```

If `--fix` and `--json` are combined, output includes both fix actions and final report:

```bash
openclaw security audit --fix --json | jq '{fix: .fix.ok, summary: .report.summary}'
```

## What `--fix` changes

`--fix` applies safe, deterministic remediations:

- flips common `groupPolicy="open"` to `groupPolicy="allowlist"` (including account variants in supported channels)
- sets `logging.redactSensitive` from `"off"` to `"tools"`
- tightens permissions for state/config and common sensitive files (`credentials/*.json`, `auth-profiles.json`, `sessions.json`, session `*.jsonl`)

`--fix` does **not**:

- rotate tokens/passwords/API keys
- disable tools (`gateway`, `cron`, `exec`, etc.)
- change gateway bind/auth/network exposure choices
- remove or rewrite plugins/skills
