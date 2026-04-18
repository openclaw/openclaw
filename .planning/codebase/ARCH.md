# Architecture

**Analysis Date:** 2026-04-18

## High-Level Pattern

OpenClaw is a **manifest-first plugin host** with a **control-plane WebSocket gateway** as its long-lived daemon. The CLI, mobile apps, desktop app, and nodes are all clients of that gateway. Messaging channels (Telegram, Discord, Slack, etc.) and model providers (Anthropic, OpenAI, Google, Bedrock, …) are bundled plugins that plug in through typed SDK subpaths, not direct core imports.

**Key characteristics:**

- **One daemon per host.** A single Gateway owns provider connections, inbound message fan-in, and all outbound sends (`docs/concepts/architecture.md:11-23`).
- **Manifest-driven plugin discovery.** `openclaw.plugin.json` + `channelEnvVars` / `providerEnvVars` declare capability before any plugin code runs (example: `extensions/telegram/openclaw.plugin.json:1-12`).
- **Typed wire protocol.** `src/gateway/protocol/schema/*.ts` + `@sinclair/typebox` schemas, validated on every frame via `ajv` in `src/gateway/protocol/index.ts:1-50`.
- **Lazy-loaded SDK.** Public `openclaw/plugin-sdk/*` subpaths split contract files from `*.runtime.ts` counterparts so hot channel entrypoints stay cheap at import time (see `src/plugin-sdk/CLAUDE.md` boundary rules).
- **Strict boundaries between core, plugin-sdk, channels, and extensions**, enforced by custom lint scripts (`pnpm check` chain in `package.json:1111`).

## Layers

**Entry / CLI wiring — `src/entry.ts`, `src/cli/`:**

- Purpose: Parse argv, normalize env, gate startup (compile cache, warning filter, respawn planner), then hand off to `runCli` / `runLegacyCliEntry`.
- Entry points: `openclaw.mjs:1` → `src/entry.ts:1` (main) or `src/index.ts:1` (legacy library path).
- Key files: `src/cli/program.ts`, `src/cli/run-main.ts`, `src/cli/route.ts`, `src/cli/deps.ts` (`createDefaultDeps` DI factory).
- Depends on: `infra/`, `config/`, `commands/`.

**Command layer — `src/commands/`:**

- Purpose: Top-level user commands (agent, send, onboard, doctor, pairing, nodes, secrets, gateway, …).
- Key file: `src/commands/agent.ts:1` (the `openclaw agent` / message surface).
- Subcommand groups live in `src/cli/*-cli.ts` (gateway-cli, models-cli, plugins-cli, channels-cli, etc.), which register into `commander` via `src/cli/program.ts`.

**Gateway daemon — `src/gateway/`:**

- Purpose: Long-lived WebSocket server, heartbeat, auth, pairing, device metadata, chat routing, agent run lifecycle, control-plane HTTP (canvas host + A2UI).
- Public entry: `startGatewayServer` exported lazily from `src/gateway/server.ts:1-17` → `src/gateway/server.impl.ts`.
- Protocol: `src/gateway/protocol/` defines the wire contract (see **Protocol boundary** below).
- Method handlers: `src/gateway/server-methods/` (for example `chat.ts:2384`, `sessions.ts:1656`, `agents.ts`).
- Identity & auth: `src/gateway/auth.ts`, `device-auth.ts`, `connection-auth.ts`, `credentials.ts`, `auth-rate-limit.ts`.
- Transport: `src/gateway/client.ts` (client side), `ws-log.ts`, health monitor `channel-health-monitor.ts`.

**Protocol boundary — `src/gateway/protocol/`:**

- `src/gateway/protocol/index.ts:1-50` wires Ajv validators for every method + event.
- `src/gateway/protocol/schema/` holds per-domain schema files: `agent.ts`, `agents-models-skills.ts`, `channels.ts`, `commands.ts`, `config.ts`, `cron.ts`, `devices.ts`, `error-codes.ts`, `exec-approvals.ts`, `frames.ts`, `logs-chat.ts`, `nodes.ts`, `plugin-approvals.ts`, `primitives.ts`, `push.ts`, `secrets.ts`, `sessions.ts`, `snapshot.ts`, `types.ts`, `wizard.ts`.
- Treated as a **contract** — see `src/gateway/protocol/CLAUDE.md` and `.claude/rules/architecture-boundaries.md`. Protocol changes go through `pnpm protocol:gen` + `pnpm protocol:gen:swift` to keep the macOS Swift client in sync.

**Channel core — `src/channels/`:**

