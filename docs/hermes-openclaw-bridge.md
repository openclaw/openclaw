---
title: Hermes OpenClaw Bridge
summary: Safe local bridge where Hermes plans and OpenClaw executes approved task templates.
read_when:
  - Integrating Hermes Agent with OpenClaw locally
  - Running the Hermes bridge mock demo
  - Reviewing bridge trust boundaries, setup, and limitations
---

# Hermes OpenClaw Bridge

This integration keeps Hermes Agent and OpenClaw in separate runtimes. Hermes is the persistent personal assistant layer: planner, memory owner, scheduler, preference store, and delegator. OpenClaw is the gateway and execution layer: channel routing, authentication, tool policy, plugins, task execution, and status reporting.

The first implementation is the bundled OpenClaw plugin `hermes-bridge` under `extensions/hermes-bridge`. It uses OpenClaw's native plugin SDK because that is the least invasive safe integration point. The plugin SDK already provides a Gateway-authenticated HTTP route and optional agent tool registration, so the bridge does not need core gateway protocol changes, WebSocket changes, raw `/tools/invoke`, or a CLI wrapper.

The real Hermes Agent repository is cloned locally for this integration. Mock Hermes clients remain only for automated tests and offline demos; they are not the completion state for the real integration.

## Real Hermes Checkout

Required local checkout:

- Path: `../hermes-agent`
- Remote: `https://github.com/NousResearch/hermes-agent.git`
- Commit: `745c4db235bdb09beb19564f66727dc1f43e4fe2`

Preflight and clone commands:

```bash
git --version
GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/NousResearch/hermes-agent.git HEAD
git clone https://github.com/NousResearch/hermes-agent.git ../hermes-agent
git -C ../hermes-agent rev-parse HEAD
git -C ../hermes-agent remote -v
```

If `../hermes-agent` already exists, do not overwrite it. It must be a git worktree whose `origin` remote is the official NousResearch repo above. If the directory exists but is not a git repo, or the remote differs, stop and report `BLOCKED`.

## Data Flow

1. Hermes builds a structured task request with `requestedBy: "hermes"`, `taskId`, `intent`, `priority`, `requiresConfirmation`, `allowedTools`, `input`, `dryRun`, and optional `idempotencyKey`.
2. Hermes sends the request to OpenClaw's plugin route:

   ```http
   POST /api/plugins/hermes-bridge/tasks
   Authorization: Bearer <gateway-token>
   x-openclaw-hermes-token: <bridge-token>
   Content-Type: application/json
   ```

3. OpenClaw verifies normal Gateway auth before the route runs.
4. The plugin verifies the Hermes bridge token from `OPENCLAW_HERMES_BRIDGE_TOKEN`.
5. The plugin validates the request schema, task allowlist, required tool allowlist, confirmation flag, and dry-run/mock execution mode.
6. The plugin executes only a declared task template and returns a structured result. Current task templates are mock-safe dry-run templates.

## Trust Boundaries

Gateway auth and the Hermes bridge token are separate controls. Do not reuse the same token for both.

Hermes may request only task template IDs, not arbitrary OpenClaw tool names. OpenClaw decides which template IDs are enabled through `allowedTasks`, and which underlying tool capabilities a template may use through `allowedTools`.

The v1 bridge has no real external side effects. Tests and the demo use dry-run mocks only. In `hermesMode: "real"`, non-dry-run requests for mock-only templates fail closed with `real_task_unavailable` instead of silently falling back to mock execution.

## Request Schema

```json
{
  "taskId": "message.preview",
  "requestedBy": "hermes",
  "intent": "Preview a Telegram reply without sending it.",
  "priority": "normal",
  "requiresConfirmation": false,
  "allowedTools": [],
  "input": {
    "channel": "telegram",
    "recipient": "@local-user",
    "body": "hello"
  },
  "dryRun": true,
  "idempotencyKey": "optional-dedup-key"
}
```

## Result Schema

