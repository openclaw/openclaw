# Upstream Update Summary (v2): v2026.4.1 → v2026.5.12

## Highlights (curated)

### Major themes (deep dives)

**Plugin dependency externalization (2026.5.12)**

Upstream is actively shrinking the core install by externalizing large dependency cones into plugins (e.g. Bedrock/AWS SDK, Slack/OpenShell sandbox, Anthropic Vertex). For Polytropos this likely reduces default install weight but increases sensitivity to plugin install/enable state and peer dependency resolution. We should re-run plugin doctor/verify after the merge and re-check our external plugin deploy pipeline assumptions.

**Tooling for orchestration + discovery (Tasks/Tool Search/Webhooks)**

The 2026.4.x → 2026.5.x window includes continued investment in Task Flow/orchestration primitives and tool discovery (Tool Search), plus webhook ingress for driving flows. This increases capability but also increases moving parts in gateway/session state and tool schema emission; worth re-validating our fork’s tool injection surfaces after merge.

**Memory stack expansion (memory-wiki / Active Memory / dreaming)**

Upstream keeps expanding memory features: memory-wiki restoration, Active Memory sub-agent, dreaming/backfill flows, and UI affordances. This is a behavioral change surface (not just internal refactors) and may intersect with Polytropos-specific memory assumptions and any custom plugins that touch transcripts.

**Browser automation and safety hardening**

There are multiple upstream changes around browser tooling, pairing/auth scopes, and safety checks. Given our recent browser-cloud plugin migration + packaging fixes, this is a key area to regression-test post-merge (tool availability, doctor output, CDP readiness, snapshot/act behavior).

### Grouped changelog highlights

**Plugins & install/doctor**

