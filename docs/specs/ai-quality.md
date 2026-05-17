# AI quality

## AI surface area

OpenClaw is LLM-driven end to end. Every inbound message on any channel is routed to an isolated agent session, which runs an LLM tool-call loop and emits a reply.

- **Agent runtime** — `src/agents/` on top of `@mariozechner/pi-agent-core` / `pi-coding-agent` / `pi-ai`. One agent per `agentId`; sessions persist under `~/.openclaw/agents/<agentId>/sessions/*.jsonl`.
- **Model providers wired in `src/providers/` + Pi SDK** — Anthropic (OAuth Pro/Max + API key), OpenAI, AWS Bedrock, Google (Gemini / Vertex / Antigravity), Moonshot/Kimi, MiniMax, Qwen, OpenRouter, GitHub Copilot, Venice, Perplexity, Brave, Ollama, Vercel AI Gateway. Auth-profile rotation + failover live in `src/agents/` (see `docs/concepts/model-failover`).
- **Tool surface** — bash/exec, browser (CDP via Playwright), canvas/A2UI, cron + wakeups, sessions_* coordination tools, channel send actions, node device tools (`node.invoke` → camera, screen.record, system.run/notify, location.get), 50+ bundled skills under `skills/*` (GitHub, Notion, Slack, Obsidian, weather, image gen, whisper, etc.).
- **Memory / retrieval** — `src/memory/` plus `extensions/memory-core` and `extensions/memory-lancedb`. Embeddings via `sqlite-vec` (default) or LanceDB; hybrid (BM25 + embeddings) retrieval; provider-pluggable embedding models.
- **Media understanding** — `src/media-understanding/` calls vision models (OpenAI / Google / Groq) for image/video; `src/link-understanding/` extracts page content + OG metadata via `@mozilla/readability`.
- **Voice** — Voice Wake + Talk Mode (macOS/iOS/Android) transcribe local audio and forward as `openclaw-mac agent --message "${text}" --thinking low`; outbound TTS via `node-edge-tts`, ElevenLabs, OpenAI, or Apple/Google providers.
- **Auto-reply** — `src/auto-reply/` handles short replies (greetings, /new prompts, command gating, broadcast groups, partial-reply chunking).

## Success criteria

Treat these as the operating bar rather than published SLOs — there is no public eval dashboard:

