# Tech stack

## Runtime & language

- **Core CLI + Gateway:** TypeScript (ESM, strict), targets **Node ≥22.12**. Bun is supported and preferred for running TS directly in dev (`bun <file.ts>` / `bunx`). Node is the production runtime for `dist/`.
- **Package manager:** `pnpm@10.23.0` (corepack). `pnpm-workspace.yaml` covers `.`, `ui/`, `packages/*` (clawdbot, moltbot compat shims), and `extensions/*` (channel + auth plugins).
- **macOS / iOS apps:** Swift + SwiftUI on a shared `OpenClawKit` library (iOS 18+, macOS 15+). Use the `Observation` framework (`@Observable`, `@Bindable`) — not `ObservableObject`/`@StateObject`.
- **Android app:** Kotlin + Jetpack Compose, `compileSdk 36`, `minSdk 31`. Gradle build; pulls OpenClawKit assets at build time.
- **Web UI:** Lit + `@lit-labs/signals` (served from the Gateway under `/__openclaw__/`).
- **TUI:** `@mariozechner/pi-tui` (terminal chat client).

## Key libraries

- **Agent runtime:** `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` — the LLM + tool-call loop, model registry, and TUI live here.
- **Model providers:** Anthropic (OAuth Pro/Max + API key), OpenAI, AWS Bedrock (`@aws-sdk/client-bedrock`), GitHub Copilot, Google (Gemini / Vertex / Antigravity), Moonshot/Kimi, MiniMax, Qwen, OpenRouter, Ollama (`ollama` dev dep), Venice, Perplexity, Brave, Vercel AI Gateway.
- **Channels:** `grammy` + `@grammyjs/runner` + `@grammyjs/transformer-throttler` (Telegram), `@buape/carbon@0.14.0` + `discord-api-types` (Discord — **frozen**, do not bump), `@slack/bolt` + `@slack/web-api` (Slack), `@whiskeysockets/baileys@7.0.0-rc.9` (WhatsApp web), `@line/bot-sdk` (LINE), `signal-cli` daemon (Signal). Extensions add Matrix (`@vector-im/matrix-bot-sdk`), Microsoft Teams, BlueBubbles, Zalo, Zalo Personal, Mattermost, Nextcloud Talk, Nostr, Tlon, Twitch, Google Chat, and a Twilio-backed Voice Call surface.
- **Transport & HTTP:** `ws` (Gateway WebSocket control plane), `express@5`, `undici` (with per-account proxy support).
- **Browser tool:** `playwright-core@1.58.1` driving an openclaw-managed Chrome/Chromium via CDP.
- **Canvas / A2UI:** in-house host under `src/canvas-host/` bundled via `scripts/bundle-a2ui.sh`; `.bundle.hash` is generated, commit separately.
- **Schemas & validation:** `@sinclair/typebox@0.34.47` (overridden), `ajv`, `zod@4`, `json5`, `yaml`.
- **Media:** `sharp`, `pdfjs-dist`, `@mozilla/readability`, `linkedom`, `file-type`, `jszip`, `tar@7.5.7` (pinned override).
- **CLI ergonomics:** `commander`, `@clack/prompts`, `osc-progress`, `chalk`, `cli-highlight`, `qrcode-terminal`; shared CLI palette in `src/terminal/palette.ts`.
- **Voice / TTS:** `node-edge-tts`, ElevenLabs (via apps), optional Apple/Google providers; Voice Wake forwards via `openclaw-mac agent --message "${text}" --thinking low`.
- **Storage / memory:** `sqlite-vec@0.1.7-alpha.2` for embeddings; `proper-lockfile` for session lock files; vector providers exposed via `extensions/memory-core` + `extensions/memory-lancedb`.
- **Process / IPC:** `@lydell/node-pty` (PTY), `@homebridge/ciao` (Bonjour discovery), `croner` (cron + wakeups), `chokidar` (file watching), `jiti` (runtime TS for plugin SDK resolution).
- **Logging:** `tslog`; macOS unified-log queries via `scripts/clawlog.sh`.

## Conventions

