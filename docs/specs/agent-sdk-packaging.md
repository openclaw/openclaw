---
title: Agent SDK Packaging Spec
description: Declarative packaging, integrity verification, and policy-scoped distribution for OpenClaw agents.
readWhen:
  - Designing agent packaging or distribution
  - Reviewing agent-sdk PRs
  - Implementing pack, validate, or enable commands
---

# Agent SDK Packaging Spec

## Goal

Turn an OpenClaw agent from a loose collection of workspace files, skills, secrets, schedules, channel bindings, and sandbox policy into a **declarative, inspectable, tamper-evident, testable artifact**.

The Agent SDK provides:

- A manifest (`agent-package.json`) that declares everything an agent needs.
- An integrity manifest (`openclaw.integrity.json`) that records content hashes and proves nothing changed.
- A CLI workflow (`pack`, `validate`, `enable`) that compiles the manifest into live OpenClaw config without scripts or hooks.
- A test harness that proves policy enforcement with mock models and mock tools.

## Scope

This spec covers the **packaging layer only**. It does not:

- Replace the OpenClaw plugin system.
- Define a new workflow engine.
- Modify the agent loop or LLM runtime.
- Change how skills are authored or discovered.

It **does** define how an agent's entire surface — instructions, tools, secrets, network policy, channel bindings, schedules, and sandbox constraints — gets declared, verified, installed, and tested as a unit.

## Trust Boundary Hierarchy

Runtime enforcement is layered. Lower layers can only **restrict**, never re-enable:

```
1. Runtime hard policy (immutable)
2. Operator policy (gateway config)
3. Global sandbox / tool policy
4. Agent package manifest (agent-package.json)
5. Agent markdown instructions (AGENTS.md, SOUL.md, etc.)
```

If layer 1 blocks network egress, no package manifest can re-enable it. If layer 3 denies `exec`, no instruction file can execute commands. This is a hard rule. The compiler rejects any package that attempts to escalate beyond the policy ceiling.

## Package Structure

```
my-agent/
├── agent-package.json          # Manifest (required)
├── openclaw.integrity.json     # Integrity manifest (generated)
├── files/
│   ├── AGENTS.md               # Agent instructions
│   ├── SOUL.md                 # Voice and tone
│   ├── USER.md                 # User profile
│   ├── HEARTBEAT.md            # Heartbeat checklist
│   └── ...                     # Other workspace files
├── skills/
│   └── my-skill/
│       ├── SKILL.md
│       └── ...
├── scripts/                    # Optional helper scripts (not auto-executed)
│   └── ...
└── tests/                      # Optional behavior proofs
    └── ...
```

## Manifest Schema (`agent-package.json`)