- Purpose: Core cross-channel primitives (routing, allowlists, pairing, command gating, typing, reactions, drafts, session state machine).
- Canonical files: `src/channels/registry.ts`, `src/channels/session.ts`, `src/channels/run-state-machine.ts`, `src/channels/allowlists/`, `src/channels/plugins/` (the core-side channel plugin contract: `types.plugin.ts`, `types.core.ts`, `types.adapters.ts`, `binding-registry.ts`, `configured-binding-*.ts`).
- Rule: this directory is **core implementation**. Plugins must only see `src/channels/plugins/types.*` through the SDK.

**Plugin SDK — `src/plugin-sdk/`:**

- Purpose: The public contract surface for bundled + third-party plugins. Declared in `package.json:47-1080` as 80+ explicit subpath exports.
- Contract files (cheap at import): `plugin-entry.ts`, `core.ts`, `provider-entry.ts`, `channel-contract.ts`, `config-schema.ts`, `api-baseline.ts`.
- Runtime files (lazy): `*-runtime.ts` companions — `agent-runtime.ts`, `channel-runtime.ts`, `approval-*-runtime.ts`, `reply-runtime.ts`, `setup-runtime.ts`, `browser-*-runtime.ts`, etc.
- Rule: SDK barrels must stay acyclic and cheap; heavy work goes in `*.runtime.ts` and is dynamic-imported from lazy callers (`.claude/rules/coding-style.md` dynamic-import guardrail, enforced via `pnpm check:import-cycles` + `pnpm check:madge-import-cycles`).

**Plugin loader / registry — `src/plugins/`:**

- Purpose: Plugin discovery, manifest validation, activation planning, hook dispatch, bundled sources, install/uninstall policy.
- Key files: `src/plugins/loader.ts:2212`, `types.ts:2020`, `discovery.ts`, `enable.ts`, `activation-planner.ts`, `hooks.ts`, `http-registry.ts`, `bundled-plugin-scan.ts`, `clawhub.ts` (remote registry).
- Hook types (`hook-*.types.ts`) define the lifecycle events plugins can subscribe to: `before-agent-start`, `before-agent-reply`, `before-tool-call`, `before-install`, `model-override`, phase hooks.

**Agent runtime — `src/agents/`:**

- Purpose: The assistant loop — prompt assembly, provider call, tool dispatch, compaction, session persistence.
- Key files: `src/agents/pi-embedded-runner/run/attempt.ts:2421`, `src/agents/bash-tools.exec.ts:1786`, `src/agents/pi-embedded-runner/run.ts:1779`, `src/agents/compaction.ts`, `src/agents/auth-profiles/`.
- Provider transport adapters live here (`anthropic-transport-stream.ts`, `anthropic-vertex-stream.ts`) but provider-specific behavior must route through the plugin SDK, not reach into `extensions/<provider>/src/**`.

**Auto-reply / delivery — `src/auto-reply/`:**

- Purpose: Deciding when to reply, chunking, command detection and dispatch, heartbeat, and the per-channel reply pipeline (`reply/agent-runner-execution.ts:1572`).

**Tasks / flows — `src/tasks/`, `src/flows/`:**

- Task registry (`tasks/task-registry.ts:2017`), executor (`tasks/task-executor.ts`), flow registry store backed by SQLite (`tasks/task-flow-registry.store.sqlite.ts`).

**Config — `src/config/`:**

- Purpose: User config load/save, schema validation (zod), migrations, backup, bundled metadata.
- Generated artifacts (gitignored baseline, `.sha256` tracked): `src/config/schema.base.generated.ts` (27k LOC), `src/config/bundled-channel-config-metadata.generated.ts` (16k LOC). Regenerate with `pnpm config:schema:gen`, `pnpm config:channels:gen`.
- Canonical types: `src/config/types.ts`, `src/config/types.channels.ts`, `src/config/zod-schema.providers-core.ts:1631`.

**Infra — `src/infra/`:**

- Utility and platform-support layer: ports, binaries, archive, backoff, bonjour/mDNS, brew, child-process bridge, env normalization, filesystem/security helpers, launchd/schtasks, warning filter, errors, logger.

**Security / secrets — `src/security/`, `src/secrets/`:**

- `src/security/` — the `openclaw doctor` / audit surface (config, plugin trust, exec surface, gateway exposure, filesystem, symlinks, host env).
- `src/secrets/` — secret resolution, `SecretRef` contract, auth-profile scanning, runtime-auth integration.

**Misc subsystems:**