- **Lint + format:** `oxlint --type-aware` and `oxfmt` (`pnpm lint`, `pnpm format`, `pnpm format:fix`). SwiftFormat + SwiftLint for Apple code.
- **Tests:** Vitest with V8 coverage gates at **70%** (lines/branches/functions/statements). Colocated `*.test.ts`; E2E in `*.e2e.test.ts` (`vitest.e2e.config.ts`); live-model tests gated by `OPENCLAW_LIVE_TEST=1` / `CLAWDBOT_LIVE_TEST=1` (`vitest.live.config.ts`); Docker E2E suites in `scripts/e2e/*` (onboard, plugins, gateway-network, QR, doctor-switch). Cap workers at 16.
- **File layout:** dependency-injection via `createDefaultDeps` (no DI framework — functional composition). Keep files under ~500 LOC where practical; ~700 is a soft ceiling. Extract helpers instead of "V2" copies. Channel-specific code lives under `src/<channel>/`; shared routing under `src/channels/` + `src/routing/`.
- **Plugins:** every messaging connector aims to be a plugin (bundled in `extensions/*` or external). Plugin runtime deps live in the extension's own `package.json` — never in root. Use `openclaw` in `devDependencies`/`peerDependencies`, never `workspace:*` under `dependencies` (npm install breaks). The runtime resolves `openclaw/plugin-sdk` via a jiti alias.
- **Naming:** `OpenClaw` (product/UI/docs headings); `openclaw` (CLI command, npm package, paths, config keys). Branding migrations from legacy `clawdbot`/`bot.molt` are handled by `openclaw doctor`.
- **Docs (Mintlify):** root-relative internal links with no `.md`/`.mdx` extension (`[Config](/configuration)`). Avoid em dashes and apostrophes in headings — they break Mintlify anchors. README on GitHub keeps absolute `https://docs.openclaw.ai/...` URLs.
- **Commits:** use `scripts/committer "<msg>" <file...>` for scoped staging; concise action-oriented messages (`CLI: add verbose flag to send`). PRs land via rebase (clean history) or squash (messy). Always add the contributor as co-author and update `bun scripts/update-clawtributors.ts` for new contributors.
- **Schema guardrails:** in tool input schemas, avoid `Type.Union`/`anyOf`/`oneOf`/`allOf` and the raw `format` property. Use `stringEnum`/`Type.Optional(...)`. Keep top-level tool schema as `type: "object"` with `properties`.

## Non-negotiables

- **Gateway auth is fail-closed.** Mode `"none"` was removed in 2026.1.25; token or password is required (Tailscale Serve identity is allowed). `gateway.bind=loopback` is enforced whenever Tailscale Serve/Funnel is enabled. Funnel additionally requires `gateway.auth.mode="password"`.
- **Inbound DMs are untrusted.** Default DM policy is `pairing` on Telegram/WhatsApp/Signal/iMessage/Microsoft Teams/Discord/Google Chat/Slack. Public DM access requires explicit `dmPolicy="open"` + `"*"` in `allowFrom`. `openclaw doctor` surfaces misconfigurations.
- **No streaming/partial replies to external messaging surfaces.** WhatsApp/Telegram/Slack/Discord/etc. receive *final* replies only; streaming/tool events stay on internal UIs and the control channel.
- **Don't edit `node_modules`** (global, Homebrew, npm, git installs — anywhere). Updates overwrite. Notes belong in `tools.md` or `AGENTS.md`.
- **Frozen / pinned dependencies:** `@buape/carbon` (never update), `tar@7.5.7` (npm + pnpm override), and any package listed in `pnpm.patchedDependencies` must use an exact version (no `^`/`~`). Patching deps (pnpm patches, overrides, vendored) requires explicit operator approval.
- **Multi-agent safety:** do not `git stash`, change worktrees, or switch branches unless explicitly asked. Assume parallel agent sessions; scope commits to your own changes.
- **Releases:** never bump version numbers or run `npm publish` without explicit operator consent. Read `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md` first. npm publishes go through the 1Password skill inside a fresh tmux session with an OTP from `op://Private/Npmjs`.
- **macOS-only constraints:** rebuild the macOS app on the Mac itself (never over SSH). Start/stop the Gateway via the app, not ad-hoc tmux. Use `launchctl print gui/$UID | grep openclaw` to verify — there is no fixed LaunchAgent label.
- **Security defaults:** mDNS minimal discovery by default; URL fetches DNS-pin to mitigate rebinding; external hook content is wrapped by default (per-hook opt-out); Tailscale Serve auth validates identity via local `tailscaled` before trusting headers.