```json
{
  "$schema": "https://openclaw.ai/schemas/agent-package/v0.2.json",
  "name": "my-agent",
  "version": "1.0.0",
  "description": "Short human description.",
  "license": "MIT",

  "metadata": {
    "author": "Name",
    "homepage": "https://example.com",
    "repository": "https://github.com/example/my-agent",
    "tags": ["security", "automation"]
  },

  "files": {
    "copy": [
      { "src": "files/AGENTS.md", "dest": "AGENTS.md" },
      { "src": "files/SOUL.md", "dest": "SOUL.md" },
      { "src": "files/USER.md", "dest": "USER.md" },
      { "src": "files/HEARTBEAT.md", "dest": "HEARTBEAT.md" }
    ],
    "mutable": [{ "dest": "memory/", "description": "Agent working memory." }]
  },

  "skills": [{ "path": "skills/my-skill", "required": true }],

  "secrets": {
    "consumer": [
      { "name": "API_KEY", "required": true, "description": "External API key." },
      { "name": "WEBHOOK_URL", "required": false }
    ],
    "mapping": {
      "API_KEY": { "source": "env", "key": "MY_AGENT_API_KEY" },
      "WEBHOOK_URL": { "source": "gateway", "ref": "secrets.webhookUrl" }
    },
    "audit": {
      "logAccess": true,
      "redactInTranscripts": true
    }
  },

  "tools": {
    "allow": ["exec", "read", "write", "edit", "web_search", "web_fetch"],
    "deny": ["browser"],
    "sandbox": {
      "mode": "inherit",
      "elevated": false,
      "network": {
        "egress": "restricted",
        "allowedDomains": ["api.example.com", "hooks.slack.com"],
        "deniedDomains": ["*.internal.corp"],
        "dnsRebindingCheck": true,
        "denyPrivateRanges": true
      },
      "filesystem": {
        "readPaths": ["workspace", "package"],
        "writePaths": ["workspace/tmp"],
        "denyPaths": ["/etc", "/proc", "/sys"]
      }
    }
  },

  "channels": {
    "bindings": [
      {
        "channel": "discord",
        "guildId": "123456789",
        "channelId": "987654321",
        "requireMention": false
      },
      {
        "channel": "telegram",
        "chatId": "-1001234567890"
      }
    ]
  },

  "schedules": [
    {
      "name": "weekly-report",
      "cron": "0 9 * * 1",
      "tz": "America/New_York",
      "payload": {
        "kind": "agentTurn",
        "message": "Generate the weekly report."
      },
      "sessionTarget": "isolated"
    }
  ],

  "policy": {
    "denyMutableInstructionFiles": true,
    "allowMutableUserInstructionFiles": false,
    "onUpgrade": "preserve-custom",
    "maxTokensPerTurn": 50000,
    "allowedModels": ["openai/gpt-5.5", "google/gemini-3.1-pro-preview"]
  }
}
```

### Field Reference

#### Top-level

| Field         | Required | Description                                                    |
| ------------- | -------- | -------------------------------------------------------------- |
| `name`        | yes      | Package identifier. Lowercase, hyphens.                        |
| `version`     | yes      | Semver.                                                        |
| `description` | yes      | One-line human summary.                                        |
| `license`     | no       | SPDX identifier.                                               |
| `metadata`    | no       | Author, homepage, repo, tags.                                  |
| `files`       | yes      | Files to copy into workspace, and mutable paths.               |
| `skills`      | no       | Skill paths and required flags.                                |
| `secrets`     | no       | Consumer declarations, source mappings, audit config.          |
| `tools`       | no       | Allow/deny lists, sandbox overrides.                           |
| `channels`    | no       | Channel binding declarations.                                  |
| `schedules`   | no       | Cron/agentTurn schedule declarations.                          |
| `policy`      | no       | Mutable instruction policy, upgrade behavior, model allowlist. |

#### `files.copy`

Each entry: `src` (relative to package root), `dest` (relative to workspace). Files are copied at enable time. Content hash recorded in integrity manifest.

#### `files.mutable`

Paths the agent can modify at runtime. These paths are **not** integrity-checked. Everything in `files.copy` is immutable by default.

#### `secrets.consumer`

Declares which secrets the agent needs. `required: true` means validation fails if the secret is not resolvable. `required: false` means the agent handles its absence.

#### `secrets.mapping`

Maps consumer names to sources:

- `{ "source": "env", "key": "..." }` — environment variable.
- `{ "source": "gateway", "ref": "..." }` — OpenClaw gateway secret reference.
- `{ "source": "file", "path": "..." }` — file on disk (path relative to workspace).

The model **never** sees raw secret values. The runtime injects them at the tool boundary.

#### `tools.sandbox.network`

- `egress`: `"full"` | `"restricted"` | `"none"`.
- `allowedDomains`: exact domains or `*.example.com` wildcards.
- `deniedDomains`: always blocked, takes precedence over allowed.
- `dnsRebindingCheck`: after DNS resolution, re-check the IP against denied ranges. Default `true`.
- `denyPrivateRanges`: block `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `fd00::/8`, `::1/128`. Default `true`. This is a runtime hard policy — cannot be overridden.

#### `policy.denyMutableInstructionFiles`

When `true`, the following files cannot appear in `files.mutable`:

- `AGENTS.md`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`
- Any file consumed via `files.copy`
- `SKILL.md` files from declared skills

