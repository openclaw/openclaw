---
title: Custom Downstream Maintenance
summary: "Runbook for keeping local OpenClaw customizations alive across upstream updates"
---

# Goal

This repository currently contains custom downstream changes that are not part of stock OpenClaw.

At the time of writing, the important custom areas are:

- Azure OpenAI Responses support for custom/provider setup
- Azure-specific model support updates
  - `gpt-5.4`
  - `gpt-realtime-mini`
  - `gpt-realtime-1.5`
- Jitsi realtime bridge
- Telegram `/jitsi` control flow for the Jitsi bridge

The goal is to stop losing these changes whenever `openclaw update` or a fresh upstream install overwrites the local installation.

# Operating Principle

Do not treat the installed OpenClaw package as the source of truth.

Instead:

1. Maintain a source repository that contains all custom changes.
2. Pull upstream changes into that repository.
3. Reapply or rebase the custom patch stack there.
4. Run smoke tests.
5. Build a package from source.
6. Deploy that package to the target host.

Do not use `openclaw update` as the primary upgrade path for customized installations.

# Recommended Repository Layout

Use a dedicated fork or downstream repo.

Suggested remotes:

- `origin`: your fork/downstream repo
- `upstream`: the official OpenClaw repo

Suggested branch model:

- `main`: your production downstream branch
- `upstream-main`: optional tracking branch mirroring upstream `main`
- feature branches for new local patches

Example:

```bash
git remote add upstream <OFFICIAL_OPENCLAW_REMOTE>
git fetch upstream
git checkout main
git merge upstream/main
```

If history cleanliness matters more than merge preservation, use `rebase` instead of `merge`.

# Patch Strategy

Do not keep all local modifications in one large commit.

Split the custom work into small, stable commits. Recommended grouping:

1. `azure-responses-support`
   - custom provider/onboarding support
   - Azure responses-specific runtime handling

2. `azure-model-forward-compat`
   - `gpt-5.4`
   - Azure reasoning/thinking compatibility
   - model filtering/catalog updates

3. `azure-realtime-models`
   - `gpt-realtime-mini`
   - `gpt-realtime-1.5`

4. `jitsi-realtime-bridge`
   - bridge service
   - browser joiner
   - realtime audio/text client

5. `telegram-jitsi-command`
   - `/jitsi` command
   - Telegram config/schema additions

This keeps rebases understandable and reduces conflict size.

# Backup Strategy

Keep a patch export in addition to git history.

Recommended:

```bash
mkdir -p patches
git format-patch upstream/main..main -o patches
```

That gives you a reapply path even if the working clone is lost.

To restore on top of a fresh upstream checkout:

```bash
git am patches/*.patch
```

If `git am` fails because upstream changed too much, replay the affected patch manually and regenerate the patch series.

# Update Workflow

When upstream releases a new version, use this flow.

## 1. Sync upstream

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

Or:

```bash
git fetch upstream
git checkout main
git rebase upstream/main
```

## 2. Resolve conflicts by patch area

Handle conflicts in this order:

1. Azure provider/runtime changes
2. model catalog/forward-compat changes
3. Jitsi bridge changes
4. Telegram `/jitsi` integration

This order matters because later pieces depend on earlier runtime/config work.

## 3. Run focused tests

At minimum, rerun the targeted checks for the customized areas:

```bash
pnpm vitest run \
  src/commands/onboard-custom.test.ts \
  src/auto-reply/thinking.test.ts \
  src/agents/model-compat.test.ts \
  src/agents/model-catalog.test.ts \
  src/agents/pi-embedded-runner/model.forward-compat.test.ts \
  src/telegram/jitsi-command.test.ts
```

If the bridge code changed, also run:

```bash
pnpm vitest run \
  src/jitsi-bridge/jitsi-url.test.ts \
  src/jitsi-bridge/room-store.test.ts \
  src/jitsi-bridge/audio.test.ts
```

## 4. Run local smoke tests

### Azure Responses

Verify a normal text turn:

```bash
node --import tsx scripts/jitsi-realtime-probe.ts 'Sag nur OK.'
```

This requires:

