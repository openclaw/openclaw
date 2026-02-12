---
name: memory-context-pr-evidence
description: Runs memory-context multi-round validation, stress and restart checks, and produces PR-ready evidence. Use when validating compaction/archive/recall behavior or when preparing test proof for a memory-context pull request.
---

# Memory Context PR Evidence

## When to use

- User asks to stress test memory behavior.
- User asks to verify compaction, archive, recall, and boundary cases.
- User asks for PR test evidence or reproducible test records.

## Preconditions

- Gateway is reachable on `ws://127.0.0.1:18789`.
- `OPENCLAW_GATEWAY_TOKEN` is set.
- Build succeeds before test run.

## Standard workflow

1. Build:

```bash
pnpm build
```

2. Start gateway:

```bash
HOME=/root bun openclaw.mjs gateway run --bind loopback --force
```

3. Run boundary suite:

```bash
OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/boundary-test.ts
```

4. Run multi-round stability (recommended: 3 rounds):

```bash
for i in 1 2 3; do
  OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/boundary-test.ts
done
```

5. Optional restart persistence check:

```bash
OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/persistence-recall.ts fill persist-edge-1
# restart gateway
OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" node --import tsx scripts/persistence-recall.ts query persist-edge-1
```

## Pass criteria

- Boundary test has no failures (`❌0 failed`).
- `segments.jsonl` exists and size is greater than 0.
- Gateway remains healthy during stress and boundary traffic.
- Short-query guard test does not show aggressive archive growth.
- Redaction test does not detect plain-text secrets in segments.

## Evidence capture checklist

- Record exact commands and date/time.
- Record summary lines from each run:
  - `Results: ✅x passed ❌y failed ⏭z skipped`
  - `segments.jsonl has content — ... bytes`
- Record multi-round results (at least 3 rounds).
- Record restart/persistence verification steps.
- Save to `docs/testing/memory-context-pr-evidence.md`.

## Notes

- Never commit real tokens; use `OPENCLAW_GATEWAY_TOKEN`.
- If debug instrumentation is disabled, mark extension-load checks as skipped and rely on behavior-based assertions.
