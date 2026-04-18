# Technology Stack

**Analysis Date:** 2026-04-18

## Languages

**Primary:**

- TypeScript (ESM) — all of `src/`, `extensions/`, `packages/`, `ui/`, `test/`.
- Node / native JS glue in `.mjs` / `.js` runner scripts under `scripts/` (for example `scripts/build-all.mjs:1`, `scripts/run-node.mjs:1`, `scripts/test-projects.mjs:1`) and the shipped CLI wrapper `openclaw.mjs:1`.

**Secondary:**

- Swift for the macOS and iOS apps (`apps/macos/`, `apps/ios/`, shared `apps/shared/OpenClawKit/`).
- Kotlin / Gradle for the Android app (`apps/android/`). Gradle tasks wired through pnpm scripts at `package.json:1089-1101`.
- Python (`pyproject.toml:1`, `uv.lock:1`, `fix2.py:1`) used only by small repo tooling (docs/spellcheck, CI helpers).

## Runtime

**Environment:**

- Node.js **>=22.14.0** (`package.json:1461-1463`).
- Bun supported as a faster TS executor (see `AGENTS.md:32-39`; `pnpm openclaw` runs through Bun by default).

**Package Manager:**

- pnpm **10.32.1** pinned via `"packageManager": "pnpm@10.32.1"` (`package.json:1464`).
- Workspaces: root `.`, `ui`, `packages/*`, `extensions/*` (`pnpm-workspace.yaml:1-5`).
- `minimumReleaseAge: 2880` minutes with an explicit allowlist (`pnpm-workspace.yaml:7-29`); new dep versions wait 48h before being pulled unless whitelisted.
- `onlyBuiltDependencies` / `ignoredBuiltDependencies` gate which native packages may run install scripts (`pnpm-workspace.yaml:31-46`).

**CLI Entry:**

- Published bin name `openclaw` → `openclaw.mjs` (`package.json:16-18`), which delegates into `dist/entry.js` (`src/entry.ts:1`).
- Main library export `dist/index.js` (`package.json:46`, `src/index.ts:1-60`) plus 50+ typed Plugin SDK subpath exports under `./plugin-sdk/*` (`package.json:47-1080`). This is the contract surface for bundled + third-party plugins.

## Frameworks & Core Libraries

**CLI / UX:**

- `commander` ^14 for CLI parsing (`package.json:1378`), wired in `src/cli/program.ts` + `src/cli/run-main.ts`.
- `@clack/prompts` ^1 for interactive onboarding (`package.json:1355`).
- `chalk`, `cli-highlight`, `qrcode-terminal`, `osc-progress` for terminal UX.
- Internal TUI framework in `src/tui/` (Ink-style, driven by `@mariozechner/pi-tui`).

**HTTP / WebSocket:**

- `hono` 4.12 for the Gateway HTTP server (`package.json:1387`).
- `express` ^5 for a few legacy handlers (`package.json:1382`).
- `ws` ^8 for the Gateway control-plane WebSocket (`package.json:1415`).
- `undici` 8.0 as the outbound HTTP client (`package.json:1413`).
- `gaxios` 7.1.4 pinned, with a custom fetch compat shim loaded at startup (`src/index.ts:39-52`, `src/infra/gaxios-fetch-compat.ts`).
- `https-proxy-agent`, `proxy-agent`, custom proxy capture in `src/proxy-capture/`.

**Validation / Schema:**

- `zod` ^4.3 for config + boundary validation (`package.json:1417`).
- `@sinclair/typebox` 0.34 + `ajv` ^8 for the Gateway wire protocol (`src/gateway/protocol/schema/*.ts`, validator wired in `src/gateway/protocol/index.ts:1-50`).

**AI / Model SDKs:**

- `@anthropic-ai/vertex-sdk` ^0.15, Anthropic SDK pinned to 0.81.0 via `pnpm.overrides` (`package.json:1466-1468`).
- `openai` ^6.34 (`package.json:1401`).
- `@google/genai` ^1.49 (`package.json:1356`).
- `@aws-sdk/client-bedrock(-runtime)` 3.1028, `@aws/bedrock-token-generator` ^1.1 (`package.json:1350-1354`).
- `@modelcontextprotocol/sdk` 1.29 (`package.json:1369`).
- `@mariozechner/pi-*` family (agent-core, pi-ai, pi-coding-agent, pi-tui) pinned to 0.66.1 (`package.json:1364-1367`).
- `@agentclientprotocol/sdk` 0.18.2 (`package.json:1348`).
- `node-llama-cpp` 3.18.1 as optional peer dep (`package.json:1444-1452`).

**Messaging Channel SDKs:**

- Telegram: `grammy` + `@grammyjs/runner` + `@grammyjs/transformer-throttler`.
- Discord: `@buape/carbon` 0.15.0 (owner-pinned; see `.claude/rules/collaboration-safety.md`), `discord-api-types`, optional `@discordjs/opus`, `opusscript`, `@lydell/node-pty`.
- Slack: `@slack/bolt` ^4, `@slack/web-api` ^7.
- Matrix: `matrix-js-sdk` 41.3, `@matrix-org/matrix-sdk-crypto-wasm` 18 (`@matrix-org/matrix-sdk-crypto-nodejs` optional).
- Feishu/Lark: `@larksuiteoapi/node-sdk` ^1.60.
- LINE: `@line/bot-sdk` ^11.
- Nostr: `nostr-tools` ^2.23.
- Plus ~80 channel plugins under `extensions/` (telegram, discord, slack, signal, imessage, matrix, feishu, whatsapp, zalo, etc.) — see `ARCH.md` for the full list.