If a mutable path contains an instruction file, `validate` fails. If mutation is detected at runtime, the package is quarantined.

Default: `true`.

#### `policy.allowMutableUserInstructionFiles`

Narrow override allowing `USER.md` to be mutable while keeping core behavior files locked. Only applies when `denyMutableInstructionFiles` is `true`.

Default: `false`.

#### `policy.onUpgrade`

- `"preserve-custom"` — keep user-modified values, apply additive changes.
- `"reset"` — reapply package defaults, overwrite user changes.
- `"prompt"` — ask the operator (interactive only).

## Integrity Manifest (`openclaw.integrity.json`)

Generated by `pack`. Records content hashes for every file in `files.copy`.

```json
{
  "version": 1,
  "algorithm": "sha256",
  "package": {
    "name": "my-agent",
    "version": "1.0.0"
  },
  "files": {
    "AGENTS.md": "sha256:abc123...",
    "SOUL.md": "sha256:def456...",
    "USER.md": "sha256:789abc...",
    "HEARTBEAT.md": "sha256:fedcba..."
  },
  "skills": {
    "skills/my-skill/SKILL.md": "sha256:123abc..."
  },
  "generatedAt": "2026-06-15T14:00:00Z"
}
```

The integrity manifest is **not** a lockfile in the npm sense. It does not resolve dependencies. It proves content integrity. The name avoids collision with `package-lock.json` and describes what it actually does.

### Mutation Detection

At runtime, the gateway periodically re-hashes instruction files and compares against the integrity manifest. If a file's hash changes:

1. The package is **quarantined** — tools are restricted to read-only.
2. The operator is notified.
3. The operator can inspect diffs, restore from package, or explicitly accept the mutation.

## CLI Workflow

### `openclaw agent pack [path]`

1. Read `agent-package.json`.
2. Validate manifest schema.
3. Resolve all `src` paths.
4. Hash every file in `files.copy` and skill `SKILL.md` files.
5. Write `openclaw.integrity.json` into the package directory.
6. Exit 0 on success, non-zero on validation failure.

### `openclaw agent validate [path]`

1. Read `agent-package.json` and `openclaw.integrity.json`.
2. Validate manifest schema.
3. Re-hash every tracked file and compare against integrity manifest.
4. Check trust boundary: no manifest field may exceed the policy ceiling.
5. Check mutable instruction file policy: no instruction file in mutable paths.
6. Report all violations. Exit 0 if clean.

### `openclaw agent enable [path]`

1. Run `validate`. Abort if validation fails.
2. **Dry-run compile**: map manifest fields into OpenClaw config schema. Produce a diff. Abort on unsupported fields. Do not write anything.
3. Show the diff. In interactive mode, prompt for approval.
4. Apply config changes: copy files, register skills, bind channels, create schedules, set sandbox policy.
5. Record the package in `agentPackages` registry in gateway config.

### `openclaw agent disable [path]`

1. Remove channel bindings, schedules, and sandbox overrides registered by this package.
2. Remove files copied by this package (only if integrity hash still matches — if modified, ask).
3. Remove the package from `agentPackages` registry.
4. Preserve mutable paths and any user data.

## Config Compiler (Dry-Run First)

The config compiler maps manifest fields into the live OpenClaw config schema. It does **not** guess field mappings. It must be implemented against the actual OpenClaw config schema and gateway protocol.

### Dry-Run Phase (PR 3)

Before any live config writes exist, the compiler must:

1. Probe the live config schema to discover available fields.
2. Compile manifest → config diff without writing.
3. Reject any manifest field that maps to no known config field.
4. Round-trip validate: compile → decompile → compare.
5. Golden test against known config shapes: sandbox, tools, bindings, schedules, metadata.

Acceptance criteria for the dry-run phase:

- Schema probe succeeds against live OpenClaw config.
- Compile-to-diff produces correct output for every manifest section.
- Unsupported fields are rejected with clear error messages.
- Round-trip validation passes for all golden configs.
- No live config writes occur.

## Network Egress Enforcement

Network policy is enforced at the tool dispatch layer, not just declared in config.

### DNS Rebinding Protection

