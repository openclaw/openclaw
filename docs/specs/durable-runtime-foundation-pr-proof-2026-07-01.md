# Durable Runtime Foundation PR Proof - 2026-07-01

## Scope

This proof covers the durable runtime foundation slice only. It intentionally
does not include Workboard UI, Workboard tools, Work module behavior, or Task
Flow projection adapters.

The PR2 foundation slice includes:

- `durable_runtime_*` tables in the shared OpenClaw state database;
- SQLite store lifecycle, schema version checks, private-mode state hardening,
  and Kysely generated type alignment;
- runtime run, step, event, ref, link, timer, and signal primitives;
- local-first claim/release, heartbeat, recovery, and bounded worker helpers;
- read-only CLI/Gateway inspection surfaces;
- generic coordination projection with unsupported write controls disabled.

## Review Boundary

This branch depends on the RFC v2 docs branch for the architecture decision. It
is intentionally a local-first, opt-in runtime substrate:

- feature flag: `OPENCLAW_DURABLE_RUNTIME`;
- default behavior: disabled;
- storage home: shared `state/openclaw.sqlite`;
- initial API posture: read-only inspection and recovery markers;
- non-goal: automatic retry/resume policy or product-specific task/card UI.

## Validation Checklist

Update this section immediately before opening the PR with exact command output:

- durable unit tests;
- gateway durable/context-ref tests;
- shared state upgrade/schema tests;
- `node scripts/generate-kysely-types.mjs --verify`;
- `node scripts/check-kysely-guardrails.mjs`;
- `npm run tsgo:core`;
- `npm run tsgo:core:test`;
- `npm run build`;
- `git diff --check`;
- isolated enabled-runtime proof for timeline/projection/recovery;
- disabled-runtime proof that read paths do not create durable state.

## Known Follow-Ups

- PR3 wires this foundation into agent/session/subagent runtime paths.
- Work module, Workboard UI, Task Flow projection, retention/compaction, and
  write controls remain follow-up PRs.
