# Copilot SDK spike workspace

This standalone workspace probes `@github/copilot-sdk@1.0.0-beta.4` without changing the OpenClaw root workspace.

## Scripts

- `pnpm spike:install` - install the spike-local dependency set and write `pnpm-lock.yaml` in this directory.
- `pnpm spike:run` - run the one-turn smoke script in `spike.mjs`.
- `pnpm spike:probe` - run all ten SDK capability probes in `probe.mjs`.

## Recommended usage

From WSL:

```bash
cd /mnt/c/Users/ramrajba/openclaw/qa/copilot-sdk-spike
pnpm install
node spike.mjs --dry-run
node probe.mjs
```

The default `spike.mjs` and `probe.mjs` flows are non-live. Set `OPENCLAW_LIVE_TEST=1` to opt into live model calls:

```bash
OPENCLAW_LIVE_TEST=1 node spike.mjs
OPENCLAW_LIVE_TEST=1 node probe.mjs
```

## Live-cost guardrails

- Live probes are skipped unless `OPENCLAW_LIVE_TEST=1` is set.
- `probe.mjs` logs a per-probe estimated token ceiling before each live probe.
- The runner hard-stops when the cumulative estimated token budget for one `probe.mjs` invocation would exceed 5000 tokens.
- Probe `q7` is capped at 200 estimated tokens; every other live probe is capped at 1000.
- Keep live runs under the task-level USD 1 cap and stop if the observed SDK usage looks higher than expected.

## Output files

- `probe-output/q<n>-<slug>.json` - one JSON result per probe.
- `probe-output/q<n>-<slug>.log` - probe-local execution log.
- `probe-output/RUN-<utc>.json` - one summary record for each probe run.
- `probe-output/SUMMARY.md` - committed placeholder until a real probe run is reviewed.
