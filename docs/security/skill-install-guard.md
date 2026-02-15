# Skill Install Security Guard (Proposal)

## Problem

OpenClaw skills can be installed quickly via marketplace tooling (`clawhub install <slug>`), but secure usage currently depends on user discipline (manual pre-install audit).

In practice, this creates a supply-chain gap:

- users skip audits under time pressure
- assistants may forget process-only rules
- suspicious packages can be installed before review

## Goal

Make pre-install security auditing the **default path**, not a memory-based workflow.

## Proposed Core Behavior

### 1) Add a built-in guard command

Introduce a first-party command in OpenClaw/ClawHub flow:

```bash
openclaw skills install-safe <slug>
```

Behavior:

1. inspect skill files from registry (without install)
2. run policy-based static scan
3. optionally run dynamic probe for higher risk categories
4. block installation unless verdict policy allows it
5. emit machine-readable audit report + human summary

### 2) Optional hard-enforcement mode

Config option:

```json
{
  "skills": {
    "installGuard": {
      "enabled": true,
      "mode": "enforce"
    }
  }
}
```

When enabled, `clawhub install` from within OpenClaw contexts should route through the guard automatically.

### 3) Verdict model

Keep decisions explicit:

- `APPROVED` → install allowed
- `CAUTION` → require explicit human confirmation
- `REJECT` → blocked

### 4) Logs + provenance

Persist report in workspace/logs with:

- slug/version
- policy profile
- findings summary
- verdict
- timestamp

## Why this helps

- removes fragile “remember to audit” behavior
- reduces malicious skill blast radius
- gives consistent policy outcomes across users/agents
- keeps fast path for trusted installs with explicit approval

## Backwards Compatibility

- default can remain permissive initially (`mode: warn`)
- teams can opt into `mode: enforce`
- no breaking changes to existing skill format

## Reference Implementation (community)

A community implementation already exists in the `skill-check` skill as wrapper scripts (`safe_install.sh` + shell guard), proving feasibility with current tools.

This proposal asks to move that behavior into OpenClaw core so all users get secure-by-default installs without custom setup.