When `dnsRebindingCheck: true` (default):

1. Resolve the hostname.
2. Check the IP against denied ranges.
3. If the IP is private and `denyPrivateRanges` is true, block.
4. Follow redirects. After each redirect, re-resolve and re-check.
5. Block if any hop resolves to a denied range.

The denied IP range list is **centralized** in one source of truth. Individual tools do not maintain their own blocklists.

### Denied Ranges (Runtime Hard Policy)

These ranges are always blocked. No package can override:

- `10.0.0.0/8`
- `172.16.0.0/12`
- `192.168.0.0/16`
- `127.0.0.0/8`
- `fd00::/8`
- `::1/128`

## Secret Scope Enforcement

Secrets are scoped at the tool boundary. The model sees **references**, not values.

### Enforcement Points

1. **Tool dispatch**: before a tool executes, resolve any secret references. If the tool is not in the allowed list for that secret, block.
2. **Transcript**: secret values are redacted in session transcripts when `redactInTranscripts: true`.
3. **Audit log**: every secret access is logged with timestamp, tool, and caller context.

### Fail-Closed Behavior

- If a secret reference cannot be resolved, the tool call fails. The model sees "secret unavailable" — not the reason.
- If the mapping source is unreachable (env var missing, gateway unreachable), the tool fails.
- No fallback to default values. No partial resolution.

## Declarative Upgrade

Package upgrades are **purely declarative**. No scripts. No hooks. No arbitrary code execution.

### Upgrade Process

1. New package version is packed and validated.
2. `openclaw agent enable --upgrade` reads the old and new manifests.
3. Computes a field-level diff.
4. Applies changes according to `onUpgrade` policy.
5. Re-validates integrity.

### What Upgrades Cannot Do

- Execute scripts or commands.
- Modify files outside declared `files.copy` and `files.mutable`.
- Change gateway config fields not mapped by the manifest.
- Escalate tool or network policy beyond the current runtime ceiling.

## Test Harness

The test harness enables deterministic behavior proofs without burning model credits.

### Components

- **Mock model**: returns canned responses. No network. No real LLM.
- **Mock tools**: record invocations, return configured results.
- **Real policy path**: the actual sandbox, network, and secret-scope enforcement code runs against mock inputs.

### Harness API (TypeScript)

```typescript
import { AgentTestHarness } from "@openclaw/agent-sdk/test";

const harness = new AgentTestHarness({
  manifest: "./agent-package.json",
  mockModel: {
    responses: [
      {
        role: "assistant",
        content: [{ type: "toolCall", name: "exec", input: { command: "whoami" } }],
      },
    ],
  },
  mockTools: {
    exec: { allow: false },
    read: { allow: true },
  },
});

const result = await harness.run();

assert(result.toolCalls.some((tc) => tc.name === "exec" && tc.blocked === true));
```

### Required Proof Tests

Every package must include tests that prove:

1. **External content cannot trigger exec** — fetched web content or email body cannot cause command execution.
2. **Secret scope enforcement** — a tool not in the allowed list cannot access a secret.
3. **DNS rebinding protection** — a hostname that resolves to a private IP is blocked even if the domain is in the allowed list.

## Gateway Config Extension

A new top-level block in `openclaw.json`:

```json
{
  "agentPackages": {
    "enabled": ["my-agent@1.0.0"],
    "policy": {
      "denyMutableInstructionFiles": true,
      "allowMutableUserInstructionFiles": false,
      "maxPackages": 10,
      "allowUnsigned": false
    },
    "registry": {
      "my-agent@1.0.0": {
        "path": "/path/to/my-agent",
        "integrity": "sha256:abc123...",
        "installedAt": "2026-06-15T14:00:00Z"
      }
    }
  }
}
```

## PR Breakdown

This is a large spec. Implementation should be incremental.

### PR 1 — Schema + Integrity Manifest

- JSON Schema for `agent-package.json`.
- `openclaw.integrity.json` structure and hash generation.
- `pack` command: validate + hash + write integrity manifest.
- `validate` command: schema + integrity + mutable instruction policy.
- Unit tests for schema validation and hash verification.
- No install. No enable. No gateway mutation.

