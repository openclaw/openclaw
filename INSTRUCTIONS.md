> **Fork of:** [openclaw/openclaw](https://github.com/openclaw/openclaw)
> **Focus:** Security-hardened AI agent for enterprise and team use
> **Audience:** AI coding agents (Claude Code, Codex, etc.) and human contributors
> **Last updated:** 2026-03-16

-----

## 1. Project Identity & Mission

This is a security-first fork of OpenClaw. The upstream project is an excellent personal AI
assistant, but its defaults and architecture introduced serious vulnerabilities at scale
(CVE-2026-25253, CVE-2026-26322, CVE-2026-26319, CVE-2026-26329, and the ClawHavoc supply
chain campaign). This fork exists to fix those issues structurally — not as patches bolted on
top, but as first-class design constraints.

**Core principles, in order of priority:**

1. **Secure by default.** Every default must be the safest possible choice. Opt-in to exposure,
   never opt-out.
1. **Least privilege.** No agent, skill, or session gets more access than it explicitly needs.
1. **Sandboxed execution.** All tool runs happen inside Docker containers. No exceptions.
1. **Auditability.** Every agent action is logged in a structured, tamper-evident format.
1. **Human-in-the-loop for destructive actions.** Approval gates before send, delete, publish,
   and execute.

This fork does **not** aim to be the easiest onboarding experience. It aims to be the one
enterprises and teams can actually trust.

-----

## 2. Repository Layout

```
.
├── src/                    # Core gateway, agent runtime, channel adapters
│   ├── gateway/            # WebSocket control plane
│   ├── agent/              # Pi agent runtime + tool dispatch
│   ├── channels/           # Channel adapters (Slack, Discord, Telegram, etc.)
│   ├── sandbox/            # Docker sandbox orchestration (OUR PRIMARY ADDITION)
│   ├── auth/               # Auth, rate limiting, brute-force protection
│   └── audit/              # Structured audit log pipeline
├── packages/               # Shared internal packages (types, schemas, utils)
├── skills/                 # Bundled skills — all pre-audited and signed
├── extensions/             # Optional channel extensions
├── apps/                   # macOS/iOS/Android companion apps
├── ui/                     # WebChat + Control UI
├── test/                   # Integration and e2e tests
├── test-fixtures/          # Shared test fixtures
├── docker/                 # Docker images for sandbox execution
│   ├── Dockerfile.sandbox          # Default tool sandbox image
│   ├── Dockerfile.sandbox-browser  # Browser sandbox image
│   └── Dockerfile.sandbox-common   # Shared base layer
├── docs/                   # Documentation
├── scripts/                # Build, release, and dev scripts
├── INSTRUCTIONS.md         # This file
├── SECURITY.md             # Vulnerability reporting + trust model
├── AGENTS.md               # Agent workspace config reference
└── CHANGELOG.md            # Release history
```

-----

## 3. Development Environment

### Prerequisites

| Tool           | Version   | Notes                                                       |
|----------------|-----------|-------------------------------------------------------------|
| Node.js        | >= 22.12.0 | Required for CVE-2025-59466 and CVE-2026-21636 patches     |
| pnpm           | >= 9.x    | **Only** supported package manager — do not use npm or yarn |
| Docker         | >= 25.x   | **Required** — tool execution will not work without it      |
| Docker Compose | >= 2.x    | Required for the full dev stack                             |

### Initial Setup

```bash
git clone https://github.com/YOUR_ORG/YOUR_FORK.git
cd YOUR_FORK

# Verify Node version — must be >= 22.12.0
node --version

# Install dependencies
pnpm install

# Build the UI (auto-installs UI deps on first run)
pnpm ui:build

# Build the project
pnpm build

# Pull and build sandbox Docker images (required before running any tools)
pnpm sandbox:build

# Run the onboarding wizard
pnpm openclaw onboard --install-daemon
```

### Dev Loop

```bash
# Gateway with auto-reload on TypeScript changes
pnpm gateway:watch

# Run all unit tests
pnpm test:unit

# Run integration tests (requires Docker)
pnpm test:integration

# Run e2e tests
pnpm test:e2e

# Type-check without building
pnpm typecheck

# Lint
pnpm lint
```

-----

## 4. Security Architecture — What We Changed and Why

This section is mandatory reading before touching `src/gateway/`, `src/auth/`, `src/sandbox/`,
or any channel adapter.

### 4.1 Gateway Binding — Localhost Only

**Upstream problem:** OpenClaw defaults to `0.0.0.0:18789`, exposing the gateway on every
network interface including the public internet.

**Our default:** `127.0.0.1:18789`. Period.

Rules for contributors and agents:

- The default bind address in config schemas **must** be `127.0.0.1`.
- If a user explicitly sets `gateway.bind: "0.0.0.0"`, the gateway **must** emit a prominent
  `[SECURITY WARNING]` log line at startup and refuse to start unless
  `gateway.auth.mode` is set to `"password"` or `"token"`.
- Do not write code that silently falls back to `0.0.0.0`.

```jsonc
// Correct default in config schema
{
  "gateway": {
    "bind": "127.0.0.1",  // NEVER change this default
    "port": 18789
  }
}
```

### 4.2 WebSocket Authentication — No Unauthenticated Connections

**Upstream problem (CVE-2026-25253):** No rate limiting on password attempts, no origin
validation, and implicit localhost trust allowed one-click RCE from any website the user
visited.

**Our requirements:**

- All WebSocket connections **must** present a valid token before any message is processed.
- The auth handler in `src/auth/ws-auth.ts` enforces:
  - Exponential backoff after 3 failed attempts (100ms -> 200ms -> 400ms -> ... -> max 30s).
  - Hard lockout after 10 consecutive failures within 60 seconds. Requires manual reset via CLI.
  - `Origin` header validation against a configurable allowlist. Reject connections with no
    `Origin` header when `gateway.bind` is not `loopback`.
- **Never** add a `skipAuth` flag, env var, or config option that bypasses these checks. If
  tests need to authenticate, use the test token helper in `test/helpers/auth.ts`.

### 4.3 Sandboxed Tool Execution — Docker Required

**Upstream problem:** Tools (bash, browser, file operations) run directly on the host with full
OS permissions. Any prompt injection or malicious skill gets host-level access.

**Our requirement:** Every tool invocation routes through the sandbox orchestrator in
`src/sandbox/`. No tool call may execute directly on the host process.

Architecture:

```
Agent loop
  -> tool_dispatch()
    -> sandbox.run(tool, args)
      -> Docker container (per-session, ephemeral)
        -> stdout/stderr/exit returned to agent
      -> container destroyed after call
```

Rules:

- Sandbox containers run as a non-root user (`uid=1000`).
- Containers start with `--cap-drop=ALL` and `--read-only` filesystem except for explicitly
  mounted volumes.
- Each session gets its own container; containers are **not** reused across sessions.
- Allowed mounts per session are defined in `src/sandbox/policy.ts`. Do not add mounts outside
  this policy file.
- Browser tools use a separate `Dockerfile.sandbox-browser` image. Do not merge browser and
  shell execution into the same container.
- If Docker is unavailable at startup, the gateway **must** refuse to start, not fall back to
  host execution. The error message must explain how to start Docker.

### 4.4 Skill Trust Model

**Upstream problem (ClawHavoc):** ~20% of ClawHub skills were found to be malicious, delivering
infostealers. Skills ran with full host permissions.

**Our requirements:**

- Skills are only loaded from two sources: (a) bundled skills in `skills/` (pre-audited by
  maintainers), and (b) skills installed by the operator from a verified source with a valid
  Ed25519 signature.
- The skill loader in `src/agent/skill-loader.ts` verifies the signature against the operator's
  configured trust store before execution. Unsigned skills are rejected.
- Skills execute **inside the sandbox**, not in the host agent process.
- Skills may not declare permissions beyond what is listed in their `skill.manifest.json`.
  Requests for elevated permissions require a separate operator approval step.
- Do not add a `--skip-skill-verification` flag. There is no legitimate use case for it in
  production.

### 4.5 Approval Gates for Destructive Actions

**Problem:** Agents autonomously send messages, delete files, and publish content without any
human confirmation step.

**Our requirement:** Any tool call tagged as `destructive: true` in `src/agent/tool-registry.ts`
**must** pause execution and emit an approval request to the session owner before proceeding.

Destructive tool categories (non-exhaustive):

- `bash` commands that write, delete, or execute outside the workspace directory
- `message.send` on any channel
- `browser` actions that submit forms or click purchase/confirm/delete buttons
- `file.delete`, `file.write` outside the sandboxed workspace
- `cron.create` and `cron.delete`

Approval flow:

1. Agent emits `approval_request` event with a human-readable summary of the action.
1. Session owner approves via `/approve <id>` or rejects via `/reject <id>` within the
   configured timeout (default: 5 minutes).
1. On timeout, the action is automatically rejected and the agent is notified.
1. Approval events are written to the audit log regardless of outcome.

### 4.6 Audit Logging

**Problem:** No structured record of what the agent did, when, and why.

**Our requirement:** Every agent action produces a structured log entry written to
`src/audit/`. The audit log is append-only. Log entries are never deleted or modified
by application code.

Each entry includes: `timestamp`, `session_id`, `agent_id`, `tool_name`, `tool_args_hash`
(not raw args — args may contain secrets), `outcome`, `approval_id` (if applicable), and
`duration_ms`.

-----

## 5. Coding Standards

### TypeScript

- Strict mode is enabled. `tsconfig.json` sets `"strict": true`. Do not disable any strict
  flags, even in test files.
- Prefer explicit types over inference for all function signatures and exported symbols.
- Use TypeBox schemas (already used upstream) for all runtime validation of external inputs —
  WebSocket messages, config files, channel payloads, and skill manifests.
- Never use `any`. Use `unknown` and narrow at the boundary. If a library forces `any`, wrap
  it in a typed adapter.

### File and Module Conventions

- One module per file. Export the primary symbol as a named export, not default.
- Filename convention: `kebab-case.ts` for modules, `kebab-case.test.ts` for tests,
  `kebab-case.schema.ts` for TypeBox schemas.
- Co-locate tests with the module they test (e.g., `src/auth/ws-auth.ts` ->
  `src/auth/ws-auth.test.ts`).

### Error Handling

- Never swallow errors silently. If you catch and cannot handle, re-throw with added context.
- Errors that cross the gateway WS boundary are serialized to a safe `{code, message}` shape.
  Never send raw stack traces to clients.
- All sandbox execution errors are caught and returned as structured `SandboxError` objects,
  never leaked as unhandled rejections.

### Secrets and Configuration

- Secrets (API keys, tokens, bot tokens) are read from environment variables or
  `~/.YOUR_FORK/credentials` (written by the onboarding wizard with `chmod 600`).
- Secrets are **never** committed to `openclaw.json`, hardcoded in source, or logged.
- The `detect-secrets` baseline (`.secrets.baseline`) runs in CI. If your change introduces
  a false positive, update the baseline with `detect-secrets scan --baseline .secrets.baseline`
  and commit the updated file.

-----

## 6. Git Workflow

### Branch Naming

| Type     | Pattern                       | Example                                |
|----------|-------------------------------|----------------------------------------|
| Feature  | `feat/short-description`      | `feat/sandbox-per-session-isolation`   |
| Bug fix  | `fix/short-description`       | `fix/ws-auth-rate-limit`               |
| Security | `security/cve-or-description` | `security/cve-2026-25253-origin-check` |
| Docs     | `docs/short-description`      | `docs/sandbox-architecture`            |
| Chore    | `chore/short-description`     | `chore/update-vitest`                  |

### Commit Messages

Follow Conventional Commits: `<type>(<scope>): <description>`

```
feat(sandbox): add per-session container isolation
fix(auth): add exponential backoff on ws auth failures
security(gateway): enforce 127.0.0.1 default bind address
docs(instructions): add sandbox architecture section
```

Security commits **must** reference the CVE or GHSA if applicable:

```
security(auth): prevent brute-force on gateway ws (CVE-2026-25253)
```

### Pull Requests

Every PR must include:

- A description of **what** changed and **why**.
- For security changes: a brief threat model note explaining what attack is mitigated.
- Tests covering the changed code path. PRs without tests will not be merged.
- For sandbox policy changes: explicit statement of which tools/permissions are affected.

Security-related PRs should be opened as **draft** first and linked to a private advisory
if they have not yet been publicly disclosed.

-----

## 7. Testing Requirements

### Coverage Expectations

| Layer           | Minimum Coverage | Notes                                   |
|-----------------|------------------|-----------------------------------------|
| `src/auth/`     | 90%              | Auth logic is critical — aim for 100%   |
| `src/sandbox/`  | 85%              | All policy paths must be tested         |
| `src/audit/`    | 85%              | All log entry shapes must be verified   |
| `src/gateway/`  | 75%              | Focus on WS lifecycle and auth flows    |
| `src/channels/` | 60%              | Channel adapters; mock the external SDK |
| `src/agent/`    | 70%              | Tool dispatch and skill loading         |

### Test Categories

```bash
pnpm test:unit          # Fast, no Docker, no network
pnpm test:integration   # Requires Docker; tests sandbox + gateway together
pnpm test:e2e           # Full stack; requires Docker + channel mocks
pnpm test:security      # Security-specific tests: auth bypass, injection, sandbox escapes
```

All `test:security` tests must pass on every commit to `main`. They are not optional.

### Security Test Cases (Required)

Every auth or sandbox change must include tests for:

- Unauthenticated WebSocket connection attempt (expect rejection).
- Brute-force sequence exceeding the threshold (expect lockout).
- Tool call without Docker available (expect hard failure, not fallback).
- Skill load without valid signature (expect rejection).
- Destructive tool call without approval (expect pause, not execution).

-----

## 8. Working with AI Coding Agents

This section is specifically for AI agents (Claude Code, Codex, Copilot, etc.) working in
this repository.

### What You Are Allowed to Do

- Implement features described in open issues tagged `good-first-issue` or `agent-friendly`.
- Write or extend tests in `test/` and co-located `*.test.ts` files.
- Refactor code within a single module without changing its public interface.
- Update documentation in `docs/` and this file.
- Fix linting errors and type errors.

### What You Must Never Do

- **Never** change the default `gateway.bind` value away from `127.0.0.1`.
- **Never** add a code path that bypasses sandbox execution and runs tools on the host.
- **Never** add a flag, env var, or config option that disables authentication.
- **Never** remove or weaken a rate-limit, lockout, or origin-check in `src/auth/`.
- **Never** add a skill install path that skips signature verification.
- **Never** remove an approval gate from a tool tagged `destructive: true`.
- **Never** commit a secret, token, or credential to the repository in any form.
- **Never** modify `.secrets.baseline` without running the scanner to regenerate it.
- **Never** use `npm install` or `yarn` — only `pnpm`.
- **Never** write a test that uses `skipAuth`, `bypassSandbox`, or any test double that
  weakens the security invariants being tested.

### When You Are Uncertain

If a task requires touching `src/auth/`, `src/sandbox/policy.ts`, or any file in
`src/audit/`, and you are not certain the change preserves the security invariants above,
**stop and leave a comment** in the PR or issue explaining what you tried and what you
were uncertain about. Do not guess on security-critical code paths.

### Understanding the Codebase Quickly

Start here, in this order:

1. `SECURITY.md` — trust model and disclosure policy
1. `src/sandbox/policy.ts` — what each tool is and is not allowed to do
1. `src/auth/ws-auth.ts` — the gateway authentication flow
1. `src/audit/logger.ts` — the audit log schema
1. `src/agent/tool-registry.ts` — full list of tools and their destructive flags
1. `docs/architecture.md` — system diagram and subsystem responsibilities

-----

## 9. Upstream Sync Policy

This fork tracks `openclaw/openclaw` upstream but does **not** auto-merge. Upstream changes
are reviewed before being pulled in.

### Merge Process

1. A maintainer opens a PR titled `chore: sync upstream vYYYY.M.D`.
1. The PR diff is reviewed with specific attention to: `src/gateway/`, any auth-related code,
   any change to tool execution, and any new dependency.
1. New dependencies are checked with `pnpm audit` and reviewed for supply chain risk before
   merging.
1. Upstream security patches (marked `security:` in their changelog) are prioritized and
   fast-tracked within 24 hours of upstream release.

### What We Do Not Inherit from Upstream

- Default `gateway.bind` changes — ours stays `127.0.0.1`.
- Any ClawHub skill auto-install or registry integration — we do not connect to ClawHub.
- Any change that removes a rate limit, lockout, or origin check.

-----

## 10. Reporting Security Issues

Do not open a public GitHub issue for security vulnerabilities.

Report privately via GitHub's Security Advisory feature on this repository, or email
`security@YOUR_DOMAIN` with:

- The affected file, function, and line range on the current `main` revision.
- A reproducible proof-of-concept.
- Your assessment of impact and severity.
- Suggested remediation if you have one.

We aim to acknowledge reports within 48 hours and publish a patch within 7 days for
critical issues.

-----

## 11. Quick Reference

```bash
# Start gateway (dev)
pnpm gateway:watch

# Build sandbox images (required after Dockerfile changes)
pnpm sandbox:build

# Run all tests
pnpm test

# Run only security tests
pnpm test:security

# Type-check
pnpm typecheck

# Lint
pnpm lint

# Check for secrets
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline

# Verify no upstream regressions
pnpm test:security && pnpm test:integration

# Check gateway bind address is not exposed
netstat -tlnp | grep 18789
# Safe result:      127.0.0.1:18789
# Dangerous result: 0.0.0.0:18789  <- investigate immediately
```
