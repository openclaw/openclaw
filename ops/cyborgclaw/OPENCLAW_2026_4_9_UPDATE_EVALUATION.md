# OpenClaw 2026.4.9 Update Evaluation

## Official release truth

Verified from official GitHub release and npm registry sources:

- latest stable release: `v2026.4.9`
- npm latest: `2026.4.9`
- current installed runtime before upgrade: `2026.4.5`

## Why this mattered now

CyborgClaw depends on a safe packaged-install upgrade path, not just a newer
CLI binary.

The exact seams that mattered for this host were:

- packaged global install continuity
- gateway service entrypoint continuity
- WhatsApp channel continuity
- `codex` and `voltaris-v2` local-memory continuity
- avoidance of accidental `dev`-channel drift

## Team input

### Real `codex`

- do not blind-upgrade
- capture a rollback bundle first
- verify the actual target because the host config still claimed `dev`
- treat local memory as a hard gate, not a nice-to-have

### Real `voltaris-v2`

- `GO`, provided the update is bounded and verified
- primary risk is the global packaged install path plus bundled
  channel/plugin loading
- dirty and missing secondary agent stores are nuisance noise, not a blocker,
  if `codex` and `voltaris-v2` stay healthy

### Real `president-a`

- `GO`, provided the host gets a real backup and short maintenance window
- packaged-install fixes in `2026.4.8` reduce risk for this host shape
- postflight must explicitly re-verify WhatsApp plus local memory

## Preflight findings on this host

- CLI before upgrade: `OpenClaw 2026.4.5 (3e72c03)`
- gateway before upgrade: reachable, app `2026.4.5`
- gateway service path:
  - global install under `~/.local/lib/node_modules/openclaw`
  - systemd user service pointed at `dist/index.js`
- WhatsApp:
  - linked and connected
- local memory before upgrade:
  - `codex`: healthy (`935` files / `34025` chunks)
  - `voltaris-v2`: healthy (`934` files / `15995` chunks)
- important footgun:
  - `openclaw update status` reported `Channel  dev (config)`
  - a plain `openclaw update` dry run would have installed `openclaw@dev`,
    not stable `2026.4.9`

## Safe path that was used

1. Build a targeted rollback bundle first:
   - config backup archive
   - copied `openclaw.json`
   - copied credentials archive
   - copied systemd unit and drop-ins
   - captured live preflight snapshots (`health`, `doctor`, `gateway probe`,
     `channels status`, `memory status`)
2. Confirm the stable target explicitly:
   - `openclaw update --dry-run --channel stable --json`
3. Apply the update with the stable channel pinned:
   - `openclaw update --channel stable --yes --json`
4. Repair the service + config explicitly after the package update:
   - `openclaw config set update.channel stable`
   - `openclaw gateway install --force`
5. Restore local-memory runtime support:
   - `npm i -g node-llama-cpp@3.18.1`
   - `openclaw gateway restart`
6. Re-run postflight checks until all gates are green:
   - `openclaw gateway probe`
   - `openclaw channels status --probe`
   - `openclaw doctor --non-interactive`
   - `openclaw memory status --agent codex`
   - `openclaw memory status --agent voltaris-v2`
   - one live gateway-mediated agent smoke turn

## What went wrong during the first pass

Two real upgrade seams showed up:

### 1. Update-channel footgun

The host still had `update.channel = dev`.

That meant:

- a plain `openclaw update` would have targeted `openclaw@dev`
- the safe path had to pin `stable` explicitly before treating the update as
  governed

### 2. Local-memory packaging regression

After the `2026.4.9` package update:

- the CLI upgraded successfully
- the gateway upgraded successfully
- but local embeddings failed because `node-llama-cpp` was missing

Observed failure:

- `openclaw doctor --non-interactive` reported local embeddings unavailable
- `openclaw memory status --agent codex` failed with:
  - `Cannot find package 'node-llama-cpp'`

Important release finding:

- the published `openclaw@2026.4.9` package expects:
  - `peerDependencies.node-llama-cpp = 3.18.1`
  - `peerDependenciesMeta.node-llama-cpp.optional = true`
- that means the packaged install does **not** restore local memory on its own
  for this host
- CyborgClaw therefore still needs one explicit recovery step today:
  - `npm i -g node-llama-cpp@3.18.1`

This is the critical truth for future bounded upgrades from `2026.4.9` until
upstream packaging changes again.

## Final verified host state

After the recovery steps:

- CLI: `OpenClaw 2026.4.9 (0512059)`
- gateway probe:
  - reachable
  - app `2026.4.9`
- update status:
  - channel `stable`
  - up to date
- systemd gateway service:
  - active / running
  - `OPENCLAW_SERVICE_VERSION=2026.4.9`
- WhatsApp:
  - linked
  - running
  - connected
- local memory:
  - `codex`: healthy (`935` files / `34025` chunks)
  - `voltaris-v2`: healthy (`934` files / `15995` chunks)
- live smoke turn:
  - gateway-mediated reply returned exactly:
    - `upgrade smoke ok`

## Operational recommendation

### Current verdict

`GO`, with one explicit caveat:

- the host is now healthy on `2026.4.9`
- but the safe cyborgclaw upgrade path is **not** a one-command `openclaw update`
  path yet

### Required future guardrails

Until upstream packaging restores local-memory runtime automatically, the safe
bounded path for CyborgClaw should remain:

1. back up config + service wiring
2. pin `stable`
3. update OpenClaw
4. force-reinstall the gateway service if needed
5. install `node-llama-cpp@3.18.1` globally
6. restart gateway
7. re-verify WhatsApp and `codex` / `voltaris-v2` memory

## Rollback path

If this host regresses later:

1. downgrade the global package:
   - `npm i -g openclaw@2026.4.5 --no-fund --no-audit --loglevel=error`
2. reinstall the gateway service:
   - `openclaw gateway install --force`
3. restart the service:
   - `openclaw gateway restart`
4. re-run:
   - `openclaw gateway probe`
   - `openclaw channels status --probe`
   - `openclaw memory status --agent codex`
   - `openclaw memory status --agent voltaris-v2`

If the downgrade alone is not enough, restore the targeted backup bundle from
before the `2026.4.9` change.