```json
{
  "ok": true,
  "idempotencyKey": "optional-dedup-key",
  "taskId": "message.preview",
  "mode": "mock",
  "status": "succeeded",
  "summary": "Hermes bridge task succeeded: message.preview",
  "artifacts": [],
  "auditLog": [
    {
      "step": "accepted",
      "message": "Accepted Hermes task message.preview.",
      "at": "1970-01-01T00:00:00.000Z"
    }
  ],
  "output": {
    "preview": {
      "channel": "telegram",
      "recipient": "@local-user",
      "body": "hello",
      "wouldSend": false
    }
  }
}
```

## V1 Task Templates

- `status.echo`: returns `input.message`.
- `status.health`: returns bridge health metadata.
- `message.preview`: builds a message preview and never sends it.
- `tasks.organize_today`: accepts the MVP Hermes request to organize today's tasks, requires `dryRun: true`, requires no tools, and returns `summary: "Dry-run completed. No external side effects were performed."`
- `agents.ask_team`: accepts a dry-run OpenClaw agent team delegation request, requires `dryRun: true`, requires no tools, does not start live agents, and returns `summary: "Dry-run completed. No OpenClaw agents were started."`
- `message.send`: mock-only future send template. It requires `requiresConfirmation: true` and `telegram.send` in both bridge config `allowedTools` and request `allowedTools`; it still never sends a message in v1.

## Local Configuration

Set environment variables in process env, `.env`, or `~/.openclaw/.env`:

```bash
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_HERMES_BRIDGE_TOKEN=
HERMES_AGENT_PATH=../hermes-agent
HERMES_MODE=mock
OPENCLAW_GATEWAY_URL=http://127.0.0.1:1455
# HERMES_HOME=~/.hermes
```

Run the real Hermes presence check:

```bash
HERMES_AGENT_PATH=../hermes-agent COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:agent:check
```

The check reads `HERMES_AGENT_PATH`, verifies the path exists, verifies it is a git repo, verifies the official remote, and prints the commit hash. It performs no sends, no provider calls, no calendar or trading operations, no filesystem mutation, and no secret reads beyond normal environment access.

Enable the plugin explicitly in OpenClaw config:

```json
{
  "plugins": {
    "hermes-bridge": {
      "enabled": true,
      "mode": "mock",
      "hermesMode": "real",
      "hermesAgentPath": "../hermes-agent",
      "sharedSecretEnv": "OPENCLAW_HERMES_BRIDGE_TOKEN",
      "allowedTasks": [
        "status.echo",
        "status.health",
        "message.preview",
        "tasks.organize_today",
        "agents.ask_team"
      ],
      "allowedTools": [],
      "maxRequestBytes": 65536
    }
  }
}
```

## Mock Demo

Run the dry-run mock demo from the repo root:

```bash
COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo
```

The demo uses `createMockHermesClient` and `createMockOpenClawBridge` to show Hermes delegating a `tasks.organize_today` dry-run task and receiving a structured OpenClaw result. It is for tests and offline demos only; it is not a substitute for the real `../hermes-agent` clone and presence check.

## Real Runtime Adapter Status

The real Hermes checkout is present and wired into configuration through `HERMES_AGENT_PATH`, `hermesAgentPath`, and the presence check. The Hermes README documents CLI, gateway, scheduler, tools, skills, memory, and migration behavior, but this bridge does not yet rely on an undocumented Hermes runtime delegation API.

The next implementation step is a Hermes-side adapter that emits the HTTP request schema above from the real Hermes runtime. Until that adapter is implemented and documented, OpenClaw's bridge keeps real mode fail-closed for non-dry-run mock-only requests.

OpenClaw also has Hermes migration docs and a plugin-owned migration provider surface for importing Hermes state into OpenClaw. That is separate from this bridge: migration moves state after preview, while the bridge keeps Hermes and OpenClaw in separate runtimes and lets Hermes delegate approved tasks at runtime.

## Troubleshooting

