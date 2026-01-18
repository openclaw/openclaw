---
summary: "Exec approvals, allowlists, and sandbox escape prompts in the macOS app"
read_when:
  - Configuring exec approvals or allowlists
  - Implementing exec approval UX in the macOS app
  - Reviewing sandbox escape prompts and implications
---

# Exec approvals (macOS app)

Exec approvals are the **macOS companion app** guardrail for running host
commands from sandboxed agents. Think of it as a per-agent “run this on my Mac”
approval layer: the agent asks, the app decides, and the command runs (or not).
This is **in addition** to tool policy and elevated gating; all of those checks
must pass before a command can run.

If you are **not** running the macOS companion app, exec approvals are
unavailable and `system.run` requests will be rejected with a message that a
companion app is required.

## Settings

In the macOS app, each agent has an **Exec approvals** setting:

- **Deny**: block all host exec requests from the agent.
- **Always ask**: show a confirmation dialog for each host exec request.
- **Always allow**: run host exec requests without prompting.

Optional toggles:
- **Auto-allow skill CLIs**: when enabled, CLIs referenced by known skills are
  treated as allowlisted (see below).

## Allowlist (per agent)

The allowlist is **per agent**. If multiple agents exist, you can switch which
agent’s allowlist you’re editing. Entries are path-based and support **globs**.

Examples:
- `~/Projects/**/bin/bird`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Each allowlist entry tracks:
- **last used** (timestamp)
- **last used command**
- **last used path** (resolved absolute path)
- **last seen metadata** (hash/version/mtime when available)

## How matching works

1) Parse the command to determine the executable (first token).
2) Resolve the executable to an absolute path using `PATH`.
3) Match against denylist (if present) → **deny**.
4) Match against allowlist → **allow**.
5) Otherwise follow the Exec approvals policy (deny/ask/allow).

If **auto-allow skill CLIs** is enabled, each installed skill can contribute one
or more allowlist entries. A skill-based allowlist entry only auto-allows when:
- the resolved path matches, and
- the binary hash/version matches the last approved record (if tracked).

If the binary changes (new hash/version), the command falls back to **Ask** so
the user can re-approve.

## Approval flow

When the policy is **Always ask** (or when a binary has changed), the macOS app
shows a confirmation dialog. The dialog should include:
- command + args
- cwd
- environment overrides (diff)
- policy + rule that matched (if any)

Actions:
- **Allow once** → run now
- **Always allow** → add/update allowlist entry + run
- **Deny** → block

When approved, the command runs **in the background** and the agent receives
system events as it starts and completes.

## System events

The agent receives system messages for observability and recovery:

- `exec.started` — command accepted and launched
- `exec.finished` — command completed (exit code + output)
- `exec.denied` — command blocked (policy or denylist)

These are **system messages**; no extra agent tool call is required to resume.

## Implications

- **Always allow** is powerful: the agent can run any host command without a
  prompt. Prefer allowlisting trusted CLIs instead.
- **Ask** keeps you in the loop while still allowing fast approvals.
- Per-agent allowlists prevent one agent’s approval set from leaking into others.

## Storage

Allowlists and approval settings are stored **locally in the macOS app** (SQLite
is a good fit). The Markdown docs describe behavior; they are not the storage
mechanism.

Related:
- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