- `AZURE_OPENAI_REALTIME_BASE_URL`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_REALTIME_MODEL`

### Jitsi bridge

Start the bridge:

```bash
node --import tsx scripts/jitsi-bridge-server.ts
```

Then verify:

- `GET /health`
- `POST /rooms`
- `POST /rooms/:roomId/briefing`
- `POST /rooms/:roomId/respond`
- `POST /rooms/:roomId/join`

### Telegram `/jitsi`

Verify that:

- Telegram config contains `channels.telegram.jitsi.bridgeUrl`
- the running bot registers `/jitsi`
- the Telegram command menu includes `jitsi`

Direct API check:

```bash
https://api.telegram.org/bot<token>/getMyCommands
```

# Build And Deploy

## Build package

From the source repo:

```bash
corepack pnpm pack
```

This produces a tarball such as:

```text
openclaw-2026.3.13.tgz
```

## Deploy package to target host

Example host:

```text
jakob@192.168.179.3
```

Copy:

```bash
rsync -az openclaw-<VERSION>.tgz user@gateway-host:/home/user/
```

Install:

```bash
ssh user@gateway-host 'npm install -g /home/user/openclaw-<VERSION>.tgz'
```

## Restart services

Restart the OpenClaw gateway:

```bash
ssh user@gateway-host '~/.npm-global/bin/openclaw gateway stop'
ssh user@gateway-host 'nohup ~/.npm-global/bin/openclaw gateway >/home/user/openclaw-gateway.log 2>&1 &'
```

Restart the Jitsi bridge if used:

```bash
ssh user@gateway-host 'nohup bash -lc "cd /home/user/openclaw-src && node --import tsx scripts/jitsi-bridge-server.ts" >/home/user/jitsi-bridge.log 2>&1 &'
```

# Required Host Configuration

The target host should keep its runtime config in `~/.openclaw/openclaw.json`.

Important sections:

## Azure model/provider config

- `models.providers.azure-openai-responses`
- `api: "azure-openai-responses"`
- `baseUrl: "https://<resource>.openai.azure.com/openai/v1"`
- `headers: { "api-key": "..." }`
- `authHeader: false`

## Telegram Jitsi config

Example:

```json
{
  "channels": {
    "telegram": {
      "jitsi": {
        "enabled": true,
        "bridgeUrl": "http://127.0.0.1:4318",
        "autoJoin": true,
        "inviteEmail": "assistant@example.com",
        "realtimeModel": "gpt-realtime-mini"
      }
    }
  }
}
```

# Smoke Test Checklist For A Target Host

Run this after every deployment.

## 1. OpenClaw gateway health

```bash
openclaw health
```

Expected:

- Telegram channel healthy
- agent available

## 2. Azure realtime models

Run both:

```bash
AZURE_OPENAI_REALTIME_MODEL=gpt-realtime-mini node --import tsx scripts/jitsi-realtime-probe.ts 'Sag nur OK.'
AZURE_OPENAI_REALTIME_MODEL=gpt-realtime-1.5 node --import tsx scripts/jitsi-realtime-probe.ts 'Sag nur OK.'
```

Expected:

- both return `OK.`

## 3. Jitsi bridge health

```bash
curl http://127.0.0.1:4318/health
```

Expected:

- `{"ok":true}`

## 4. Jitsi room flow

Verify:

- room creation works
- briefing update works
- `/respond` returns text
- `/join` writes a screenshot artifact under `.artifacts/jitsi-realtime-bridge`

## 5. Telegram command menu

Verify:

- `/jitsi` is present in `getMyCommands`

## 6. Telegram live DM test

From Telegram, send:

```text
/jitsi start Investor Briefing
```

Then verify:

- bot replies with room id + Jitsi URL
- joiner starts
- room status becomes `joining`

# What Not To Do

Do not rely on these as the primary maintenance workflow:

- editing installed files directly under the global npm location
- manually redoing changes after each `openclaw update`
- using a host as the only copy of the custom work
- mixing unrelated downstream changes into one unstructured commit

# Minimum Durable Setup

If time is limited, at least do this:

1. Keep the custom source tree in git.
2. Keep a patch export under `patches/`.
3. Build with `pnpm pack`.
4. Deploy the tarball manually to each target host.
5. Run the smoke tests above after every deployment.

# Best Durable Setup

For a more stable long-term path:

1. Maintain a real fork.
2. Keep the patch stack split by feature area.
3. Add a release script, for example:
   - `scripts/release-192.168.179.3.sh`
4. Add a remote smoke-test script, for example:
   - `scripts/smoke-test-192.168.179.3.sh`
5. Upstream generic Azure support where possible so the downstream patch set shrinks over time.