- `src/acp/` — Agent Client Protocol bindings and control plane (`acp/control-plane/manager.core.ts:2221`).
- `src/mcp/` — Model Context Protocol client/server glue.
- `src/canvas-host/` — Canvas and A2UI hosting served by the gateway HTTP server.
- `src/media/`, `src/media-generation/`, `src/media-understanding/`, `src/image-generation/`, `src/video-generation/`, `src/music-generation/`, `src/realtime-voice/`, `src/realtime-transcription/`, `src/tts/` — media pipelines.
- `src/pairing/`, `src/daemon/`, `src/node-host/` — device pairing and node lifecycle.
- `src/routing/` — reply routing policy.
- `src/hooks/` — host-side hook execution.
- `src/cron/`, `src/scripts/`, `src/wizard/` — scheduled tasks, one-off scripts, onboarding wizard.
- `src/tui/`, `src/interactive/` — terminal UI.
- `src/web/`, `src/chat/`, `src/channel-web.ts` — web chat provider.
- `src/proxy-capture/` — HTTP capture/proxy tooling for observability.

## Bundled Plugins (extensions/)

~95 bundled plugin packages live under `extensions/*`, each a pnpm workspace package. Examples grouped by kind:

- **Messaging channels:** `telegram`, `discord`, `slack`, `signal`, `imessage`, `bluebubbles`, `matrix`, `feishu`, `googlechat`, `msteams`, `line`, `irc`, `nostr`, `tlon`, `twitch`, `whatsapp`, `zalo`, `zalouser`, `synology-chat`, `nextcloud-talk`, `qqbot`, `mattermost`, `mobile/voice-call`, `talk-voice`, `phone-control`, `webhooks`, `qa-channel`.
- **Model providers:** `openai`, `anthropic`, `anthropic-vertex`, `google`, `amazon-bedrock`, `amazon-bedrock-mantle`, `xai`, `mistral`, `groq`, `fireworks`, `together`, `openrouter`, `moonshot`, `deepseek`, `qwen`, `zai`, `minimax`, `venice`, `perplexity`, `kimi-coding`, `stepfun`, `chutes`, `synthetic`, `vercel-ai-gateway`, `huggingface`, `litellm`, `vllm`, `sglang`, `ollama`, `cloudflare-ai-gateway`, `github-copilot`, `copilot-proxy`, `nvidia`, `arcee`, `microsoft`, `microsoft-foundry`, `qianfan`, `volcengine`, `byteplus`, `alibaba`.
- **CLI backends / agent harnesses:** `codex`, `opencode`, `opencode-go`, `kilocode`, `llm-task`.
- **Tools / integrations:** `brave`, `duckduckgo`, `exa`, `firecrawl`, `tavily`, `searxng`, `browser`, `openshell`, `acpx`, `diffs`, `open-prose`, `vydra`, `lobster`, `diagnostics-otel`, `memory-core`, `memory-lancedb`, `memory-wiki`, `active-memory`, `image-generation-core`, `video-generation-core`, `media-understanding-core`, `speech-core`, `deepgram`, `elevenlabs`, `comfy`, `fal`, `runway`, `device-pair`, `qa-lab`, `thread-ownership`.

Each plugin declares its surface in `openclaw.plugin.json` and exposes public barrels (`api.ts`, `runtime-api.ts`, `contract-api.ts`, `test-api.ts`, `index.ts`). Core reaches bundled plugins only through `src/plugin-sdk/<id>.ts` facades or `src/test-utils/bundled-plugin-public-surface.ts`.

## Data Flow

**Inbound message turn:**

1. Channel plugin (e.g. `extensions/telegram/src/`) receives an update via its SDK.
2. Plugin adapter normalizes to a `ChannelInbound*` shape declared in the plugin SDK, delivered into `src/channels/` routing.
3. `src/channels/run-state-machine.ts` + allowlist / pairing / command gating decide whether to accept the turn.
4. On accept, `src/auto-reply/` / `src/agents/` assembles the agent prompt, chooses a provider via `src/agents/auth-profiles/` + `src/plugins/capability-provider-runtime.ts`, and runs the model call.
5. Streamed tokens flow back through `src/plugin-sdk/reply-dispatch-runtime.ts` + channel reply pipeline (`src/plugin-sdk/channel-reply-pipeline.ts`) into the channel plugin's outbound send.
6. Gateway clients observing via WS receive `agent` / `chat` / `presence` events (`src/gateway/events.ts`, `src/gateway/agent-job.ts`).

**Control-plane request (CLI / mac app / iOS):**

1. Client connects on `ws://127.0.0.1:18789/` with a `connect` frame (`docs/concepts/architecture.md:59-76`).
2. Auth resolves via shared-secret, Tailscale header trust, or pairing token (`src/gateway/auth-mode-policy.ts`, `connection-auth.ts`).
3. Client issues typed `req:*` methods; the corresponding handler in `src/gateway/server-methods/*.ts` runs, returns `res:*`.
4. Server-push events (`event:agent`, `event:chat`, `event:tick`, `event:shutdown`) stream from the gateway event bus.