- (2026.4.2) Plugins/xAI: move `x_search` settings from the legacy core `tools.web.x_search.*` path to the plugin-owned `plugins.entries.xai.config.xSearch.*` path, standardize `x_search` auth on `plugins.entries.xai.config.webSearch.apiKey` / `XAI_API_KEY`, and migrate legacy config with `openclaw doctor --fix`. (#59674) Thanks @vincentkoc.
- (2026.4.2) Plugins/web fetch: move Firecrawl `web_fetch` config from the legacy core `tools.web.fetch.firecrawl.*` path to the plugin-owned `plugins.entries.firecrawl.config.webFetch.*` path, route `web_fetch` fallback through the new fetch-provider boundary instead of a Firecrawl-only core branch, and migrate legacy config with `openclaw doctor --fix`. (#59465) Thanks @vincentkoc.
- (2026.4.21) Plugins/skills: add the Skill Workshop plugin, which captures reusable workflow corrections as pending or auto-applied workspace skills, runs threshold-based reviewer passes for stronger completion bias on reusable procedures, quarantines unsafe proposals, and refreshes skill availability after safe writes.
- (2026.4.21) Plugin SDK/channels: add presentation and skills runtime contracts, decouple channel presentation rendering, and document message presentation cards so plugins can own richer interactive surfaces without channel-specific glue.
- (2026.4.25) Plugin startup and install paths move to the cold persisted registry, cutting broad manifest scans while making plugin update, repair, provider discovery, and install metadata more deterministic. Thanks @vincentkoc and @shakkernerd.
- (2026.4.26) Plugins/cron: add a typed `cron_changed` hook for observing gateway-owned cron lifecycle updates without depending on internal cron events. Thanks @amknight.
- (2026.4.27) Plugin startup and model catalogs move toward manifest-first metadata, reducing Gateway boot work and making provider rows/aliases/suppressions easier to audit. Thanks @shakkernerd.
- (2026.4.7) Plugins/webhooks: add a bundled webhook ingress plugin so external automation can create and drive bound TaskFlows through per-route shared-secret endpoints. (#61892) Thanks @mbelinky.
- (2026.4.8) Bundled plugins: align packaged plugin compatibility metadata with the release version so bundled channels and providers load on OpenClaw 2026.4.8.
- (2026.4.9) Plugins/provider-auth: let provider manifests declare `providerAuthAliases` so provider variants can share env vars, auth profiles, config-backed auth, and API-key onboarding choices without core-specific wiring.
- (2026.5.12) Plugins: externalize Slack, OpenShell sandbox, and Anthropic Vertex so their runtime dependency cones install only when those plugins are installed.
- (2026.5.2) External plugin installation now covers diagnostics, onboarding, doctor repair, channel setup, install/update records, and artifact metadata while keeping bare package installs on npm for the first cutover. Thanks @vincentkoc.
- (2026.5.3) Plugins/file-transfer: add bundled file-transfer plugin with `file_fetch`, `dir_list`, `dir_fetch`, and `file_write` agent tools for binary file ops on paired nodes; default-deny per-node path policy under `plugins.entries.file-transfer.config.nodes` with operator approval, symlink traversal refused by default (opt-in `followSymlinks`), and a 16 MB byte ceiling per round-trip. (#74742) Thanks @omarshahine.
- (2026.5.3) Plugins/install: harden official plugin install, uninstall, update, onboarding, ClawHub fallback, npm dependency-state reporting, and beta-channel update paths so externalized plugins behave like first-class package installs.
- (2026.5.3-1) Plugins/security: stop the install scanner from blocking official bundled plugin packages when `process.env` access and normal API sends only appear in distant parts of the same compiled bundle. Thanks @vincentkoc.
- (2026.5.4) Plugins/migration: emit catalog-backed install hints when `plugins.entries` or `plugins.allow` references an official external plugin that is not installed, so upgraded configs point operators to `openclaw plugins install <spec>` instead of telling them to remove valid plugin config. (#77483) Thanks @hclsys.
- (2026.5.5) Doctor/Codex OAuth: preserve working `openai-codex/*` PI routes during `doctor --fix`, recover 2026.5.5-rewritten `openai/*` GPT-5 routes when only Codex OAuth auth is available, and warn without rewriting mixed Codex OAuth plus direct OpenAI PI routes, so update repair does not break subscription-auth setups. Fixes #78407. Thanks @shakkernerd.
- (2026.5.5) Plugins/runtime fetch: drop third-party symbol metadata from plain request header dictionaries before passing them into native `fetch` or `Headers`, so SDK and guarded/proxy fetch paths do not reject otherwise valid plugin requests. Fixes #77846. Thanks @shakkernerd.
- (2026.5.6) Doctor/OpenAI config: keep the 2026.5.6 release branch clear of the legacy Codex route rewrite that could change OpenAI model config during `doctor --fix`, preserving existing OpenAI routes unless a supported repair path applies.
- (2026.5.6) Plugins/runtime fetch: drop third-party symbol metadata from plain request header dictionaries before passing them into native `fetch` or `Headers`, so SDK and guarded/proxy fetch paths do not reject otherwise valid plugin requests. Fixes #77846. Thanks @shakkernerd.
- (2026.5.9) Doctor: warn when a per-agent model config omits the `fallbacks` key and `agents.defaults.model.fallbacks` is non-empty. Covers both string-form (`"model": "..."`) and partial-object form (`"model": { "primary": "..." }`) — both silently clobber the defaults chain at runtime. Use `"fallbacks": []` to explicitly opt out of fallbacks, or add `"fallbacks": [...]` to inherit or override. Fixes #79369.

**Tools & agent runtime**

- (2026.4.1) macOS/Voice Wake: add the Voice Wake option to trigger Talk Mode. (#58490) Thanks @SmoothExec.
- (2026.4.1) Tasks/chat: add `/tasks` as a chat-native background task board for the current session, with recent task details and agent-local fallback counts when no linked tasks are visible. Related #54226. Thanks @vincentkoc.
- (2026.4.10) Models/Codex: add the bundled Codex provider and plugin-owned app-server harness so `codex/gpt-*` models use Codex-managed auth, native threads, model discovery, and compaction while `openai/gpt-*` stays on the normal OpenAI provider path. (#64298).
- (2026.4.10) Tools/video generation: add Seedance 2.0 model refs to the bundled fal provider and submit the provider-specific duration, resolution, audio, and seed metadata fields needed for live Seedance 2.0 runs.
- (2026.4.11) Tools/video_generate: add URL-only generated asset delivery, typed `providerOptions`, reference audio inputs, per-asset role hints, `adaptive` aspect-ratio support, and a higher image-input cap so video providers can expose richer generation modes without forcing large files into memory. (#61987, #61988) Thanks @xieyongliang.
- (2026.4.14) OpenAI Codex/models: add forward-compat support for `gpt-5.4-pro`, including Codex pricing/limits and list/status visibility before the upstream catalog catches up. (#66453) Thanks @jepson-liu.
- (2026.4.14) Agents/Ollama: forward the configured embedded-run timeout into the global undici stream timeout tuning so slow local Ollama runs no longer inherit the default stream cutoff instead of the operator-set run timeout. (#63175) Thanks @mindcraftreader and @vincentkoc.
- (2026.4.14) Models/Codex: include `apiKey` in the codex provider catalog output so the Pi ModelRegistry validator no longer rejects the entry and silently drops all custom models from every provider in `models.json`. (#66180) Thanks @hoyyeva.
- (2026.4.18) Codex/gateway: fix gateway crashes when the codex-acp subprocess terminates abruptly; pending requests now shut down gracefully instead of propagating an uncaught EPIPE through the gateway daemon and connected channels. Fixes #67886. (#67947) Thanks @openperf.
- (2026.4.2) Tasks/Task Flow: restore the core Task Flow substrate with managed-vs-mirrored sync modes, durable flow state/revision tracking, and `openclaw tasks flow` inspection/recovery primitives so background orchestration can persist and be operated separately from plugin authoring layers. (#58930) Thanks @mbelinky.
- (2026.4.2) Tasks/Task Flow: add managed child task spawning plus sticky cancel intent, so external orchestrators can stop scheduling immediately and let parent Task Flows settle to `cancelled` once active child tasks finish. (#59610) Thanks @mbelinky.
- (2026.4.20) Agents/prompts: strengthen the default system prompt and OpenAI GPT-5 overlay with clearer completion bias, live-state checks, weak-result recovery, and verification-before-final guidance.
- (2026.4.20) Sessions/Maintenance: enforce the built-in entry cap and age prune by default, and prune oversized stores at load time so accumulated cron/executor session backlogs cannot OOM the gateway before the write path runs. (#69404) Thanks @bobrenze-bot.
- (2026.4.23) Providers/OpenAI: add image generation and reference-image editing through Codex OAuth, so `openai/gpt-image-2` works without an `OPENAI_API_KEY`. Fixes #70703.
- (2026.4.23) Agents/subagents: add optional forked context for native `sessions_spawn` runs so agents can let a child inherit the requester transcript when needed, while keeping clean isolated sessions as the default; includes prompt guidance, context-engine hook metadata, docs, and QA coverage.
- (2026.4.27) Codex Computer Use setup now ships with status/install commands, marketplace discovery, and fail-closed MCP checks for Codex-mode desktop control. Thanks @pash-openai.
- (2026.4.29) Provider/model coverage expands with NVIDIA onboarding/catalogs plus faster manifest-backed model/auth paths, Bedrock Opus 4.7 thinking parity, and safer Codex/OpenAI-compatible replay and streaming behavior. Thanks @eleqtrizit, @shakkernerd, @prasad-yashdeep, @woodhouse-bot, and @LyHug.
- (2026.4.5) Agents/video generation: add the built-in `video_generate` tool so agents can create videos through configured providers and return the generated media directly in the reply.
- (2026.4.5) Agents/music generation: ignore unsupported optional hints such as `durationSeconds` with a warning instead of hard-failing requests on providers like Google Lyria.
- (2026.4.7) Tools/media generation: auto-fallback across auth-backed image, music, and video providers by default, preserve intent during provider switches, remap size/aspect/resolution/duration hints to the closest supported option, and surface provider capabilities plus mode-aware video-to-video support.
- (2026.4.8) Agents/progress: keep `update_plan` available for OpenAI-family runs while returning compact success payloads and allowing `tools.experimental.planTool=false` to opt out.
- (2026.5.12) ACP: add `acp.fallbacks` so ACP turns can try configured backup runtime backends when the primary backend is unavailable before any output is emitted. (#69542) Thanks @kaseonedge.
- (2026.5.2) Control UI and WebChat reliability improves across Sessions, Cron, long-running Gateway WebSockets, grouped-message width, slash-command feedback, iOS PWA bounds, selection contrast, and Talk diagnostics.
- (2026.5.3) Gateway/performance: trim startup and Control UI hot paths by lazy-loading plugin/runtime discovery, cron, schema, shutdown, sessions, and model metadata work only when needed.
- (2026.5.4) Gateway/Windows: bind the default loopback gateway listener only to `127.0.0.1` on Windows so libuv's dual-stack `::1` behavior cannot wedge localhost HTTP requests. (#69701, fixes #69674) Thanks @SARAMALI15792.
- …and 4 more

**Channels & messaging**

- (2026.4.1) Telegram/errors: add configurable `errorPolicy` and `errorCooldownMs` controls so Telegram can suppress repeated delivery errors per account, chat, and topic without muting distinct failures. (#51914) Thanks @chinar-amrutkar
- (2026.4.11) Feishu: improve document comment sessions with richer context parsing, comment reactions, and typing feedback so document-thread conversations behave more like chat conversations. (#63785).
- (2026.4.12) QA/lab: add Convex-backed pooled Telegram credential leasing plus `openclaw qa credentials` admin commands and broker setup docs. (#65596) Thanks @joshavant.
- (2026.4.14) Telegram/forum topics: surface human topic names in agent context, prompt metadata, and plugin hook metadata by learning names from Telegram forum service messages. (#65973) Thanks @ptahdunbar.
- (2026.4.8) Telegram/setup: load setup and secret contracts through packaged top-level sidecars so installed npm builds no longer try to import missing `dist/extensions/telegram/src/*` files during gateway startup.
- (2026.4.8) Bundled channels/setup: load shared secret contracts through packaged top-level sidecars across BlueBubbles, Feishu, Google Chat, IRC, Matrix, Mattermost, Microsoft Teams, Nextcloud Talk, Slack, and Zalo so installed npm builds no longer rely on missing `dist/extensions/*/src/*` files during gateway startup.
- (2026.5.12) Re-verify Discord/Telegram behavior (approvals/audit/runtime)
- (2026.5.2) Channel and provider fixes cover Telegram topic commands and networking, Discord delivery and startup edge cases, OpenAI-compatible TTS/Realtime, OpenRouter/DeepSeek replay, Anthropic-compatible streaming, Brave/SearXNG/Firecrawl web search, and voice-call routing.
- (2026.5.3) Channels/replies: improve Discord status reactions and degraded transport reporting, add WhatsApp Channel/Newsletter targets, and tighten Telegram, Feishu, Matrix, Microsoft Teams, and Slack delivery/recovery behavior.

**UI / WebChat / TUI**

- (2026.4.11) Control UI/webchat: render assistant media/reply/voice directives as structured chat bubbles, add the `[embed ...]` rich output tag, and gate external embed URLs behind config. (#64104).
- (2026.4.15) Control UI/Overview: add a Model Auth status card showing OAuth token health and provider rate-limit pressure at a glance, with attention callouts when OAuth tokens are expiring or expired. Backed by a new `models.authStatus` gateway method that strips credentials and caches for 60s. (#66211) Thanks @omarshahine.
- (2026.4.18) Control UI/settings: overhaul the settings and slash-command experience with faster presets, quick-create flows, and refreshed command discovery. (#67819) Thanks @BunsDev.
- (2026.4.22) TUI: add local embedded mode for running terminal chats without a Gateway while keeping plugin approval gates enforced. (#66767) Thanks @fuller-stack-dev.
- (2026.4.26) Control UI/Talk: add a generic browser realtime transport contract, Google Live browser Talk sessions with constrained ephemeral tokens, and a Gateway relay for backend-only realtime voice plugins. Thanks @VACInc.
- (2026.4.9) Control UI/dreaming: add a structured diary view with timeline navigation, backfill/reset controls, traceable dreaming summaries, and a grounded Scene lane with promotion hints plus a safe clear-grounded action for staged backfill signals. (#63395) Thanks @mbelinky.
- (2026.5.12) Control UI/WebChat: add a persisted auto-scroll mode selector so users can keep the current near-bottom behavior, always follow streaming output, or turn automatic streaming scroll off and use the New messages button manually. Fixes #7648 and #81287. Thanks @BunsDev.

**Models & providers**

- (2026.4.15) Anthropic/models: default Anthropic selections, `opus` aliases, Claude CLI defaults, and bundled image understanding to Claude Opus 4.7.
- (2026.4.15) Google/TTS: add Gemini text-to-speech support to the bundled `google` plugin, including provider registration, voice selection, WAV reply output, PCM telephony output, and setup/docs guidance. (#67515) Thanks @barronlroth.
- (2026.4.18) Anthropic/models: add Claude Opus 4.7 `xhigh` reasoning effort support and keep it separate from adaptive thinking.
- (2026.4.20) Models/costs: support tiered model pricing from cached catalogs and configured models, and include bundled Moonshot Kimi K2.6/K2.5 cost estimates for token-usage reports. (#67605) Thanks @sliverp.
- (2026.4.21) OpenAI/images: default the bundled image-generation provider and live media smoke tests to `gpt-image-2`, and advertise the newer 2K/4K OpenAI size hints in image-generation docs and tool metadata.
- (2026.4.21) Fireworks/models: add Kimi K2.6 (`fireworks/accounts/fireworks/models/kimi-k2p6`) to the bundled catalog and live-model priority list, while keeping Kimi thinking disabled for Fireworks K2.6 requests.
- (2026.4.22) Providers/xAI: add image generation, text-to-speech, and speech-to-text support, including `grok-imagine-image` / `grok-imagine-image-pro`, reference-image edits, six live xAI voices, MP3/WAV/PCM/G.711 TTS formats, `grok-stt` audio transcription, and xAI realtime transcription for Voice Call streaming. (#68694) Thanks @KateWilkins.
- (2026.4.22) Providers/STT: add Voice Call streaming transcription for Deepgram, ElevenLabs, and Mistral, alongside the existing OpenAI and xAI realtime STT paths; ElevenLabs also gains Scribe v2 batch audio transcription for inbound media.
- (2026.4.23) Providers/OpenRouter: add image generation and reference-image editing through `image_generate`, so OpenRouter image models work with `OPENROUTER_API_KEY`. Fixes #55066 via #67668. Thanks @notamicrodose.
- (2026.4.23) Image generation: let agents request provider-supported quality and output format hints, and pass OpenAI-specific background, moderation, compression, and user hints through the `image_generate` tool. (#70503) Thanks @ottodeng.
- (2026.4.24) DeepSeek V4 Flash and V4 Pro are in the bundled catalog, V4 Flash is the onboarding default, and DeepSeek thinking/replay behavior is fixed for follow-up tool-call turns.
- (2026.4.24) Providers/OpenRouter: add native video generation through `video_generate`, so OpenRouter video models work with `OPENROUTER_API_KEY`. (#72700) Thanks @notamicrodose.
- (2026.4.26) Providers: add Cerebras as a bundled plugin with onboarding, static model catalog, docs, and manifest-owned endpoint metadata.
- (2026.4.5) Providers/Arcee AI: add a bundled Arcee AI provider plugin with `ARCEEAI_API_KEY` onboarding, Trinity model catalog (mini, large-preview, large-thinking), OpenAI-compatible API support, and OpenRouter as an alternative auth path. (#62068) Thanks @arthurbr11.
- (2026.5.12) Amazon Bedrock: externalize the Bedrock and Bedrock Mantle provider packages so core installs no longer pull AWS SDK dependencies unless those providers are installed.
- (2026.5.7) OpenAI: support `openai/chat-latest` as an explicit direct API-key model override for trying the moving ChatGPT Instant API alias without changing the stable default model.

**Security / sandbox / auth**

- (2026.4.12) CLI/exec policy: add a local `openclaw exec-policy` command with `show`, `preset`, and `set` subcommands for synchronizing requested `tools.exec.*` config with the local exec approvals file, plus follow-up hardening for node-host rejection, rollback safety, and sync conflict detection. (#64050) Thanks @rugvedS07.
- (2026.4.5) Config: remove legacy public config aliases such as `talk.voiceId` / `talk.apiKey`, `agents.*.sandbox.perSession`, `browser.ssrfPolicy.allowPrivateNetwork`, `hooks.internal.handlers`, and channel/group/room `allow` toggles in favor of the canonical public paths and `enabled`, while keeping load-time compatibility and `openclaw doctor --fix` migration support for existing configs. (#60726) Thanks @vincentkoc.

**Other**

- (2026.4.1) Web search/SearXNG: add the bundled SearXNG provider plugin for `web_search` with configurable host support. (#57317) Thanks @cgdusek.
- (2026.4.10) Memory/Active Memory: add a new optional Active Memory plugin that gives OpenClaw a dedicated memory sub-agent right before the main reply, so ongoing chats can automatically pull in relevant preferences, context, and past details without making users remember to manually say "remember this" or "search memory" first. Includes configurable message/recent/full context modes, live `/verbose` inspection, advanced prompt/thinking overrides for tuning, and opt-in transcript persistence for debugging. Docs: https://docs.openclaw.ai/concepts/active-memory. (#63286) Thanks @Takhoffman.
- (2026.4.10) macOS/Talk: add an experimental local MLX speech provider for Talk Mode, with explicit provider selection, local utterance playback, interruption handling, and system-voice fallback. (#63539) Thanks @ImLukeF.
- (2026.4.11) Dreaming/memory-wiki: add ChatGPT import ingestion plus new `Imported Insights` and `Memory Palace` diary subtabs so Dreaming can inspect imported source chats, compiled wiki pages, and full source pages directly from the UI. (#64505).
- (2026.4.12) Memory/Active Memory: add a new optional Active Memory plugin that gives OpenClaw a dedicated memory sub-agent right before the main reply, so ongoing chats can automatically pull in relevant preferences, context, and past details without making users remember to manually say "remember this" or "search memory" first. Includes configurable message/recent/full context modes, live `/verbose` inspection, advanced prompt/thinking overrides for tuning, and opt-in transcript persistence for debugging. Docs: https://docs.openclaw.ai/concepts/active-memory. (#63286) Thanks @Takhoffman.
- (2026.4.12) macOS/Talk: add an experimental local MLX speech provider for Talk Mode, with explicit provider selection, local utterance playback, interruption handling, and system-voice fallback. (#63539) Thanks @ImLukeF.
- (2026.4.15) Memory/LanceDB: add cloud storage support to `memory-lancedb` so durable memory indexes can run on remote object storage instead of local disk only. (#63502) Thanks @rugvedS07.
- (2026.4.18) macOS/gateway: add `screen.snapshot` support for macOS app nodes, including runtime plumbing, default macOS allowlisting, and docs for monitor preview flows. (#67954) Thanks @BunsDev.
- (2026.4.20) Onboard/wizard: restyle the setup security disclaimer with a single yellow warning banner, section headings and bulleted checklists, and un-dim the note body so key guidance is easy to scan; add a loading spinner during the initial model catalog load so the wizard no longer goes blank while it runs; add an "API key" placeholder to provider API key prompts. (#69553) Thanks @Patrick-Erichsen.
- (2026.4.22) Onboarding: auto-install missing provider and channel plugins during setup so first-run configuration can complete without manual plugin recovery. Thanks @vincentkoc.
- (2026.4.24) Google Meet joins OpenClaw as a bundled participant plugin, with personal Google auth, Chrome/Twilio realtime sessions, paired-node Chrome support, artifact/attendance exports, and recovery tooling for already-open Meet tabs.
- (2026.4.24) Talk, Voice Call, and Google Meet can use realtime voice loops that consult the full OpenClaw agent for deeper tool-backed answers.
- (2026.4.25) Voice replies get a full TTS upgrade: `/tts latest`, chat-scoped auto-TTS controls, personas, per-agent/per-account overrides, and new Azure Speech, Xiaomi, Local CLI, Inworld, Volcengine, and ElevenLabs v3 provider coverage. Thanks @leonchui, @zoujiejun, @solar2ain, @cshape, @xuruiray, @itsuzef, and @barronlroth.
- (2026.4.25) OpenTelemetry coverage expands across model calls, token usage, tool loops, harness runs, exec processes, outbound delivery, context assembly, and memory pressure with bounded low-cardinality attributes. Thanks @vincentkoc, @jlapenna, @Lidang-Jiang, and @oc-factus.
- (2026.4.25) Browser automation gets safer tab URLs, iframe-aware role snapshots, CDP readiness tuning, headless one-shot launch, and deeper browser doctor probes for slow hosts. Thanks @beat843796 and @BenediktSchackenberg.
- (2026.4.26) CLI/models: route provider-filtered model listing through an explicit source plan so user config, installed manifest rows, Provider Index previews, and scoped runtime fallbacks keep a stable authority order without adding another catalog cache. Thanks @shakkernerd.
- (2026.4.27) DeepInfra joins the bundled provider set with model discovery, media generation/editing, TTS, embeddings, and provider-owned onboarding policy. Thanks @ats3v.
- (2026.4.27) Tencent Yuanbao and QQBot support expand channel coverage with Yuanbao docs/catalog entries and QQBot group chat, streaming, media upload, and pipeline refactors. Thanks @loongfay and @cxyhhhhh.
- (2026.4.29) Messaging and automation get active-run steering by default, visible-reply enforcement, spawned subagent routing metadata, and opt-in follow-up commitments for heartbeat-delivered reminders. Thanks @vincentkoc, @scoootscooob, @samzong, and @vignesh07.
- (2026.4.29) Memory grows into a people-aware wiki with provenance views, per-conversation Active Memory filters, partial recall on timeout, and bounded REM preview diagnostics. Thanks @vincentkoc, @quengh, @joeykrug, and @samzong.
- (2026.4.29) Gateway and packaged-plugin reliability focuses on slow-host startup, reusable model catalogs, event-loop readiness diagnostics, runtime-dependency repair, stale-session recovery, and version-scoped update caches. Thanks @lpendeavors, @DerFlash, @vincentkoc, @pashpashpash, and @jhsmith409.
- (2026.4.7) CLI/infer: add a first-class `openclaw infer ...` hub for provider-backed inference workflows across model, media, web, and embedding tasks. Thanks @Takhoffman.
- (2026.4.7) Memory/wiki: restore the bundled `memory-wiki` stack with plugin, CLI, sync/query/apply tooling, memory-host integration, structured claim/evidence fields, compiled digest retrieval, claim-health linting, contradiction clustering, staleness dashboards, and freshness-weighted search. Thanks @vincentkoc.
- (2026.4.9) Memory/dreaming: add a grounded REM backfill lane with historical `rem-harness --path`, diary commit/reset flows, cleaner durable-fact extraction, and live short-term promotion integration so old daily notes can replay into Dreams and durable memory without a second memory stack. Thanks @mbelinky.
- (2026.4.9) QA/lab: add character-vibes evaluation reports with model selection and parallel runs so live QA can compare candidate behavior faster.
- …and 12 more

## Merge conflicts (today)

Conflict detection (fork main → upstream v2026.5.12) via `git merge-tree --write-tree --name-only main v2026.5.12`.

Conflicting files:

```
package.json
```

## Polytropos post-merge verification checklist

- Run plugin verification gates + `openclaw plugins doctor`
- Re-verify external plugin deploy-prod behavior (runtime deps + manifest root)
- Validate `.github/workflows/*` vs Polytropos release steps
- Smoke-test Discord + Telegram runtime approvals
- Smoke-test browser tools (browser-cloud) end-to-end

---

## Blog-topic mapping → code evidence (v2026.4.1 → v2026.5.12)

This section maps claims/themes from the OpenClaw blog posts to concrete evidence in the upstream repo (CHANGELOG entries and representative file paths).

### 1) “Security in public” / “Where security is heading” → fs-safe + audits + policy docs

**Changelog evidence (examples):**

- `Security/fs-safe write hardening ...` (atomic rename + revalidation)
- `Browser/Security output boundary hardening ... shared fs-safe write flows`
- `Security: expanded openclaw security audit (+ --fix) ... SECURITY.md reporting policy`

**Code evidence (paths):**

- `src/infra/fs-safe.ts` (+ tests)
- `src/media/*` (uses fs-safe helpers)
- `extensions/browser/src/browser/*` (routes output/download paths through fs-safe)
- `src/node-host/exec-policy.*` (exec approval/policy surface)
- `.github/CODEOWNERS` includes `/SECURITY.md` ownership

### 2) “Rough week” → plugin dependency repair, registry, and externalization

**Changelog evidence (examples):**

- `Plugin startup and install paths move to the cold persisted registry ...`
- `Plugins/registry: recover managed-npm external plugins ...`
- `Plugins/install: harden official plugin install, uninstall, update ...`
- `Dependencies: ... move @openclaw/fs-safe ... to published npm package`
- `Amazon Bedrock: externalize ...` and other “externalize heavy deps” entries

**Code evidence (paths):**

- `src/plugins/*` (install/runtime/registry)
- `docs/cli/plugins.md` (persisted registry description)
- `src/plugins/install.runtime.ts`

### 3) “OpenAI models done right” → models auth + Codex runtime boundary

**Changelog evidence (examples):**

- `Models/OpenAI CLI auth: openclaw models auth login --provider openai ...`
- `OpenAI Codex OAuth/login parity ...`
- `Models/auth: merge provider-owned default-model additions ...`

**Code evidence (paths):**

- `src/commands/models/auth.ts`
- `extensions/openai/*` (codex provider integration)

---

Notes:

- This mapping is evidence-driven: if it is not present in CHANGELOG or code paths, we do not treat it as shipped.
- Some blog claims refer to “in flight” items; we should treat those as roadmap, not part of the v2026.5.12 update scope.
