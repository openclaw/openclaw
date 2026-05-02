---
name: crabbox
description: Use Crabbox as the primary OpenClaw remote validation path, including Blacksmith-backed workers, warmed reusable boxes, GitHub Actions hydration, sync timing, logs, results, caches, and lease cleanup.
---

# Crabbox

Use Crabbox when OpenClaw needs remote Linux proof. Crabbox is the default
front door for broad maintainer validation and can run on owned AWS/Hetzner
capacity or delegate to Blacksmith workers with `provider: blacksmith-testbox`.

## Before Running

- Run from the repo root. Crabbox sync mirrors the current checkout.
- Prefer local targeted tests for tight edit loops.
- Prefer Crabbox for broad OpenClaw gates. Use `provider: blacksmith-testbox`
  when the desired backend is Blacksmith.
- Use the Blacksmith Testbox skill only for raw CLI fallback, auth details, or
  Blacksmith-specific comparison/debugging.
- Check `.crabbox.yaml` for repo defaults before adding flags.
- Install with `brew install openclaw/tap/crabbox`; auth is required before use:
  `printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login --url https://crabbox-coordinator.steipete.workers.dev --provider aws --token-stdin`.
- On macOS the user config is `~/Library/Application Support/crabbox/config.yaml`;
  it must include `broker.url`, `broker.token`, and usually `provider: aws`.

## OpenClaw Flow

For Blacksmith-backed workers, either set `provider: blacksmith-testbox` in
`.crabbox.yaml` or pass it on the command line:

```sh
pnpm crabbox:warmup -- --provider blacksmith-testbox --blacksmith-workflow .github/workflows/ci-check-testbox.yml --blacksmith-ref main --idle-timeout 90m
```

Warm a reusable box:

```sh
pnpm crabbox:warmup -- --idle-timeout 90m
```

Hydrate it through the repository workflow:

```sh
pnpm crabbox:hydrate -- --id <cbx_id-or-slug>
```

Run broad proof:

```sh
pnpm crabbox:run -- --id <cbx_id-or-slug> --shell "OPENCLAW_TESTBOX=1 pnpm check:changed"
pnpm crabbox:run -- --id <cbx_id-or-slug> --shell "corepack enable && pnpm install --frozen-lockfile && pnpm test"
```

For a Blacksmith-backed full suite:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --id <tbx_id-or-slug> --shell "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test"
```

Stop boxes you created before handoff:

```sh
pnpm crabbox:stop -- <cbx_id-or-slug>
```

## Useful Commands

```sh
crabbox status --id <id-or-slug> --wait
crabbox inspect --id <id-or-slug> --json
crabbox sync-plan
crabbox history --lease <id-or-slug>
crabbox logs <run_id>
crabbox results <run_id>
crabbox cache stats --id <id-or-slug>
crabbox ssh --id <id-or-slug>
```

Use `--debug` on `run` when measuring sync timing.

## Hydration Boundary

`.github/workflows/crabbox-hydrate.yml` is repo-specific on purpose. It owns
OpenClaw checkout, setup-node, pnpm setup, provider env hydration, ready marker,
and keepalive. Crabbox owns runner registration, workflow dispatch, SSH sync,
command execution, logs/results, local lease claims, and idle cleanup.

Do not add OpenClaw-specific setup to Crabbox. Put repo setup in the hydration
workflow and generic lease/sync behavior in Crabbox.

## Cleanup

Crabbox has coordinator-owned idle expiry and local lease claims, so OpenClaw
does not need a custom ledger. Default idle timeout is 30 minutes unless config
or flags set a different value. Still stop boxes you created when done.