**Media / Content Pipeline:**

- `sharp` ^0.34 images, `jimp` ^1.6, `pdfjs-dist` ^5.6, `file-type` 22, `jszip` ^3.10, `tar` 7.5.
- Audio: `mpg123-decoder`, `silk-wasm`, `node-edge-tts`, optional `@discordjs/opus`.
- Browser automation: `playwright-core` 1.59.1 pinned.
- DOM scraping: `linkedom` ^0.18, `@mozilla/readability` ^0.6.
- mDNS discovery: `@homebridge/ciao` ^1.3.
- Vector search: `@lancedb/lancedb` ^0.27, `sqlite-vec` 0.1.9.

**Storage / Serialization:**

- `yaml` ^2.8, `json5` ^2.2, `markdown-it` 14.1.
- Crypto / auth: `google-auth-library` ^10.6, `@aws-sdk/credential-provider-node` 3.972.
- `dotenv` ^17.4, `uuid` ^13, `long` ^5.3, `croner` ^10 for scheduling, `chokidar` ^5 for filesystem watching.

## Build Tooling

**Bundler:**

- `tsdown` 0.21.7 (`devDependencies`, `tsdown.config.ts:1`).
- `scripts/tsdown-build.mjs` invoked from `pnpm build` via `scripts/build-all.mjs` (`package.json:1103-1106`).

**Transpile / Run-as-TS:**

- `tsx` ^4.21 for `node --import tsx` in scripts.
- `jiti` ^2.6 used at runtime to alias `openclaw/plugin-sdk` for bundled plugins (see `AGENTS.md:14-16`).

**Type Checker:**

- `@typescript/native-preview` 7.0 dev builds, driven by `pnpm tsgo` (`scripts/run-tsgo.mjs`).
- `typescript` ^6.0.2 present for `.d.ts` emission (`tsconfig.plugin-sdk.dts.json:1`).

**Lint / Format:**

- `oxlint` ^1.59 + `oxlint-tsgolint` ^0.20 (`package.json:1435-1436`). Runner: `scripts/run-oxlint.mjs`.
- `oxfmt` 0.44 for formatting (`pnpm format`, `pnpm format:fix`).
- `madge` ^8 + custom `scripts/check-import-cycles.ts` / `scripts/check-madge-import-cycles.ts` for cycle detection.
- `jscpd` 4.0.9 for duplication detection (`pnpm dup:check`).
- `knip.config.ts:1` + `ts-prune` + `ts-unused-exports` for dead-code reporting (`pnpm deadcode:*`).
- Swift: `swiftformat`, `swiftlint` via `pnpm format:swift`, `pnpm lint:swift`.
- Markdown: `markdownlint-cli2`.

**Testing:**

- `vitest` ^4.1.4 + `@vitest/coverage-v8` ^4.1 (`package.json:1429, 1442`). See `QUALITY.md`.

**Docs:**

- Mintlify (`docs/docs.json:1`, `docs/CLAUDE.md` policy).

## Publishing / Distribution

- npm: published as `openclaw` (`package.json:2`). Release checks in `pnpm release:check`, `pnpm release:openclaw:npm:*`.
- Mac app: `scripts/package-mac-app.sh`, Sparkle feed at `appcast.xml:1`.
- iOS/Android: XcodeGen + Gradle scripts under `pnpm ios:*` / `pnpm android:*`.
- Docker: root `Dockerfile:1`, sandbox variants `Dockerfile.sandbox`, `Dockerfile.sandbox-browser`, `Dockerfile.sandbox-common`.
- Fly.io deployments: `fly.toml:1`, `fly.private.toml:1`; Render deploy at `render.yaml:1`.
- ClawHub plugin registry: `pnpm release:plugins:clawhub:*`, `pnpm release:plugins:npm:*`.

## Configuration

**Environment:**

- Primary env surface lives under each plugin's `channelEnvVars` / `providerEnvVars` (for example `extensions/telegram/openclaw.plugin.json:4-6`). Core loader honors this in `src/secrets/channel-env-vars.ts` and `src/secrets/provider-env-vars.ts`.
- Web provider creds: `~/.openclaw/credentials/`. Pi sessions: `~/.openclaw/sessions/` (`.claude/rules/security-config.md:3-5`).
- `dotenv` used via `src/cli/dotenv.ts`.

**Build-time flags:**

- `FAST_COMMIT`, `OPENCLAW_LOCAL_CHECK`, `OPENCLAW_LOCAL_CHECK_MODE`, `OPENCLAW_SKIP_CHANNELS`, `OPENCLAW_VITEST_POOL`, `OPENCLAW_VITEST_MAX_WORKERS` (see `AGENTS.md:45-56`, `.claude/rules/testing-guidelines.md`).

## Platform Requirements

**Development:**

- Node 22.14+, pnpm 10.32.1 (enforced via `packageManager`).
- `prek install` for pre-commit hook (`AGENTS.md:35`).
- Pre-requisites for native modules: Python + a C toolchain for `sharp`, `@lydell/node-pty`, `@napi-rs/canvas` (peer-optional), `node-llama-cpp` (peer-optional).

**Production:**

- Ships as a Node CLI (`openclaw`) plus platform-specific bundles (macOS .app via Sparkle, iOS via App Store/TestFlight, Android via Gradle play/third-party flavors, Docker images).
- Gateway default bind: `127.0.0.1:18789` (`docs/concepts/architecture.md:15-23`).

---

_Stack analysis: 2026-04-18_