- Inbound on every supported channel reaches an agent reply (or a typed error) without crashing the Gateway. The Gateway already filters transient network errors and only exits on fatal errors (CHANGELOG 2026.1.25, #2980).
- Model failover skips cooldowned providers (#2143) and falls through the configured auth-profile chain without surfacing provider noise to the user.
- Context compaction stays inside the configured cap (#6187) and summarizes dropped messages during safeguard pruning (#2509).
- External chat surfaces (WhatsApp/Telegram/Slack/Discord/...) receive **only final replies**, not streaming partials.
- Live model tests pass (`pnpm test:live` and `pnpm test:docker:live-models`).

Explicit measurable targets (precision/recall/coverage) are not currently published. Define them before relying on this file as a production gate.

## Evaluation approach

- **Unit + integration:** Vitest with 70% coverage thresholds across lines/branches/functions/statements (`pnpm test`, `pnpm test:coverage`).
- **Live-model regression:** `OPENCLAW_LIVE_TEST=1 pnpm test:live` (OpenClaw-only) or `LIVE=1` (includes provider live tests). Docker-pinned runs: `pnpm test:docker:live-models` and `pnpm test:docker:live-gateway`.
- **End-to-end onboarding + plugins + QR + doctor-switch:** Docker E2E suites under `scripts/e2e/*` (`pnpm test:docker:onboard`, `pnpm test:docker:plugins`, `pnpm test:docker:qr`, `pnpm test:docker:doctor-switch`, `pnpm test:docker:gateway-network`).
- **Model benchmarking:** ad-hoc via `scripts/bench-model.ts`; reproductions via `scripts/repro/*`; Claude usage debugging via `scripts/debug-claude-usage.ts`.
- **Formal conformance:** the `formal-conformance.yml` workflow runs on PRs and validates against the external `clawdbot-formal-models` repo.
- **Full gate before landing a PR:** `pnpm lint && pnpm build && pnpm test` (per `AGENTS.md` landing-mode rules).

## Known failure modes

- **Prompt injection from inbound DMs.** Treat every inbound DM as untrusted input. Mitigations: DM `pairing` default policy, per-channel allowlists, external hook content wrapped by default (#1827), `openclaw doctor` flagging risky DM configurations.
- **Provider outages / rate limits.** Mitigated by auth-profile rotation and failover that skips cooldowned providers (#2143). Transient network errors (fetch failures, timeouts, DNS) no longer crash the Gateway (#2980).
- **Context overflow.** Compaction respects configured context window (#6187) and summarizes dropped messages (#2509).
- **Oversized images / unsupported media.** Retries on oversized image errors are suppressed; size limits surfaced (#2871). Text-attachment MIME misclassification covered (#3628).
- **Multi-account / multi-agent confusion.** Per-account DM session scope (#3095); precompiled session-key regexes (#1697); requesterOrigin preferred over stale session entries (#4957); AccountId included in Telegram native command context (#2942).
- **Tool-loop drift.** `sessions_*` tools coordinate work between sessions instead of letting agents jump chat surfaces; `/compact`, `/new`, `/reset` chat commands give the operator manual control.
- **Streaming bleed-through to chat apps.** Hard rule: only final replies on external surfaces; streaming/tool events on internal UIs only.

## Safety & privacy

- **Gateway auth fail-closed.** Mode `"none"` removed (2026.1.25). Token or password required; Tailscale Serve identity allowed.
- **Loopback enforcement.** `gateway.bind=loopback` when Tailscale Serve/Funnel is on. Funnel requires `gateway.auth.mode="password"`.
- **DM allowlist + pairing.** Default `dmPolicy="pairing"`; opening DMs to the public requires `dmPolicy="open"` + `"*"` in `allowFrom`.
- **Trusted-proxy detection.** Loopback + non-local Host connections are treated as remote unless trusted proxy headers are present.
- **External content wrapping.** Hook content from external sources is wrapped by default (#1827, per-hook opt-out).
- **URL fetch hardening.** DNS pinning mitigates rebinding on outbound URL fetches.
- **mDNS minimal.** Discovery defaults to minimal mode to reduce information disclosure (#1882).
- **Voice-call webhook signing.** Twilio webhook signature verification enforced for ngrok URLs; free-tier ngrok bypass disabled by default.
- **Secrets handling.** Web provider credentials under `~/.openclaw/credentials/`; Pi session logs under `~/.openclaw/sessions/`. Never commit real phone numbers, videos, tokens, or live config — `AGENTS.md` mandates fake placeholders in docs/tests/examples.
- **`.secrets.baseline`** + `detect-secrets` pre-commit hook (`.pre-commit-config.yaml`) gates accidental secret commits.
- **Lobster shell-injection fix (GHSA-4mhr-g7xj-cg8j)** in 2026.1.31 (#5335). Continue to audit any tool that takes operator-supplied paths or argv.

## Regression checks

The small set that must keep working after every prompt or model change:

- `pnpm test` (unit + integration, 70% coverage gate).
- `pnpm protocol:check` — TypeBox schema + Swift `GatewayModels.swift` stay in sync.
- `pnpm test:docker:live-models` — Docker-pinned multi-provider sanity.
- `pnpm test:docker:onboard` — end-to-end onboarding wizard.
- `pnpm test:docker:plugins` — plugin install/discovery.
- Channel smoke: send a DM through each enabled channel and confirm a final reply lands (no streaming bleed-through, no empty replies, correct session key per `outbound-session-mirroring` invariants).
- `openclaw doctor` — clean output on a fresh and on an upgraded install.