**State management:**

- Long-term config lives on disk (`~/.openclaw/…`) and is loaded via `src/config/io.ts:1813` + `loadConfig` (`src/library.ts:6-10`).
- Per-device pairing state in `~/.openclaw/sessions/` (`.claude/rules/security-config.md:3-5`).
- Run state per agent: `src/gateway/agent-job.ts`, `src/channels/session.ts`.
- Flow / task durability: SQLite via `src/tasks/task-flow-registry.store.sqlite.ts`.
- Vector memory: `@lancedb/lancedb`, `sqlite-vec` (`extensions/memory-lancedb`).

## Key Abstractions

- **`ChannelPlugin` / `ProviderPlugin`** — declared via `src/plugin-sdk/plugin-entry.ts` + `provider-entry.ts`. Plugins register themselves at load time; host enumerates them through the plugin registry.
- **`SecretRef`** — first-class addressable reference to a secret value (`src/secrets/ref-contract.ts`, resolved by `src/secrets/resolve.ts`). Avoids plaintext secrets in config.
- **`AuthProfile`** — provider credentials with health/cooldown metadata (`src/agents/auth-profiles/`).
- **`Hook*` types** — typed pre-agent, pre-tool-call, pre-install, model-override hooks (`src/plugins/hook-*.types.ts`).
- **`DeviceIdentity` / `PairingRequest`** — node and operator identity for WS connects (`src/gateway/device-auth.ts`, `src/pairing/`).
- **`SessionKey` / `SessionStore`** — chat session identity + storage (`src/config/sessions/`, re-exported from `src/library.ts:6-10`).

## Entry Points

| Kind                | File                                             | Triggers                                | Notes                                           |
| ------------------- | ------------------------------------------------ | --------------------------------------- | ----------------------------------------------- |
| CLI main            | `openclaw.mjs:1`                                 | `openclaw …` on user PATH               | Thin wrapper that loads `dist/entry.js`.        |
| Entry logic         | `src/entry.ts:1`                                 | Startup, respawn planning               | Guards against double-entry via `isMainModule`. |
| Library             | `src/index.ts:1-60` → `src/library.ts:1`         | Consumers importing `"openclaw"`        | Lazy bindings populated on demand.              |
| Gateway daemon      | `src/gateway/server.ts:7`                        | `openclaw gateway run`                  | Dynamic-imports `server.impl.ts`.               |
| Agent RPC           | `pnpm openclaw:rpc` / `pnpm moltbot:rpc`         | `scripts/run-node.mjs agent --mode rpc` | JSON-over-stdio agent interface.                |
| Mac app             | `apps/macos/Sources/OpenClaw/`                   | Sparkle updater + app bundle            | Talks to gateway over WS.                       |
| iOS app             | `apps/ios/Sources/`                              | App Store build                         | Same WS client, pairing-based.                  |
| Android app         | `apps/android/`                                  | `pnpm android:run`                      | Play + third-party flavors.                     |
| Plugin SDK subpaths | `openclaw/plugin-sdk/*` (`package.json:47-1080`) | Plugin imports                          | 80+ typed subpaths.                             |

## Error Handling

- `Result<T, E>`-style outcomes and closed error-code unions preferred over freeform strings (`.claude/rules/coding-style.md`).
- Gateway surfaces error codes from `src/gateway/protocol/schema/error-codes.ts`; client sees structured `{ok:false, error:{code, message, details?}}`.
- Unhandled rejection + uncaught error handlers installed at startup (`src/index.ts:4-6`, `src/infra/unhandled-rejections.ts`, `src/infra/errors.ts`).
- Gaxios fetch compat shim intercepts errors from Google SDKs (`src/infra/gaxios-fetch-compat.ts`).

## Cross-Cutting Concerns

- **Logging:** `src/logger.ts`, `src/logging/`, `tslog` ^4.10. macOS unified-log subsystem via `scripts/clawlog.sh`.
- **Validation:** `zod` at config + external boundaries; `@sinclair/typebox` + `ajv` at the WebSocket protocol.
- **Authentication:** layered — OS-local filesystem (`~/.openclaw/`) + per-client pairing + shared-secret / Tailscale header auth on WS (`docs/concepts/architecture.md:99-116`).
- **Authorization:** allowlist / owner-only + per-channel command gating (`src/channels/allowlists/`, `src/channels/command-gating.ts`).
- **Feature gates:** env-flagged everywhere — `OPENCLAW_LOCAL_CHECK`, `OPENCLAW_VITEST_*`, `OPENCLAW_AUTH_STORE_READONLY` (set in `src/entry.ts:22-30`), etc.

---

_Architecture analysis: 2026-04-18_
