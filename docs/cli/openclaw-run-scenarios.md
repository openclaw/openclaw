---
summary: "Scenario-based OpenClaw command playbook for setup, development, diagnostics, and validation"
read_when:
  - You want a practical command flow by task scenario
  - You need the shortest safe command sequence for daily use
  - You are unsure whether to run targeted checks or broad gates
title: "Run scenarios"
---

# `openclaw` run scenarios

Use this page when you want a fast, scenario-based command checklist instead of browsing each CLI command page individually.

## Scenario 1: First run on a machine

Goal: install state, onboard, and confirm the Gateway is healthy.

```bash
pnpm install
pnpm openclaw onboard --install-daemon
pnpm openclaw gateway status --deep
pnpm openclaw dashboard
```

Why this sequence:

- `onboard` sets up provider auth and baseline config.
- `gateway status --deep` verifies process and RPC reachability.
- `dashboard` confirms Control UI is reachable.

## Scenario 2: Daily local development loop

Goal: make changes and verify quickly with low-cost local checks.

```bash
pnpm dev
pnpm test <path-or-filter>
pnpm openclaw gateway status --deep
```

Typical examples:

```bash
pnpm test src/cli/gateway.status.test.ts
pnpm test test/cli/gateway.e2e.test.ts
```

Why this sequence:

- `pnpm dev` keeps the local loop fast.
- Targeted `pnpm test ...` proves touched behavior without broad fanout.
- `gateway status --deep` catches runtime drift early.

## Scenario 3: Gateway troubleshooting

Goal: isolate whether the problem is process state, network reachability, or auth scope.

```bash
pnpm openclaw gateway status --deep --require-rpc
pnpm openclaw gateway probe --json
pnpm openclaw gateway health --json
pnpm openclaw logs
```

Use this when:

- the Gateway appears up but calls fail,
- auth capability changed after config edits,
- local and remote endpoints disagree.

## Scenario 4: Before commit or push (code changes)

Goal: validate changed surfaces before handoff.

```bash
pnpm changed:lanes --json
pnpm check:changed
```

When to expand:

```bash
pnpm build
```

Run `pnpm build` when packaging, module boundaries, lazy imports, or published surfaces changed.

## Scenario 5: Docs-only changes

Goal: verify docs edits without triggering unnecessary broad checks.

```bash
pnpm docs:list
git diff --check
```

If docs automation or generated artifacts are touched, run the related docs checks required by that workflow.

## Scenario 6: Service lifecycle operations

Goal: operate the managed Gateway service safely.

```bash
pnpm openclaw gateway restart
pnpm openclaw gateway status --deep
```

Preferred restart path:

- Use `gateway restart` directly.
- Do not replace restart with a manual `stop` then `start` sequence.

## Quick decision table

Use this rule of thumb:

- Editing one or a few files: `pnpm test <target>` first.
- Cross-cutting behavior or config: `pnpm check:changed`.
- Build/runtime boundary touched: add `pnpm build`.
- Runtime issues: start from `gateway status --deep --require-rpc`.

## Related

- [CLI reference](/cli)
- [Gateway](/cli/gateway)
- [Getting started](/start/getting-started)
- [Testing reference](/reference/test)