- `missing_secret`: set `OPENCLAW_HERMES_BRIDGE_TOKEN` in the Gateway environment.
- `invalid_token`: the `x-openclaw-hermes-token` header does not match the configured env var.
- `task_not_allowed`: add the task template ID to `allowedTasks`.
- `tool_not_allowed`: add the template's required tool capability to both config `allowedTools` and request `allowedTools`.
- `confirmation_required`: set `requiresConfirmation: true` only after the operator has explicitly approved the task.
- `real_task_unavailable`: `hermesMode` is `real`, but the selected task has only a mock/dry-run executor. Add a real task adapter with tests before allowing non-dry-run execution.
- `BLOCKED`: report this when the mandatory `git --version`, `git ls-remote`, clone, `rev-parse`, remote verification, or presence check fails.

## Smoke Tests

```bash
git -C ../hermes-agent rev-parse HEAD
git -C ../hermes-agent remote -v
HERMES_AGENT_PATH=../hermes-agent COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:agent:check
COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo
COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge
COREPACK_HOME=/private/tmp/corepack corepack pnpm test test/scripts/check-hermes-agent-presence.test.ts
```

## Progress Log

- 2026-06-22: Added bundled `hermes-bridge` plugin with Gateway-auth route, plugin-local shared secret, typed request/result schema, mock-safe task registry, optional tool, mock Hermes client, dry-run demo script, tests, and setup docs.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo` passes and prints a `message.preview` dry-run result with `status: "succeeded"` and `wouldSend: false`.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm exec oxfmt --check --threads=1 extensions/hermes-bridge docs/hermes-openclaw-bridge.md docs/tools/hermes-bridge.md package.json .env.example` passes.
- 2026-06-22: Verified direct `node --import tsx` behavior smoke passes for mock delegation, dangerous-task confirmation, and missing shared-secret fail-closed handling.
- 2026-06-22: `COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge` is blocked before project tests run because `scripts/test-projects.test-support.mjs` imports missing local file `test/vitest/vitest.channel-paths.mjs`.
- 2026-06-22: `COREPACK_HOME=/private/tmp/corepack corepack pnpm tsgo:extensions` was attempted with the required heavy-check lock access, produced no diagnostic output for 60 seconds, and was stopped to avoid leaving a broad local gate running.
- 2026-06-22: Targeted repo oxlint wrapper `COREPACK_HOME=/private/tmp/corepack corepack pnpm exec node scripts/run-oxlint.mjs --tsconfig tsconfig.oxlint.extensions.json extensions/hermes-bridge` produced no output for 30 seconds and was stopped; the wrapper then reported `prepare-extension-package-boundary-artifacts failed with exit code 130`.
- 2026-06-22: Restored tracked validation/build support directories that were missing from the worktree (`test/`, `ui/`, and `tsconfig.oxlint.{core,extensions}.json`) so repo-native wrappers could run.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge` passes with 7 test files and 17 tests.
- 2026-06-22: Fixed memory host SDK type drift exposed by extension boundary prep (`mem0`/`hybrid` memory backends and `cli` memory manager purpose), then verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test packages/memory-host-sdk/src/host/backend-config.test.ts` passes with 23 tests.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test:extensions:package-boundary:compile -- extensions/hermes-bridge` passes across 108 bundled plugins.
- 2026-06-22: Verified targeted repo oxlint wrapper passes with 0 warnings and 0 errors for `extensions/hermes-bridge`, memory host SDK type files, and `extensions/memory-core/src/memory/search-manager.ts`.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm tsgo:extensions` passes.
- 2026-06-22: `COREPACK_HOME=/private/tmp/corepack corepack pnpm build` progressed through A2UI, tsdown, CLI bootstrap import guard, and into `runtime-postbuild`; the only remaining process was `node scripts/runtime-postbuild.mjs`, which produced no output for more than ten minutes and was stopped to avoid leaving a background build process.
- 2026-06-22: Diagnosed the `runtime-postbuild` stall to bundled runtime dependency staging. `@mariozechner/pi-ai` contained broken package-manager `.bin` symlinks, causing root-workspace staging to fail and fall back to `npm install`; fixed staging to skip broken `.bin` shims and verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test test/scripts/stage-bundled-plugin-runtime-deps.test.ts` passes with 40 tests.
- 2026-06-22: Continued runtime dependency staging and found the next fallback is `diffs`, where the local dependency tree is inconsistent (`@pierre/theme` installed as `0.0.28` while `extensions/diffs/package.json` requires `0.0.29`). `COREPACK_HOME=/private/tmp/corepack corepack pnpm install` was attempted per missing-deps policy, but install cannot proceed because tracked dependency control files are missing from the worktree: `pnpm-lock.yaml`, `patches/.gitkeep`, `patches/@agentclientprotocol__claude-agent-acp@0.31.0.patch`, and `patches/@whiskeysockets__baileys@7.0.0-rc.9.patch`.
- 2026-06-22: After explicit approval, restored only the four missing dependency control files above, ran `COREPACK_HOME=/private/tmp/corepack corepack pnpm install --no-frozen-lockfile` to add the new `extensions/hermes-bridge` importer to `pnpm-lock.yaml`, and verified `CI=true COREPACK_HOME=/private/tmp/corepack corepack pnpm install --frozen-lockfile` exits 0.
- 2026-06-22: Hardened bundled runtime dependency fallback installs so npm runs with `--workspaces=false`, `npm_config_workspaces=false`, and `SIGKILL` timeout behavior; this prevents plugin-owned temp installs under `dist/extensions/*` from inheriting the repo workspace. Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test test/scripts/stage-bundled-plugin-runtime-deps.test.ts` passes with 41 tests.
- 2026-06-22: Verified current Hermes bridge validation: `COREPACK_HOME=/private/tmp/corepack corepack pnpm test extensions/hermes-bridge` passes with 7 files and 17 tests; `COREPACK_HOME=/private/tmp/corepack corepack pnpm hermes:bridge:demo` exits 0 and returns a `message.preview` mock result with `wouldSend: false`; targeted `oxfmt` check passes for bridge, docs, config, package, and staging files; `COREPACK_HOME=/private/tmp/corepack corepack pnpm tsgo:extensions` exits 0; targeted oxlint exits 0 with 0 warnings and 0 errors.
- 2026-06-22: Verified broad checks available locally: `COREPACK_HOME=/private/tmp/corepack corepack pnpm build` exits 0, including `runtime-postbuild`; `COREPACK_HOME=/private/tmp/corepack corepack pnpm lint:extensions` exits 0 across 5414 files. Blacksmith Testbox is unavailable in PATH, so the fallback `PATH=$PWD/.tmp-bin:$PATH COREPACK_HOME=/private/tmp/corepack corepack pnpm check:changed` was run; it selected all lanes due unrelated existing worktree changes and failed only because pre-existing deletion of `CHANGELOG.md` makes `check:changelog-attributions` fail with `ENOENT`.
- 2026-06-22: Verified `COREPACK_HOME=/private/tmp/corepack corepack pnpm test:extensions:package-boundary:compile -- extensions/hermes-bridge` exits 0; `hermes-bridge` is included in the 108 compiled bundled plugin boundary checks.
- 2026-06-22: Cloned and verified real Hermes Agent at `../hermes-agent`, remote `https://github.com/NousResearch/hermes-agent.git`, commit `745c4db235bdb09beb19564f66727dc1f43e4fe2`.

## Known Limitations

- V1 has the real Hermes repo present and verified, but live non-dry-run task execution remains fail-closed until a documented Hermes-side runtime adapter is implemented.
- V1 does not perform real Telegram sends or other external side effects.
- Idempotency is process-local for the plugin route and mock bridge. Persisted deduplication can be added if Hermes starts scheduling long-running tasks.
- The changed gate cannot complete in the current dirty worktree until unrelated missing files such as `CHANGELOG.md` are restored or excluded; targeted bridge validation, extension typecheck/lint, install, and build pass.

## Next Tasks

- Add the Hermes-side adapter in `../hermes-agent` once its stable plugin, CLI, or gateway extension surface is selected.
- Add real non-dry-run task templates one at a time with explicit allowlists, confirmation behavior, audit logging, and tests.
- Persist idempotency if Hermes delegates long-running scheduled tasks.
