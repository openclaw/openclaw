# Deploying Our Fork to Skyhigh

## Golden Rule

**Always use the repo's own Dockerfile to build.** Never write a custom one. The official
Dockerfile handles Node version, native deps, pnpm workspace layout, plugin resolution,
and entrypoint setup. All of these are tightly coupled.

## How to Build & Deploy

```bash
# 1. Push changes to the fork
git push origin feature/deny-from

# 2. On skyhigh: clone and build using the repo's Dockerfile
ssh kalyan@10.0.0.70
cd /tmp && rm -rf openclaw-build
git clone --depth 1 --branch feature/deny-from https://github.com/kalven22/openclaw.git openclaw-build
cd openclaw-build
docker build --no-cache -t openclaw-custom:latest .
rm -rf /tmp/openclaw-build

# 3. Recreate the container
cd /home/kalyan/code/homeserver
set -a && eval $(grep -v '^#' .env | grep -v 'USER_AGENT' | sed 's/=\(.*\)/="\1"/') && set +a
docker stop openclaw-gateway && docker rm openclaw-gateway
docker compose up -d openclaw-gateway
```

## Compose Entry Point

The compose file (`compose/homeserver/openclaw.yml`) must use `openclaw.mjs`, NOT `dist/index.js`.
The official image uses `openclaw.mjs` which does Node version checks, compile cache setup,
and imports `dist/entry.js`. Using `dist/index.js` directly skips initialization and can
cause Baileys event listeners to not fire (messages received but no inbound events).

## Sync Fork with Upstream

```bash
cd ~/code/openclaw
git fetch upstream
git checkout main && git merge upstream/main --ff-only && git push origin main
git checkout feature/deny-from && git rebase main && git push origin feature/deny-from --force-with-lease
```

Then rebuild and deploy (steps above).

## Watchtower

Watchtower CANNOT update locally-built images. It only pulls from registries.
Once the upstream PR (openclaw/openclaw#63302) is merged, revert the Dockerfile
to `FROM ghcr.io/openclaw/openclaw:latest` and Watchtower will handle updates again.

---

## Mistakes We Made (Don't Repeat)

### 1. Never hot-swap dist files into a running container

We tried `docker cp dist/ openclaw-gateway:/app/dist/` — this breaks because:

- Built dist files have hashed filenames (e.g., `dm-policy-shared-dViK6mWl.js`)
- Different builds produce different hashes
- The entry point, extensions, and node_modules all reference specific hashes
- Mixing dist from one build with extensions/node_modules from another = broken imports

### 2. Never write a custom Dockerfile

We tried multiple custom Dockerfiles with `FROM node:22-slim` / `FROM node:24-slim`.
Every one failed because:

- Wrong Node version (official uses Node 24 pinned to specific digest)
- pnpm prune failed due to lockfile issues after rebase
- node_modules from `pnpm install` in our build had different structure than expected
- Missing `docker-entrypoint.sh`, tini setup, Corepack config, etc.
- Baileys connected but event listeners didn't fire (messages never received)

**The official Dockerfile handles all of this.** Just use it.

### 3. Never mix versions (dist + extensions + node_modules must match)

We tried overlaying our dist/extensions onto the official base image (2026.4.1):

- Extensions from 2026.4.9 required `>=2026.4.9` in package.json
- node_modules/acpx from 2026.4.1 was incompatible with 2026.4.9 extensions
- Plugin SDK resolution paths (`root-alias.cjs`) changed between versions

Everything in `/app/` is tightly coupled. Treat it as one unit.

### 4. Schema changes require regenerating generated files

Adding a field to a Zod schema (e.g., `denyFrom` in `zod-schema.providers-whatsapp.ts`)
is NOT enough. You must also:

```bash
node --import tsx scripts/generate-bundled-channel-config-metadata.ts --write
node --import tsx scripts/generate-base-config-schema.ts --write
pnpm config:docs:gen
pnpm build
```

Without this, `openclaw config set` and `openclaw config validate` will reject the
new field as "additional properties" even though the Zod schema accepts it.

### 5. isSenderAllowed has a self-chat bypass

The `isSenderAllowed` callback in WhatsApp access control has:

```typescript
if (!params.group && isSamePhone) return true;
```

This means calling `isSenderAllowed(denyFrom)` returns `true` for self-messages,
blocking the owner. Use a separate `isSenderDenied` callback for deny checks that
does pure E164 matching without wildcards or self-chat shortcuts.

### 6. Test each step before moving on

We repeatedly built → deployed → discovered issues → rebuilt → redeployed in a loop.
Instead: build → verify locally (tests, typecheck) → deploy → test ONE thing → proceed.

---

## Current Config on Skyhigh

- **Provider:** MapleFlow (OpenAI-compatible) at `https://api.mapleflow.io/v1`
- **Model:** `openai/llama-3.1-8b` (Groq via MapleFlow, cheapest, fastest)
- **Heartbeat: DISABLED** (`agents.defaults.heartbeat.every: "0m"`) — see Gotcha #7
- Debounce: `5000ms`
- DM History Limit: `20` messages
- denyFrom: `["14379749558", "15093369948", "16468741906", "18573342767"]`
- dmPolicy: `open`
- allowFrom: `["*"]`

Canonical baseline is committed as `config.baseline.json` in the repo. On a fresh skyhigh deploy, copy that to `$OPENCLAW_CONFIG_DIR/openclaw.json` (currently `/home/kalyan/logs/docker/appdata/openclaw/config/openclaw.json`) and set `OPENAI_API_KEY` in `~/code/homeserver/.env` to the MapleFlow `sk_live_*` token.

## Gotcha #7 — Default Heartbeat Burns Money

OpenClaw's default heartbeat fires the primary model every **30 minutes** even with zero
inbound traffic. That's 48 LLM calls/day doing nothing useful. On April 2026 this caused
~$15 of unexplained OpenAI spend before detection.

**Always** set `agents.defaults.heartbeat.every: "0m"` on fresh deployments. It is included
in `config.baseline.json`. Config change hot-reloads; no rebuild required:

```bash
docker exec openclaw-gateway openclaw config set agents.defaults.heartbeat.every "0m"
docker compose restart openclaw-gateway
```

Verify in logs: `docker logs openclaw-gateway | grep -i heartbeat` should show `[heartbeat] disabled`.
