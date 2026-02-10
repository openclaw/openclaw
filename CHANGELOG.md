# Changelog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Docs: https://docs.openclaw.ai（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.9（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Added（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: add `commands.allowFrom` config for separate command authorization, allowing operators to restrict slash commands to specific users while keeping chat open to others. (#12430) Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: add ClawDock shell helpers for Docker workflows. (#12817) Thanks @Olshansk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS: alpha node app + setup-code onboarding. (#11756) Thanks @mbelinky.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: comprehensive BlueBubbles and channel cleanup. (#11093) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: device pairing + phone control plugins (Telegram `/pair`, iOS/Android node controls). (#11755) Thanks @mbelinky.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add Grok (xAI) as a `web_search` provider. (#12419) Thanks @tmchow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: add agent management RPC methods for the web UI (`agents.create`, `agents.update`, `agents.delete`). (#11045) Thanks @advaitpaliwal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: show a Compaction divider in chat history. (#11341) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: include runtime shell in agent envelopes. (#1835) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: auto-select `zai/glm-4.6v` for image understanding when ZAI is primary provider. (#10267) Thanks @liuy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paths: add `OPENCLAW_HOME` for overriding the home directory used by internal path resolution. (#12091) Thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add Custom Provider flow for OpenAI and Anthropic-compatible endpoints. (#11106) Thanks @MackDing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: add exec approval cleanup option to delete DMs after approval/denial/timeout. (#13205) Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: prune stale entries, cap session store size, rotate large stores, accept duration/size thresholds, default to warn-only maintenance, and prune cron run sessions after retention windows. (#13083) Thanks @skyfallsin, @Glucksberg, @gumadeiras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CI: Implement pipeline and workflow order. Thanks @quotentiroler.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: preserve original filenames for inbound documents. (#12691) Thanks @akramcodez.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: harden quote parsing; preserve quote context; avoid QUOTE_TEXT_INVALID; avoid nested reply quote misclassification. (#12156) Thanks @rybnikov.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: recover proactive sends when stale topic thread IDs are used by retrying without `message_thread_id`. (#11620)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: auto-create forum/media thread posts on send, with chunked follow-up replies and media handling for forum sends. (#12380) Thanks @magendary, @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: cap gateway reconnect attempts to avoid infinite retry loops. (#12230) Thanks @Yida-Dev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: render markdown spoilers with `<tg-spoiler>` HTML tags. (#11543) Thanks @ezhikkk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: truncate command registration to 100 entries to avoid `BOT_COMMANDS_TOO_MUCH` failures on startup. (#12356) Thanks @arosstale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: match DM `allowFrom` against sender user id (fallback to chat id) and clarify pairing logs. (#12779) Thanks @liuxiaopai-ai.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: QuickStart now auto-installs shell completion (prompt only in Manual).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: make `docker-setup.sh` compatible with macOS Bash 3.2 and empty extra mounts. (#9441) Thanks @mateusz-michalik.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: strip embedded line breaks from pasted API keys and tokens before storing/resolving credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: strip reasoning tags and downgraded tool markers from messaging tool and streaming output to prevent leakage. (#11053, #13453) Thanks @liebertar, @meaadore1221-afk, @gumadeiras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: make chat refresh smoothly scroll to the latest messages and suppress new-messages badge flash during manual refresh.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools/web_search: include provider-specific settings in the web search cache key, and pass `inlineCitations` for Grok. (#12419) Thanks @tmchow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools/web_search: fix Grok response parsing for xAI Responses API output blocks. (#13049) Thanks @ereid7.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools/web_search: normalize direct Perplexity model IDs while keeping OpenRouter model IDs unchanged. (#12795) Thanks @cdorsey.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model failover: treat HTTP 400 errors as failover-eligible, enabling automatic model fallback. (#1879) Thanks @orenyomtov.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Errors: prevent false positive context overflow detection when conversation mentions "context overflow" topic. (#2078) Thanks @sbking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Errors: avoid rewriting/swallowing normal assistant replies that mention error keywords by scoping `sanitizeUserFacingText` rewrites to error-context. (#12988) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: re-hydrate state-dir `.env` during runtime config loads so `${VAR}` substitutions remain resolvable. (#12748) Thanks @rodrigouroz.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: no more post-compaction amnesia; injected transcript writes now preserve Pi session `parentId` chain so agents can remember again. (#12283) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: fix multi-agent sessions.usage discovery. (#11523) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: recover from context overflow caused by oversized tool results (pre-emptive capping + fallback truncation). (#11579) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Subagents/compaction: stabilize announce timing and preserve compaction metrics across retries. (#11664) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: share isolated announce flow and harden scheduling/delivery reliability. (#11641) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron tool: recover flat params when LLM omits the `job` wrapper for add requests. (#12124) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/CLI: when `gateway.bind=lan`, use a LAN IP for probe URLs and Control UI links. (#11448) Thanks @AnonO6.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: make `openclaw plugins list` output scannable by hoisting source roots and shortening bundled/global/workspace plugin paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks: fix bundled hooks broken since 2026.2.2 (tsdown migration). (#9295) Thanks @patrickshao.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Routing: refresh bindings per message by loading config at route resolution so binding changes apply without restart. (#11372) Thanks @juanpablodlc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: render forwarded commands in monospace for safer approval scanning. (#11937) Thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: clamp `maxTokens` to `contextWindow` to prevent invalid model configs. (#5516) Thanks @lailoo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thinking: allow xhigh for `github-copilot/gpt-5.2-codex` and `github-copilot/gpt-5.2`. (#11646) Thanks @LatencyTDH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Thinking: honor `/think off` for reasoning-capable models. (#9564) Thanks @liuy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: support forum/media thread-create starter messages, wire `message thread create --message`, and harden routing. (#10062) Thanks @jarvis89757.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Paths: structurally resolve `OPENCLAW_HOME`-derived home paths and fix Windows drive-letter handling in tool meta shortening. (#12125) Thanks @mcaxtr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: set Voyage embeddings `input_type` for improved retrieval. (#10818) Thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: disable async batch embeddings by default for memory indexing (opt-in via `agents.defaults.memorySearch.remote.batch.enabled`). (#13069) Thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory/QMD: reuse default model cache across agents instead of re-downloading per agent. (#12114) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory/QMD: run boot refresh in background by default, add configurable QMD maintenance timeouts, retry QMD after fallback failures, and scope QMD queries to OpenClaw-managed collections. (#9690, #9705, #10042) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory/QMD: initialize QMD backend on gateway startup so background update timers restart after process reloads. (#10797) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config/Memory: auto-migrate legacy top-level `memorySearch` settings into `agents.defaults.memorySearch`. (#11278, #9143) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding: recognize `.caf` audio attachments for transcription. (#10982) Thanks @succ985.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- State dir: honor `OPENCLAW_STATE_DIR` for default device identity and canvas storage paths. (#4824) Thanks @kossoy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.6（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: default `wakeMode` is now `"now"` for new jobs (was `"next-heartbeat"`). (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: `cron run` defaults to force execution; use `--due` to restrict to due-only. (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: support Anthropic Opus 4.6 and OpenAI Codex gpt-5.3-codex (forward-compat fallbacks). (#9853, #10720, #9995) Thanks @TinyTb, @calvin-hpnet, @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: add xAI (Grok) support. (#9885) Thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: add Baidu Qianfan support. (#8868) Thanks @ide-rea.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: add token usage dashboard. (#10072) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: native Voyage AI support. (#7078) Thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: cap sessions_history payloads to reduce context overflow. (#10000) Thanks @gut-puncture.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: sort commands alphabetically in help output. (#8068) Thanks @deepsoumya617.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CI: optimize pipeline throughput (macOS consolidation, Windows perf, workflow concurrency). (#10784) Thanks @mcaxtr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: bump pi-mono to 0.52.7; add embedded forward-compat fallback for Opus 4.6 model ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Added（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: run history deep-links to session chat from the dashboard. (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: per-run session keys in run log entries and default labels for cron sessions. (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: legacy payload field compatibility (`deliver`, `channel`, `to`, `bestEffortDeliver`) in schema. (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: scheduler reliability (timer drift, restart catch-up, lock contention, stale running markers). (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: store migration hardening (legacy field migration, parse error handling, explicit delivery mode persistence). (#10776) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: set Voyage embeddings `input_type` for improved retrieval. (#10818) Thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory/QMD: run boot refresh in background by default, add configurable QMD maintenance timeouts, retry QMD after fallback failures, and scope QMD queries to OpenClaw-managed collections. (#9690, #9705, #10042) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding: recognize `.caf` audio attachments for transcription. (#10982) Thanks @succ985.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: auto-inject DM topic threadId in message tool + subagent announce. (#7235) Thanks @Lukavyi.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: require auth for Gateway canvas host and A2UI assets. (#9518) Thanks @coygeek.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: fix scheduling and reminder delivery regressions; harden next-run recompute + timer re-arming + legacy schedule fields. (#9733, #9823, #9948, #9932) Thanks @tyler6204, @pycckuu, @j2h4u, @fujiwara-tofu-shop.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update: harden Control UI asset handling in update flow. (#10146) Thanks @gumadeiras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: add skill/plugin code safety scanner; redact credentials from config.get gateway responses. (#9806, #9858) Thanks @abdelsfane.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: coerce bare string allowlist entries to objects. (#9903) Thanks @mcaxtr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: add mention stripPatterns for /new and /reset. (#9971) Thanks @ironbyte-rgb.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Chrome extension: fix bundled path resolution. (#8914) Thanks @kelvinCB.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Compaction/errors: allow multiple compaction retries on context overflow; show clear billing errors. (#8928, #8391) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: remove last `@ts-nocheck` from `bot-handlers.ts`, use Grammy types directly, deduplicate `StickerMetadata`. Zero `@ts-nocheck` remaining in `src/telegram/`. (#9206)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: remove `@ts-nocheck` from `bot-message.ts`, type deps via `Omit<BuildTelegramMessageContextParams>`, widen `allMedia` to `TelegramMediaRef[]`. (#9180)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: remove `@ts-nocheck` from `bot.ts`, fix duplicate `bot.catch` error handler (Grammy overrides), remove dead reaction `message_thread_id` routing, harden sticker cache guard. (#9077)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add Cloudflare AI Gateway provider setup and docs. (#7914) Thanks @roerohan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add Moonshot (.cn) auth choice and keep the China base URL when preserving defaults. (#7180) Thanks @waynelwz.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify tmux send-keys for TUI by splitting text and Enter. (#7737) Thanks @Wangnov.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: mirror the landing page revamp for zh-CN (features, quickstart, docs directory, network model, credits). (#8994) Thanks @joshp123.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: add per-channel and per-account responsePrefix overrides across channels. (#9001) Thanks @mudrii.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: add announce delivery mode for isolated jobs (CLI + Control UI) and delivery mode config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: default isolated jobs to announce delivery; accept ISO 8601 `schedule.at` in tool inputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: hard-migrate isolated jobs to announce/none delivery; drop legacy post-to-main/payload delivery fields and `atMs` inputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: delete one-shot jobs after success by default; add `--keep-after-run` for CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: suppress messaging tools during announce delivery so summaries post consistently.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: avoid duplicate deliveries when isolated runs send messages directly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: allow explicit accountId routing for multi-account channels. (#8702) Thanks @lsh411.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI/Gateway: handle non-streaming finals, refresh history for non-local chat runs, and avoid event gap warnings for targeted tool streams. (#8432) Thanks @gumadeiras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Shell completion: auto-detect and migrate slow dynamic patterns to cached files for faster terminal startup; add completion health checks to doctor/update/onboard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: honor session model overrides in inline model selection. (#8193) Thanks @gildo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: fix agent model selection saves for default/non-default agents and wrap long workspace paths. Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: resolve header logo path when `gateway.controlUi.basePath` is set. (#7178) Thanks @Yeom-JinHo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: apply button styling to the new-messages indicator.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: infer auth choice from non-interactive API key flags. (#8484) Thanks @f-trycua.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: keep untrusted channel metadata out of system prompts (Slack/Discord). Thanks @KonstantinMirin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: enforce sandboxed media paths for message tool attachments. (#9182) Thanks @victormier.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: require explicit credentials for gateway URL overrides to prevent credential leakage. (#8113) Thanks @victormier.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: gate `whatsapp_login` tool to owner senders and default-deny non-owner contexts. (#8768) Thanks @victormier.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice call: harden webhook verification with host allowlists/proxy trust and keep ngrok loopback bypass.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice call: add regression coverage for anonymous inbound caller IDs with allowlist policy. (#8104) Thanks @victormier.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: accept epoch timestamps and 0ms durations in CLI `--at` parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: reload store data when the store file is recreated or mtime changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: deliver announce runs directly, honor delivery mode, and respect wakeMode for summaries. (#8540) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: include forward_from_chat metadata in forwarded messages and harden cron delivery target checks. (#8392) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: fix cron payload summary rendering and ISO 8601 formatter concurrency safety.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: enforce DM allowlists for agent components (buttons/select menus), honoring pairing store approvals and tag matches. (#11254) Thanks @thedudeabidesai.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.2-3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update: ship legacy daemon-cli shim for pre-tsdown update imports (fixes daemon restart after npm update).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.2-2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: promote BlueBubbles as the recommended iMessage integration; mark imsg channel as legacy. (#8415) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI status: resolve build-info from bundled dist output (fixes "unknown" commit in npm builds).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.2-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI status: fall back to build-info for version detection (fixes "unknown" in beta builds). Thanks @gumadeira.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Feishu: add Feishu/Lark plugin support + docs. (#7313) Thanks @jiulingyun (openclaw-cn).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: add Agents dashboard for managing agent files, tools, skills, models, channels, and cron jobs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Subagents: discourage direct messaging tool use unless a specific external recipient is requested.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: implement the opt-in QMD backend for workspace memory. (#3160) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: add healthcheck skill and bootstrap audit guidance. (#7641) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: allow setting a default subagent thinking level via `agents.defaults.subagents.thinking` (and per-agent `agents.list[].subagents.thinking`). (#7372) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: zh-CN translations seed + polish, pipeline guidance, nav/landing updates, and typo fixes. (#8202, #6995, #6619, #7242, #7303, #7415) Thanks @AaronWander, @taiyi747, @Explorer1092, @rendaoyuan, @joshp123, @lailoo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add zh-CN i18n guardrails to avoid editing generated translations. (#8416) Thanks @joshp123.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: finish renaming the QMD memory docs to reference the OpenClaw state dir.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: keep TUI flow exclusive (skip completion prompt + background Web UI seed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: drop completion prompt now handled by install/update.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: block onboarding output while TUI is active and restore terminal state on exit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: cache shell completion scripts in state dir and source cached files in profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Zsh completion: escape option descriptions to avoid invalid option errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: repair malformed tool calls and session transcripts. (#7473) Thanks @justinhuangcode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(agents): validate AbortSignal instances before calling AbortSignal.any() (#7277) (thanks @Elarwei001)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(webchat): respect user scroll position during streaming and refresh (#7226) (thanks @marcomarandiz)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: recover from grammY long-poll timed out errors. (#7466) Thanks @macmimi23.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding: skip binary media from file text extraction. (#7475) Thanks @AlexZhangji.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: enforce access-group gating for Slack slash commands when channel type lookup fails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: require validated shared-secret auth before skipping device identity on gateway connect.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: guard skill installer downloads with SSRF checks (block private/localhost URLs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: harden Windows exec allowlist; block cmd.exe bypass via single &. Thanks @simecek.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(voice-call): harden inbound allowlist; reject anonymous callers; require Telnyx publicKey for allowlist; token-gate Twilio media streams; cap webhook body size (thanks @simecek)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding: apply SSRF guardrails to provider fetches; allow private baseUrl overrides explicitly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(webchat): respect user scroll position during streaming and refresh (#7226) (thanks @marcomarandiz)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: recover from grammY long-poll timed out errors. (#7466) Thanks @macmimi23.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: repair malformed tool calls and session transcripts. (#7473) Thanks @justinhuangcode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(agents): validate AbortSignal instances before calling AbortSignal.any() (#7277) (thanks @Elarwei001)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding: skip binary media from file text extraction. (#7475) Thanks @AlexZhangji.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: keep TUI flow exclusive (skip completion prompt + background Web UI seed); completion prompt now handled by install/update.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: block onboarding output while TUI is active and restore terminal state on exit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Zsh completion: cache scripts in state dir and escape option descriptions to avoid invalid option errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(ui): resolve Control UI asset path correctly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(ui): refresh agent files after external edits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: finish renaming the QMD memory docs to reference the OpenClaw state dir.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: stub SSRF DNS pinning in web auto-reply + Gemini video coverage. (#6619) Thanks @joshp123.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.2.1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: onboarding/install/i18n/exec-approvals/Control UI/exe.dev/cacheRetention updates + misc nav/typos. (#3050, #3461, #4064, #4675, #4729, #4763, #5003, #5402, #5446, #5474, #5663, #5689, #5694, #5967, #6270, #6300, #6311, #6416, #6487, #6550, #6789)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: use shared pairing store. (#6127) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add OpenRouter app attribution headers. Thanks @alexanderatallah.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add system prompt safety guardrails. (#5445) Thanks @joshp123.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: update pi-ai to 0.50.9 and rename cacheControlTtl -> cacheRetention (with back-compat mapping).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: extend CreateAgentSessionOptions with systemPrompt/skills/contextFiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add tool policy conformance snapshot (no runtime behavior change). (#6011)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: update MiniMax OAuth hint + portal auth note copy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: inherit thread parent bindings for routing. (#3892) Thanks @aerolalit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: inject timestamps into agent and chat.send messages. (#3705) Thanks @conroywhitney, @CashWilliams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: require TLS 1.3 minimum for TLS listeners. (#5970) Thanks @loganaden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: refine chat layout + extend session active duration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CI: add formal conformance + alias consistency checks. (#5723, #5807)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: guard remote media fetches with SSRF protections (block private/localhost, DNS pinning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updates: clean stale global install rename dirs and extend gateway update timeouts to avoid npm ENOTEMPTY failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: validate plugin/hook install paths and reject traversal-like names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add download timeouts for file fetches. (#6914) Thanks @hclsys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: enforce thread specs for DM vs forum sends. (#6833) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming: flush block streaming on paragraph boundaries for newline chunking. (#7014)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming: stabilize partial streaming filters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: avoid referencing workspace files in /new greeting prompt. (#5706) Thanks @bravostation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: align tool execute adapters/signatures (legacy + parameter order + arg normalization).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: treat "\*" tool allowlist entries as valid to avoid spurious unknown-entry warnings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: update session-logs paths from .clawdbot to .openclaw. (#4502)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: harden media fetch limits and Slack file URL validation. (#6639) Thanks @davidiach.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lint: satisfy curly rule after import sorting. (#6310)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Process: resolve Windows `spawn()` failures for npm-family CLIs by appending `.cmd` when needed. (#5815) Thanks @thejhinvirtuoso.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: resolve PluralKit proxied senders for allowlists and labels. (#5838) Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tlon: add timeout to SSE client fetch calls (CWE-400). (#5926)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory search: L2-normalize local embedding vectors to fix semantic search. (#5332)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: align embedded runner + typings with pi-coding-agent API updates (pi 0.51.0).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: ensure OpenRouter attribution headers apply in the embedded runner.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: cap context window resolution for compaction safeguard. (#6187) Thanks @iamEvanYT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System prompt: resolve overrides and hint using session_status for current date/time. (#1897, #1928, #2108, #3677)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: fix Pi prompt template argument syntax. (#6543)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Subagents: fix announce failover race (always emit lifecycle end; timeout=0 means no-timeout). (#6621)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Teams: gate media auth retries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: restore draft streaming partials. (#5543) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: friendlier Windows onboarding message. (#6242) Thanks @shanselman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: prevent crash when searching with digits in the model selector.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: wire before_tool_call plugin hook into tool execution. (#6570, #6660) Thanks @ryancnelson.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: secure Chrome extension relay CDP sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: use container port for gateway command instead of host port. (#5110) Thanks @mise42.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: start gateway CMD by default for container deployments. (#6635) Thanks @kaizen403.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(lobster): block arbitrary exec via lobsterPath/cwd injection (GHSA-4mhr-g7xj-cg8j). (#5335) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: sanitize WhatsApp accountId to prevent path traversal. (#4610)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: restrict MEDIA path extraction to prevent LFI. (#4930)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: validate message-tool filePath/path against sandbox root. (#6398)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: block LD*/DYLD* env overrides for host exec. (#4896) Thanks @HassanFleyah.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: harden web tool content wrapping + file parsing safeguards. (#4058) Thanks @VACInc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: enforce Twitch `allowFrom` allowlist gating (deny non-allowlisted senders). Thanks @MegaManSec.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.31（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: onboarding/install/i18n/exec-approvals/Control UI/exe.dev/cacheRetention updates + misc nav/typos. (#3050, #3461, #4064, #4675, #4729, #4763, #5003, #5402, #5446, #5474, #5663, #5689, #5694, #5967, #6270, #6300, #6311, #6416, #6487, #6550, #6789)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: use shared pairing store. (#6127) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add OpenRouter app attribution headers. Thanks @alexanderatallah.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add system prompt safety guardrails. (#5445) Thanks @joshp123.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: update pi-ai to 0.50.9 and rename cacheControlTtl -> cacheRetention (with back-compat mapping).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: extend CreateAgentSessionOptions with systemPrompt/skills/contextFiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add tool policy conformance snapshot (no runtime behavior change). (#6011)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: update MiniMax OAuth hint + portal auth note copy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: inherit thread parent bindings for routing. (#3892) Thanks @aerolalit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: inject timestamps into agent and chat.send messages. (#3705) Thanks @conroywhitney, @CashWilliams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: require TLS 1.3 minimum for TLS listeners. (#5970) Thanks @loganaden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: refine chat layout + extend session active duration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CI: add formal conformance + alias consistency checks. (#5723, #5807)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: guard remote media fetches with SSRF protections (block private/localhost, DNS pinning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Updates: clean stale global install rename dirs and extend gateway update timeouts to avoid npm ENOTEMPTY failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: validate plugin/hook install paths and reject traversal-like names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add download timeouts for file fetches. (#6914) Thanks @hclsys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: enforce thread specs for DM vs forum sends. (#6833) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming: flush block streaming on paragraph boundaries for newline chunking. (#7014)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming: stabilize partial streaming filters.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: avoid referencing workspace files in /new greeting prompt. (#5706) Thanks @bravostation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: align tool execute adapters/signatures (legacy + parameter order + arg normalization).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: treat `"*"` tool allowlist entries as valid to avoid spurious unknown-entry warnings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: update session-logs paths from .clawdbot to .openclaw. (#4502)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: harden media fetch limits and Slack file URL validation. (#6639) Thanks @davidiach.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lint: satisfy curly rule after import sorting. (#6310)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Process: resolve Windows `spawn()` failures for npm-family CLIs by appending `.cmd` when needed. (#5815) Thanks @thejhinvirtuoso.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: resolve PluralKit proxied senders for allowlists and labels. (#5838) Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tlon: add timeout to SSE client fetch calls (CWE-400). (#5926)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory search: L2-normalize local embedding vectors to fix semantic search. (#5332)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: align embedded runner + typings with pi-coding-agent API updates (pi 0.51.0).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: ensure OpenRouter attribution headers apply in the embedded runner.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: cap context window resolution for compaction safeguard. (#6187) Thanks @iamEvanYT.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System prompt: resolve overrides and hint using session_status for current date/time. (#1897, #1928, #2108, #3677)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: fix Pi prompt template argument syntax. (#6543)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Subagents: fix announce failover race (always emit lifecycle end; timeout=0 means no-timeout). (#6621)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Teams: gate media auth retries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: restore draft streaming partials. (#5543) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: friendlier Windows onboarding message. (#6242) Thanks @shanselman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: prevent crash when searching with digits in the model selector.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: wire before_tool_call plugin hook into tool execution. (#6570, #6660) Thanks @ryancnelson.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: secure Chrome extension relay CDP sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: use container port for gateway command instead of host port. (#5110) Thanks @mise42.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: start gateway CMD by default for container deployments. (#6635) Thanks @kaizen403.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- fix(lobster): block arbitrary exec via lobsterPath/cwd injection (GHSA-4mhr-g7xj-cg8j). (#5335) Thanks @vignesh07.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: sanitize WhatsApp accountId to prevent path traversal. (#4610)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: restrict MEDIA path extraction to prevent LFI. (#4930)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: validate message-tool filePath/path against sandbox root. (#6398)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: block LD*/DYLD* env overrides for host exec. (#4896) Thanks @HassanFleyah.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: harden web tool content wrapping + file parsing safeguards. (#4058) Thanks @VACInc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: enforce Twitch `allowFrom` allowlist gating (deny non-allowlisted senders). Thanks @MegaManSec.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.30（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add `completion` command (Zsh/Bash/PowerShell/Fish) and auto-setup during postinstall/onboarding.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add per-agent `models status` (`--agent` filter). (#4780) Thanks @jlowin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add Kimi K2.5 to the synthetic model catalog. (#4407) Thanks @manikv12.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: switch Kimi Coding to built-in provider; normalize OAuth profile email.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: add MiniMax OAuth plugin + onboarding option. (#4521) Thanks @Maosghoul.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: update pi SDK/API usage and dependencies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: refresh sessions after chat commands and improve session display names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: move TypeScript builds to `tsdown` + `tsgo` (faster builds, CI typechecks), update tsconfig target, and clean up lint rules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: align npm tar override and bin metadata so the `openclaw` CLI entrypoint is preserved in npm publishes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add pi/pi-dev docs and update OpenClaw branding + install links.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker E2E: stabilize gateway readiness, plugin installs/manifests, and cleanup/doctor switch entrypoint checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: restrict local path extraction in media parser to prevent LFI. (#4880)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: prevent token defaults from becoming the literal "undefined". (#4873) Thanks @Hisleren.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: fix assets resolution for npm global installs. (#4909) Thanks @YuriNachos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: avoid stderr pipe backpressure in gateway discovery. (#3304) Thanks @abhijeet117.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: normalize account token lookup for non-normalized IDs. (#5055) Thanks @jasonsschin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: preserve delivery thread fallback and fix threadId handling in delivery context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: fix HTML nesting for overlapping styles/links. (#4578) Thanks @ThanhNguyxn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: accept numeric messageId/chatId in react actions. (#4533) Thanks @Ayush10.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: honor per-account proxy dispatcher via undici fetch. (#4456) Thanks @spiceoogway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: scope skill commands to bound agent per bot. (#4360) Thanks @robhparker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: debounce by messageId to preserve attachments in text+image messages. (#4984)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Routing: prefer requesterOrigin over stale session entries for sub-agent announce delivery. (#4957)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Extensions: restore embedded extension discovery typings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: fix `tui:dev` port resolution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- LINE: fix status command TypeError. (#4651)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OAuth: skip expired-token warnings when refresh tokens are still valid. (#4593)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: skip redundant UI install step in Dockerfile. (#4584) Thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.29（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Rebrand: rename the npm package/CLI to `openclaw`, add a `openclaw` compatibility shim, and move extensions to the `@openclaw/*` scope.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: strengthen security warning copy for beta + access control expectations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add Venice API key to non-interactive flow. (#1893) Thanks @jonisjongithub.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: auto-migrate legacy state/config paths and keep config resolution consistent across legacy filenames.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: warn on hook tokens via query params; document header auth preference. (#2200) Thanks @YuriNachos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: add dangerous Control UI device auth bypass flag + audit warnings. (#2248)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: warn on gateway exposure without auth. (#2016) Thanks @Alex-Alaniz.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: keep sub-agent announce replies visible in WebChat. (#1977) Thanks @andrescardonas7.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: route browser control via gateway/node; remove standalone browser control command and control URL config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: route `browser.request` via node proxies when available; honor proxy timeouts; derive browser ports from `gateway.port`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: fall back to URL matching for extension relay target resolution. (#1999) Thanks @jonit-dev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: allow caption param for media sends. (#1888) Thanks @mguellsegarra.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: support plugin sendPayload channelData (media/buttons) and validate plugin commands. (#1917) Thanks @JoshuaLelon.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: avoid block replies when streaming is disabled. (#1885) Thanks @ivancasco.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add optional silent send flag (disable notifications). (#2382) Thanks @Suksham-sharma.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: support editing sent messages via message(action="edit"). (#2394) Thanks @marcelomar21.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: support quote replies for message tool and inbound context. (#2900) Thanks @aduk059.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add sticker receive/send with vision caching. (#2629) Thanks @longjos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: send sticker pixels to vision models. (#2650)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: keep topic IDs in restart sentinel notifications. (#1807) Thanks @hsrvc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: add configurable privileged gateway intents for presences/members. (#2266) Thanks @kentaro.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: clear ack reaction after streamed replies. (#2044) Thanks @fancyboi999.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix: switch plugin SDK to @vector-im/matrix-bot-sdk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tlon: format thread reply IDs as @ud. (#1837) Thanks @wca4a.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add per-sender group tool policies and fix precedence. (#1757) Thanks @adam91holt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: summarize dropped messages during compaction safeguard pruning. (#2509) Thanks @jogi47.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: expand cron tool description with full schema docs. (#1988) Thanks @tomascupr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: honor tools.exec.safeBins in exec allowlist checks. (#2281)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory Search: allow extra paths for memory indexing (ignores symlinks). (#3600) Thanks @kira-ariaki.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: add multi-image input support to Nano Banana Pro skill. (#1958) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: add missing dependency metadata for GitHub, Notion, Slack, Discord. (#1995) Thanks @jackheuberger.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: group /help and /commands output with Telegram paging. (#2504) Thanks @hougangdev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Routing: add per-account DM session scope and document multi-account isolation. (#3095) Thanks @jarvis-sam.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Routing: precompile session key regexes. (#1697) Thanks @Ray0907.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: use Node's module compile cache for faster startup. (#2808) Thanks @pi0.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: show copyable Google auth URL after ASCII prompt. (#1787) Thanks @robbyczgw-cla.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: avoid width overflow when rendering selection lists. (#1686) Thanks @mossein.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: finish OpenClaw app rename for macOS sources, bundle identifiers, and shared kit paths. (#2844) Thanks @fal3.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Branding: update launchd labels, mobile bundle IDs, and logging subsystems to bot.molt (legacy bundle ID migrations). Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: limit project-local `node_modules/.bin` PATH preference to debug builds (reduce PATH hijacking risk).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: keep custom SSH usernames in remote target. (#2046) Thanks @algal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: avoid crash when rendering code blocks by bumping Textual to 0.3.1. (#2033) Thanks @garricn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Update: ignore dist/control-ui for dirty checks and restore after ui builds. (#1976) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: bundle A2UI assets during build and stop tracking generated bundles. (#2455) Thanks @0oAstro.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CI: increase Node heap size for macOS checks. (#1890) Thanks @realZachi.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: apply config.env before ${VAR} substitution. (#1813) Thanks @spanishflu-est1918.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: prefer newest session metadata when combining stores. (#1823) Thanks @emanuelst.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: tighten Fly private deployment steps. (#2289) Thanks @dguido.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add migration guide for moving to a new machine. (#2381)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Northflank one-click deployment guide. (#2167) Thanks @AdeboyeDN.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Vercel AI Gateway to providers sidebar. (#1901) Thanks @jerilynzheng.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Render deployment guide. (#1975) Thanks @anurag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Claude Max API Proxy guide. (#1875) Thanks @atalovesyou.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add DigitalOcean deployment guide. (#1870) Thanks @0xJonHoldsCrypto.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Oracle Cloud (OCI) platform guide + cross-links. (#2333) Thanks @hirefrank.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Raspberry Pi install guide. (#1871) Thanks @0xJonHoldsCrypto.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add GCP Compute Engine deployment guide. (#1848) Thanks @hougangdev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add LINE channel guide. Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: credit both contributors for Control UI refresh. (#1852) Thanks @EnzeD.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: keep docs header sticky so navbar stays visible while scrolling. (#2445) Thanks @chenyuan99.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: update exe.dev install instructions. (#https://github.com/openclaw/openclaw/pull/3047) Thanks @zackerthescar.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Gateway auth mode "none" is removed; gateway now requires token/password (Tailscale Serve identity still allowed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: update session-logs paths to use ~/.openclaw. (#4502) Thanks @bonald.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: avoid silent empty replies by tracking normalization skips before fallback. (#3796)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mentions: honor mentionPatterns even when explicit mentions are present. (#3303) Thanks @HirokiKobayashi-R.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: restore username directory lookup in target resolution. (#3131) Thanks @bonald.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: align MiniMax base URL test expectation with default provider config. (#3131) Thanks @bonald.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: prevent retries on oversized image errors and surface size limits. (#2871) Thanks @Suksham-sharma.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: inherit provider baseUrl/api for inline models. (#2740) Thanks @lploc94.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory Search: keep auto provider model defaults and only include remote when configured. (#2576) Thanks @papago2355.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: include AccountId in native command context for multi-agent routing. (#2942) Thanks @Chloe-VP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: handle video note attachments in media extraction. (#2905) Thanks @mylukin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS: read OPENAI_TTS_BASE_URL at runtime instead of module load to honor config.env. (#3341) Thanks @hclsys.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: auto-scroll to bottom when sending a new message while scrolled up. (#2471) Thanks @kennyklee.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: auto-expand the chat compose textarea while typing (with sensible max height). (#2950) Thanks @shivamraut101.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: prevent crashes on transient network errors (fetch failures, timeouts, DNS). Added fatal error detection to only exit on truly critical errors. Fixes #2895, #2879, #2873. (#2980) Thanks @elliotsecops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: guard channel tool listActions to avoid plugin crashes. (#2859) Thanks @mbelinky.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: stop resolveDiscordTarget from passing directory params into messaging target parsers. Fixes #3167. Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: avoid resolving bare channel names to user DMs when a username matches. Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: fix directory config type import for target resolution. Thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: update MiniMax API endpoint and compatibility mode. (#3064) Thanks @hlbbbbbbb.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: treat more network errors as recoverable in polling. (#3013) Thanks @ryancontent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: resolve usernames to user IDs for outbound messages. (#2649) Thanks @nonggialiang.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: update Moonshot Kimi model references to kimi-k2.5. (#2762) Thanks @MarvinCui.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: suppress AbortError and transient network errors in unhandled rejections. (#2451) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS: keep /tts status replies on text-only commands and avoid duplicate block-stream audio. (#2451) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: pin npm overrides to keep tar@7.5.4 for install toolchains.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: properly test Windows ACL audit for config includes. (#2403) Thanks @dominicnunez.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: recognize versioned Node executables when parsing argv. (#2490) Thanks @David-Marsh-Photo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: avoid prompting for gateway runtime under the spinner. (#2874)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: coalesce inbound URL link preview messages. (#1981) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: allow payloads containing "heartbeat" in event filter. (#2219) Thanks @dwfinkelstein.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: avoid loading config for global help/version while registering plugin commands. (#2212) Thanks @dial481.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: include memory.md when bootstrapping memory context. (#2318) Thanks @czekaj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: release session locks on process termination and cover more signals. (#2483) Thanks @janeexai.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: skip cooldowned providers during model failover. (#2143) Thanks @YiWang24.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: harden polling + retry behavior for transient network errors and Node 22 transport issues. (#2420) Thanks @techboss.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: ignore non-forum group message_thread_id while preserving DM thread sessions. (#2731) Thanks @dylanneve1.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: wrap reasoning italics per line to avoid raw underscores. (#2181) Thanks @YuriNachos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: centralize API error logging for delivery and bot calls. (#2492) Thanks @altryne.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice Call: enforce Twilio webhook signature verification for ngrok URLs; disable ngrok free tier bypass by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: harden Tailscale Serve auth by validating identity via local tailscaled before trusting headers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media: fix text attachment MIME misclassification with CSV/TSV inference and UTF-16 detection; add XML attribute escaping for file output. (#3628) Thanks @frankekn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: align memory-core peer dependency with lockfile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: add mDNS discovery mode with minimal default to reduce information disclosure. (#1882) Thanks @orlyjamie.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: harden URL fetches with DNS pinning to reduce rebinding risk. Thanks Chris Zheng.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: improve WebChat image paste previews and allow image-only sends. (#1925) Thanks @smartprogrammer93.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: wrap external hook content by default with a per-hook opt-out. (#1827) Thanks @mertcicekci0.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: default auth now fail-closed (token/password required; Tailscale Serve identity remains allowed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: treat loopback + non-local Host connections as remote unless trusted proxy headers are present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: remove unsupported gateway auth "off" choice from onboarding/configure flows and CLI flags.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.24-3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: fix image downloads failing due to missing Authorization header on cross-origin redirects. (#1936) Thanks @sanderhelgesen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: harden reverse proxy handling for local-client detection and unauthenticated proxied connects. (#1795) Thanks @orlyjamie.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security audit: flag loopback Control UI with auth disabled as critical. (#1795) Thanks @orlyjamie.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: resume claude-cli sessions and stream CLI replies to TUI clients. (#1921) Thanks @rmorse.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.24-2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: include dist/link-understanding output in npm tarball (fixes missing apply.js import on install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.24-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: include dist/shared output in npm tarball (fixes missing reasoning-tags import on install).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.24（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: Ollama discovery + docs; Venice guide upgrades + cross-links. (#1606) Thanks @abhaymundhara. https://docs.openclaw.ai/providers/ollama https://docs.openclaw.ai/providers/venice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: LINE plugin (Messaging API) with rich replies + quick replies. (#1630) Thanks @plum-dawg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS: Edge fallback (keyless) + `/tts` auto modes. (#1668, #1667) Thanks @steipete, @sebslight. https://docs.openclaw.ai/tts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: approve in-chat via `/approve` across all channels (including plugins). (#1621) Thanks @czekaj. https://docs.openclaw.ai/tools/exec-approvals https://docs.openclaw.ai/tools/slash-commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: DM topics as separate sessions + outbound link preview toggle. (#1597, #1700) Thanks @rohannagpal, @zerone0x. https://docs.openclaw.ai/channels/telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: add LINE plugin (Messaging API) with rich replies, quick replies, and plugin HTTP registry. (#1630) Thanks @plum-dawg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS: add Edge TTS provider fallback, defaulting to keyless Edge with MP3 retry on format failures. (#1668) Thanks @steipete. https://docs.openclaw.ai/tts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS: add auto mode enum (off/always/inbound/tagged) with per-session `/tts` override. (#1667) Thanks @sebslight. https://docs.openclaw.ai/tts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: treat DM topics as separate sessions and keep DM history limits stable with thread suffixes. (#1597) Thanks @rohannagpal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add `channels.telegram.linkPreview` to toggle outbound link previews. (#1700) Thanks @zerone0x. https://docs.openclaw.ai/channels/telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web search: add Brave freshness filter parameter for time-scoped results. (#1688) Thanks @JonUleis. https://docs.openclaw.ai/tools/web（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: refresh Control UI dashboard design system (colors, icons, typography). (#1745, #1786) Thanks @EnzeD, @mousberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: forward approval prompts to chat with `/approve` for all channels (including plugins). (#1621) Thanks @czekaj. https://docs.openclaw.ai/tools/exec-approvals https://docs.openclaw.ai/tools/slash-commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: expose config.patch in the gateway tool with safe partial updates + restart sentinel. (#1653) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Diagnostics: add diagnostic flags for targeted debug logs (config + env override). https://docs.openclaw.ai/diagnostics/flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: expand FAQ (migration, scheduling, concurrency, model recommendations, OpenAI subscription auth, Pi sizing, hackable install, docs SSL workaround).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add verbose installer troubleshooting guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add macOS VM guide with local/hosted options + VPS/nodes guidance. (#1693) Thanks @f-trycua.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Bedrock EC2 instance role setup + IAM steps. (#1625) Thanks @sergical. https://docs.openclaw.ai/bedrock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: update Fly.io guide notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dev: add prek pre-commit hooks + dependabot config for weekly updates. (#1720) Thanks @dguido.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: fix config/debug layout overflow, scrolling, and code block sizing. (#1715) Thanks @saipreetham589.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: show Stop button during active runs, swap back to New session when idle. (#1664) Thanks @ndbroadbent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: clear stale disconnect banners on reconnect; allow form saves with unsupported schema paths but block missing schema. (#1707) Thanks @Glucksberg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI: hide internal `message_id` hints in chat bubbles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: allow Control UI token-only auth to skip device pairing even when device identity is present (`gateway.controlUi.allowInsecureAuth`). (#1679) Thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix: decrypt E2EE media attachments with preflight size guard. (#1744) Thanks @araa47.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: route phone-number targets to DMs, avoid leaking routing IDs, and auto-create missing DMs (Private API required). (#1751) Thanks @tyler6204. https://docs.openclaw.ai/channels/bluebubbles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: keep part-index GUIDs in reply tags when short IDs are missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: normalize chat_id/chat_guid/chat_identifier prefixes case-insensitively and keep service-prefixed handles stable. (#1708) Thanks @aaronn.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: repair reaction sends (group/UUID targets + CLI author flags). (#1651) Thanks @vilkasdev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: add configurable signal-cli startup timeout + external daemon mode docs. (#1677) https://docs.openclaw.ai/channels/signal（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: set fetch duplex="half" for uploads on Node 22 to avoid sendPhoto failures. (#1684) Thanks @commdata2338.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: use wrapped fetch for long-polling on Node to normalize AbortSignal handling. (#1639)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: honor per-account proxy for outbound API calls. (#1774) Thanks @radek-paclt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: fall back to text when voice notes are blocked by privacy settings. (#1725) Thanks @foeken.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice Call: return stream TwiML for outbound conversation calls on initial Twilio webhook. (#1634)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice Call: serialize Twilio TTS playback and cancel on barge-in to prevent overlap. (#1713) Thanks @dguido.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google Chat: tighten email allowlist matching, typing cleanup, media caps, and onboarding/docs/tests. (#1635) Thanks @iHildy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google Chat: normalize space targets without double `spaces/` prefix.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: auto-compact on context overflow prompt errors before failing. (#1627) Thanks @rodrigouroz.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: use the active auth profile for auto-compaction recovery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media understanding: skip image understanding when the primary model already supports vision. (#1747) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: default missing custom provider fields so minimal configs are accepted.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging: keep newline chunking safe for fenced markdown blocks across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging: treat newline chunking as paragraph-aware (blank-line splits) to keep lists and headings together. (#1726) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: reload history after gateway reconnect to restore session state. (#1663)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: normalize target identifiers for consistent routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: keep approvals for elevated ask unless full mode. (#1616) Thanks @ivancasco.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: treat Windows platform labels as Windows for node shell selection. (#1760) Thanks @ymat19.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: include inline config env vars in service install environments. (#1735) Thanks @Seredeep.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: skip Tailscale DNS probing when tailscale.mode is off. (#1671)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: reduce log noise for late invokes + remote node probes; debounce skills refresh. (#1607) Thanks @petter-b.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: clarify Control UI/WebChat auth error hints for missing tokens. (#1690)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: listen on IPv6 loopback when bound to 127.0.0.1 so localhost webhooks work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: store lock files in the temp directory to avoid stale locks on persistent volumes. (#1676)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: default direct-transport `ws://` URLs to port 18789; document `gateway.remote.transport`. (#1603) Thanks @ngutman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: cap Vitest workers on CI macOS to reduce timeouts. (#1597) Thanks @rohannagpal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: avoid fake-timer dependency in embedded runner stream mock to reduce CI flakes. (#1597) Thanks @rohannagpal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: increase embedded runner ordering test timeout to reduce CI flakes. (#1597) Thanks @rohannagpal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.23-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: include dist/tts output in npm tarball (fixes missing dist/tts/tts.js).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.23（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTS: move Telegram TTS into core + enable model-driven TTS tags by default for expressive audio replies. (#1559) Thanks @Glucksberg. https://docs.openclaw.ai/tts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: add `/tools/invoke` HTTP endpoint for direct tool calls (auth + tool policy enforced). (#1575) Thanks @vignesh07. https://docs.openclaw.ai/gateway/tools-invoke-http-api（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: per-channel visibility controls (OK/alerts/indicator). (#1452) Thanks @dlauer. https://docs.openclaw.ai/gateway/heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deploy: add Fly.io deployment support + guide. (#1570) https://docs.openclaw.ai/platforms/fly（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: add Tlon/Urbit channel plugin (DMs, group mentions, thread replies). (#1544) Thanks @wca4a. https://docs.openclaw.ai/channels/tlon（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: allow per-group tool allow/deny policies across built-in + plugin channels. (#1546) Thanks @adam91holt. https://docs.openclaw.ai/multi-agent-sandbox-tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add Bedrock auto-discovery defaults + config overrides. (#1553) Thanks @fal3. https://docs.openclaw.ai/bedrock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add `openclaw system` for system events + heartbeat controls; remove standalone `wake`. (commit 71203829d) https://docs.openclaw.ai/cli/system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add live auth probes to `openclaw models status` for per-profile verification. (commit 40181afde) https://docs.openclaw.ai/cli/models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: restart the gateway by default after `openclaw update`; add `--no-restart` to skip it. (commit 2c85b1b40)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: add node-host proxy auto-routing for remote gateways (configurable per gateway/node). (commit c3cb26f7c)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add optional `llm-task` JSON-only tool for workflows. (#1498) Thanks @vignesh07. https://docs.openclaw.ai/tools/llm-task（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Markdown: add per-channel table conversion (bullets for Signal/WhatsApp, code blocks elsewhere). (#1495) Thanks @odysseus0.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: keep system prompt time zone-only and move current time to `session_status` for better cache hits. (commit 66eec295b)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: remove redundant bash tool alias from tool registration/display. (#1571) Thanks @Takhoffman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add cron vs heartbeat decision guide (with Lobster workflow notes). (#1533) Thanks @JustYannicc. https://docs.openclaw.ai/automation/cron-vs-heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify HEARTBEAT.md empty file skips heartbeats, missing file still runs. (#1535) Thanks @JustYannicc. https://docs.openclaw.ai/gateway/heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: accept non-UUID sessionIds for history/send/status while preserving agent scoping. (#1518)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: accept plugin channel ids for heartbeat target validation + UI hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging/Sessions: mirror outbound sends into target session keys (threads + dmScope), create session entries on send, and normalize session key casing. (#1520, commit 4b6cdd1d3)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: reject array-backed session stores to prevent silent wipes. (#1469)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: compare Linux process start time to avoid PID recycling lock loops; keep locks unless stale. (#1572) Thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: accept null optional fields in exec approval requests. (#1511) Thanks @pvoo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: persist allowlist entry ids to keep macOS allowlist rows stable. (#1521) Thanks @ngutman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: honor tools.exec ask/security defaults for elevated approvals (avoid unwanted prompts). (commit 5662a9cdf)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon: use platform PATH delimiters when building minimal service paths. (commit a4e57d3ac)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Linux: include env-configured user bin roots in systemd PATH and align PATH audits. (#1512) Thanks @robbyczgw-cla.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale: retry serve/funnel with sudo only for permission errors and keep original failure details. (#1551) Thanks @sweepies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: update gateway command in docker-compose and Hetzner guide. (#1514)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: show tool error fallback when the last assistant turn only invoked tools (prevents silent stops). (commit 8ea8801d0)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: ignore IDENTITY.md template placeholders when parsing identity. (#1556)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: drop orphaned OpenAI Responses reasoning blocks on model switches. (#1562) Thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add CLI log hint to "agent failed before reply" messages. (#1550) Thanks @sweepies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: warn and ignore tool allowlists that only reference unknown or unloaded plugin tools. (#1566)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: treat plugin-only tool allowlists as opt-ins; keep core tools enabled. (#1467)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: honor enqueue overrides for embedded runs to avoid queue deadlocks in tests. (commit 084002998)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: honor open groupPolicy for unlisted channels in message + slash gating. (#1563) Thanks @itsjaydesu.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: limit autoThread mention bypass to bot-owned threads; keep ack reactions mention-gated. (#1511) Thanks @pvoo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: retry rate-limited allowlist resolution + command deploy to avoid gateway crashes. (commit f70ac0c7c)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mentions: ignore mentionPattern matches when another explicit mention is present in group chats (Slack/Discord/Telegram/WhatsApp). (commit d905ca0e0)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: render markdown in media captions. (#1478)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams: remove `.default` suffix from Graph scopes and Bot Framework probe scopes. (#1507, #1574) Thanks @Evizero.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: keep extension relay tabs controllable when the extension reuses a session id after switching tabs. (#1160)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice wake: auto-save wake words on blur/submit across iOS/Android and align limits with macOS. (commit 69f645c66)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: keep the Control UI sidebar visible while scrolling long pages. (#1515) Thanks @pookNast.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: cache Control UI markdown rendering + memoize chat text extraction to reduce Safari typing jank. (commit d57cb2e1a)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: forward unknown slash commands, include Gateway commands in autocomplete, and render slash replies as system output. (commit 1af227b61, commit 8195497ce, commit 6fba598ea)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: auth probe output polish (table output, inline errors, reduced noise, and wrap fixes in `openclaw models status`). (commit da3f2b489, commit 00ae21bed, commit 31e59cd58, commit f7dc27f2d, commit 438e782f8, commit 886752217, commit aabe0bed3, commit 81535d512, commit c63144ab1)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media: only parse `MEDIA:` tags when they start the line to avoid stripping prose mentions. (#1206)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media: preserve PNG alpha when possible; fall back to JPEG when still over size cap. (#1491) Thanks @robbyczgw-cla.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: gate bird Homebrew install to macOS. (#1569) Thanks @bradleypriest.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.22（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Highlight: Compaction safeguard now uses adaptive chunking, progressive fallback, and UI status + retries. (#1466) Thanks @dlauer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: add Antigravity usage tracking to status output. (#1490) Thanks @patelhiren.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: add chat-type reply threading overrides via `replyToModeByChatType`. (#1442) Thanks @stefangalescu.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: add `asVoice` support for MP3/CAF voice memos in sendAttachment. (#1477, #1482) Thanks @Nicell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add hatch choice (TUI/Web/Later), token explainer, background dashboard seed on macOS, and showcase link.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: stop typing indicator on idle/no-reply. (#1439) Thanks @Nicell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Message tool: keep path/filePath as-is for send; hydrate buffers only for sendAttachment. (#1444) Thanks @hopyky.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: only report a model switch when session state is available. (#1465) Thanks @robbyczgw-cla.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: resolve local avatar URLs with basePath across injection + identity RPC. (#1457) Thanks @dlauer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: sanitize assistant history text to strip tool-call markers. (#1456) Thanks @zerone0x.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: clarify Message Content Intent onboarding hint. (#1487) Thanks @kyleok.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: stop the service before uninstalling and fail if it remains loaded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: surface concrete API error details instead of generic AI service errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: fall back to non-PTY when PTY spawn fails (EBADF). (#1484)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: allow per-segment allowlists for chained shell commands on gateway + node hosts. (#1458) Thanks @czekaj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: make OpenAI sessions image-sanitize-only; gate tool-id/repair sanitization by provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: honor CLAWDBOT_GATEWAY_TOKEN for auth checks and security audit token reuse. (#1448) Thanks @azade-c.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: make tool summaries more readable and only show optional params when set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: honor SOUL.md guidance even when the file is nested or path-qualified. (#1434) Thanks @neooriginal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix (plugin): persist m.direct for resolved DMs and harden room fallback. (#1436, #1486) Thanks @sibbl.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: prefer `~` for home paths in output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mattermost (plugin): enforce pairing/allowlist gating, keep @username targets, and clarify plugin-only docs. (#1428) Thanks @damoahdominic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: centralize transcript sanitization in the runner; keep <final> tags and error turns intact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: skip auth profiles in cooldown during initial selection and rotation. (#1316) Thanks @odrobnik.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/TUI: honor user-pinned auth profiles during cooldown and preserve search picker ranking. (#1432) Thanks @tobiasbischoff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: fix gog auth services example to include docs scope. (#1454) Thanks @zerone0x.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: reduce WebClient retries to avoid duplicate sends. (#1481)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: read thread replies for message reads when threadId is provided (replies-only). (#1450) Thanks @rodrigouroz.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: honor accountId across message actions and cron deliveries. (#1492) Thanks @svkozak.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: prefer linked channels in gateway summary to avoid false “not linked” status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS/tests: fix gateway summary lookup after guard unwrap; prevent browser opens during tests. (ECID-1483)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.21-2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: ignore bootstrap identity placeholder text for avatar values and fall back to the default avatar. https://docs.openclaw.ai/cli/agents https://docs.openclaw.ai/web/control-ui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: remove deprecated `filetype` field from `files.uploadV2` to eliminate API warnings. (#1447)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.21（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Highlight: Lobster optional plugin tool for typed workflows + approval gates. https://docs.openclaw.ai/tools/lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Lobster: allow workflow file args via `argsJson` in the plugin tool. https://docs.openclaw.ai/tools/lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: allow running heartbeats in an explicit session key. (#1256) Thanks @zknicker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: default exec approvals to the local host, add gateway/node targeting flags, and show target details in allowlist output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: exec approvals mutations render tables instead of raw JSON.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: support wildcard agent allowlists (`*`) across all agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: allowlist matches resolved binary paths only, add safe stdin-only bins, and tighten allowlist shell parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes: expose node PATH in status/describe and bootstrap PATH for node-host execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: flatten node service commands under `openclaw node` and remove `service node` docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: move gateway service commands under `openclaw gateway` and add `gateway probe` for reachability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: add per-channel reset overrides via `session.resetByChannel`. (#1353) Thanks @cash-echo-bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add identity avatar config support and Control UI avatar rendering. (#1329, #1424) Thanks @dlauer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: show per-session assistant identity in the Control UI. (#1420) Thanks @robbyczgw-cla.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add `openclaw update wizard` for interactive channel selection and restart prompts. https://docs.openclaw.ai/cli/update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: add typing indicators and DM read receipts via signal-cli.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MSTeams: add file uploads, adaptive cards, and attachment handling improvements. (#1410) Thanks @Evizero.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: remove the run setup-token auth option (paste setup-token or reuse CLI creds instead).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add troubleshooting entry for gateway.mode blocking gateway start. https://docs.openclaw.ai/gateway/troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add /model allowlist troubleshooting note. (#1405)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add per-message Gmail search example for gog. (#1220) Thanks @mbelinky.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Control UI now rejects insecure HTTP without device identity by default. Use HTTPS (Tailscale Serve) or set `gateway.controlUi.allowInsecureAuth: true` to allow token-only auth. https://docs.openclaw.ai/web/control-ui#insecure-http（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Envelope and system event timestamps now default to host-local time (was UTC) so agents don’t have to constantly convert.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes/macOS: prompt on allowlist miss for node exec approvals, persist allowlist decisions, and flatten node invoke errors. (#1394) Thanks @ngutman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: keep auto bind loopback-first and add explicit tailnet binding to avoid Tailscale taking over local UI. (#1380)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: prevent CLI hangs by deferring vector probes, adding sqlite-vec/embedding timeouts, and showing sync progress early.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: enforce 9-char alphanumeric tool call ids for Mistral providers. (#1372) Thanks @zerone0x.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Embedded runner: persist injected history images so attachments aren’t reloaded each turn. (#1374) Thanks @Nicell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes tool: include agent/node/gateway context in tool failure logs to speed approval debugging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: exec approvals now respect wildcard agent allowlists (`*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: allow SSH agent auth when no identity file is set. (#1384) Thanks @ameno-.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: prevent multiple gateways from sharing the same config/state at once (singleton lock).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: remove the chat stop button and keep the composer aligned to the bottom edge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Typing: start instant typing indicators at run start so DMs and mentions show immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure: restrict the model allowlist picker to OAuth-compatible Anthropic models and preselect Opus 4.5.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure: seed model fallbacks from the allowlist selection when multiple models are chosen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model picker: list the full catalog when no model allowlist is configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: honor wildcard channel configs via shared match helpers. (#1334) Thanks @pvoo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- BlueBubbles: resolve short message IDs safely and expose full IDs in templates. (#1387) Thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Infra: preserve fetch helper methods when wrapping abort signals. (#1387)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: default distribution packaging to universal binaries. (#1396) Thanks @JustYannicc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: add copy-as-markdown with error feedback. (#1345) https://docs.openclaw.ai/web/control-ui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: drop the legacy list view. (#1345) https://docs.openclaw.ai/web/control-ui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: add syntax highlighting for code blocks. (#1200) https://docs.openclaw.ai/tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: session picker shows derived titles, fuzzy search, relative times, and last message preview. (#1271) https://docs.openclaw.ai/tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: add a searchable model picker for quicker model selection. (#1198) https://docs.openclaw.ai/tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: add input history (up/down) for submitted messages. (#1348) https://docs.openclaw.ai/tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP: add `openclaw acp` for IDE integrations. https://docs.openclaw.ai/cli/acp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ACP: add `openclaw acp client` interactive harness for debugging. https://docs.openclaw.ai/cli/acp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: add download installs with OS-filtered options. https://docs.openclaw.ai/tools/skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: add the local sherpa-onnx-tts skill. https://docs.openclaw.ai/tools/skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add hybrid BM25 + vector search (FTS5) with weighted merging and fallback. https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add SQLite embedding cache to speed up reindexing and frequent updates. https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add OpenAI batch indexing for embeddings when configured. https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: enable OpenAI batch indexing by default for OpenAI embeddings. https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: allow parallel OpenAI batch indexing jobs (default concurrency: 2). https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: render progress immediately, color batch statuses in verbose logs, and poll OpenAI batch status every 2s by default. https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add `--verbose` logging for memory status + batch indexing details. https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add native Gemini embeddings provider for memory search. (#1151) https://docs.openclaw.ai/concepts/memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: allow config defaults for efficient snapshots in the tool/CLI. (#1336) https://docs.openclaw.ai/tools/browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nostr: add the Nostr channel plugin with profile management + onboarding defaults. (#1323) https://docs.openclaw.ai/channels/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Matrix: migrate to matrix-bot-sdk with E2EE support, location handling, and group allowlist upgrades. (#1298) https://docs.openclaw.ai/channels/matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: add HTTP webhook mode via Bolt HTTP receiver. (#1143) https://docs.openclaw.ai/channels/slack（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: enrich forwarded-message context with normalized origin details + legacy fallback. (#1090) https://docs.openclaw.ai/channels/telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: fall back to `/skill` when native command limits are exceeded. (#1287)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: expose `/skill` globally. (#1287)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Zalouser: add channel dock metadata, config schema, setup wiring, probe, and status issues. (#1219) https://docs.openclaw.ai/plugins/zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: require manifest-embedded config schemas with preflight validation warnings. (#1272) https://docs.openclaw.ai/plugins/manifest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: move channel catalog metadata into plugin manifests. (#1290) https://docs.openclaw.ai/plugins/manifest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: align Nextcloud Talk policy helpers with core patterns. (#1290) https://docs.openclaw.ai/plugins/manifest（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins/UI: let channel plugin metadata drive UI labels/icons and cron channel options. (#1306) https://docs.openclaw.ai/web/control-ui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/UI: add agent avatar support in identity config, IDENTITY.md, and the Control UI. (#1329) https://docs.openclaw.ai/gateway/configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add plugin slots with a dedicated memory slot selector. https://docs.openclaw.ai/plugins/agent-tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: ship the bundled BlueBubbles channel plugin (disabled by default). https://docs.openclaw.ai/channels/bluebubbles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: migrate bundled messaging extensions to the plugin SDK and resolve plugin-sdk imports in the loader.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: migrate the Zalo plugin to the shared plugin SDK runtime. https://docs.openclaw.ai/channels/zalo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: migrate the Zalo Personal plugin to the shared plugin SDK runtime. https://docs.openclaw.ai/plugins/zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: allow optional agent tools with explicit allowlists and add the plugin tool authoring guide. https://docs.openclaw.ai/plugins/agent-tools（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: auto-enable bundled channel/provider plugins when configuration is present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: sync plugin sources on channel switches and update npm-installed plugins during `openclaw update`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: share npm plugin update logic between `openclaw update` and `openclaw plugins update`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/API: add `/v1/responses` (OpenResponses) with item-based input + semantic streaming events. (#1229)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/API: expand `/v1/responses` to support file/image inputs, tool_choice, usage, and output limits. (#1229)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Usage: add `/usage cost` summaries and macOS menu cost charts. https://docs.openclaw.ai/reference/api-usage-costs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: warn when <=300B models run without sandboxing while web tools are enabled. https://docs.openclaw.ai/cli/security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: add host/security/ask routing for gateway + node exec. https://docs.openclaw.ai/tools/exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: add `/exec` directive for per-session exec defaults (host/security/ask/node). https://docs.openclaw.ai/tools/exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: migrate approvals to `~/.openclaw/exec-approvals.json` with per-agent allowlists + skill auto-allow toggle, and add approvals UI + node exec lifecycle events. https://docs.openclaw.ai/tools/exec-approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes: add headless node host (`openclaw node start`) for `system.run`/`system.which`. https://docs.openclaw.ai/cli/node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes: add node daemon service install/status/start/stop/restart. https://docs.openclaw.ai/cli/node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bridge: add `skills.bins` RPC to support node host auto-allow skill bins.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: add daily reset policy with per-type overrides and idle windows (default 4am local), preserving legacy idle-only configs. (#1146) https://docs.openclaw.ai/concepts/session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: allow `sessions_spawn` to override thinking level for sub-agent runs. https://docs.openclaw.ai/tools/subagents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: unify thread/topic allowlist matching + command/mention gating helpers across core providers. https://docs.openclaw.ai/concepts/groups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: add Qwen Portal OAuth provider support. (#1120) https://docs.openclaw.ai/providers/qwen（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add allowlist prompts and username-to-id resolution across core and extension channels. https://docs.openclaw.ai/start/onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify allowlist input types and onboarding behavior for messaging channels. https://docs.openclaw.ai/start/onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: refresh Android node discovery docs for the Gateway WS service type. https://docs.openclaw.ai/platforms/android（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: surface Amazon Bedrock in provider lists and clarify Bedrock auth env vars. (#1289) https://docs.openclaw.ai/bedrock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify WhatsApp voice notes. https://docs.openclaw.ai/channels/whatsapp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify Windows WSL portproxy LAN access notes. https://docs.openclaw.ai/platforms/windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: refresh bird skill install metadata and usage notes. (#1302) https://docs.openclaw.ai/tools/browser-login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add local docs path resolution and include docs/mirror/source/community pointers in the system prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: clarify node_modules read-only guidance in agent instructions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: stamp last-touched metadata on write and warn if the config is newer than the running build.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: hide usage section when usage is unavailable instead of showing provider errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: migrate node transport to the Gateway WebSocket protocol with TLS pinning support + gateway discovery naming.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: send structured payloads in node events/invokes and include user-agent metadata in gateway connects.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: remove legacy bridge transport code now that nodes use the gateway protocol.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: bump okhttp + dnsjava to satisfy lint dependency checks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: update workspace + core/plugin deps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: use tsgo for dev/watch builds by default (opt out with `OPENCLAW_TS_COMPILER=tsc`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repo: remove the Peekaboo git submodule now that the SPM release is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: switch PeekabooBridge integration to the tagged Swift Package Manager release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: stop syncing Peekaboo in postinstall.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Swabble: use the tagged Commander Swift package release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Reject invalid/unknown config entries and refuse to start the gateway for safety. Run `openclaw doctor --fix` to repair, then update plugins (`openclaw plugins update`) if you use any.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discovery: shorten Bonjour DNS-SD service type to `_moltbot-gw._tcp` and update discovery clients/docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Diagnostics: export OTLP logs, correct queue depth tracking, and document message-flow telemetry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Diagnostics: emit message-flow diagnostics across channels via shared dispatch. (#1244)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Diagnostics: gate heartbeat/webhook logging. (#1244)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: strip inbound envelope headers from chat history messages to keep clients clean.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: clarify unauthorized handshake responses with token/password mismatch guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: allow mobile node client ids for iOS + Android handshake validation. (#1354)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: clarify connect/validation errors for gateway params. (#1347)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: preserve restart wake routing + thread replies across restarts. (#1337)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: reschedule per-agent heartbeats on config hot reload without restarting the runner.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: require authorized restarts for SIGUSR1 (restart/apply/update) so config gating can't be bypassed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: auto-deliver isolated agent output to explicit targets without tool calls. (#1285)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: preserve subagent announce thread/topic routing + queued replies across channels. (#1241)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: propagate accountId into embedded runs so sub-agent announce routing honors the originating account. (#1058)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: avoid treating timeout errors with "aborted" messages as user aborts, so model fallback still runs. (#1137)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: sanitize oversized image payloads before send and surface image-dimension errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: fall back to session labels when listing display names. (#1124)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Compaction: include tool failure summaries in safeguard compaction to prevent retry loops. (#1084)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: log invalid config issues once per run and keep invalid-config errors stackless.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: allow Perplexity as a web_search provider in config validation. (#1230)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: allow custom fields under `skills.entries.<name>.config` for skill credentials/config. (#1226)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: clarify plugin auto-enable hint text in the startup banner.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: canonicalize legacy session keys in session stores to prevent stale metadata. (#1169)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: make docs:list fail fast with a clear error if the docs directory is missing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add Nextcloud Talk manifest for plugin config validation. (#1297)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: surface plugin load/register/config errors in gateway logs with plugin/source context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: preserve cron delivery settings when editing message payloads. (#1322)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: keep `openclaw logs` output resilient to broken pipes while preserving progress output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: avoid duplicating --profile/--dev flags when formatting commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: centralize CLI command registration to keep fast-path routing and program wiring in sync. (#1207)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: keep banners on routed commands, restore config guarding outside fast-path routing, and tighten fast-path flag parsing while skipping console capture for extra speed. (#1195)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: skip runner rebuilds when dist is fresh. (#1231)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add WSL2/systemd unavailable hints in daemon status/doctor output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status: route native `/status` to the active agent so model selection reflects the correct profile. (#1301)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status: show both usage windows with reset hints when usage data is available. (#1101)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: keep config form enums typed, preserve empty strings, protect sensitive defaults, and deepen config search. (#1315)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: preserve ordered list numbering in chat markdown. (#1341)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: allow Control UI to read gatewayUrl from URL params for remote WebSocket targets. (#1342)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: prevent double-scroll in Control UI chat by locking chat layout to the viewport. (#1283)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: enable shell mode for sync Windows spawns to avoid `pnpm ui:build` EINVAL. (#1212)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: keep thinking blocks ordered before content during streaming and isolate per-run assembly. (#1202)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: align custom editor initialization with the latest pi-tui API. (#1298)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: show generic empty-state text for searchable pickers. (#1201)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: highlight model search matches and stabilize search ordering.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Configure: hide OpenRouter auto routing model from the model picker. (#1182)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: show total file counts + scan issues in `openclaw memory status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: fall back to non-batch embeddings after repeated batch failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: apply OpenAI batch defaults even without explicit remote config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: index atomically so failed reindex preserves the previous memory database. (#1151)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: avoid sqlite-vec unique constraint failures when reindexing duplicate chunk ids. (#1151)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: retry transient 5xx errors (Cloudflare) during embedding indexing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: parallelize embedding indexing with rate-limit retries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: split overly long lines to keep embeddings under token limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: skip empty chunks to avoid invalid embedding inputs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: split embedding batches to avoid OpenAI token limits during indexing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: probe sqlite-vec availability in `openclaw memory status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: enforce allowlist when ask is off.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals: prefer raw command for node approvals/events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: show exec elevated flag before the command and keep it outside markdown in tool summaries.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: return a companion-app-required message when node exec is requested with no paired node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: return a companion-app-required message when `system.run` is requested without a supporting node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: default gateway/node exec security to allowlist when unset (sandbox stays deny).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: prefer bash when fish is default shell, falling back to sh if bash is missing. (#1297)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec: merge login-shell PATH for host=gateway exec while keeping daemon PATH minimal. (#1304)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Streaming: emit assistant deltas for OpenAI-compatible SSE chunks. (#1147)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: make resolve warnings avoid raw JSON payloads on rate limits.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: process message handlers in parallel across sessions to avoid event queue blocking. (#1295)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: stop reconnecting the gateway after aborts to prevent duplicate listeners.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: only emit slow listener warnings after 30s.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: inherit parent channel allowlists for thread slash commands and reactions. (#1123)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: honor pairing allowlists for native slash commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: preserve hidden text_link URLs by expanding entities in inbound text. (#1118)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: resolve Bolt import interop for Bun + Node. (#1191)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web search: infer Perplexity base URL from API key source (direct vs OpenRouter).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web fetch: harden SSRF protection with shared hostname checks and redirect limits. (#1346)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: register AI snapshot refs for act commands. (#1282)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Voice call: include request query in Twilio webhook verification when publicUrl is set. (#864)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: default API prompt caching to 1h with configurable TTL override.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: ignore TTL for OAuth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth profiles: keep auto-pinned preference while allowing rotation on failover. (#1138)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth profiles: user pins stay locked. (#1138)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model catalog: avoid caching import failures, log transient discovery errors, and keep partial results. (#1332)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: stabilize Windows gateway/CLI tests by skipping sidecars, normalizing argv, and extending timeouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: stabilize plugin SDK resolution and embedded agent timeouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: install gateway scheduled task as the current user.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Windows: show friendly guidance instead of failing on access denied.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: load menu session previews asynchronously so items populate while the menu is open.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: use label colors for session preview text so previews render in menu subviews.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: suppress usage error text in the menubar cost view.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: Doctor repairs LaunchAgent bootstrap issues for Gateway + Node when listed but not loaded. (#1166)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: avoid touching launchd in Remote over SSH so quitting the app no longer disables the remote gateway. (#1105)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: bundle Textual resources in packaged app builds to avoid code block crashes. (#1006)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon: include HOME in service environments to avoid missing HOME errors. (#1214)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Thanks @AlexMikhalev, @CoreyH, @John-Rood, @KrauseFx, @MaudeBot, @Nachx639, @NicholaiVogel, @RyanLisse, @ThePickle31, @VACInc, @Whoaa512, @YuriNachos, @aaronveklabs, @abdaraxus, @alauppe, @ameno-, @artuskg, @austinm911, @bradleypriest, @cheeeee, @dougvk, @fogboots, @gnarco, @gumadeiras, @jdrhyne, @joelklabo, @longmaba, @mukhtharcm, @odysseus0, @oscargavin, @rhjoh, @sebslight, @sibbl, @sleontenko, @steipete, @suminhthanh, @thewilloftheshadow, @tyler6204, @vignesh07, @visionik, @ysqander, @zerone0x.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.16-2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: stamp build commit into dist metadata so banners show the commit in npm installs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: close memory manager after memory commands to avoid hanging processes. (#1127) — thanks @NicholasSpisak.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.16-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks: add hooks system with bundled hooks, CLI tooling, and docs. (#1028) — thanks @ThomsenDrake. https://docs.openclaw.ai/hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media: add inbound media understanding (image/audio/video) with provider + CLI fallbacks. https://docs.openclaw.ai/nodes/media-understanding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add Zalo Personal plugin (`@openclaw/zalouser`) and unify channel directory for plugins. (#1032) — thanks @suminhthanh. https://docs.openclaw.ai/plugins/zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: add Vercel AI Gateway auth choice + onboarding updates. (#1016) — thanks @timolins. https://docs.openclaw.ai/providers/vercel-ai-gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: add `session.identityLinks` for cross-platform DM session li nking. (#1033) — thanks @thewilloftheshadow. https://docs.openclaw.ai/concepts/session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web search: add `country`/`language` parameters (schema + Brave API) and docs. (#1046) — thanks @YuriNachos. https://docs.openclaw.ai/tools/web（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** `openclaw message` and message tool now require `target` (dropping `to`/`channelId` for destinations). (#1034) — thanks @tobalsan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Channel auth now prefers config over env for Discord/Telegram/Matrix (env is fallback only). (#1040) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Drop legacy `chatType: "room"` support; use `chatType: "channel"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** remove legacy provider-specific target resolution fallbacks; target resolution is centralized with plugin hints + directory lookups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** `openclaw hooks` is now `openclaw webhooks`; hooks live under `openclaw hooks`. https://docs.openclaw.ai/cli/webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** `openclaw plugins install <path>` now copies into `~/.openclaw/extensions` (use `--link` to keep path-based loading).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: ship bundled plugins disabled by default and allow overrides by installed versions. (#1066) — thanks @ItzR3NO.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add bundled Antigravity + Gemini CLI OAuth + Copilot Proxy provider plugins. (#1066) — thanks @ItzR3NO.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: improve `web_fetch` extraction using Readability (with fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add Firecrawl fallback for `web_fetch` when configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: send Chrome-like headers by default for `web_fetch` to improve extraction on bot-sensitive sites.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: Firecrawl fallback now uses bot-circumvention + cache by default; remove basic HTML fallback when extraction fails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: default `exec` exit notifications and auto-migrate legacy `tools.bash` to `tools.exec`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add `exec` PTY support for interactive sessions. https://docs.openclaw.ai/tools/exec（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add tmux-style `process send-keys` and bracketed paste helpers for PTY sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add `process submit` helper to send CR for PTY sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: respond to PTY cursor position queries to unblock interactive TUIs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: include tool outputs in verbose mode and expand verbose tool feedback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: update coding-agent guidance to prefer PTY-enabled exec runs and simplify tmux usage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: refresh session token counts after runs complete or fail. (#1079) — thanks @d-ploutarchos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status: trim `/status` to current-provider usage only and drop the OAuth/token block.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Directory: unify `openclaw directory` across channels and plugin channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: allow deleting sessions from the Control UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add sqlite-vec vector acceleration with CLI status details.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add experimental session transcript indexing for memory_search (opt-in via memorySearch.experimental.sessionMemory + sources).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: add user-invocable skill commands and expanded skill command registration.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: default reaction level to minimal and enable reaction notifications by default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: allow reply-chain messages to bypass mention gating in groups. (#1038) — thanks @adityashaw2.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: add remote attachment support for VM/SSH deployments.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: refresh live directory cache results when resolving targets.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: mirror delivered outbound text/media into session transcripts. (#1031) — thanks @TSavo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: avoid redundant sender envelopes for iMessage + Signal group chats. (#1080) — thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Media: normalize Deepgram audio upload bytes for fetch compatibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: isolated cron jobs now start a fresh session id on every run to prevent context buildup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add `/help` hub, Node/npm PATH guide, and expand directory CLI docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: support env var substitution in config values. (#1044) — thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Health: add per-agent session summaries and account-level health details, and allow selective probes. (#1047) — thanks @gumadeiras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks: add hook pack installs (npm/path/zip/tar) with `openclaw.hooks` manifests and `openclaw hooks install/update`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add zip installs and `--link` to avoid copying local paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: drain subprocess pipes before waiting to avoid deadlocks. (#1081) — thanks @thesash.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verbose: wrap tool summaries/output in markdown only for markdown-capable channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: include provider/session context in elevated exec denial errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: normalize exec tool alias naming in tool error logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logging: reuse shared ANSI stripping to keep console capture lint-clean.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logging: prefix nested agent output with session/run/channel context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: accept tg/group/telegram prefixes + topic targets for inline button validation. (#1072) — thanks @danielz1z.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: split long captions into follow-up messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: block startup on invalid config, preserve best-effort doctor config, and keep rolling config backups. (#1083) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sub-agents: normalize announce delivery origin + queue bucketing by accountId to keep multi-account routing stable. (#1061, #1058) — thanks @adam91holt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: include deliveryContext in sessions.list and reuse normalized delivery routing for announce/restart fallbacks. (#1058)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: propagate deliveryContext into last-route updates to keep account/channel routing stable. (#1058)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: preserve overrides on `/new` reset.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: prevent unhandled rejections when watch/interval sync fails. (#1076) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: avoid gateway crash when embeddings return 429/insufficient_quota (disable tool + surface error). (#1004)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: honor explicit delivery targets without implicit accountId fallback; preserve lastAccountId for implicit routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: avoid reusing last-to/accountId when the requested channel differs; sync deliveryContext with last route fields.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: allow `@lydell/node-pty` builds on supported platforms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repo: fix oxlint config filename and move ignore pattern into config. (#1064) — thanks @connorshea.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: `/stop` now hard-aborts queued followups and sub-agent runs; suppress zero-count stop notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: honor message tool channel when deduping sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: include sender labels for live group messages across channels, matching queued/history formatting. (#1059)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: reset `compactionCount` on `/new` and `/reset`, and preserve `sessions.json` file mode (0600).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: repair orphaned user turns before embedded prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: hard-stop `sessions.delete` cleanup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: treat replies to the bot as implicit mentions across supported channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: normalize object-format capabilities in channel capability parsing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: default-deny slash/control commands unless a channel computed `CommandAuthorized` (fixes accidental “open” behavior), and ensure WhatsApp + Zalo plugin channels gate inline `/…` tokens correctly. https://docs.openclaw.ai/gateway/security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: redact sensitive text in gateway WS logs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: cap pending `exec` process output to avoid unbounded buffers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: speed up `openclaw sandbox-explain` by avoiding heavy plugin imports when normalizing channel ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: remote profile tab operations prefer persistent Playwright and avoid silent HTTP fallbacks. (#1057) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: remote profile tab ops follow-up: shared Playwright loader, Playwright-based focus, and more coverage (incl. opt-in live Browserless test). (follow-up to #1057) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: refresh extension relay tab metadata after navigation so `/json/list` stays current. (#1073) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: scope self-chat response prefix; inject pending-only group history and clear after any processed message.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: include `linked` field in `describeAccount`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: drop unsigned Gemini tool calls and avoid JSON Schema `format` keyword collisions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: hide the image tool when the primary model already supports images.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: avoid duplicate sends by replying with `NO_REPLY` after `message` tool sends.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: inherit/merge sub-agent auth profiles from the main agent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: resolve local auth for security probe and validate gateway token/password file modes. (#1011, #1022) — thanks @ivanrvpereira, @kkarimi.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal/iMessage: bound transport readiness waits to 30s with periodic logging. (#1014) — thanks @Szpadel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: avoid RPC restart loops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OpenAI image-gen: handle URL + `b64_json` responses and remove deprecated `response_format` (use URL downloads).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: auto-update global installs when installed via a package manager.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Routing: migrate legacy `accountID` bindings to `accountId` and remove legacy fallback lookups. (#1047) — thanks @gumadeiras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: truncate skill command descriptions to 100 chars for slash command limits. (#1018) — thanks @evalexpr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: bump `tar` to 7.5.3.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: align ZAI thinking toggles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage/Signal: include sender metadata for non-queued group messages. (#1059)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: preserve whitespace when chunking long lines so message splits keep spacing intact.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: fix skills watcher ignored list typing (tsc).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.15（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add provider auth registry + `openclaw models auth login` for plugin-driven OAuth/API key flows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: improve remote CDP/Browserless support (auth passthrough, `wss` upgrade, timeouts, clearer errors).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: per-agent configuration + 24h duplicate suppression. (#980) — thanks @voidserf.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: audit warns on weak model tiers; app nodes store auth tokens encrypted (Keychain/SecurePrefs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** iOS minimum version is now 18.0 to support Textual markdown rendering in native chat. (#702)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Microsoft Teams is now a plugin; install `@openclaw/msteams` via `openclaw plugins install @openclaw/msteams`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** Channel auth now prefers config over env for Discord/Telegram/Matrix (env is fallback only). (#1040) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI/Apps: move channel/config settings to schema-driven forms and rename Connections → Channels. (#1040) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: set process titles to `openclaw-<command>` for clearer process listings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/macOS: sync remote SSH target/identity to config and let `gateway status` auto-infer SSH targets (ssh-config aware).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: scope inline buttons with allowlist default + callback gating in DMs/groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: default reaction notifications to own.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: improve `web_fetch` extraction using Readability (with fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: tighten prompt guidance + suppress duplicate alerts for 24h. (#980) — thanks @voidserf.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Repo: ignore local identity files to avoid accidental commits. (#1001) — thanks @gerardward2007.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions/Security: add `session.dmScope` for multi-user DM isolation and audit warnings. (#948) — thanks @Alphonse-arianee.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add provider auth registry + `openclaw models auth login` for plugin-driven OAuth/API key flows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: switch channels setup to a single-select loop with per-channel actions and disabled hints in the picker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: show provider/model labels for the active session and default model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: add per-agent heartbeat configuration and multi-agent docs example.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: show gateway auth guidance + doc link on unauthorized Control UI connections.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: add session deletion action in Control UI sessions list. (#1017) — thanks @Szpadel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: warn on weak model tiers (Haiku, below GPT-5, below Claude 4.5) in `openclaw security audit`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Apps: store node auth tokens encrypted (Keychain/SecurePrefs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon: share profile/state-dir resolution across service helpers and honor `CLAWDBOT_STATE_DIR` for Windows task scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify multi-gateway rescue bot guidance. (#969) — thanks @bjesuiter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add Current Date & Time system prompt section with configurable time format (auto/12/24).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: normalize Slack/Discord message timestamps with `timestampMs`/`timestampUtc` while keeping raw provider fields.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: add `system.which` for prompt-free remote skill discovery (with gateway fallback to `system.run`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Date & Time guide and update prompt/timezone configuration docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: debounce rapid inbound messages across channels with per-connector overrides. (#971) — thanks @juanpablodlc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: allow media-only sends (CLI/tool) and show Telegram voice recording status for voice notes. (#957) — thanks @rdev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth/Status: keep auth profiles sticky per session (rotate on compaction/new), surface provider usage headers in `/status` and `openclaw models status`, and update docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add `--json` output for `openclaw daemon` lifecycle/install commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: make `node-llama-cpp` an optional dependency (avoid Node 25 install failures) and improve local-embeddings fallback/errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: add `snapshot refs=aria` (Playwright aria-ref ids) for self-resolving refs across `snapshot` → `act`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: `profile="chrome"` now defaults to host control and returns clearer “attach a tab” errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: prefer stable Chrome for auto-detect, with Brave/Edge fallbacks and updated docs. (#983) — thanks @cpojer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: increase remote CDP reachability timeouts + add `remoteCdpTimeoutMs`/`remoteCdpHandshakeTimeoutMs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: preserve auth/query tokens for remote CDP endpoints and pass Basic auth for CDP HTTP/WS. (#895) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add bidirectional reaction support with configurable notifications and agent guidance. (#964) — thanks @bohdanpodvirnyi.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: allow custom commands in the bot menu (merged with native; conflicts ignored). (#860) — thanks @nachoiacovino.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: allow allowlisted guilds without channel lists to receive messages when `groupPolicy="allowlist"`. — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: allow emoji/sticker uploads + channel actions in config defaults. (#870) — thanks @JDIVE.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: make `/stop` clear queued followups and pending session lane work for a hard abort.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messages: make `/stop` abort active sub-agent runs spawned from the requester session and report how many were stopped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: report linked status consistently in channel status. (#1050) — thanks @YuriNachos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: keep per-session overrides when `/new` resets compaction counters. (#1050) — thanks @YuriNachos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: allow OpenAI image-gen helper to handle URL or base64 responses. (#1050) — thanks @YuriNachos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: default response prefix only for self-chat, using identity name when set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal/iMessage: bound transport readiness waits to 30s with periodic logging. (#1014) — thanks @Szpadel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: treat missing `imsg rpc` support as fatal to avoid restart loops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: merge main auth profiles into per-agent stores for sub-agents and document inheritance. (#1013) — thanks @marcmarg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: avoid JSON Schema `format` collisions in tool params by renaming snapshot format fields. (#1013) — thanks @marcmarg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: make `openclaw update` auto-update global installs when installed via a package manager.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: list model picker entries as provider/model pairs for explicit selection. (#970) — thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: align OpenAI image-gen defaults with DALL-E 3 standard quality and document output formats. (#880) — thanks @mkbehr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: persist `gateway.mode=local` after selecting Local run mode in `openclaw configure`, even if no other sections are chosen.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon: fix profile-aware service label resolution (env-driven) and add coverage for launchd/systemd/schtasks. (#969) — thanks @bjesuiter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: avoid false positives when logging unsupported Google tool schema keywords.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: skip Gemini history downgrades for google-antigravity to preserve tool calls. (#894) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status: restore usage summary line for current provider when no OAuth profiles exist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: guard model fallback against undefined provider/model values. (#954) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: refactor session store updates, add chat.inject, and harden subagent cleanup flow. (#944) — thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: clean up suspended CLI processes across backends. (#978) — thanks @Nachx639.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: support MiniMax coding plan usage responses with `model_remains`/`current_interval_*` payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: honor message tool channel for duplicate suppression (prefer `NO_REPLY` after `message` tool sends). (#1053) — thanks @sashcatanzarite.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: suppress WhatsApp pairing replies for historical catch-up DMs on initial link. (#904)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: extension mode recovers when only one tab is attached (stale targetId fallback).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: fix `tab not found` for extension relay snapshots/actions when Playwright blocks `newCDPSession` (use the single available Page).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: upgrade `ws` → `wss` when remote CDP uses `https` (fixes Browserless handshake).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: skip `message_thread_id=1` for General topic sends while keeping typing indicators. (#848) — thanks @azade-c.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: sanitize user-facing error text + strip `<final>` tags across reply pipelines. (#975) — thanks @ThomsenDrake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: normalize pairing CLI aliases, allow extension channels, and harden Zalo webhook payload parsing. (#991) — thanks @longmaba.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: allow local Tailscale Serve hostnames without treating tailnet clients as direct. (#885) — thanks @oswalpalash.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Fix: reset sessions after role-ordering conflicts to recover from consecutive user turns. (#998)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.14-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web search: `web_search`/`web_fetch` tools (Brave API) + first-time setup in onboarding/configure.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser control: Chrome extension relay takeover mode + remote browser control support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: channel plugins (gateway HTTP hooks) + Zalo plugin + onboarding install flow. (#854) — thanks @longmaba.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: expanded `openclaw security audit` (+ `--fix`), detect-secrets CI scan, and a `SECURITY.md` reporting policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: clarify per-agent auth stores, sandboxed skill binaries, and elevated semantics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add FAQ entries for missing provider auth after adding agents and Gemini thinking signature errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add optional auth-profile copy prompt on `agents add` and improve auth error messaging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: expand `openclaw security audit` checks (model hygiene, config includes, plugin allowlists, exposure matrix) and extend `--fix` to tighten more sensitive state paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: add `SECURITY.md` reporting policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channels: add Matrix plugin (external) with docs + onboarding hooks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add Zalo channel plugin with gateway HTTP hooks and onboarding install prompt. (#854) — thanks @longmaba.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: add a security checkpoint prompt (docs link + sandboxing hint); require `--accept-risk` for `--non-interactive`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: expand gateway security hardening guidance and incident response checklist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: document DM history limits for channel DMs. (#883) — thanks @pkrmf.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: add detect-secrets CI scan and baseline guidance. (#227) — thanks @Hyaxia.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add `web_search`/`web_fetch` (Brave API), auto-enable `web_fetch` for sandboxed sessions, and remove the `brave-search` skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Docs: add a web tools configure section for storing Brave API keys and update onboarding tips.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: add Chrome extension relay takeover mode (toolbar button), plus `openclaw browser extension install/path` and remote browser control (standalone server + token auth).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sessions: refactor session store updates to lock + mutate per-entry, add chat.inject, and harden subagent cleanup flow. (#944) — thanks @tyler6204.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser: add tests for snapshot labels/efficient query params and labeled image responses.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google: downgrade unsigned thinking blocks before send to avoid missing signature errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: avoid re-adding WhatsApp config when only legacy ack reactions are set. (#927, fixes #900) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: scrub tuple `items` schemas for Gemini tool calls. (#926, fixes #746) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: harden Antigravity Claude history/tool-call sanitization. (#968) — thanks @rdev.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: stabilize sub-agent announce status from runtime outcomes and normalize Result/Notes. (#835) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Embedded runner: suppress raw API error payloads from replies. (#924) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: normalize Claude Code CLI profile mode to oauth and auto-migrate config. (#855) — thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Daemon: clear persisted launchd disabled state before bootstrap (fixes `daemon install` after uninstall). (#849) — thanks @ndraiman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logging: tolerate `EIO` from console writes to avoid gateway crashes. (#925, fixes #878) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: restore `docker.binds` config validation for custom bind mounts. (#873) — thanks @akonyer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: preserve configured PATH for `docker exec` so custom tools remain available. (#873) — thanks @akonyer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: respect `channels.slack.requireMention` default when resolving channel mention gating. (#850) — thanks @evalexpr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: aggregate split inbound messages into one prompt (reduces “one reply per fragment”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: treat trailing `NO_REPLY` tokens as silent replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: prevent partial config writes from clobbering unrelated settings (base hash guard + merge patch for connection saves).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.14（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Usage: add MiniMax coding plan usage tracking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: label Claude Code CLI auth options. (#915) — thanks @SeanZoR.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: standardize Claude Code CLI naming across docs and prompts. (follow-up to #915)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add message delete action in the message tool. (#903) — thanks @sleontenko.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: add `channels.<provider>.configWrites` gating for channel-initiated config writes; migrate Slack channel IDs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mac: pass auth token/password to dashboard URL for authenticated access. (#918) — thanks @rahthakor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- UI: use application-defined WebSocket close code (browser compatibility). (#918) — thanks @rahthakor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: render picker overlays via the overlay stack so /models and /settings display. (#921) — thanks @grizzdank.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: add a bright spinner + elapsed time in the status line for send/stream/run states.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: show LLM error messages (rate limits, auth, etc.) instead of `(no output)`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Dev: ensure `pnpm gateway:dev` always uses the dev profile config + state (`~/.openclaw-dev`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Agents / Auth / Tools / Sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: make user time zone and 24-hour time explicit in the system prompt. (#859) — thanks @CashWilliams.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: strip downgraded tool call text without eating adjacent replies and filter thinking-tag leaks. (#905) — thanks @erikpr1994.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: cap tool call IDs for OpenAI/OpenRouter to avoid request rejections. (#875) — thanks @j1philli.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: scrub tuple `items` schemas for Gemini tool calls. (#926, fixes #746) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: stabilize sub-agent announce status from runtime outcomes and normalize Result/Notes. (#835) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: normalize Claude Code CLI profile mode to oauth and auto-migrate config. (#855) — thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Embedded runner: suppress raw API error payloads from replies. (#924) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Logging: tolerate `EIO` from console writes to avoid gateway crashes. (#925, fixes #878) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: restore `docker.binds` config validation and preserve configured PATH for `docker exec`. (#873) — thanks @akonyer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Google: downgrade unsigned thinking blocks before send to avoid missing signature errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### macOS / Apps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: ensure launchd log directory exists with a test-only override. (#909) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: format ConnectionsStore config to satisfy SwiftFormat lint. (#852) — thanks @mneves75.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: pass auth token/password to dashboard URL for authenticated access. (#918) — thanks @rahthakor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: reuse launchd gateway auth and skip wizard when gateway config already exists. (#917)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: prefer the default bridge tunnel port in remote mode for node bridge connectivity; document macOS remote control + bridge tunnels. (#960, fixes #865) — thanks @kkarimi.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Apps: use canonical main session keys from gateway defaults across macOS/iOS/Android to avoid creating bare `main` sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: fix cron preview/testing payload to use `channel` key. (#867) — thanks @wes-davis.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: honor `channels.telegram.timeoutSeconds` for grammY API requests. (#863) — thanks @Snaver.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: split long captions into media + follow-up text messages. (#907) - thanks @jalehman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: migrate group config when supergroups change chat IDs. (#906) — thanks @sleontenko.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging: unify markdown formatting + format-first chunking for Slack/Telegram/Signal. (#920) — thanks @TheSethRose.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: drop Socket Mode events with mismatched `api_app_id`/`team_id`. (#889) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: isolate autoThread thread context. (#856) — thanks @davidguttman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: fix context isolation using wrong ID (was bot's number, now conversation ID). (#911) — thanks @tristanmanchester.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: normalize user JIDs with device suffix for allowlist checks in groups. (#838) — thanks @peschee.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.13（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Postinstall: treat already-applied pnpm patches as no-ops to avoid npm/bun install failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: pin `@mariozechner/pi-ai` to 0.45.7 and refresh patched dependency to match npm resolution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.12-2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: include `dist/memory/**` in the npm tarball (fixes `ERR_MODULE_NOT_FOUND` for `dist/memory/index.js`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: persist sub-agent registry across gateway restarts and resume announce flow safely. (#831) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: strip invalid Gemini thought signatures from OpenRouter history to avoid 400s. (#841, #845) — thanks @MatthieuBizien.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.12-1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: include `dist/channels/**` in the npm tarball (fixes `ERR_MODULE_NOT_FOUND` for `dist/channels/registry.js`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.12（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **BREAKING:** rename chat “providers” (Slack/Telegram/WhatsApp/…) to **channels** across CLI/RPC/config; legacy config keys auto-migrate on load (and are written back as `channels.*`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add vector search for agent memories (Markdown-only) with SQLite index, chunking, lazy sync + file watch, and per-agent enablement/fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: restore full voice-call plugin parity (Telnyx/Twilio, streaming, inbound policies, tools/CLI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: add Synthetic provider plus Moonshot Kimi K2 0905 + turbo/thinking variants (with docs). (#811) — thanks @siraht; (#818) — thanks @mickahouan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: one-shot schedules accept ISO timestamps (UTC) with optional delete-after-run; cron jobs can target a specific agent (CLI + macOS/Control UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add compaction mode config with optional safeguard summarization and per-agent model fallbacks. (#700) — thanks @thewilloftheshadow; (#583) — thanks @mitschabaude-bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### New & Improved（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: add custom OpenAI-compatible embedding endpoints; support OpenAI/local `node-llama-cpp` embeddings with per-agent overrides and provider metadata in tools/CLI. (#819) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Memory: new `openclaw memory` CLI plus `memory_search`/`memory_get` tools with snippets + line ranges; index stored under `~/.openclaw/memory/{agentId}.sqlite` with watch-on-by-default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: strengthen memory recall guidance; make workspace bootstrap truncation configurable (default 20k) with warnings; add default sub-agent model config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools/Sandbox: add tool profiles + group shorthands; support tool-policy groups in `tools.sandbox.tools`; drop legacy `memory` shorthand; allow Docker bind mounts via `docker.binds`. (#790) — thanks @akonyer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add provider/model-specific tool policy overrides (`tools.byProvider`) to trim tool exposure per provider.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: add browser `scrollintoview` action; allow Claude/Gemini tool param aliases; allow thinking `xhigh` for GPT-5.2/Codex with safe downgrades. (#793) — thanks @hsrvc; (#444) — thanks @grp06.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/CLI: add Tailscale binary discovery, custom bind mode, and probe auth retry; add `openclaw dashboard` auto-open flow; default native slash commands to `"auto"` with per-provider overrides. (#740) — thanks @jeffersonwarrior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth/Onboarding: add Chutes OAuth (PKCE + refresh + onboarding choice); normalize API key inputs; default TUI onboarding to `deliver: false`. (#726) — thanks @FrieSei; (#791) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: add `discord.allowBots`; trim legacy MiniMax M2 from default catalogs; route MiniMax vision to the Coding Plan VLM endpoint (also accepts `@/path/to/file.png` inputs). (#802) — thanks @zknicker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: allow Tailscale Serve identity headers to satisfy token auth; rebuild Control UI assets when protocol schema is newer. (#823) — thanks @roshanasingh4; (#786) — thanks @meaningfool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: default `ackMaxChars` to 300 so short `HEARTBEAT_OK` replies stay internal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Installer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install: run `openclaw doctor --non-interactive` after git installs/updates and nudge daemon restarts when detected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: warn on pnpm workspace mismatches, missing Control UI assets, and missing tsx binaries; offer UI rebuilds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools: apply global tool allow/deny even when agent-specific tool policy is set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models/Providers: treat credential validation failures as auth errors to trigger fallback; normalize `${ENV_VAR}` apiKey values and auto-fill missing provider keys; preserve explicit GitHub Copilot provider config + agent-dir auth profiles. (#822) — thanks @sebslight; (#705) — thanks @TAGOOZ.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: drop invalid auth profiles from ordering so environment keys can still be used for providers like MiniMax.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gemini: normalize Gemini 3 ids to preview variants; strip Gemini CLI tool call/response ids; downgrade missing `thought_signature`; strip Claude `msg_*` thought_signature fields to avoid base64 decode errors. (#795) — thanks @thewilloftheshadow; (#783) — thanks @ananth-vardhan-cn; (#793) — thanks @hsrvc; (#805) — thanks @marcmarg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: auto-recover from compaction context overflow by resetting the session and retrying; propagate overflow details from embedded runs so callers can recover.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MiniMax: strip malformed tool invocation XML; include `MiniMax-VL-01` in implicit provider for image pairing. (#809) — thanks @latitudeki5223.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Auth: honor `CLAWDBOT_AGENT_DIR` / `PI_CODING_AGENT_DIR` when writing auth profiles (MiniMax). (#829) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: handle `overloaded_error` with a friendly message and failover classification. (#832) — thanks @danielz1z.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Anthropic: merge consecutive user turns (preserve newest metadata) before validation to avoid incorrect role errors. (#804) — thanks @ThomsenDrake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Messaging: enforce context isolation for message tool sends; keep typing indicators alive during tool execution. (#793) — thanks @hsrvc; (#450, #447) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: `/status` allowlist behavior, reasoning-tag enforcement on fallback, and system-event enqueueing for elevated/reasoning toggles. (#810) — thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System events: include local timestamps when events are injected into prompts. (#245) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: resolve ambiguous `/model` matches; fix streaming block reply media handling; keep >300 char heartbeat replies instead of dropping.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord/Slack: centralize reply-thread planning; fix autoThread routing + add per-channel autoThread; avoid duplicate listeners; keep reasoning italics intact; allow clearing channel parents via message tool. (#800, #807) — thanks @davidguttman; (#744) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: preserve forum topic thread ids, persist polling offsets, respect account bindings in webhook mode, and show typing indicator in General topics. (#727, #739) — thanks @thewilloftheshadow; (#821) — thanks @gumadeiras; (#779) — thanks @azade-c.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Slack: accept slash commands with or without leading `/` for custom command configs. (#798) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: persist disabled jobs correctly; accept `jobId` aliases for update/run/remove params. (#205, #252) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/CLI: honor `CLAWDBOT_LAUNCHD_LABEL` / `CLAWDBOT_SYSTEMD_UNIT` overrides; `agents.list` respects explicit config; reduce noisy loopback WS logs during tests; run `openclaw doctor --non-interactive` during updates. (#781) — thanks @ronyrus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Control UI: refuse invalid configs (run doctor first); quote Windows browser URLs for OAuth; keep chat scroll position unless the user is near the bottom. (#764) — thanks @mukhtharcm; (#794) — thanks @roshanasingh4; (#217) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tools/UI: harden tool input schemas for strict providers; drop null-only union variants for Gemini schema cleanup; treat `maxChars: 0` as unlimited; keep TUI last streamed response instead of "(no output)". (#782) — thanks @AbhisekBasu1; (#796) — thanks @gabriel-trigo; (#747) — thanks @thewilloftheshadow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Connections UI: polish multi-account account cards. (#816) — thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Maintenance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dependencies: bump Pi packages to 0.45.3 and refresh patched pi-ai.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Testing: update Vitest + browser-playwright to 4.0.17.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Amazon Bedrock provider notes and link from models/FAQ.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.11（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins are now first-class: loader + CLI management, plus the new Voice Call plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: modular `$include` support for split config files. (#731) — thanks @pasogott.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Pi: reserve compaction headroom so pre-compaction memory writes can run before auto-compaction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: automatic pre-compaction memory flush turn to store durable memories before compaction.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Onboarding: simplify MiniMax auth choice to a single M2.1 option.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: configure section selection now loops until Continue.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: explain MiniMax vs MiniMax Lightning (speed vs cost) and restore LM Studio example.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add Cerebras GLM 4.6/4.7 config example (OpenAI-compatible endpoint).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/CLI: group model/auth choice by provider and label Z.AI as GLM 4.7.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Docs: add Moonshot AI (Kimi K2) auth choice + config example.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Onboarding: prompt to reuse detected API keys for Moonshot/MiniMax/Z.AI/Gemini/Anthropic/OpenCode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: add compact `/model` picker (models + available providers) and show provider endpoints in `/model status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: add Config tab model presets (MiniMax M2.1, GLM 4.7, Kimi) for one-click setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add extension loader (tools/RPC/CLI/services), discovery paths, and config schema + Control UI labels (uiHints).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: add `openclaw plugins install` (path/tgz/npm), plus `list|info|enable|disable|doctor` UX.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: voice-call plugin now real (Twilio/log), adds start/status RPC/CLI/tool + tests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add plugins doc + cross-links from tools/skills/gateway config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add beginner-friendly plugin quick start + expand Voice Call plugin docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: add Docker plugin loader + tgz-install smoke test.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: extend Docker plugin E2E to cover installing from local folders (`plugins.load.paths`) and `file:` npm specs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: add coverage for pre-compaction memory flush settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests: modernize live model smoke selection for current releases and enforce tools/images/thinking-high coverage. (#769) — thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Tools: add `apply_patch` tool for multi-file edits (experimental; gated by tools.exec.applyPatch; OpenAI-only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Tools: rename the bash tool to exec (config alias maintained). (#748) — thanks @myfunc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add pre-compaction memory flush config (`agents.defaults.compaction.*`) with a soft threshold + system prompt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: add `$include` directive for modular config files. (#731) — thanks @pasogott.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: set pnpm minimum release age to 2880 minutes (2 days). (#718) — thanks @dan-dr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: prompt to install the global `openclaw` CLI when missing in local mode; install via `openclaw.ai/install-cli.sh` (no onboarding) and use external launchd/CLI instead of the embedded gateway runtime.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: add gog calendar event color IDs from `gog calendar colors`. (#715) — thanks @mjrussell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron/CLI: add `--model` flag to cron add/edit commands. (#711) — thanks @mjrussell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron/CLI: trim model overrides on cron edits and document main-session guidance. (#711) — thanks @mjrussell.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills: bundle `skill-creator` to guide creating and packaging skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: add per-DM history limit overrides (`dmHistoryLimit`) with provider-level config. (#728) — thanks @pkrmf.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: expose channel/category management actions in the message tool. (#730) — thanks @NicholasSpisak.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: rename README “macOS app” section to “Apps”. (#733) — thanks @AbhisekBasu1.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: require `client.id` in WebSocket connect params; use `client.instanceId` for presence de-dupe; update docs/tests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: remove the attach-only gateway setting; local mode now always manages launchd while still attaching to an existing gateway if present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Installer（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Postinstall: replace `git apply` with builtin JS patcher (works npm/pnpm/bun; no git dependency) plus regression tests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Postinstall: skip pnpm patch fallback when the new patcher is active.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installer tests: add root+non-root docker smokes, CI workflow to fetch openclaw.ai scripts and run install sh/cli with onboarding skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installer UX: support `CLAWDBOT_NO_ONBOARD=1` for non-interactive installs; fix npm prefix on Linux and auto-install git.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installer UX: add `install.sh --help` with flags/env and git install hint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installer UX: add `--install-method git|npm` and auto-detect source checkouts (prompt to update git checkout vs migrate to npm).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models/Onboarding: configure MiniMax (minimax.io) via Anthropic-compatible `/anthropic` endpoint by default (keep `minimax-api` as a legacy alias).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: normalize Gemini 3 Pro/Flash IDs to preview names for live model lookups. (#769) — thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: fix guardCancel typing for configure prompts. (#769) — thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/WebChat: include handshake validation details in the WebSocket close reason for easier debugging; preserve close codes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Auth: send invalid connect responses before closing the handshake; stabilize invalid-connect auth test.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: tighten gateway listener detection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: hide onboarding chat when configured and guard the mobile chat sidebar overlay.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: read Codex keychain credentials and make the lookup platform-aware.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS/Release: avoid bundling dist artifacts in relay builds and generate appcasts from zip-only sources.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: surface plugin diagnostics in the report.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Plugins: treat `plugins.load.paths` directory entries as package roots when they contain `package.json` + `openclaw.extensions`; load plugin packages from config dirs; extract archives without system tar.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: expand `~` in `CLAWDBOT_CONFIG_PATH` and common path-like config fields (including `plugins.load.paths`); guard invalid `$include` paths. (#731) — thanks @pasogott.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: stop pre-creating session transcripts so first user messages persist in JSONL history.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: skip pre-compaction memory flush when the session workspace is read-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: ignore inline `/status` directives unless the message is directive-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: align `/think` default display with model reasoning defaults. (#751) — thanks @gabriel-trigo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: flush block reply buffers on tool boundaries. (#750) — thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: allow sender fallback for command authorization when `SenderId` is empty (WhatsApp self-chat). (#755) — thanks @juanpablodlc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: treat whitespace-only sender ids as missing for command authorization (WhatsApp self-chat). (#766) — thanks @steipete.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: refresh prompt text for updated defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Tools: use PowerShell on Windows to capture system utility output. (#748) — thanks @myfunc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: tolerate unset optional env vars in docker-setup.sh under strict mode. (#725) — thanks @petradonka.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Update: preserve base environment when passing overrides to update subprocesses. (#713) — thanks @danielz1z.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: treat message tool errors as failures so fallback replies still send; require `to` + `message` for `action=send`. (#717) — thanks @theglove44.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: preserve reasoning items on tool-only turns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Subagents: wait for completion before announcing, align wait timeout with run timeout, and make announce prompts more emphatic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: route subagent transcripts to the target agent sessions directory and add regression coverage. (#708) — thanks @xMikeMickelson.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Tools: preserve action enums when flattening tool schemas. (#708) — thanks @xMikeMickelson.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Agents: canonicalize main session aliases for store writes and add regression coverage. (#709) — thanks @xMikeMickelson.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: reset sessions and retry when auto-compaction overflows instead of crashing the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers/Telegram: normalize command mentions for consistent parsing. (#729) — thanks @obviyus.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: skip DM history limit handling for non-DM sessions. (#728) — thanks @pkrmf.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: fix non-main mode incorrectly sandboxing the main DM session and align `/status` runtime reporting with effective sandbox state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox/Gateway: treat `agent:<id>:main` as a main-session alias when `session.mainKey` is customized (backwards compatible).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: fast-path allowlisted slash commands (inline `/help`/`/commands`/`/status`/`/whoami` stripped before model).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw status` now table-based + shows OS/update/gateway/daemon/agents/sessions; `status --all` adds a full read-only debug report (tables, log tails, Tailscale summary, and scan progress via OSC-9 + spinner).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI Backends: add Codex CLI fallback with resume support (text output) and JSONL parsing for new runs, plus a live CLI resume probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add `openclaw update` (safe-ish git checkout update) + `--update` shorthand. (#673) — thanks @fm1randa.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: add OpenAI-compatible `/v1/chat/completions` HTTP endpoint (auth, SSE streaming, per-agent routing). (#680).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Models: add first-class Z.AI (GLM) auth choice (`zai-api-key`) + `--zai-api-key` flag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Onboarding: add OpenRouter API key auth option in configure/onboard. (#703) — thanks @mteam88.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: add human-delay pacing between block replies (modes: off/natural/custom, per-agent configurable). (#446) — thanks @tony-freedomology.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Browser: add `browser.target` (sandbox/host/custom) with sandbox host-control gating via `agents.defaults.sandbox.browser.allowHostControl`, allowlists for custom control URLs/hosts/ports, and expand browser tool docs (remote control, profiles, internals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Models: add catalog-backed default model picker to onboarding + configure. (#611) — thanks @jonasjancarik.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/OpenCode Zen: update fallback models + defaults, keep legacy alias mappings. (#669) — thanks @magimetal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: add `openclaw reset` and `openclaw uninstall` flows (interactive + non-interactive) plus docker cleanup smoke test.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: move provider wiring to a plugin architecture. (#661).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: unify group history context wrappers across providers with per-provider/per-account `historyLimit` overrides (fallback to `messages.groupChat.historyLimit`). Set `0` to disable. (#672).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Heartbeat: optionally deliver heartbeat `Reasoning:` output (`agents.defaults.heartbeat.includeReasoning`). (#690)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: allow optional home volume + extra bind mounts in `docker-setup.sh`. (#679) — thanks @gabriel-trigo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: suppress draft/typing streaming for `NO_REPLY` (silent system ops) so it doesn’t leak partial output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Status: expand tables to full terminal width; clarify provider setup vs runtime warnings; richer per-provider detail; token previews in `status` while keeping `status --all` redacted; add troubleshooting link footer; keep log tails pasteable; show gateway auth used when reachable; surface provider runtime errors (Signal/iMessage/Slack); harden `tailscale status --json` parsing; make `status --all` scan progress determinate; and replace the footer with a 3-line “Next steps” recommendation (share/debug/probe).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Gateway: clarify that `openclaw gateway status` reports RPC health (connect + RPC) and shows RPC failures separately from connect failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Update: gate progress spinner on stdout TTY and align clean-check step label. (#701) — thanks @bjesuiter.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add `/whoami` + `/id` commands to reveal sender id for allowlists; allow `@username` and prefixed ids in `allowFrom` prompts (with stability warning).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat: strip markup-wrapped `HEARTBEAT_OK` so acks don’t leak to external providers (e.g., Telegram).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: stop auto-writing `telegram.groups["*"]` and warn/confirm before enabling wildcard groups.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: send ack reactions only for handled messages and ignore legacy `messages.ackReaction` (doctor copies to `whatsapp.ackReaction`). (#629) — thanks @pasogott.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox/Skills: mirror skills into sandbox workspaces for read-only mounts so SKILL.md stays accessible.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Terminal/Table: ANSI-safe wrapping to prevent table clipping/color loss; add regression coverage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docker: allow optional apt packages during image build and document the build arg. (#697) — thanks @gabriel-trigo.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Heartbeat: deliver reasoning even when the main heartbeat reply is `HEARTBEAT_OK`. (#694) — thanks @antons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Pi: inject config `temperature`/`maxTokens` into streaming without replacing the session streamFn; cover with live maxTokens probe. (#732) — thanks @peschee.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: clear unsigned launchd overrides on signed restarts and warn via doctor when attach-only/disable markers are set. (#695) — thanks @jeffersonwarrior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: enforce single-writer session locks and drop orphan tool results to prevent tool-call ID failures (MiniMax/Anthropic-compatible APIs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: make `openclaw status` the first diagnostic step, clarify `status --deep` behavior, and document `/whoami` + `/id`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs/Testing: clarify live tool+image probes and how to list your testable `provider/model` ids.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests/Live: make gateway bash+read probes resilient to provider formatting while still validating real tool calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: detect @lid mentions in groups using authDir reverse mapping + resolve self JID E.164 for mention gating. (#692) — thanks @peschee.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Auth: default to token auth on loopback during onboarding, add doctor token generation flow, and tighten audio transcription config to Whisper-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: dedupe inbound messages across providers to avoid duplicate LLM runs on redeliveries/reconnects. (#689) — thanks @adam91holt.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: strip `<thought>`/`<antthinking>` tags from hidden reasoning output and cover tag variants in tests. (#688) — thanks @theglove44.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: save model picker selections as normalized provider/model IDs and keep manual entries aligned. (#683) — thanks @benithors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: recognize "usage limit" errors as rate limits for failover. (#687) — thanks @evalexpr.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: avoid success message when daemon restart is skipped. (#685) — thanks @carlulsoe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: disable `/config` + `/debug` by default; gate via `commands.config`/`commands.debug` and hide from native registration/help output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/System: clarify that sub-agents remain sandboxed and cannot use elevated host access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: disable the OpenAI-compatible `/v1/chat/completions` endpoint by default; enable via `gateway.http.endpoints.chatCompletions.enabled=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: stabilize bridge tunnels, guard invoke senders on disconnect, and drain stdout/stderr to avoid deadlocks. (#676) — thanks @ngutman.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/System: clarify sandboxed runtime in system prompt and surface elevated availability when sandboxed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: prefer `RawBody` for command/directive parsing (WhatsApp + Discord) and prevent fallback runs from clobbering concurrent session updates. (#643) — thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: fix group reactions by preserving message IDs and sender JIDs in history; normalize participant phone numbers to JIDs in outbound reactions. (#640) — thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: expose group participant IDs to the model so reactions can target the right sender.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron: `wakeMode: "now"` waits for heartbeat completion (and retries when the main lane is busy). (#666) — thanks @roshanasingh4.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/OpenAI: fix Responses tool-only → follow-up turn handling (avoid standalone `reasoning` items that trigger 400 “required following item”) and replay reasoning items in Responses/Codex Responses history for tool-call-only turns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: add `openclaw sandbox explain` (effective policy inspector + fix-it keys); improve “sandbox jail” tool-policy/elevated errors with actionable config key paths; link to docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks/Gmail: keep Tailscale serve path at `/` while preserving the public path. (#668) — thanks @antons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Hooks/Gmail: allow Tailscale target URLs to preserve internal serve paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: update Claude Code keychain credentials in-place during refresh sync; share JSON file helpers; add CLI fallback coverage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: throttle external CLI credential syncs (Claude/Codex), reduce Keychain reads, and skip sync when cached credentials are still fresh.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: respect `CLAWDBOT_STATE_DIR` for node pairing + voice wake settings storage. (#664) — thanks @azade-c.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Gateway: persist non-interactive gateway token auth in config; add WS wizard + gateway tool-calling regression coverage.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Control UI: make `chat.send` non-blocking, wire Stop to `chat.abort`, and treat `/stop` as an out-of-band abort. (#653)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Control UI: allow `chat.abort` without `runId` (abort active runs), suppress post-abort chat streaming, and prune stuck chat runs. (#653)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Control UI: sniff image attachments for chat.send, drop non-images, and log mismatches. (#670) — thanks @cristip73.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: force `restart-mac.sh --sign` to require identities and keep bundled Node signed for relay verification. (#580) — thanks @jeffersonwarrior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Agent: accept image attachments on `agent` (multimodal message) and add live gateway image probe (`CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw sessions` now includes `elev:*` + `usage:*` flags in the table output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Pairing: accept positional provider for `pairing list|approve` (npm-run compatible); update docs/bot hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Branding: normalize legacy casing/branding to “OpenClaw” (CLI, status, docs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: fix native `/model` not updating the actual chat session (Telegram/Slack/Discord). (#646)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: offer to run `openclaw update` first on git installs (keeps doctor output aligned with latest).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: avoid false legacy workspace warning when install dir is `~/openclaw`. (#660)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: fix reasoning persistence across DMs; avoid partial/duplicate replies when reasoning is enabled. (#655) — thanks @antons.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models/Auth: allow MiniMax API configs without `models.providers.minimax.apiKey` (auth profiles / `MINIMAX_API_KEY`). (#656) — thanks @mneves75.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: avoid duplicate replies when the message tool sends. (#659) — thanks @mickahouan.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: harden Cloud Code Assist tool ID sanitization (toolUse/toolCall/toolResult) and scrub extra JSON Schema constraints. (#665) — thanks @sebslight.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: sanitize tool results + Cloud Code Assist tool IDs at context-build time (prevents mid-run strict-provider request rejects).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Tools: resolve workspace-relative Read/Write/Edit paths; align bash default cwd. (#642) — thanks @mukhtharcm.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: include forwarded message snapshots in agent session context. (#667) — thanks @rubyrunsstuff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: add `telegram.draftChunk` to tune draft streaming chunking for `streamMode: "block"`. (#667) — thanks @rubyrunsstuff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests/Agents: add regression coverage for workspace tool path resolution and bash cwd defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS/Android: enable stricter concurrency/lint checks; fix Swift 6 strict concurrency issues + Android lint errors (ExifInterface, obsolete SDK check). (#662) — thanks @KristijanJovanovski.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: read Codex CLI keychain tokens on macOS before falling back to `~/.codex/auth.json`, preventing stale refresh tokens from breaking gateway live tests.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iOS/macOS: share `AsyncTimeout`, require explicit `bridgeStableID` on connect, and harden tool display defaults (avoids missing-resource label fallbacks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: serialize media-group processing to avoid missed albums under load.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: handle `dataMessage.reaction` events (signal-cli SSE) to avoid broken attachment errors. (#637) — thanks @neist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: showcase entries for ParentPay, R2 Upload, iOS TestFlight, and Oura Health. (#650) — thanks @henrino3.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents: repair session transcripts by dropping duplicate tool results across the whole history (unblocks Anthropic-compatible APIs after retries).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tests/Live: reset the gateway session between model runs to avoid cross-provider transcript incompatibilities (notably OpenAI Responses reasoning replay rules).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.9（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Microsoft Teams provider: polling, attachments, outbound CLI send, per-channel policy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models/Auth expansion: OpenCode Zen + MiniMax API onboarding; token auth profiles + auth order; OAuth health in doctor/status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Gateway UX: message subcommands, gateway discover/status/SSH, /config + /debug, sandbox CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider reliability sweep: WhatsApp contact cards/targets, Telegram audio-as-voice + streaming, Signal reactions, Slack threading, Discord stability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply + status: block-streaming controls, reasoning handling, usage/cost reporting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI/TUI: queued messages, session links, reasoning view, mobile polish, logs UX.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: `openclaw message` now subcommands (`message send|poll|...`) and requires `--provider` unless only one provider configured.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands/Tools: `/restart` and gateway restart tool disabled by default; enable with `commands.restart=true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### New Features and Changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models/Auth: OpenCode Zen onboarding (#623) — thanks @magimetal; MiniMax Anthropic-compatible API + hosted onboarding (#590, #495) — thanks @mneves75, @tobiasbischoff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models/Auth: setup-token + token auth profiles; `openclaw models auth order {get,set,clear}`; per-agent auth candidates in `/model status`; OAuth expiry checks in doctor/status.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent/System: claude-cli runner; `session_status` tool (and sandbox allow); adaptive context pruning default; system prompt messaging guidance + no auto self-update; eligible skills list injection; sub-agent context trimmed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: `/commands` list; `/models` alias; `/usage` alias; `/debug` runtime overrides + effective config view; `/config` chat updates + `/config get`; `config --section`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Gateway: unified message tool + message subcommands; gateway discover (local + wide-area DNS-SD) with JSON/timeout; gateway status human-readable + JSON + SSH loopback; wide-area records include gatewayPort/sshPort/cliPath + tailnet DNS fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI UX: logs output modes (pretty/plain/JSONL) + colorized health/daemon output; global `--no-color`; lobster palette in onboarding/config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dev ergonomics: gateway `--dev/--reset` + dev profile auto-config; C-3PO dev templates; dev gateway/TUI helper scripts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox/Workspace: sandbox list/recreate commands; sync skills into sandbox workspace; sandbox browser auto-start.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config/Onboarding: inline env vars; OpenAI API key flow to shared `~/.openclaw/.env`; Opus 4.5 default prompt for Anthropic auth; QuickStart auto-install gateway (Node-only) + provider picker tweaks + skip-systemd flags; TUI bootstrap prompt (`tui --message`); remove Bun runtime choice.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: Microsoft Teams provider (polling, attachments, outbound sends, requireMention, config reload/DM policy). (#404) — thanks @onutc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: WhatsApp broadcast groups for multi-agent replies (#547) — thanks @pasogott; inbound media size cap configurable (#505) — thanks @koala73; identity-based message prefixes (#578) — thanks @p6l-richard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: Telegram inline keyboard buttons + callback payload routing (#491) — thanks @azade-c; cron topic delivery targets (#474/#478) — thanks @mitschabaude-bot, @nachoiacovino; `[[audio_as_voice]]` tag support (#490) — thanks @jarvis-medmatic.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: Signal reactions + notifications with allowlist support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status/Usage: /status cost reporting + `/cost` lines; auth profile snippet; provider usage windows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: mobile responsiveness (#558) — thanks @carlulsoe; queued messages + Enter-to-send (#527) — thanks @YuriNachos; session links (#471) — thanks @HazAT; reasoning view; skill install feedback (#445) — thanks @pkrmf; chat layout refresh (#475) — thanks @rahthakor; docs link + new session button; drop explicit `ui:install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TUI: agent picker + agents list RPC; improved status line.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor/Daemon: audit/repair flows, permissions checks, supervisor config audits; provider status probes + warnings for Discord intents and Telegram privacy; last activity timestamps; gateway restart guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: Hetzner Docker VPS guide + cross-links (#556/#592) — thanks @Iamadig; Ansible guide (#545) — thanks @pasogott; provider troubleshooting index; hook parameter expansion (#532) — thanks @mcinteerj; model allowlist notes; OAuth deep dive; showcase refresh.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Apps/Branding: refreshed iOS/Android/macOS icons (#521) — thanks @fishfisher.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Packaging: include MS Teams send module in npm tarball.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox/Browser: auto-start CDP endpoint; proxy CDP out of container for attachOnly; relax Bun fetch typing; align sandbox list output with config images.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agents/Runtime: gate heartbeat prompt to default sessions; /stop aborts between tool calls; require explicit system-event session keys; guard small context windows; fix model fallback stringification; sessions_spawn inherits provider; failover on billing/credits; respect auth cooldown ordering; restore Anthropic OAuth tool dispatch + tool-name bypass; avoid OpenAI invalid reasoning replay; harden Gmail hook model defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent history/schema: strip/skip empty assistant/error blocks to prevent session corruption/Claude 400s; scrub unsupported JSON Schema keywords + sanitize tool call IDs for Cloud Code Assist; simplify Gemini-compatible tool/session schemas; require raw for config.apply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply/Streaming: default audioAsVoice false; preserve audio_as_voice propagation + buffer audio blocks + guard voice notes; block reply ordering (timeout) + forced-block fence-safe; avoid chunk splits inside parentheses + fence-close breaks + invalid UTF-16 truncation; preserve inline directive spacing + allow whitespace in reply tags; filter NO_REPLY prefixes + normalize routed replies; suppress <think> leakage with separate Reasoning; block streaming defaults (off by default, minChars/idle tuning) + coalesced blocks; dedupe followup queue; restore explicit responsePrefix default.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Status/Commands: provider prefix in /status model display; usage filtering + provider mapping; auth label + usage snapshots (claude-cli fallback + optional claude.ai); show Verbose/Elevated only when enabled; compact usage/cost line + restore emoji-rich status; /status in directive-only + multi-directive handling; mention-bypass elevated handling; surface provider usage errors; wire /usage to /status; restore hidden gateway-daemon alias; fallback /model list when catalog unavailable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: vCard/contact cards (prefer FN, include numbers, show all contacts, keep summary counts, better empty summaries); preserve group JIDs + normalize targets; resolve @lid mappings/JIDs (Baileys/auth-dir) + inbound mapping; route queued replies to sender; improve web listener errors + remove provider name from errors; record outbound activity account id; fix web media fetch errors; broadcast group history consistency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram: keep streamMode draft-only; long-poll conflict retries + update dedupe; grammY fetch mismatch fixes + restrict native fetch to Bun; suppress getUpdates stack traces; include user id in pairing; audio_as_voice handling fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord/Slack: thread context helpers + forum thread starters; avoid category parent overrides; gateway reconnect logs + HELLO timeout + stop provider after reconnect exhaustion; DM recipient parsing for numeric IDs; remove incorrect limited warning; reply threading + mrkdwn edge cases; remove ack reactions after reply; gateway debug event visibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Signal: reaction handling safety; own-reaction matching (uuid+phone); UUID-only senders accepted; ignore reaction-only messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- MS Teams: download image attachments reliably; fix top-level replies; stop on shutdown + honor chunk limits; normalize poll providers/deps; pairing label fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- iMessage: isolate group-ish threads by chat_id.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway/Daemon/Doctor: atomic config writes; repair gateway service entrypoint + install switches; non-interactive legacy migrations; systemd unit alignment + KillMode=process; node bridge keepalive/pings; Launch at Login persistence; bundle MoltbotKit resources + Swift 6.2 compat dylib; relay version check + remove smoke test; regen Swift GatewayModels + keep agent provider string; cron jobId alias + channel alias migration + main session key normalization; heartbeat Telegram accountId resolution; avoid WhatsApp fallback for internal runs; gateway listener error wording; serveBaseUrl param; honor gateway --dev; fix wide-area discovery updates; align agents.defaults schema; provider account metadata in daemon status; refresh Carbon patch for gateway fixes; restore doctor prompter initialValue handling.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI/TUI: persist per-session verbose off + hide tool cards; logs tab opens at bottom; relative asset paths + landing cleanup; session labels lookup/persistence; stop pinning main session in recents; start logs at bottom; TUI status bar refresh + timeout handling + hide reasoning label when off.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding/Configure: QuickStart single-select provider picker; avoid Codex CLI false-expiry warnings; clarify WhatsApp owner prompt; fix Minimax hosted onboarding (agents.defaults + msteams heartbeat target); remove configure Control UI prompt; honor gateway --dev flag.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Maintenance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dependencies: bump pi-\* stack to 0.42.2.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dependencies: Pi 0.40.0 bump (#543) — thanks @mcinteerj.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Build: Docker build cache layer (#605) — thanks @zknicker.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auth: enable OAuth token refresh for Claude Code CLI credentials (`anthropic:claude-cli`) with bidirectional sync back to Claude Code storage (file on Linux/Windows, Keychain on macOS). This allows long-running agents to operate autonomously without manual re-authentication (#654 — thanks @radek-paclt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.8（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Security: DMs locked down by default across providers; pairing-first + allowlist guidance.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: per-agent scope defaults + workspace access controls; tool/session isolation tuned.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent loop: compaction, pruning, streaming, and error handling hardened.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: Telegram/WhatsApp/Discord/Slack reliability, threading, reactions, media, and retries improved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: logs tab, streaming stability, focus mode, and large-output rendering fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI/Gateway/Doctor: daemon/logs/status, auth migration, and diagnostics significantly expanded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Breaking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SECURITY (update ASAP):** inbound DMs are now **locked down by default** on Telegram/WhatsApp/Signal/iMessage/Discord/Slack.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Previously, if you didn’t configure an allowlist, your bot could be **open to anyone** (especially discoverable Telegram bots).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - New default: DM pairing (`dmPolicy="pairing"` / `discord.dm.policy="pairing"` / `slack.dm.policy="pairing"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - To keep old “open to everyone” behavior: set `dmPolicy="open"` and include `"*"` in the relevant `allowFrom` (Discord/Slack: `discord.dm.allowFrom` / `slack.dm.allowFrom`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Approve requests via `openclaw pairing list <provider>` + `openclaw pairing approve <provider> <code>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sandbox: default `agent.sandbox.scope` to `"agent"` (one container/workspace per agent). Use `"session"` for per-session isolation; `"shared"` disables cross-session isolation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Timestamps in agent envelopes are now UTC (compact `YYYY-MM-DDTHH:mmZ`); removed `messages.timestampPrefix`. Add `agent.userTimezone` to tell the model the user’s local time (system prompt only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model config schema changes (auth profiles + model lists); doctor auto-migrates and the gateway rewrites legacy configs on startup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: gate all slash commands to authorized senders; add `/compact` to manually compact session context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Groups: `whatsapp.groups`, `telegram.groups`, and `imessage.groups` now act as allowlists when set. Add `"*"` to keep allow-all behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Auto-reply: removed `autoReply` from Discord/Slack/Telegram channel configs; use `requireMention` instead (Telegram topics now support `requireMention` overrides).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: remove `update`, `gateway-daemon`, `gateway {install|uninstall|start|stop|restart|daemon status|wake|send|agent}`, and `telegram` commands; move `login/logout` to `providers login/logout` (top-level aliases hidden); use `daemon` for service control, `send`/`agent`/`wake` for RPC, and `nodes canvas` for canvas ops.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **CLI/Gateway/Doctor:** daemon runtime selection + improved logs/status/health/errors; auth/password handling for local CLI; richer close/timeout details; auto-migrate legacy config/sessions/state; integrity checks + repair prompts; `--yes`/`--non-interactive`; `--deep` gateway scans; better restart/service hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Agent loop + compaction:** compaction/pruning tuning, overflow handling, safer bootstrap context, and per-provider threading/confirmations; opt-in tool-result pruning + compact tracking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Sandbox + tools:** per-agent sandbox overrides, workspaceAccess controls, session tool visibility, tool policy overrides, process isolation, and tool schema/timeout/reaction unification.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Providers (Telegram/WhatsApp/Discord/Slack/Signal/iMessage):** retry/backoff, threading, reactions, media groups/attachments, mention gating, typing behavior, and error/log stability; long polling + forum topic isolation for Telegram.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway/CLI UX:** `openclaw logs`, cron list colors/aliases, docs search, agents list/add/delete flows, status usage snapshots, runtime/auth source display, and `/status`/commands auth unification.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Control UI/Web:** logs tab, focus mode polish, config form resilience, streaming stability, tool output caps, windowed chat history, and reconnect/password URL auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **macOS/Android/TUI/Build:** macOS gateway races, QR bundling, JSON5 config safety, Voice Wake hardening; Android EXIF rotation + APK naming/versioning; TUI key handling; tooling/bundling fixes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Packaging/compat:** npm dist folder coverage, Node 25 qrcode-terminal import fixes, Bun/Playwright/WebSocket patches, and Docker Bun install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Docs:** new FAQ/ClawHub/config examples/showcase entries and clarified auth, sandbox, and systemd docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Maintenance（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Skills additions (Himalaya email, CodexBar, 1Password).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Dependency refreshes (pi-\* stack, Slack SDK, discord-api-types, file-type, zod, Biome, Vite).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Refactors: centralized group allowlist/mention policy; lint/import cleanup; switch tsx → bun for TS execution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## 2026.1.5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Highlights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Models: add image-specific model config (`agent.imageModel` + fallbacks) and scan support.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent tools: new `image` tool routed to the image model (when configured).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config: default model shorthands (`opus`, `sonnet`, `gpt`, `gpt-mini`, `gemini`, `gemini-flash`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs: document built-in model shorthands + precedence (user config wins).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Bun: optional local install/build workflow without maintaining a Bun lockfile (see `docs/bun.md`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: render Markdown in tool result cards.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: prevent overlapping action buttons in Discord guild rules on narrow layouts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android: tapping the foreground service notification brings the app to the front. (#179) — thanks @Syhids（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron tool uses `id` for update/remove/run/runs (aligns with gateway params). (#180) — thanks @adamgall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Control UI: chat view uses page scroll with sticky header/sidebar and fixed composer (no inner scroll frame).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: treat location permission as always-only to avoid iOS-only enums. (#165) — thanks @Nachx639（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: make generated gateway protocol models `Sendable` for Swift 6 strict concurrency. (#195) — thanks @andranik-sahakyan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: bundle QR code renderer modules so DMG gateway boot doesn't crash on missing qrcode-terminal vendor files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS: parse JSON5 config safely to avoid wiping user settings when comments are present.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: suppress typing indicator during heartbeat background tasks. (#190) — thanks @mcinteerj（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WhatsApp: mark offline history sync messages as read without auto-reply. (#193) — thanks @mcinteerj（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: avoid duplicate replies when a provider emits late streaming `text_end` events (OpenAI/GPT).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: use tailnet IP for local gateway calls when bind is tailnet/auto (fixes #176).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Env: load global `$OPENCLAW_STATE_DIR/.env` (`~/.openclaw/.env`) as a fallback after CWD `.env`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Env: optional login-shell env fallback (opt-in; imports expected keys without overriding existing env).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent tools: OpenAI-compatible tool JSON Schemas (fix `browser`, normalize union schemas).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Onboarding: when running from source, auto-build missing Control UI assets (`bun run ui:build`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord/Slack: route reaction + system notifications to the correct session (no main-session bleed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Agent tools: honor `agent.tools` allow/deny policy even when sandbox is off.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discord: avoid duplicate replies when OpenAI emits repeated `message_end` events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Commands: unify /status (inline) and command auth across providers; group bypass for authorized control commands; remove Discord /clawd slash handler.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI: run `openclaw agent` via the Gateway by default; use `--local` to force embedded mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