### PR 2 — Secret Scope + Network Policy Types

- TypeScript types for `secrets` and `tools.sandbox.network`.
- Secret reference resolution (env, gateway, file).
- DNS rebinding check implementation.
- Denied IP range list (centralized).
- Unit tests for resolution and network checks.

### PR 3 — Config Compiler Dry-Run

- Schema probe against live OpenClaw config.
- Compile manifest → config diff (no writes).
- Reject unsupported fields.
- Round-trip validation.
- Golden tests for sandbox, tools, bindings, schedules, metadata.
- **No live config writes.** This PR proves the compiler understands the config shape.

### PR 4 — Enable + Disable

- `enable` command: validate → dry-run compile → apply.
- `disable` command: remove bindings, schedules, files.
- Gateway config registry read/write.
- Integration tests against a temporary OpenClaw config.

### PR 5 — Test Harness

- Mock model and mock tool implementations.
- Harness runner with real policy path.
- Three required proof tests (external content → exec blocked, secret scope, DNS rebinding).
- Documentation for writing package tests.

### PR 6 — Mutation Detection + Quarantine

- Runtime integrity re-check.
- Quarantine flow: restrict tools, notify operator, present diffs.
- Operator actions: restore, accept mutation, disable package.

### PR 7 — Config Compiler Live Integration

- Wire the dry-run compiler into `enable` with live writes.
- Handle edge cases: partial failures, rollback, concurrent enables.
- Full integration test suite.

### PR 8 — Declarative Upgrade

- `enable --upgrade` flow.
- Field-level diff between old and new manifests.
- `onUpgrade` policy implementation.
- Upgrade tests.

### PR 9 — Documentation + Examples

- Full CLI reference.
- Example package: minimal, standard, and security-hardened.
- Migration guide for existing agent setups.
- Contributor guide for the agent-sdk package.

## Security Considerations

### Supply Chain

- Packages are content-addressed. The integrity manifest proves what was packed.
- Unsigned packages can be blocked by policy (`allowUnsigned: false`).
- Mutation detection catches post-install tampering.

### Instruction File Integrity

Instruction files (AGENTS.md, SOUL.md, etc.) are prompt-layer code. Mutating them is equivalent to changing a script. The `denyMutableInstructionFiles` policy defaults to `true` because:

- A mutable AGENTS.md can redirect the agent to exfiltrate data.
- A mutable SOUL.md can remove safety constraints.
- A mutable HEARTBEAT.md can schedule malicious recurring actions.

If an operator needs editable USER.md, `allowMutableUserInstructionFiles: true` provides a narrow escape hatch without unlocking core behavior.

### No Arbitrary Code

The packaging layer never executes package code. `scripts/` can exist in a package directory but are never auto-executed. The only code that runs is the OpenClaw CLI itself.

### Fail-Closed Defaults

| Setting                            | Default           | Rationale                          |
| ---------------------------------- | ----------------- | ---------------------------------- |
| `denyMutableInstructionFiles`      | `true`            | Prevent prompt-layer code mutation |
| `allowMutableUserInstructionFiles` | `false`           | Narrow override only               |
| `dnsRebindingCheck`                | `true`            | Prevent DNS rebinding attacks      |
| `denyPrivateRanges`                | `true`            | Runtime hard policy                |
| `allowUnsigned`                    | `false`           | Require integrity verification     |
| `redactInTranscripts`              | `true`            | Prevent secret leakage in logs     |
| `onUpgrade`                        | `preserve-custom` | Safe default, no data loss         |

## Open Questions

1. **Multi-agent packages**: Can one package declare multiple agents with separate instruction files and tool scopes? Out of scope for v0.2.
2. **Package registry**: Should OpenClaw host a public package registry? Out of scope. Local and git-based sources only for now.
3. **Skill version pinning**: Should skills declare a version or hash? Likely yes, but needs skill manifest changes first.
4. **Cross-package dependencies**: Can one package depend on another? Out of scope for v0.2.
