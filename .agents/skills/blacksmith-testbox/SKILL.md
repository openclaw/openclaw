---
name: blacksmith-testbox
description: Use raw Blacksmith Testbox only for backend auth, direct CLI fallback, Blacksmith-specific troubleshooting, or comparison runs when Crabbox is not the right surface.
---

# Blacksmith Testbox

## Scope

For OpenClaw, use the Crabbox skill first. Crabbox is the primary remote-test
front door and can delegate to Blacksmith workers with
`provider: blacksmith-testbox` while preserving OpenClaw-friendly slugs, local
claims, timing summaries, config conventions, and cleanup.

Use raw Blacksmith only when:

- the user explicitly asks for raw Blacksmith behavior;
- Crabbox's Blacksmith wrapper appears to be the thing under test;
- you need Blacksmith CLI auth/install details;
- you need a direct comparison between Crabbox and raw Blacksmith;
- you are debugging a Blacksmith-specific workflow/testbox-step failure.

Do not make raw Blacksmith the normal OpenClaw validation path.

## Install And Auth

Install:

```sh
curl -fsSL https://get.blacksmith.sh | sh
```

Canary:

```sh
BLACKSMITH_CHANNEL=canary sh -c 'curl -fsSL https://get.blacksmith.sh | sh'
```

Interactive auth:

```sh
blacksmith auth login
```

Agent-triggered browser auth:

```sh
blacksmith auth login --non-interactive --organization <org-slug>
```

The org slug can come from `BLACKSMITH_ORG`, `--org`, repo config, or user
context. Do not use `--api-token` for browser auth; that flag is for
headless/token-based auth.

## Preferred OpenClaw Path

Use Crabbox with the Blacksmith provider:

```sh
pnpm crabbox:warmup -- --provider blacksmith-testbox --blacksmith-workflow .github/workflows/ci-check-testbox.yml --blacksmith-ref main --idle-timeout 90m
pnpm crabbox:run -- --provider blacksmith-testbox --id <tbx_id-or-slug> --shell "OPENCLAW_TESTBOX=1 pnpm check:changed"
pnpm crabbox:stop -- --provider blacksmith-testbox <tbx_id-or-slug>
```

For the full suite:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --id <tbx_id-or-slug> --shell "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test"
```

For installable-package product proof, prefer the GitHub `Package Acceptance`
workflow over an ad hoc Testbox command.

## Raw CLI Fallback

Run from the repository root. The Blacksmith CLI syncs the current working
directory to the Testbox using rsync with delete semantics; invoking it from a
subdirectory can wipe the rest of the remote checkout.

Warm:

```sh
blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90
```

Run:

```sh
blacksmith testbox run --id <tbx_id> "OPENCLAW_TESTBOX=1 pnpm check:changed"
```

Download artifacts:

```sh
blacksmith testbox download --id <tbx_id> coverage/ ./coverage/
```

Stop:

```sh
blacksmith testbox stop --id <tbx_id>
```

## Direct CLI Footguns

- `blacksmith testbox list` is diagnostics, not a reusable work queue.
- Listed boxes can be stale for the current local agent lane.
- Raw Blacksmith does not provide Crabbox's local slug/claim cleanup.
- If dependency manifests changed, rerun install inside the box before testing.
- `.gitignore`d directories such as `node_modules`, `dist`, and build caches are
  not synced from local; they must exist from warmup or be rebuilt remotely.
- Testboxes automatically shut down after idle timeout, defaulting to 30
  minutes unless warmup sets a longer timeout.
