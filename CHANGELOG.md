# Changelog

Docs: https://docs.openclaw.ai

## 2026.2.15 (Unreleased)

### Changes

### Fixes

- TUI: make searchable-select filtering and highlight rendering ANSI-aware so queries ignore hidden escape codes and no longer corrupt ANSI styling sequences during match highlighting. (#4519) Thanks @bee4come.
- TUI/Windows: coalesce rapid single-line submit bursts in Git Bash into one multiline message as a fallback when bracketed paste is unavailable, preventing pasted multiline text from being split into multiple sends. (#4986) Thanks @adamkane.
- TUI: suppress false `(no output)` placeholders for non-local empty final events during concurrent runs, preventing external-channel replies from showing empty assistant bubbles while a local run is still streaming. (#5782) Thanks @LagWizard and @vignesh07.
- Auto-reply/WhatsApp/TUI/Web: when a final assistant message is `NO_REPLY` and a messaging tool send succeeded, mirror the delivered messaging-tool text into session-visible assistant output so TUI/Web no longer show `NO_REPLY` placeholders. (#7010) Thanks @Morrowind-Xie.
- Gateway/Chat: harden `chat.send` inbound message handling by rejecting null bytes, stripping unsafe control characters, and normalizing Unicode to NFC before dispatch. (#8593) Thanks @fr33d3m0n.
- Gateway/Security: redact sensitive session/path details from `status` responses for non-admin clients; full details remain available to `operator.admin`. (#8590) Thanks @fr33d3m0n.
- Agents: return an explicit timeout error reply when an embedded run times out before producing any payloads, preventing silent dropped turns during slow cache-refresh transitions. (#16659) Thanks @liaosvcaf and @vignesh07.
- Agents/OpenAI: force `store=true` for direct OpenAI Responses/Codex runs to preserve multi-turn server-side conversation state, while leaving proxy/non-OpenAI endpoints unchanged. (#16803) Thanks @mark9232 and @vignesh07.
- CLI/Build: make legacy daemon CLI compatibility shim generation tolerant of minimal tsdown daemon export sets, while preserving restart/register compatibility aliases and surfacing explicit errors for unavailable legacy daemon commands. Thanks @vignesh07.

## 2026.2.14

### Changes

- Telegram: add poll sending via `openclaw message poll` (duration seconds, silent delivery, anonymity controls). (#16209) Thanks @robbyczgw-cla.
- Slack/Discord: add `dmPolicy` + `allowFrom` config aliases for DM access control; legacy `dm.policy` + `dm.allowFrom` keys remain supported and `openclaw doctor --fix` can migrate them.
- Discord: allow exec approval prompts to target channels or both DM+channel via `channels.discord.execApprovals.target`. (#16051) Thanks @leonnardo.
- Sandbox: add `sandbox.browser.binds` to configure browser-container bind mounts separately from exec containers. (#16230) Thanks @seheepeak.
- Discord: add debug logging for message routing decisions to improve `--debug` tracing. (#16202) Thanks @jayleekr.
- Agents: add optional `messages.suppressToolErrors` config to hide non-mutating tool-failure warnings from user-facing chat while still surfacing mutating failures. (#16620) Thanks @vai-oro.

### Fixes

- CLI/Plugins: ensure `openclaw message send` exits after successful delivery across plugin-backed channels so one-shot sends do not hang. (#16491) Thanks @yinghaosang.
- CLI/Plugins: run registered plugin `gateway_stop` hooks before `openclaw message` exits (success and failure paths), so plugin-backed channels can clean up one-shot CLI resources. (#16580) Thanks @gumadeiras.
- WhatsApp: honor per-account `dmPolicy` overrides (account-level settings now take precedence over channel defaults for inbound DMs). (#10082) Thanks @mcaxtr.
- Telegram: when `channels.telegram.commands.native` is `false`, exclude plugin commands from `setMyCommands` menu registration while keeping plugin slash handlers callable. (#15132) Thanks @Glucksberg.
- LINE: return 200 OK for Developers Console "Verify" requests (`{"events":[]}`) without `X-Line-Signature`, while still requiring signatures for real deliveries. (#16582) Thanks @arosstale.
- Cron: deliver text-only output directly when `delivery.to` is set so cron recipients get full output instead of summaries. (#16360) Thanks @thewilloftheshadow.
- Cron/Slack: preserve agent identity (name and icon) when cron jobs deliver outbound messages. (#16242) Thanks @robbyczgw-cla.
- Media: accept `MEDIA:`-prefixed paths (lenient whitespace) when loading outbound media to prevent `ENOENT` for tool-returned local media paths. (#13107) Thanks @mcaxtr.
- Media understanding: treat binary `application/vnd.*`/zip/octet-stream attachments as non-text (while keeping vendor `+json`/`+xml` text-eligible) so Office/ZIP files are not inlined into prompt body text. (#16513) Thanks @rmramsey32.
- Agents: deliver tool result media (screenshots, images, audio) to channels regardless of verbose level. (#11735) Thanks @strelov1.
- Auto-reply/Block streaming: strip leading whitespace from streamed block replies so messages starting with blank lines no longer deliver visible leading empty lines. (#16422) Thanks @mcinteerj.
- Auto-reply/Queue: keep queued followups and overflow summaries when drain attempts fail, then retry delivery instead of dropping messages on transient errors. (#16771) Thanks @mmhzlrj.
- Agents/Image tool: allow workspace-local image paths by including the active workspace directory in local media allowlists, and trust sandbox-validated paths in image loaders to prevent false "not under an allowed directory" rejections. (#15541)
- Agents/Image tool: propagate the effective workspace root into tool wiring so workspace-local image paths are accepted by default when running without an explicit `workspaceDir`. (#16722)
- BlueBubbles: include sender identity in group chat envelopes and pass clean message text to the agent prompt, aligning with iMessage/Signal formatting. (#16210) Thanks @zerone0x.
- CLI: fix lazy core command registration so top-level maintenance commands (`doctor`, `dashboard`, `reset`, `uninstall`) resolve correctly instead of exposing a non-functional `maintenance` placeholder command.
- CLI/Dashboard: when `gateway.bind=lan`, generate localhost dashboard URLs to satisfy browser secure-context requirements while preserving non-LAN bind behavior. (#16434) Thanks @BinHPdev.
- TUI/Gateway: resolve local gateway target URL from `gateway.bind` mode (tailnet/lan) instead of hardcoded localhost so `openclaw tui` connects when gateway is non-loopback. (#16299) Thanks @cortexuvula.
- TUI: honor explicit `--session <key>` in `openclaw tui` even when `session.scope` is `global`, so named sessions no longer collapse into shared global history. (#16575) Thanks @cinqu.
- TUI: use available terminal width for session name display in searchable select lists. (#16238) Thanks @robbyczgw-cla.
- TUI: refactor searchable select list description layout and add regression coverage for ANSI-highlight width bounds.
- TUI: preserve in-flight streaming replies when a different run finalizes concurrently (avoid clearing active run or reloading history mid-stream). (#10704) Thanks @axschr73.
- TUI: keep pre-tool streamed text visible when later tool-boundary deltas temporarily omit earlier text blocks. (#6958) Thanks @KrisKind75.
- TUI: sanitize ANSI/control-heavy history text, redact binary-like lines, and split pathological long unbroken tokens before rendering to prevent startup crashes on binary attachment history. (#13007) Thanks @wilkinspoe.
- TUI: harden render-time sanitizer for narrow terminals by chunking moderately long unbroken tokens and adding fast-path sanitization guards to reduce overhead on normal text. (#5355) Thanks @tingxueren.
- TUI: render assistant body text in terminal default foreground (instead of fixed light ANSI color) so contrast remains readable on light themes such as Solarized Light. (#16750) Thanks @paymog.
- TUI/Hooks: pass explicit reset reason (`new` vs `reset`) through `sessions.reset` and emit internal command hooks for gateway-triggered resets so `/new` hook workflows fire in TUI/webchat.
- Gateway/Agent: route bare `/new` and `/reset` through `sessions.reset` before running the fresh-session greeting prompt, so reset commands clear the current session in-place instead of falling through to normal agent runs. (#16732) Thanks @kdotndot and @vignesh07.
- Cron: prevent `cron list`/`cron status` from silently skipping past-due recurring jobs by using maintenance recompute semantics. (#16156) Thanks @zerone0x.
- Cron: repair missing/corrupt `nextRunAtMs` for the updated job without globally recomputing unrelated due jobs during `cron update`. (#15750)
- Cron: skip missed-job replay on startup for jobs interrupted mid-run (stale `runningAtMs` markers), preventing restart loops for self-restarting jobs such as update tasks. (#16694) Thanks @sbmilburn.
- Heartbeat/Cron: treat cron-tagged queued system events as cron reminders even on interval wakes, so isolated cron announce summaries no longer run under the default heartbeat prompt. (#14947) Thanks @archedark-ada and @vignesh07.
- Discord: prefer gateway guild id when logging inbound messages so cached-miss guilds do not appear as `guild=dm`. Thanks @thewilloftheshadow.
- Discord: treat empty per-guild `channels: {}` config maps as no channel allowlist (not deny-all), so `groupPolicy: "open"` guilds without explicit channel entries continue to receive messages. (#16714) Thanks @xqliu.
- Models/CLI: guard `models status` string trimming paths to prevent crashes from malformed non-string config values. (#16395) Thanks @BinHPdev.
- Gateway/Subagents: preserve queued announce items and summary state on delivery errors, retry failed announce drains, and avoid dropping unsent announcements on timeout/failure. (#16729) Thanks @Clawdette-Workspace.
- Gateway/Config: make `config.patch` merge object arrays by `id` (for example `agents.list`) instead of replacing the whole array, so partial agent updates do not silently delete unrelated agents. (#6766) Thanks @lightclient.
- Webchat/Prompts: stop injecting direct-chat `conversation_label` into inbound untrusted metadata context blocks, preventing internal label noise from leaking into visible chat replies. (#16556) Thanks @nberardi.
- Gateway/Sessions: abort active embedded runs and clear queued session work before `sessions.reset`, returning unavailable if the run does not stop in time. (#16576) Thanks @Grynn.
- Sessions/Agents: harden transcript path resolution for mismatched agent context by preserving explicit store roots and adding safe absolute-path fallback to the correct agent sessions directory. (#16288) Thanks @robbyczgw-cla.
- Agents: add a safety timeout around embedded `session.compact()` to ensure stalled compaction runs settle and release blocked session lanes. (#16331) Thanks @BinHPdev.
- Agents: keep unresolved mutating tool failures visible until the same action retry succeeds, scope mutation-error surfacing to mutating calls (including `session_status` model changes), and dedupe duplicate failure warnings in outbound replies. (#16131) Thanks @Swader.
- Agents/Process/Bootstrap: preserve unbounded `process log` offset-only pagination (default tail applies only when both `offset` and `limit` are omitted) and enforce strict `bootstrapTotalMaxChars` budgeting across injected bootstrap content (including markers), skipping additional injection when remaining budget is too small. (#16539) Thanks @CharlieGreenman.
- Agents/Workspace: persist bootstrap onboarding state so partially initialized workspaces recover missing `BOOTSTRAP.md` once, while completed onboarding keeps BOOTSTRAP deleted even if runtime files are later recreated. Thanks @gumadeiras.
- Agents/Workspace: create `BOOTSTRAP.md` when core workspace files are seeded in partially initialized workspaces, while keeping BOOTSTRAP one-shot after onboarding deletion. (#16457) Thanks @robbyczgw-cla.
- Agents: classify external timeout aborts during compaction the same as internal timeouts, preventing unnecessary auth-profile rotation and preserving compaction-timeout snapshot fallback behavior. (#9855) Thanks @mverrilli.
- Agents: treat empty-stream provider failures (`request ended without sending any chunks`) as timeout-class failover signals, enabling auth-profile rotation/fallback and showing a friendly timeout message instead of raw provider errors. (#10210) Thanks @zenchantlive.
- Agents: treat `read` tool `file_path` arguments as valid in tool-start diagnostics to avoid false “read tool called without path” warnings when alias parameters are used. (#16717) Thanks @Stache73.
- Agents/Transcript: drop malformed tool-call blocks with blank required fields (`id`/`name` or missing `input`/`arguments`) during session transcript repair to prevent persistent tool-call corruption on future turns. (#15485) Thanks @mike-zachariades.
- Tools/Write/Edit: normalize structured text-block arguments for `content`/`oldText`/`newText` before filesystem edits, preventing JSON-like file corruption and false “exact text not found” misses from block-form params. (#16778) Thanks @danielpipernz.
- Ollama/Agents: avoid forcing `<final>` tag enforcement for Ollama models, which could suppress all output as `(no output)`. (#16191) Thanks @Glucksberg.
- Plugins: suppress false duplicate plugin id warnings when the same extension is discovered via multiple paths (config/workspace/global vs bundled), while still warning on genuine duplicates. (#16222) Thanks @shadril238.
- Skills: watch `SKILL.md` only when refreshing skills snapshot to avoid file-descriptor exhaustion in large data trees. (#11325) Thanks @household-bard.
- Memory/QMD: make `memory status` read-only by skipping QMD boot update/embed side effects for status-only manager checks.
- Memory/QMD: keep original QMD failures when builtin fallback initialization fails (for example missing embedding API keys), instead of replacing them with fallback init errors.
- Memory/Builtin: keep `memory status` dirty reporting stable across invocations by deriving status-only manager dirty state from persisted index metadata instead of process-start defaults. (#10863) Thanks @BarryYangi.
- Memory/QMD: cap QMD command output buffering to prevent memory exhaustion from pathological `qmd` command output.
- Memory/QMD: parse qmd scope keys once per request to avoid repeated parsing in scope checks.
- Memory/QMD: query QMD index using exact docid matches before falling back to prefix lookup for better recall correctness and index efficiency.
- Memory/QMD: pass result limits to `search`/`vsearch` commands so QMD can cap results earlier.
- Memory/QMD: avoid reading full markdown files when a `from/lines` window is requested in QMD reads.
- Memory/QMD: skip rewriting unchanged session export markdown files during sync to reduce disk churn.
- Memory/QMD: make QMD result JSON parsing resilient to noisy command output by extracting the first JSON array from noisy `stdout`.
- Memory/QMD: treat prefixed `no results found` marker output as an empty result set in qmd JSON parsing. (#11302) Thanks @blazerui.
- Memory/QMD: avoid multi-collection `query` ranking corruption by running one `qmd query -c <collection>` per managed collection and merging by best score (also used for `search`/`vsearch` fallback-to-query). (#16740) Thanks @volarian-vai.
- Memory/QMD: make `openclaw memory index` verify and print the active QMD index file path/size, and fail when QMD leaves a missing or zero-byte index artifact after an update. (#16775) Thanks @Shunamxiao.
- Memory/QMD: detect null-byte `ENOTDIR` update failures, rebuild managed collections once, and retry update to self-heal corrupted collection metadata. (#12919) Thanks @jorgejhms.
- Memory/QMD/Security: add `rawKeyPrefix` support for QMD scope rules and preserve legacy `keyPrefix: "agent:..."` matching, preventing scoped deny bypass when operators match agent-prefixed session keys.
- Memory/Builtin: narrow memory watcher targets to markdown globs and ignore dependency/venv directories to reduce file-descriptor pressure during memory sync startup. (#11721) Thanks @rex05ai.
- Security/Memory-LanceDB: treat recalled memories as untrusted context (escape injected memory text + explicit non-instruction framing), skip likely prompt-injection payloads during auto-capture, and restrict auto-capture to user messages to reduce memory-poisoning risk. (#12524) Thanks @davidschmid24.
- Security/Memory-LanceDB: require explicit `autoCapture: true` opt-in (default is now disabled) to prevent automatic PII capture unless operators intentionally enable it. (#12552) Thanks @fr33d3m0n.
- Diagnostics/Memory: prune stale diagnostic session state entries and cap tracked session states to prevent unbounded in-memory growth on long-running gateways. (#5136) Thanks @coygeek and @vignesh07.
- Gateway/Memory: clean up `agentRunSeq` tracking on run completion/abort and enforce maintenance-time cap pruning to prevent unbounded sequence-map growth over long uptimes. (#6036) Thanks @coygeek and @vignesh07.
- Auto-reply/Memory: bound `ABORT_MEMORY` growth by evicting oldest entries and deleting reset (`false`) flags so abort state tracking cannot grow unbounded over long uptimes. (#6629) Thanks @coygeek and @vignesh07.
- Slack/Memory: bound thread-starter cache growth with TTL + max-size pruning to prevent long-running Slack gateways from accumulating unbounded thread cache state. (#5258) Thanks @coygeek and @vignesh07.
- Outbound/Memory: bound directory cache growth with max-size eviction and proactive TTL pruning to prevent long-running gateways from accumulating unbounded directory entries. (#5140) Thanks @coygeek and @vignesh07.
- Skills/Memory: remove disconnected nodes from remote-skills cache to prevent stale node metadata from accumulating over long uptimes. (#6760) Thanks @coygeek.
- Sandbox/Tools: make sandbox file tools bind-mount aware (including absolute container paths) and enforce read-only bind semantics for writes. (#16379) Thanks @tasaankaeris.
- Sandbox/Prompts: show the sandbox container workdir as the prompt working directory and clarify host-path usage for file tools, preventing host-path `exec` failures in sandbox sessions. (#16790) Thanks @carrotRakko.
- Media/Security: allow local media reads from OpenClaw state `workspace/` and `sandboxes/` roots by default so generated workspace media can be delivered without unsafe global path bypasses. (#15541) Thanks @lanceji.
- Media/Security: harden local media allowlist bypasses by requiring an explicit `readFile` override when callers mark paths as validated, and reject filesystem-root `localRoots` entries. (#16739)
- Discord/Security: harden voice message media loading (SSRF + allowed-local-root checks) so tool-supplied paths/URLs cannot be used to probe internal URLs or read arbitrary local files.
- Security/BlueBubbles: require explicit `mediaLocalRoots` allowlists for local outbound media path reads to prevent local file disclosure. (#16322) Thanks @mbelinky.
- Security/BlueBubbles: reject ambiguous shared-path webhook routing when multiple webhook targets match the same guid/password.
- Security/BlueBubbles: harden BlueBubbles webhook auth behind reverse proxies by only accepting passwordless webhooks for direct localhost loopback requests (forwarded/proxied requests now require a password). Thanks @simecek.
- Feishu/Security: harden media URL fetching against SSRF and local file disclosure. (#16285) Thanks @mbelinky.
- Security/Zalo: reject ambiguous shared-path webhook routing when multiple webhook targets match the same secret.
- Security/Nostr: require loopback source and block cross-origin profile mutation/import attempts. Thanks @vincentkoc.
- Security/Signal: harden signal-cli archive extraction during install to prevent path traversal outside the install root.
- Security/Hooks: restrict hook transform modules to `~/.openclaw/hooks/transforms` (prevents path traversal/escape module loads via config). Config note: `hooks.transformsDir` must now be within that directory. Thanks @akhmittra.
- Security/Hooks: ignore hook package manifest entries that point outside the package directory (prevents out-of-tree handler loads during hook discovery).
- Security/Archive: enforce archive extraction entry/size limits to prevent resource exhaustion from high-expansion ZIP/TAR archives. Thanks @vincentkoc.
- Security/Media: reject oversized base64-backed input media before decoding to avoid large allocations. Thanks @vincentkoc.
- Security/Media: stream and bound URL-backed input media fetches to prevent memory exhaustion from oversized responses. Thanks @vincentkoc.
- Security/Skills: harden archive extraction for download-installed skills to prevent path traversal outside the target directory. Thanks @markmusson.
- Security/Slack: compute command authorization for DM slash commands even when `dmPolicy=open`, preventing unauthorized users from running privileged commands via DM. Thanks @christos-eth.
- Security/iMessage: keep DM pairing-store identities out of group allowlist authorization (prevents cross-context command authorization). Thanks @vincentkoc.
- Security/Google Chat: deprecate `users/<email>` allowlists (treat `users/...` as immutable user id only); keep raw email allowlists for usability. Thanks @vincentkoc.
- Security/Google Chat: reject ambiguous shared-path webhook routing when multiple webhook targets verify successfully (prevents cross-account policy-context misrouting). Thanks @vincentkoc.
- Telegram/Security: require numeric Telegram sender IDs for allowlist authorization (reject `@username` principals), auto-resolve `@username` to IDs in `openclaw doctor --fix` (when possible), and warn in `openclaw security audit` when legacy configs contain usernames. Thanks @vincentkoc.
- Telegram/Security: reject Telegram webhook startup when `webhookSecret` is missing or empty (prevents unauthenticated webhook request forgery). Thanks @yueyueL.
- Security/Windows: avoid shell invocation when spawning child processes to prevent cmd.exe metacharacter injection via untrusted CLI arguments (e.g. agent prompt text).
- Telegram: set webhook callback timeout handling to `onTimeout: "return"` (10s) so long-running update processing no longer emits webhook 500s and retry storms. (#16763) Thanks @chansearrington.
- Signal: preserve case-sensitive `group:` target IDs during normalization so mixed-case group IDs no longer fail with `Group not found`. (#16748) Thanks @repfigit.
- Feishu/Security: harden media URL fetching against SSRF and local file disclosure. (#16285) Thanks @mbelinky.
- Security/Agents: scope CLI process cleanup to owned child PIDs to avoid killing unrelated processes on shared hosts. Thanks @aether-ai-agent.
- Security/Agents: enforce workspace-root path bounds for `apply_patch` in non-sandbox mode to block traversal and symlink escape writes. Thanks @p80n-sec.
- Security/Agents: enforce symlink-escape checks for `apply_patch` delete hunks under `workspaceOnly`, while still allowing deleting the symlink itself. Thanks @p80n-sec.
- Security/Agents (macOS): prevent shell injection when writing Claude CLI keychain credentials. (#15924) Thanks @aether-ai-agent.
- macOS: hard-limit unkeyed `openclaw://agent` deep links and ignore `deliver` / `to` / `channel` unless a valid unattended key is provided. Thanks @Cillian-Collins.
- Scripts/Security: validate GitHub logins and avoid shell invocation in `scripts/update-clawtributors.ts` to prevent command injection via malicious commit records. Thanks @scanleale.
- Security: fix Chutes manual OAuth login state validation by requiring the full redirect URL (reject code-only pastes) (thanks @aether-ai-agent).
- Security/Gateway: harden tool-supplied `gatewayUrl` overrides by restricting them to loopback or the configured `gateway.remote.url`. Thanks @p80n-sec.
- Security/Gateway: block `system.execApprovals.*` via `node.invoke` (use `exec.approvals.node.*` instead). Thanks @christos-eth.
- Security/Gateway: reject oversized base64 chat attachments before decoding to avoid large allocations. Thanks @vincentkoc.
- Security/Gateway: stop returning raw resolved config values in `skills.status` requirement checks (prevents operator.read clients from reading secrets). Thanks @simecek.
- Security/Net: fix SSRF guard bypass via full-form IPv4-mapped IPv6 literals (blocks loopback/private/metadata access). Thanks @yueyueL.
- Security/Browser: harden browser control file upload + download helpers to prevent path traversal / local file disclosure. Thanks @1seal.
- Security/Browser: block cross-origin mutating requests to loopback browser control routes (CSRF hardening). Thanks @vincentkoc.
- Security/Node Host: enforce `system.run` rawCommand/argv consistency to prevent allowlist/approval bypass. Thanks @christos-eth.
- Security/Exec approvals: prevent safeBins allowlist bypass via shell expansion (host exec allowlist mode only; not enabled by default). Thanks @christos-eth.
- Security/Exec: harden PATH handling by disabling project-local `node_modules/.bin` bootstrapping by default, disallowing node-host `PATH` overrides, and spawning ACP servers via the current executable by default. Thanks @akhmittra.
- Security/Tlon: harden Urbit URL fetching against SSRF by blocking private/internal hosts by default (opt-in: `channels.tlon.allowPrivateNetwork`). Thanks @p80n-sec.
- Security/Voice Call (Telnyx): require webhook signature verification when receiving inbound events; configs without `telnyx.publicKey` are now rejected unless `skipSignatureVerification` is enabled. Thanks @p80n-sec.
- Security/Voice Call: require valid Twilio webhook signatures even when ngrok free tier loopback compatibility mode is enabled. Thanks @p80n-sec.
- Security/Discovery: stop treating Bonjour TXT records as authoritative routing (prefer resolved service endpoints) and prevent discovery from overriding stored TLS pins; autoconnect now requires a previously trusted gateway. Thanks @simecek.

## 2026.2.13

### Changes

- Install: add optional Podman-based setup: `setup-podman.sh` for one-time host setup (openclaw user, image, launch script, systemd quadlet), `run-openclaw-podman.sh launch` / `launch setup`; systemd Quadlet unit for openclaw user service; docs for rootless container, openclaw user (subuid/subgid), and quadlet (troubleshooting). (#16273) Thanks @DarwinsBuddy.
- Discord: send voice messages with waveform previews from local audio files (including silent delivery). (#7253) Thanks @nyanjou.
- Discord: add configurable presence status/activity/type/url (custom status defaults to activity text). (#10855) Thanks @h0tp-ftw.
- Slack/Plugins: add thread-ownership outbound gating via `message_sending` hooks, including @-mention bypass tracking and Slack outbound hook wiring for cancel/modify behavior. (#15775) Thanks @DarlingtonDeveloper.
- Agents: add synthetic catalog support for `hf:zai-org/GLM-5`. (#15867) Thanks @battman21.
- Skills: remove duplicate `local-places` Google Places skill/proxy and keep `goplaces` as the single supported Google Places path.
- Agents: add pre-prompt context diagnostics (`messages`, `systemPromptChars`, `promptChars`, provider/model, session file) before embedded runner prompt calls to improve overflow debugging. (#8930) Thanks @Glucksberg.
- Onboarding/Providers: add first-class Hugging Face Inference provider support (provider wiring, onboarding auth choice/API key flow, and default-model selection), and preserve Hugging Face auth intent in auth-choice remapping (`tokenProvider=huggingface` with `authChoice=apiKey`) while skipping env-override prompts when an explicit token is provided. (#13472) Thanks @Josephrp.
- Onboarding/Providers: add `minimax-api-key-cn` auth choice for the MiniMax China API endpoint. (#15191) Thanks @liuy.

### Breaking

- Config/State: removed legacy `.moltbot` auto-detection/migration and `moltbot.json` config candidates. If you still have state/config under `~/.moltbot`, move it to `~/.openclaw` (recommended) or set `OPENCLAW_STATE_DIR` / `OPENCLAW_CONFIG_PATH` explicitly.

### Fixes

- Gateway/Auth: add trusted-proxy mode hardening follow-ups by keeping `OPENCLAW_GATEWAY_*` env compatibility, auto-normalizing invalid setup combinations in interactive `gateway configure` (trusted-proxy forces `bind=lan` and disables Tailscale serve/funnel), and suppressing shared-secret/rate-limit audit findings that do not apply to trusted-proxy deployments. (#15940) Thanks @nickytonline.
- Docs/Hooks: update hooks documentation URLs to the new `/automation/hooks` location. (#16165) Thanks @nicholascyh.
- Security/Audit: warn when `gateway.tools.allow` re-enables default-denied tools over HTTP `POST /tools/invoke`, since this can increase RCE blast radius if the gateway is reachable.
- Security/Plugins/Hooks: harden npm-based installs by restricting specs to registry packages only, passing `--ignore-scripts` to `npm pack`, and cleaning up temp install directories.
- Feishu: stop persistent Typing reaction on NO_REPLY/suppressed runs by wiring reply-dispatcher cleanup to remove typing indicators. (#15464) Thanks @arosstale.
- Agents: strip leading empty lines from `sanitizeUserFacingText` output and normalize whitespace-only outputs to empty text. (#16158) Thanks @mcinteerj.
- BlueBubbles: gracefully degrade when Private API is disabled by filtering private-only actions, skipping private-only reactions/reply effects, and avoiding private reply markers so non-private flows remain usable. (#16002) Thanks @L-U-C-K-Y.
- Outbound: add a write-ahead delivery queue with crash-recovery retries to prevent lost outbound messages after gateway restarts. (#15636) Thanks @nabbilkhan, @thewilloftheshadow.
- Auto-reply/Threading: auto-inject implicit reply threading so `replyToMode` works without requiring model-emitted `[[reply_to_current]]`, while preserving `replyToMode: "off"` behavior for implicit Slack replies and keeping block-streaming chunk coalescing stable under `replyToMode: "first"`. (#14976) Thanks @Diaspar4u.
- Auto-reply/Threading: honor explicit `[[reply_to_*]]` tags even when `replyToMode` is `off`. (#16174) Thanks @aldoeliacim.
- Plugins/Threading: rename `allowTagsWhenOff` to `allowExplicitReplyTagsWhenOff` and keep the old key as a deprecated alias for compatibility. (#16189)
- Outbound/Threading: pass `replyTo` and `threadId` from `message send` tool actions through the core outbound send path to channel adapters, preserving thread/reply routing. (#14948) Thanks @mcaxtr.
- Auto-reply/Media: allow image-only inbound messages (no caption) to reach the agent instead of short-circuiting as empty text, and preserve thread context in queued/followup prompt bodies for media-only runs. (#11916) Thanks @arosstale.
- Discord: route autoThread replies to existing threads instead of the root channel. (#8302) Thanks @gavinbmoore, @thewilloftheshadow.
- Web UI: add `img` to DOMPurify allowed tags and `src`/`alt` to allowed attributes so markdown images render in webchat instead of being stripped. (#15437) Thanks @lailoo.
- Telegram/Matrix: treat MP3 and M4A (including `audio/mp4`) as voice-compatible for `asVoice` routing, and keep WAV/AAC falling back to regular audio sends. (#15438) Thanks @azade-c.
- WhatsApp: preserve outbound document filenames for web-session document sends instead of always sending `"file"`. (#15594) Thanks @TsekaLuk.
- Telegram: cap bot menu registration to Telegram's 100-command limit with an overflow warning while keeping typed hidden commands available. (#15844) Thanks @battman21.
- Telegram: scope skill commands to the resolved agent for default accounts so `setMyCommands` no longer triggers `BOT_COMMANDS_TOO_MUCH` when multiple agents are configured. (#15599)
- Discord: avoid misrouting numeric guild allowlist entries to `/channels/<guildId>` by prefixing guild-only inputs with `guild:` during resolution. (#12326) Thanks @headswim.
- Memory/QMD: default `memory.qmd.searchMode` to `search` for faster CPU-only recall and always scope `search`/`vsearch` requests to managed collections (auto-falling back to `query` when required). (#16047) Thanks @togotago.
- Memory/LanceDB: add configurable `captureMaxChars` for auto-capture while keeping the legacy 500-char default. (#16641) Thanks @ciberponk.
- MS Teams: preserve parsed mention entities/text when appending OneDrive fallback file links, and accept broader real-world Teams mention ID formats (`29:...`, `8:orgid:...`) while still rejecting placeholder patterns. (#15436) Thanks @hyojin.
- Media: classify `text/*` MIME types as documents in media-kind routing so text attachments are no longer treated as unknown. (#12237) Thanks @arosstale.
- Inbound/Web UI: preserve literal `\n` sequences when normalizing inbound text so Windows paths like `C:\\Work\\nxxx\\README.md` are not corrupted. (#11547) Thanks @mcaxtr.
- TUI/Streaming: preserve richer streamed assistant text when final payload drops pre-tool-call text blocks, while keeping non-empty final payload authoritative for plain-text updates. (#15452) Thanks @TsekaLuk.
- Providers/MiniMax: switch implicit MiniMax API-key provider from `openai-completions` to `anthropic-messages` with the correct Anthropic-compatible base URL, fixing `invalid role: developer (2013)` errors on MiniMax M2.5. (#15275) Thanks @lailoo.
- Ollama/Agents: use resolved model/provider base URLs for native `/api/chat` streaming (including aliased providers), normalize `/v1` endpoints, and forward abort + `maxTokens` stream options for reliable cancellation and token caps. (#11853) Thanks @BrokenFinger98.
- OpenAI Codex/Spark: implement end-to-end `gpt-5.3-codex-spark` support across fallback/thinking/model resolution and `models list` forward-compat visibility. (#14990, #15174) Thanks @L-U-C-K-Y, @loiie45e.
- Agents/Codex: allow `gpt-5.3-codex-spark` in forward-compat fallback, live model filtering, and thinking presets, and fix model-picker recognition for spark. (#14990) Thanks @L-U-C-K-Y.
- Models/Codex: resolve configured `openai-codex/gpt-5.3-codex-spark` through forward-compat fallback during `models list`, so it is not incorrectly tagged as missing when runtime resolution succeeds. (#15174) Thanks @loiie45e.
- OpenAI Codex/Auth: bridge OpenClaw OAuth profiles into `pi` `auth.json` so model discovery and models-list registry resolution can use Codex OAuth credentials. (#15184) Thanks @loiie45e.
- Auth/OpenAI Codex: share OAuth login handling across onboarding and `models auth login --provider openai-codex`, keep onboarding alive when OAuth fails, and surface a direct OAuth help note instead of terminating the wizard. (#15406, follow-up to #14552) Thanks @zhiluo20.
- Onboarding/Providers: add vLLM as an onboarding provider with model discovery, auth profile wiring, and non-interactive auth-choice validation. (#12577) Thanks @gejifeng.
- Onboarding/CLI: restore terminal state without resuming paused `stdin`, so onboarding exits cleanly (including Docker TTY installs that would otherwise hang). (#12972) Thanks @vincentkoc.
- Signal/Install: auto-install `signal-cli` via Homebrew on non-x64 Linux architectures, avoiding x86_64 native binary `Exec format error` failures on arm64/arm hosts. (#15443) Thanks @jogvan-k.
- macOS Voice Wake: fix a crash in trigger trimming for CJK/Unicode transcripts by matching and slicing on original-string ranges instead of transformed-string indices. (#11052) Thanks @Flash-LHR.
- Mattermost (plugin): retry websocket monitor connections with exponential backoff and abort-aware teardown so transient connect failures no longer permanently stop monitoring. (#14962) Thanks @mcaxtr.
- Discord/Agents: apply channel/group `historyLimit` during embedded-runner history compaction to prevent long-running channel sessions from bypassing truncation and overflowing context windows. (#11224) Thanks @shadril238.
- Outbound targets: fail closed for WhatsApp/Twitch/Google Chat fallback paths so invalid or missing targets are dropped instead of rerouted, and align resolver hints with strict target requirements. (#13578) Thanks @mcaxtr.
- Gateway/Restart: clear stale command-queue and heartbeat wake runtime state after SIGUSR1 in-process restarts to prevent zombie gateway behavior where queued work stops draining. (#15195) Thanks @joeykrug.
- Heartbeat: prevent scheduler silent-death races during runner reloads, preserve retry cooldown backoff under wake bursts, and prioritize user/action wake causes over interval/retry reasons when coalescing. (#15108) Thanks @joeykrug.
- Heartbeat: allow explicit wake (`wake`) and hook wake (`hook:*`) reasons to run even when `HEARTBEAT.md` is effectively empty so queued system events are processed. (#14527) Thanks @arosstale.
- Auto-reply/Heartbeat: strip sentence-ending `HEARTBEAT_OK` tokens even when followed by up to 4 punctuation characters, while preserving surrounding sentence punctuation. (#15847) Thanks @Spacefish.
- Sessions/Agents: pass `agentId` when resolving existing transcript paths in reply runs so non-default agents and heartbeat/chat handlers no longer fail with `Session file path must be within sessions directory`. (#15141) Thanks @Goldenmonstew.
- Sessions/Agents: pass `agentId` through status and usage transcript-resolution paths (auto-reply, gateway usage APIs, and session cost/log loaders) so non-default agents can resolve absolute session files without path-validation failures. (#15103) Thanks @jalehman.
- Sessions: archive previous transcript files on `/new` and `/reset` session resets (including gateway `sessions.reset`) so stale transcripts do not accumulate on disk. (#14869) Thanks @mcaxtr.
- Status/Sessions: stop clamping derived `totalTokens` to context-window size, keep prompt-token snapshots wired through session accounting, and surface context usage as unknown when fresh snapshot data is missing to avoid false 100% reports. (#15114) Thanks @echoVic.
- Gateway/Routing: speed up hot paths for session listing (derived titles + previews), WS broadcast, and binding resolution.
- Gateway/Sessions: cache derived title + last-message transcript reads to speed up repeated sessions list refreshes.
- CLI/Completion: route plugin-load logs to stderr and write generated completion scripts directly to stdout to avoid `source <(openclaw completion ...)` corruption. (#15481) Thanks @arosstale.
- CLI: lazily load outbound provider dependencies and remove forced success-path exits so commands terminate naturally without killing intentional long-running foreground actions. (#12906) Thanks @DrCrinkle.
- CLI: speed up startup by lazily registering core commands (keeps rich `--help` while reducing cold-start overhead).
- Security/Gateway + ACP: block high-risk tools (`sessions_spawn`, `sessions_send`, `gateway`, `whatsapp_login`) from HTTP `/tools/invoke` by default with `gateway.tools.{allow,deny}` overrides, and harden ACP permission selection to fail closed when tool identity/options are ambiguous while supporting `allow_always`/`reject_always`. (#15390) Thanks @aether-ai-agent.
- Security/ACP: prompt for non-read/search permission requests in ACP clients (reduces silent tool approval risk). Thanks @aether-ai-agent.
- Security/Gateway: breaking default-behavior change - canvas IP-based auth fallback now only accepts machine-scoped addresses (RFC1918, link-local, ULA IPv6, CGNAT); public-source IP matches now require bearer token auth. (#14661) Thanks @sumleo.
- Security/Link understanding: block loopback/internal host patterns and private/mapped IPv6 addresses in extracted URL handling to close SSRF bypasses in link CLI flows. (#15604) Thanks @AI-Reviewer-QS.
- Security/Browser: constrain `POST /trace/stop`, `POST /wait/download`, and `POST /download` output paths to OpenClaw temp roots and reject traversal/escape paths.
- Security/Browser: sanitize download `suggestedFilename` to keep implicit `wait/download` paths within the downloads root. Thanks @1seal.
- Security/Browser: confine `POST /hooks/file-chooser` upload paths to an OpenClaw temp uploads root and reject traversal/escape paths. Thanks @1seal.
- Security/Browser: require auth for the sandbox browser bridge server (protects `/profiles`, `/tabs`, CDP URLs, and other control endpoints). Thanks @jackhax.
- Security: bind local helper servers to loopback and fail closed on non-loopback OAuth callback hosts (reduces localhost/LAN attack surface).
- Security/Canvas: serve A2UI assets via the shared safe-open path (`openFileWithinRoot`) to close traversal/TOCTOU gaps, with traversal and symlink regression coverage. (#10525) Thanks @abdelsfane.
- Security/WhatsApp: enforce `0o600` on `creds.json` and `creds.json.bak` on save/backup/restore paths to reduce credential file exposure. (#10529) Thanks @abdelsfane.
- Security/Gateway: sanitize and truncate untrusted WebSocket header values in pre-handshake close logs to reduce log-poisoning risk. Thanks @thewilloftheshadow.
- Security/Audit: add misconfiguration checks for sandbox Docker config with sandbox mode off, ineffective `gateway.nodes.denyCommands` entries, global minimal tool-profile overrides by agent profiles, and permissive extension-plugin tool reachability.
- Security/Audit: distinguish external webhooks (`hooks.enabled`) from internal hooks (`hooks.internal.enabled`) in attack-surface summaries to avoid false exposure signals when only internal hooks are enabled. (#13474) Thanks @mcaxtr.
- Security/Onboarding: clarify multi-user DM isolation remediation with explicit `openclaw config set session.dmScope ...` commands in security audit, doctor security, and channel onboarding guidance. (#13129) Thanks @VintLin.
- Security/Gateway: bind node `system.run` approval overrides to gateway exec-approval records (runId-bound), preventing approval-bypass via `node.invoke` param injection. Thanks @222n5.
- Agents/Nodes: harden node exec approval decision handling in the `nodes` tool run path by failing closed on unexpected approval decisions, and add regression coverage for approval-required retry/deny/timeout flows. (#4726) Thanks @rmorse.
- Android/Nodes: harden `app.update` by requiring HTTPS and gateway-host URL matching plus SHA-256 verification, stream URL camera downloads to disk with size guards to avoid memory spikes, and stop signing release builds with debug keys. (#13541) Thanks @smartprogrammer93.
- Routing: enforce strict binding-scope matching across peer/guild/team/roles so peer-scoped Discord/Slack bindings no longer match unrelated guild/team contexts or fallback tiers. (#15274) Thanks @lailoo.
- Exec/Allowlist: allow multiline heredoc bodies (`<<`, `<<-`) while keeping multiline non-heredoc shell commands blocked, so exec approval parsing permits heredoc input safely without allowing general newline command chaining. (#13811) Thanks @mcaxtr.
- Config: preserve `${VAR}` env references when writing config files so `openclaw config set/apply/patch` does not persist secrets to disk. Thanks @thewilloftheshadow.
- Config: remove a cross-request env-snapshot race in config writes by carrying read-time env context into write calls per request, preserving `${VAR}` refs safely under concurrent gateway config mutations. (#11560) Thanks @akoscz.
- Config: log overwrite audit entries (path, backup target, and hash transition) whenever an existing config file is replaced, improving traceability for unexpected config clobbers.
- Config: keep legacy audio transcription migration strict by rejecting non-string/unsafe command tokens while still migrating valid custom script executables. (#5042) Thanks @shayan919293.
- Config: accept `$schema` key in config file so JSON Schema editor tooling works without validation errors. (#14998)
- Gateway/Tools Invoke: sanitize `/tools/invoke` execution failures while preserving `400` for tool input errors and returning `500` for unexpected runtime failures, with regression coverage and docs updates. (#13185) Thanks @davidrudduck.
- Gateway/Hooks: preserve `408` for hook request-body timeout responses while keeping bounded auth-failure cache eviction behavior, with timeout-status regression coverage. (#15848) Thanks @AI-Reviewer-QS.
- Plugins/Hooks: fire `before_tool_call` hook exactly once per tool invocation in embedded runs by removing duplicate dispatch paths while preserving parameter mutation semantics. (#15635) Thanks @lailoo.
- Agents/Transcript policy: sanitize OpenAI/Codex tool-call ids during transcript policy normalization to prevent invalid tool-call identifiers from propagating into session history. (#15279) Thanks @divisonofficer.
- Agents/Image tool: cap image-analysis completion `maxTokens` by model capability (`min(4096, model.maxTokens)`) to avoid over-limit provider failures while still preventing truncation. (#11770) Thanks @detecti1.
- Agents/Compaction: centralize exec default resolution in the shared tool factory so per-agent `tools.exec` overrides (host/security/ask/node and related defaults) persist across compaction retries. (#15833) Thanks @napetrov.
- Gateway/Agents: stop injecting a phantom `main` agent into gateway agent listings when `agents.list` explicitly excludes it. (#11450) Thanks @arosstale.
- Process/Exec: avoid shell execution for `.exe` commands on Windows so env overrides work reliably in `runCommandWithTimeout`. Thanks @thewilloftheshadow.
- Daemon/Windows: preserve literal backslashes in `gateway.cmd` command parsing so drive and UNC paths are not corrupted in runtime checks and doctor entrypoint comparisons. (#15642) Thanks @arosstale.
- Sandbox: pass configured `sandbox.docker.env` variables to sandbox containers at `docker create` time. (#15138) Thanks @stevebot-alive.
- Voice Call: route webhook runtime event handling through shared manager event logic so rejected inbound hangups are idempotent in production, with regression tests for duplicate reject events and provider-call-ID remapping parity. (#15892) Thanks @dcantu96.
- Cron: add regression coverage for announce-mode isolated jobs so runs that already report `delivered: true` do not enqueue duplicate main-session relays, including delivery configs where `mode` is omitted and defaults to announce. (#15737) Thanks @brandonwise.
- Cron: honor `deleteAfterRun` in isolated announce delivery by mapping it to subagent announce cleanup mode, so cron run sessions configured for deletion are removed after completion. (#15368) Thanks @arosstale.
- Web tools/web_fetch: prefer `text/markdown` responses for Cloudflare Markdown for Agents, add `cf-markdown` extraction for markdown bodies, and redact fetched URLs in `x-markdown-tokens` debug logs to avoid leaking raw paths/query params. (#15376) Thanks @Yaxuan42.
- Tools/web_search: support `freshness` for the Perplexity provider by mapping `pd`/`pw`/`pm`/`py` to Perplexity `search_recency_filter` values and including freshness in the Perplexity cache key. (#15343) Thanks @echoVic.
- Clawdock: avoid Zsh readonly variable collisions in helper scripts. (#15501) Thanks @nkelner.
- Memory: switch default local embedding model to the QAT `embeddinggemma-300m-qat-Q8_0` variant for better quality at the same footprint. (#15429) Thanks @azade-c.
- Docs/Mermaid: remove hardcoded Mermaid init theme blocks from four docs diagrams so dark mode inherits readable theme defaults. (#15157) Thanks @heytulsiprasad.
- Security/Pairing: generate 256-bit base64url device and node pairing tokens and use byte-safe constant-time verification to avoid token-compare edge-case failures. (#16535) Thanks @FaizanKolega, @gumadeiras.

## 2026.2.12

### Changes

- CLI/Plugins: add `openclaw plugins uninstall <id>` with `--dry-run`, `--force`, and `--keep-files` options, including safe uninstall path handling and plugin uninstall docs. (#5985) Thanks @JustasMonkev.
- CLI: add `openclaw logs --local-time` to display log timestamps in local timezone. (#13818) Thanks @xialonglee.
- Telegram: render blockquotes as native `<blockquote>` tags instead of stripping them. (#14608)
- Telegram: expose `/compact` in the native command menu. (#10352) Thanks @akramcodez.
- Discord: add role-based allowlists and role-based agent routing. (#10650) Thanks @Minidoracat.
- Config: avoid redacting `maxTokens`-like fields during config snapshot redaction, preventing round-trip validation failures in `/config`. (#14006) Thanks @constansino.

### Breaking

- Hooks: `POST /hooks/agent` now rejects payload `sessionKey` overrides by default. To keep fixed hook context, set `hooks.defaultSessionKey` (recommended with `hooks.allowedSessionKeyPrefixes: ["hook:"]`). If you need legacy behavior, explicitly set `hooks.allowRequestSessionKey: true`. Thanks @alpernae for reporting.

### Fixes

- Gateway/OpenResponses: harden URL-based `input_file`/`input_image` handling with explicit SSRF deny policy, hostname allowlists (`files.urlAllowlist` / `images.urlAllowlist`), per-request URL input caps (`maxUrlParts`), blocked-fetch audit logging, and regression coverage/docs updates.
- Security: fix unauthenticated Nostr profile API remote config tampering. (#13719) Thanks @coygeek.
- Security: remove bundled soul-evil hook. (#14757) Thanks @Imccccc.
- Security/Audit: add hook session-routing hardening checks (`hooks.defaultSessionKey`, `hooks.allowRequestSessionKey`, and prefix allowlists), and warn when HTTP API endpoints allow explicit session-key routing.
- Security/Sandbox: confine mirrored skill sync destinations to the sandbox `skills/` root and stop using frontmatter-controlled skill names as filesystem destination paths. Thanks @1seal.
- Security/Web tools: treat browser/web content as untrusted by default (wrapped outputs for browser snapshot/tabs/console and structured external-content metadata for web tools), and strip `toolResult.details` from model-facing transcript/compaction inputs to reduce prompt-injection replay risk.
- Security/Hooks: harden webhook and device token verification with shared constant-time secret comparison, and add per-client auth-failure throttling for hook endpoints (`429` + `Retry-After`). Thanks @akhmittra.
- Security/Browser: require auth for loopback browser control HTTP routes, auto-generate `gateway.auth.token` when browser control starts without auth, and add a security-audit check for unauthenticated browser control. Thanks @tcusolle.
- Sessions/Gateway: harden transcript path resolution and reject unsafe session IDs/file paths so session operations stay within agent sessions directories. Thanks @akhmittra.
- Sessions: preserve `verboseLevel`, `thinkingLevel`/`reasoningLevel`, and `ttsAuto` overrides across `/new` and `/reset` session resets. (#10787) Thanks @mcaxtr.
- Gateway: raise WS payload/buffer limits so 5,000,000-byte image attachments work reliably. (#14486) Thanks @0xRaini.
- Logging/CLI: use local timezone timestamps for console prefixing, and include `±HH:MM` offsets when using `openclaw logs --local-time` to avoid ambiguity. (#14771) Thanks @0xRaini.
- Gateway: drain active turns before restart to prevent message loss. (#13931) Thanks @0xRaini.
- Gateway: auto-generate auth token during install to prevent launchd restart loops. (#13813) Thanks @cathrynlavery.
- Gateway: prevent `undefined`/missing token in auth config. (#13809) Thanks @asklee-klawd.
- Configure/Gateway: reject literal `"undefined"`/`"null"` token input and validate gateway password prompt values to avoid invalid password-mode configs. (#13767) Thanks @omair445.
- Gateway: handle async `EPIPE` on stdout/stderr during shutdown. (#13414) Thanks @keshav55.
- Gateway/Control UI: resolve missing dashboard assets when `openclaw` is installed globally via symlink-based Node managers (nvm/fnm/n/Homebrew). (#14919) Thanks @aynorica.
- Cron: use requested `agentId` for isolated job auth resolution. (#13983) Thanks @0xRaini.
- Cron: prevent cron jobs from skipping execution when `nextRunAtMs` advances. (#14068) Thanks @WalterSumbon.
- Cron: pass `agentId` to `runHeartbeatOnce` for main-session jobs. (#14140) Thanks @ishikawa-pro.
- Cron: re-arm timers when `onTimer` fires while a job is still executing. (#14233) Thanks @tomron87.
- Cron: prevent duplicate fires when multiple jobs trigger simultaneously. (#14256) Thanks @xinhuagu.
- Cron: prevent duplicate announce-mode isolated cron deliveries, and keep main-session fallback active when best-effort structured delivery attempts fail to send any message. (#15739) Thanks @widingmarcus-cyber.
- Cron: isolate scheduler errors so one bad job does not break all jobs. (#14385) Thanks @MarvinDontPanic.
- Cron: prevent one-shot `at` jobs from re-firing on restart after skipped/errored runs. (#13878) Thanks @lailoo.
- Heartbeat: prevent scheduler stalls on unexpected run errors and avoid immediate rerun loops after `requests-in-flight` skips. (#14901) Thanks @joeykrug.
- Cron: honor stored session model overrides for isolated-agent runs while preserving `hooks.gmail.model` precedence for Gmail hook sessions. (#14983) Thanks @shtse8.
- Logging/Browser: fall back to `os.tmpdir()/openclaw` for default log, browser trace, and browser download temp paths when `/tmp/openclaw` is unavailable.
- WhatsApp: convert Markdown bold/strikethrough to WhatsApp formatting. (#14285) Thanks @Raikan10.
- WhatsApp: allow media-only sends and normalize leading blank payloads. (#14408) Thanks @karimnaguib.
- WhatsApp: default MIME type for voice messages when Baileys omits it. (#14444) Thanks @mcaxtr.
- Telegram: handle no-text message in model picker editMessageText. (#14397) Thanks @0xRaini.
- Telegram: surface REACTION_INVALID as non-fatal warning. (#14340) Thanks @0xRaini.
- BlueBubbles: fix webhook auth bypass via loopback proxy trust. (#13787) Thanks @coygeek.
- Slack: change default replyToMode from "off" to "all". (#14364) Thanks @nm-de.
- Slack: honor `limit` for `emoji-list` actions across core and extension adapters, with capped emoji-list responses in the Slack action handler. (#4293) Thanks @mcaxtr.
- Slack: detect control commands when channel messages start with bot mention prefixes (for example, `@Bot /new`). (#14142) Thanks @beefiker.
- Slack: include thread reply metadata in inbound message footer context (`thread_ts`, `parent_user_id`) while keeping top-level `thread_ts == ts` events unthreaded. (#14625) Thanks @bennewton999.
- Signal: enforce E.164 validation for the Signal bot account prompt so mistyped numbers are caught early. (#15063) Thanks @Duartemartins.
- Discord: process DM reactions instead of silently dropping them. (#10418) Thanks @mcaxtr.
- Discord: treat Administrator as full permissions in channel permission checks. Thanks @thewilloftheshadow.
- Discord: respect replyToMode in threads. (#11062) Thanks @cordx56.
- Discord: add optional gateway proxy support for WebSocket connections via `channels.discord.proxy`. (#10400) Thanks @winter-loo, @thewilloftheshadow.
- Browser: add Chrome launch flag `--disable-blink-features=AutomationControlled` to reduce `navigator.webdriver` automation detection issues on reCAPTCHA-protected sites. (#10735) Thanks @Milofax.
- Heartbeat: filter noise-only system events so scheduled reminder notifications do not fire when cron runs carry only heartbeat markers. (#13317) Thanks @pvtclawn.
- Signal: render mention placeholders as `@uuid`/`@phone` so mention gating and Clawdbot targeting work. (#2013) Thanks @alexgleason.
- Discord: omit empty content fields for media-only messages while preserving caption whitespace. (#9507) Thanks @leszekszpunar.
- Onboarding/Providers: add Z.AI endpoint-specific auth choices (`zai-coding-global`, `zai-coding-cn`, `zai-global`, `zai-cn`) and expand default Z.AI model wiring. (#13456) Thanks @tomsun28.
- Onboarding/Providers: update MiniMax API default/recommended models from M2.1 to M2.5, add M2.5/M2.5-Lightning model entries, and include `minimax-m2.5` in modern model filtering. (#14865) Thanks @adao-max.
- Ollama: use configured `models.providers.ollama.baseUrl` for model discovery and normalize `/v1` endpoints to the native Ollama API root. (#14131) Thanks @shtse8.
- Voice Call: pass Twilio stream auth token via `<Parameter>` instead of query string. (#14029) Thanks @mcwigglesmcgee.
- Config/Models: allow full `models.providers.*.models[*].compat` keys used by `openai-completions` (`thinkingFormat`, `supportsStrictMode`, and streaming/tool-result compatibility flags) so valid provider overrides no longer fail strict config validation. (#11063) Thanks @ikari-pl.
- Feishu: pass `Buffer` directly to the Feishu SDK upload APIs instead of `Readable.from(...)` to avoid form-data upload failures. (#10345) Thanks @youngerstyle.
- Feishu: trigger mention-gated group handling only when the bot itself is mentioned (not just any mention). (#11088) Thanks @openperf.
- Feishu: probe status uses the resolved account context for multi-account credential checks. (#11233) Thanks @onevcat.
- Feishu: add streaming card replies via Card Kit API and preserve `renderMode=auto` fallback behavior for plain-text responses. (#10379) Thanks @xzq-xu.
- Feishu DocX: preserve top-level converted block order using `firstLevelBlockIds` when writing/appending documents. (#13994) Thanks @Cynosure159.
- Feishu plugin packaging: remove `workspace:*` `openclaw` dependency from `extensions/feishu` and sync lockfile for install compatibility. (#14423) Thanks @jackcooper2015.
- CLI/Wizard: exit with code 1 when `configure`, `agents add`, or interactive `onboard` wizards are canceled, so `set -e` automation stops correctly. (#14156) Thanks @0xRaini.
- Media: strip `MEDIA:` lines with local paths instead of leaking as visible text. (#14399) Thanks @0xRaini.
- Config/Cron: exclude `maxTokens` from config redaction and honor `deleteAfterRun` on skipped cron jobs. (#13342) Thanks @niceysam.
- Config: ignore `meta` field changes in config file watcher. (#13460) Thanks @brandonwise.
- Cron: use requested `agentId` for isolated job auth resolution. (#13983) Thanks @0xRaini.
- Cron: pass `agentId` to `runHeartbeatOnce` for main-session jobs. (#14140) Thanks @ishikawa-pro.
- Cron: prevent cron jobs from skipping execution when `nextRunAtMs` advances. (#14068) Thanks @WalterSumbon.
- Cron: re-arm timers when `onTimer` fires while a job is still executing. (#14233) Thanks @tomron87.
- Cron: prevent duplicate fires when multiple jobs trigger simultaneously. (#14256) Thanks @xinhuagu.
- Cron: isolate scheduler errors so one bad job does not break all jobs. (#14385) Thanks @MarvinDontPanic.
- Cron: prevent one-shot `at` jobs from re-firing on restart after skipped/errored runs. (#13878) Thanks @lailoo.
- Daemon: suppress `EPIPE` error when restarting LaunchAgent. (#14343) Thanks @0xRaini.
- Antigravity: add opus 4.6 forward-compat model and bypass thinking signature sanitization. (#14218) Thanks @jg-noncelogic.
- Agents: prevent file descriptor leaks in child process cleanup. (#13565) Thanks @KyleChen26.
- Agents: prevent double compaction caused by cache TTL bypassing guard. (#13514) Thanks @taw0002.
- Agents: use last API call's cache tokens for context display instead of accumulated sum. (#13805) Thanks @akari-musubi.
- Agents: keep followup-runner session `totalTokens` aligned with post-compaction context by using last-call usage and shared token-accounting logic. (#14979) Thanks @shtse8.
- Hooks/Plugins: wire 9 previously unwired plugin lifecycle hooks into core runtime paths (session, compaction, gateway, and outbound message hooks). (#14882) Thanks @shtse8.
- Hooks/Tools: dispatch `before_tool_call` and `after_tool_call` hooks from both tool execution paths with rebased conflict fixes. (#15012) Thanks @Patrick-Barletta, @Takhoffman.
- Hooks: replace loader `console.*` output with subsystem logger messages so hook loading errors/warnings route through standard logging. (#11029) Thanks @shadril238.
- Discord: allow channel-edit to archive/lock threads and set auto-archive duration. (#5542) Thanks @stumct.
- Discord tests: use a partial @buape/carbon mock in slash command coverage. (#13262) Thanks @arosstale.
- Tests: update thread ID handling in Slack message collection tests. (#14108) Thanks @swizzmagik.
- Update/Daemon: fix post-update restart compatibility by generating `dist/cli/daemon-cli.js` with alias-aware exports from hashed daemon bundles, preventing `registerDaemonCli` import failures during `openclaw update`.

## 2026.2.9

### Added

- Commands: add `commands.allowFrom` config for separate command authorization, allowing operators to restrict slash commands to specific users while keeping chat open to others. (#12430) Thanks @thewilloftheshadow.
- Docker: add ClawDock shell helpers for Docker workflows. (#12817) Thanks @Olshansk.
- iOS: alpha node app + setup-code onboarding. (#11756) Thanks @mbelinky.
- Channels: comprehensive BlueBubbles and channel cleanup. (#11093) Thanks @tyler6204.
- Channels: IRC first-class channel support. (#11482) Thanks @vignesh07.
- Plugins: device pairing + phone control plugins (Telegram `/pair`, iOS/Android node controls). (#11755) Thanks @mbelinky.
- Tools: add Grok (xAI) as a `web_search` provider. (#12419) Thanks @tmchow.
- Gateway: add agent management RPC methods for the web UI (`agents.create`, `agents.update`, `agents.delete`). (#11045) Thanks @advaitpaliwal.
- Gateway: stream thinking events to WS clients and broadcast tool events independent of verbose level. (#10568) Thanks @nk1tz.
- Web UI: show a Compaction divider in chat history. (#11341) Thanks @Takhoffman.
- Agents: include runtime shell in agent envelopes. (#1835) Thanks @Takhoffman.
- Agents: auto-select `zai/glm-4.6v` for image understanding when ZAI is primary provider. (#10267) Thanks @liuy.
- Paths: add `OPENCLAW_HOME` for overriding the home directory used by internal path resolution. (#12091) Thanks @sebslight.
- Onboarding: add Custom Provider flow for OpenAI and Anthropic-compatible endpoints. (#11106) Thanks @MackDing.
- Hooks: route webhook agent runs to specific `agentId`s, add `hooks.allowedAgentIds` controls, and fall back to default agent when unknown IDs are provided. (#13672) Thanks @BillChirico.

### Fixes

- Cron: prevent one-shot `at` jobs from re-firing on gateway restart when previously skipped or errored. (#13845)
- Discord: add exec approval cleanup option to delete DMs after approval/denial/timeout. (#13205) Thanks @thewilloftheshadow.
- Sessions: prune stale entries, cap session store size, rotate large stores, accept duration/size thresholds, default to warn-only maintenance, and prune cron run sessions after retention windows. (#13083) Thanks @skyfallsin, @Glucksberg, @gumadeiras.
- CI: Implement pipeline and workflow order. Thanks @quotentiroler.
- WhatsApp: preserve original filenames for inbound documents. (#12691) Thanks @akramcodez.
- Telegram: harden quote parsing; preserve quote context; avoid QUOTE_TEXT_INVALID; avoid nested reply quote misclassification. (#12156) Thanks @rybnikov.
- Security/Telegram: breaking default-behavior change — standalone canvas host + Telegram webhook listeners now bind loopback (`127.0.0.1`) instead of `0.0.0.0`; set `channels.telegram.webhookHost` when external ingress is required. (#13184) Thanks @davidrudduck.
- Telegram: recover proactive sends when stale topic thread IDs are used by retrying without `message_thread_id`. (#11620)
- Discord: auto-create forum/media thread posts on send, with chunked follow-up replies and media handling for forum sends. (#12380) Thanks @magendary, @thewilloftheshadow.
- Discord: cap gateway reconnect attempts to avoid infinite retry loops. (#12230) Thanks @Yida-Dev.
- Telegram: render markdown spoilers with `<tg-spoiler>` HTML tags. (#11543) Thanks @ezhikkk.
- Telegram: truncate command registration to 100 entries to avoid `BOT_COMMANDS_TOO_MUCH` failures on startup. (#12356) Thanks @arosstale.
- Telegram: match DM `allowFrom` against sender user id (fallback to chat id) and clarify pairing logs. (#12779) Thanks @liuxiaopai-ai.
- Pairing/Telegram: include the actual pairing code in approve commands, route Telegram pairing replies through the shared pairing message builder, and add regression checks to prevent `<code>` placeholder drift.
- Onboarding: QuickStart now auto-installs shell completion (prompt only in Manual).
- Onboarding/Providers: add LiteLLM provider onboarding and preserve custom LiteLLM proxy base URLs while enforcing API-key auth mode. (#12823) Thanks @ryan-crabbe.
- Docker: make `docker-setup.sh` compatible with macOS Bash 3.2 and empty extra mounts. (#9441) Thanks @mateusz-michalik.
- Auth: strip embedded line breaks from pasted API keys and tokens before storing/resolving credentials.
- Agents: strip reasoning tags and downgraded tool markers from messaging tool and streaming output to prevent leakage. (#11053, #13453) Thanks @liebertar, @meaadore1221-afk, @gumadeiras.
- Browser: prevent stuck `act:evaluate` from wedging the browser tool, and make cancellation stop waiting promptly. (#13498) Thanks @onutc.
- Security/Gateway: default-deny missing connect `scopes` (no implicit `operator.admin`).
- Web UI: make chat refresh smoothly scroll to the latest messages and suppress new-messages badge flash during manual refresh.
- Web UI: coerce Form Editor values to schema types before `config.set` and `config.apply`, preventing numeric and boolean fields from being serialized as strings. (#13468) Thanks @mcaxtr.
- Tools/web_search: include provider-specific settings in the web search cache key, and pass `inlineCitations` for Grok. (#12419) Thanks @tmchow.
- Tools/web_search: fix Grok response parsing for xAI Responses API output blocks. (#13049) Thanks @ereid7.
- Tools/web_search: normalize direct Perplexity model IDs while keeping OpenRouter model IDs unchanged. (#12795) Thanks @cdorsey.
- Model failover: treat HTTP 400 errors as failover-eligible, enabling automatic model fallback. (#1879) Thanks @orenyomtov.
- Errors: prevent false positive context overflow detection when conversation mentions "context overflow" topic. (#2078) Thanks @sbking.
- Errors: avoid rewriting/swallowing normal assistant replies that mention error keywords by scoping `sanitizeUserFacingText` rewrites to error-context. (#12988) Thanks @Takhoffman.
- Config: re-hydrate state-dir `.env` during runtime config loads so `${VAR}` substitutions remain resolvable. (#12748) Thanks @rodrigouroz.
- Gateway: no more post-compaction amnesia; injected transcript writes now preserve Pi session `parentId` chain so agents can remember again. (#12283) Thanks @Takhoffman.
- Gateway: fix multi-agent sessions.usage discovery. (#11523) Thanks @Takhoffman.
- Agents: recover from context overflow caused by oversized tool results (pre-emptive capping + fallback truncation). (#11579) Thanks @tyler6204.
- Subagents/compaction: stabilize announce timing and preserve compaction metrics across retries. (#11664) Thanks @tyler6204.
- Subagents: report timeout-aborted runs as timed out instead of completed successfully in parent-session announcements. (#13996) Thanks @dario-github.
- Cron: share isolated announce flow and harden scheduling/delivery reliability. (#11641) Thanks @tyler6204.
- Cron tool: recover flat params when LLM omits the `job` wrapper for add requests. (#12124) Thanks @tyler6204.
- Gateway/CLI: when `gateway.bind=lan`, use a LAN IP for probe URLs and Control UI links. (#11448) Thanks @AnonO6.
- CLI: make `openclaw plugins list` output scannable by hoisting source roots and shortening bundled/global/workspace plugin paths.
- Hooks: fix bundled hooks broken since 2026.2.2 (tsdown migration). (#9295) Thanks @patrickshao.
- Security/Plugins: install plugin and hook dependencies with `--ignore-scripts` to prevent lifecycle script execution.
- Routing: refresh bindings per message by loading config at route resolution so binding changes apply without restart. (#11372) Thanks @juanpablodlc.
- Exec approvals: render forwarded commands in monospace for safer approval scanning. (#11937) Thanks @sebslight.
- Config: clamp `maxTokens` to `contextWindow` to prevent invalid model configs. (#5516) Thanks @lailoo.
- Thinking: allow xhigh for `github-copilot/gpt-5.2-codex` and `github-copilot/gpt-5.2`. (#11646) Thanks @LatencyTDH.
- Thinking: honor `/think off` for reasoning-capable models. (#9564) Thanks @liuy.
- Discord: support forum/media thread-create starter messages, wire `message thread create --message`, and harden routing. (#10062) Thanks @jarvis89757.
- Paths: structurally resolve `OPENCLAW_HOME`-derived home paths and fix Windows drive-letter handling in tool meta shortening. (#12125) Thanks @mcaxtr.
- Memory: set Voyage embeddings `input_type` for improved retrieval. (#10818) Thanks @mcinteerj.
- Memory: disable async batch embeddings by default for memory indexing (opt-in via `agents.defaults.memorySearch.remote.batch.enabled`). (#13069) Thanks @mcinteerj.
- Memory/QMD: reuse default model cache across agents instead of re-downloading per agent. (#12114) Thanks @tyler6204.
- Memory/QMD: run boot refresh in background by default, add configurable QMD maintenance timeouts, retry QMD after fallback failures, and scope QMD queries to OpenClaw-managed collections. (#9690, #9705, #10042) Thanks @vignesh07.
- Memory/QMD: initialize QMD backend on gateway startup so background update timers restart after process reloads. (#10797) Thanks @vignesh07.
- Config/Memory: auto-migrate legacy top-level `memorySearch` settings into `agents.defaults.memorySearch`. (#11278, #9143) Thanks @vignesh07.
- Memory/QMD: treat plain-text `No results found` output from QMD as an empty result instead of throwing invalid JSON errors. (#9824)
- Memory/QMD: add `memory.qmd.searchMode` to choose `query`, `search`, or `vsearch` recall mode. (#9967, #10084)
- Media understanding: recognize `.caf` audio attachments for transcription. (#10982) Thanks @succ985.
- State dir: honor `OPENCLAW_STATE_DIR` for default device identity and canvas storage paths. (#4824) Thanks @kossoy.
- Doctor/State dir: suppress repeated legacy migration warnings only for valid symlink mirrors, while keeping warnings for empty or invalid legacy trees. (#11709) Thanks @gumadeiras.
- Tests: harden flaky hotspots by removing timer sleeps, consolidating onboarding provider-auth coverage, and improving memory test realism. (#11598) Thanks @gumadeiras.
- macOS: honor Nix-managed defaults suite (`ai.openclaw.mac`) for nixMode to prevent onboarding from reappearing after bundle-id churn. (#12205) Thanks @joshp123.
- Matrix: add multi-account support via `channels.matrix.accounts`; use per-account config for dm policy, allowFrom, groups, and other settings; serialize account startup to avoid race condition. (#7286, #3165, #3085) Thanks @emonty.

## 2026.2.6

### Changes

- Cron: default `wakeMode` is now `"now"` for new jobs (was `"next-heartbeat"`). (#10776) Thanks @tyler6204.
- Cron: `cron run` defaults to force execution; use `--due` to restrict to due-only. (#10776) Thanks @tyler6204.
- Models: support Anthropic Opus 4.6 and OpenAI Codex gpt-5.3-codex (forward-compat fallbacks). (#9853, #10720, #9995) Thanks @TinyTb, @calvin-hpnet, @tyler6204.
- Providers: add xAI (Grok) support. (#9885) Thanks @grp06.
- Providers: add Baidu Qianfan support. (#8868) Thanks @ide-rea.
- Web UI: add token usage dashboard. (#10072) Thanks @Takhoffman.
- Web UI: add RTL auto-direction support for Hebrew/Arabic text in chat composer and rendered messages. (#11498) Thanks @dirbalak.
- Memory: native Voyage AI support. (#7078) Thanks @mcinteerj.
- Sessions: cap sessions_history payloads to reduce context overflow. (#10000) Thanks @gut-puncture.
- CLI: sort commands alphabetically in help output. (#8068) Thanks @deepsoumya617.
- CI: optimize pipeline throughput (macOS consolidation, Windows perf, workflow concurrency). (#10784) Thanks @mcaxtr.
- Agents: bump pi-mono to 0.52.7; add embedded forward-compat fallback for Opus 4.6 model ids.

### Added

- Cron: run history deep-links to session chat from the dashboard. (#10776) Thanks @tyler6204.
- Cron: per-run session keys in run log entries and default labels for cron sessions. (#10776) Thanks @tyler6204.
- Cron: legacy payload field compatibility (`deliver`, `channel`, `to`, `bestEffortDeliver`) in schema. (#10776) Thanks @tyler6204.

### Fixes

- TTS: add missing OpenAI voices (ballad, cedar, juniper, marin, verse) to the allowlist so they are recognized instead of silently falling back to Edge TTS. (#2393)
- Cron: scheduler reliability (timer drift, restart catch-up, lock contention, stale running markers). (#10776) Thanks @tyler6204.
- Cron: store migration hardening (legacy field migration, parse error handling, explicit delivery mode persistence). (#10776) Thanks @tyler6204.
- Memory: set Voyage embeddings `input_type` for improved retrieval. (#10818) Thanks @mcinteerj.
- Memory/QMD: run boot refresh in background by default, add configurable QMD maintenance timeouts, retry QMD after fallback failures, and scope QMD queries to OpenClaw-managed collections. (#9690, #9705, #10042) Thanks @vignesh07.
- Media understanding: recognize `.caf` audio attachments for transcription. (#10982) Thanks @succ985.
- Telegram: auto-inject DM topic threadId in message tool + subagent announce. (#7235) Thanks @Lukavyi.
- Security: require auth for Gateway canvas host and A2UI assets. (#9518) Thanks @coygeek.
- Cron: fix scheduling and reminder delivery regressions; harden next-run recompute + timer re-arming + legacy schedule fields. (#9733, #9823, #9948, #9932) Thanks @tyler6204, @pycckuu, @j2h4u, @fujiwara-tofu-shop.
- Update: harden Control UI asset handling in update flow. (#10146) Thanks @gumadeiras.
- Security: add skill/plugin code safety scanner; redact credentials from config.get gateway responses. (#9806, #9858) Thanks @abdelsfane.
- Exec approvals: coerce bare string allowlist entries to objects. (#9903) Thanks @mcaxtr.
- Slack: add mention stripPatterns for /new and /reset. (#9971) Thanks @ironbyte-rgb.
- Chrome extension: fix bundled path resolution. (#8914) Thanks @kelvinCB.
- Compaction/errors: allow multiple compaction retries on context overflow; show clear billing errors. (#8928, #8391) Thanks @Glucksberg.

## 2026.2.3

### Changes

- Telegram: remove last `@ts-nocheck` from `bot-handlers.ts`, use Grammy types directly, deduplicate `StickerMetadata`. Zero `@ts-nocheck` remaining in `src/telegram/`. (#9206)
- Telegram: remove `@ts-nocheck` from `bot-message.ts`, type deps via `Omit<BuildTelegramMessageContextParams>`, widen `allMedia` to `TelegramMediaRef[]`. (#9180)
- Telegram: remove `@ts-nocheck` from `bot.ts`, fix duplicate `bot.catch` error handler (Grammy overrides), remove dead reaction `message_thread_id` routing, harden sticker cache guard. (#9077)
- Onboarding: add Cloudflare AI Gateway provider setup and docs. (#7914) Thanks @roerohan.
- Onboarding: add Moonshot (.cn) auth choice and keep the China base URL when preserving defaults. (#7180) Thanks @waynelwz.
- Docs: clarify tmux send-keys for TUI by splitting text and Enter. (#7737) Thanks @Wangnov.
- Docs: mirror the landing page revamp for zh-CN (features, quickstart, docs directory, network model, credits). (#8994) Thanks @joshp123.
- Messages: add per-channel and per-account responsePrefix overrides across channels. (#9001) Thanks @mudrii.
- Cron: add announce delivery mode for isolated jobs (CLI + Control UI) and delivery mode config.
- Cron: default isolated jobs to announce delivery; accept ISO 8601 `schedule.at` in tool inputs.
- Cron: hard-migrate isolated jobs to announce/none delivery; drop legacy post-to-main/payload delivery fields and `atMs` inputs.
- Cron: delete one-shot jobs after success by default; add `--keep-after-run` for CLI.
- Cron: suppress messaging tools during announce delivery so summaries post consistently.
- Cron: avoid duplicate deliveries when isolated runs send messages directly.

### Fixes

- Control UI: add hardened fallback for asset resolution in global npm installs. (#4855) Thanks @anapivirtua.
- Update: remove dead restore control-ui step that failed on gitignored dist/ output.
- Update: avoid wiping prebuilt Control UI assets during dev auto-builds (`tsdown --no-clean`), run update doctor via `openclaw.mjs`, and auto-restore missing UI assets after doctor. (#10146) Thanks @gumadeiras.
- Models: add forward-compat fallback for `openai-codex/gpt-5.3-codex` when model registry hasn't discovered it yet. (#9989) Thanks @w1kke.
- Auto-reply/Docs: normalize `extra-high` (and spaced variants) to `xhigh` for Codex thinking levels, and align Codex 5.3 FAQ examples. (#9976) Thanks @slonce70.
- Compaction: remove orphaned `tool_result` messages during history pruning to prevent session corruption from aborted tool calls. (#9868, fixes #9769, #9724, #9672)
- Telegram: pass `parentPeer` for forum topic binding inheritance so group-level bindings apply to all topics within the group. (#9789, fixes #9545, #9351)
- CLI: pass `--disable-warning=ExperimentalWarning` as a Node CLI option when respawning (avoid disallowed `NODE_OPTIONS` usage; fixes npm pack). (#9691) Thanks @18-RAJAT.
- CLI: resolve bundled Chrome extension assets by walking up to the nearest assets directory; add resolver and clipboard tests. (#8914) Thanks @kelvinCB.
- Tests: stabilize Windows ACL coverage with deterministic os.userInfo mocking. (#9335) Thanks @M00N7682.
- Exec approvals: coerce bare string allowlist entries to objects to prevent allowlist corruption. (#9903, fixes #9790) Thanks @mcaxtr.
- Exec approvals: ensure two-phase approval registration/decision flow works reliably by validating `twoPhase` requests and exposing `waitDecision` as an approvals-scoped gateway method. (#3357, fixes #2402) Thanks @ramin-shirali.
- Heartbeat: allow explicit accountId routing for multi-account channels. (#8702) Thanks @lsh411.
- TUI/Gateway: handle non-streaming finals, refresh history for non-local chat runs, and avoid event gap warnings for targeted tool streams. (#8432) Thanks @gumadeiras.
- Shell completion: auto-detect and migrate slow dynamic patterns to cached files for faster terminal startup; add completion health checks to doctor/update/onboard.
- Telegram: honor session model overrides in inline model selection. (#8193) Thanks @gildo.
- Web UI: fix agent model selection saves for default/non-default agents and wrap long workspace paths. Thanks @Takhoffman.
- Web UI: resolve header logo path when `gateway.controlUi.basePath` is set. (#7178) Thanks @Yeom-JinHo.
- Web UI: apply button styling to the new-messages indicator.
- Onboarding: infer auth choice from non-interactive API key flags. (#8484) Thanks @f-trycua.
- Security: keep untrusted channel metadata out of system prompts (Slack/Discord). Thanks @KonstantinMirin.
- Security: enforce sandboxed media paths for message tool attachments. (#9182) Thanks @victormier.
- Security: require explicit credentials for gateway URL overrides to prevent credential leakage. (#8113) Thanks @victormier.
- Security: gate `whatsapp_login` tool to owner senders and default-deny non-owner contexts. (#8768) Thanks @victormier.
- Voice call: harden webhook verification with host allowlists/proxy trust and keep ngrok loopback bypass.
- Voice call: add regression coverage for anonymous inbound caller IDs with allowlist policy. (#8104) Thanks @victormier.
- Cron: accept epoch timestamps and 0ms durations in CLI `--at` parsing.
- Cron: reload store data when the store file is recreated or mtime changes.
- Cron: deliver announce runs directly, honor delivery mode, and respect wakeMode for summaries. (#8540) Thanks @tyler6204.
- Telegram: include forward_from_chat metadata in forwarded messages and harden cron delivery target checks. (#8392) Thanks @Glucksberg.
- macOS: fix cron payload summary rendering and ISO 8601 formatter concurrency safety.
- Discord: enforce DM allowlists for agent components (buttons/select menus), honoring pairing store approvals and tag matches. (#11254) Thanks @thedudeabidesai.

## 2026.2.2-3

### Fixes

- Update: ship legacy daemon-cli shim for pre-tsdown update imports (fixes daemon restart after npm update).

## 2026.2.2-2

### Changes

- Docs: promote BlueBubbles as the recommended iMessage integration; mark imsg channel as legacy. (#8415) Thanks @tyler6204.

### Fixes

- CLI status: resolve build-info from bundled dist output (fixes "unknown" commit in npm builds).

## 2026.2.2-1

### Fixes

- CLI status: fall back to build-info for version detection (fixes "unknown" in beta builds). Thanks @gumadeira.

## 2026.2.2

### Changes

- Feishu: add Feishu/Lark plugin support + docs. (#7313) Thanks @jiulingyun (openclaw-cn).
- Web UI: add Agents dashboard for managing agent files, tools, skills, models, channels, and cron jobs.
- Subagents: discourage direct messaging tool use unless a specific external recipient is requested.
- Memory: implement the opt-in QMD backend for workspace memory. (#3160) Thanks @vignesh07.
- Security: add healthcheck skill and bootstrap audit guidance. (#7641) Thanks @Takhoffman.
- Config: allow setting a default subagent thinking level via `agents.defaults.subagents.thinking` (and per-agent `agents.list[].subagents.thinking`). (#7372) Thanks @tyler6204.
- Docs: zh-CN translations seed + polish, pipeline guidance, nav/landing updates, and typo fixes. (#8202, #6995, #6619, #7242, #7303, #7415) Thanks @AaronWander, @taiyi747, @Explorer1092, @rendaoyuan, @joshp123, @lailoo.
- Docs: add zh-CN i18n guardrails to avoid editing generated translations. (#8416) Thanks @joshp123.

### Fixes

- Docs: finish renaming the QMD memory docs to reference the OpenClaw state dir.
- Onboarding: keep TUI flow exclusive (skip completion prompt + background Web UI seed).
- Onboarding: drop completion prompt now handled by install/update.
- TUI: block onboarding output while TUI is active and restore terminal state on exit.
- CLI: cache shell completion scripts in state dir and source cached files in profiles.
- Zsh completion: escape option descriptions to avoid invalid option errors.
- Agents: repair malformed tool calls and session transcripts. (#7473) Thanks @justinhuangcode.
- fix(agents): validate AbortSignal instances before calling AbortSignal.any() (#7277) (thanks @Elarwei001)
- fix(webchat): respect user scroll position during streaming and refresh (#7226) (thanks @marcomarandiz)
- Telegram: recover from grammY long-poll timed out errors. (#7466) Thanks @macmimi23.
- Media understanding: skip binary media from file text extraction. (#7475) Thanks @AlexZhangji.
- Security: enforce access-group gating for Slack slash commands when channel type lookup fails.
- Security: require validated shared-secret auth before skipping device identity on gateway connect. Thanks @simecek.
- Security: guard skill installer downloads with SSRF checks (block private/localhost URLs).
- Security/Gateway: require `operator.approvals` for in-chat `/approve` when invoked from gateway clients. Thanks @yueyueL.
- Security: harden Windows exec allowlist; block cmd.exe bypass via single &. Thanks @simecek.
- Discord: route autoThread replies to existing threads instead of the root channel. (#8302) Thanks @gavinbmoore, @thewilloftheshadow.
- Media understanding: apply SSRF guardrails to provider fetches; allow private baseUrl overrides explicitly.
- fix(voice-call): harden inbound allowlist; reject anonymous callers; require Telnyx publicKey for allowlist; token-gate Twilio media streams; cap webhook body size (thanks @simecek)
- fix(webchat): respect user scroll position during streaming and refresh (#7226) (thanks @marcomarandiz)
- Telegram: recover from grammY long-poll timed out errors. (#7466) Thanks @macmimi23.
- Agents: repair malformed tool calls and session transcripts. (#7473) Thanks @justinhuangcode.
- fix(agents): validate AbortSignal instances before calling AbortSignal.any() (#7277) (thanks @Elarwei001)
- Media understanding: skip binary media from file text extraction. (#7475) Thanks @AlexZhangji.
- Onboarding: keep TUI flow exclusive (skip completion prompt + background Web UI seed); completion prompt now handled by install/update.
- TUI: block onboarding output while TUI is active and restore terminal state on exit.
- CLI/Zsh completion: cache scripts in state dir and escape option descriptions to avoid invalid option errors.
- fix(ui): resolve Control UI asset path correctly.
- fix(ui): refresh agent files after external edits.
- Docs: finish renaming the QMD memory docs to reference the OpenClaw state dir.
- Tests: stub SSRF DNS pinning in web auto-reply + Gemini video coverage. (#6619) Thanks @joshp123.

## 2026.2.1

### Changes

- Docs: onboarding/install/i18n/exec-approvals/Control UI/exe.dev/cacheRetention updates + misc nav/typos. (#3050, #3461, #4064, #4675, #4729, #4763, #5003, #5402, #5446, #5474, #5663, #5689, #5694, #5967, #6270, #6300, #6311, #6416, #6487, #6550, #6789)
- Telegram: use shared pairing store. (#6127) Thanks @obviyus.
- Agents: add OpenRouter app attribution headers. Thanks @alexanderatallah.
- Agents: add system prompt safety guardrails. (#5445) Thanks @joshp123.
- Agents: update pi-ai to 0.50.9 and rename cacheControlTtl -> cacheRetention (with back-compat mapping).
- Agents: extend CreateAgentSessionOptions with systemPrompt/skills/contextFiles.
- Agents: add tool policy conformance snapshot (no runtime behavior change). (#6011)
- Auth: update MiniMax OAuth hint + portal auth note copy.
- Discord: inherit thread parent bindings for routing. (#3892) Thanks @aerolalit.
- Gateway: inject timestamps into agent and chat.send messages. (#3705) Thanks @conroywhitney, @CashWilliams.
- Gateway: require TLS 1.3 minimum for TLS listeners. (#5970) Thanks @loganaden.
- Web UI: refine chat layout + extend session active duration.
- CI: add formal conformance + alias consistency checks. (#5723, #5807)

### Fixes

- Security: guard remote media fetches with SSRF protections (block private/localhost, DNS pinning).
- Updates: clean stale global install rename dirs and extend gateway update timeouts to avoid npm ENOTEMPTY failures.
- Security/Plugins/Hooks: validate install paths and reject traversal-like names (prevents path traversal outside the state dir). Thanks @logicx24.
- Telegram: add download timeouts for file fetches. (#6914) Thanks @hclsys.
- Telegram: enforce thread specs for DM vs forum sends. (#6833) Thanks @obviyus.
- Streaming: flush block streaming on paragraph boundaries for newline chunking. (#7014)
- Streaming: stabilize partial streaming filters.
- Auto-reply: avoid referencing workspace files in /new greeting prompt. (#5706) Thanks @bravostation.
- Tools: align tool execute adapters/signatures (legacy + parameter order + arg normalization).
- Tools: treat "\*" tool allowlist entries as valid to avoid spurious unknown-entry warnings.
- Skills: update session-logs paths from .clawdbot to .openclaw. (#4502)
- Slack: harden media fetch limits and Slack file URL validation. (#6639) Thanks @davidiach.
- Lint: satisfy curly rule after import sorting. (#6310)
- Process: resolve Windows `spawn()` failures for npm-family CLIs by appending `.cmd` when needed. (#5815) Thanks @thejhinvirtuoso.
- Discord: resolve PluralKit proxied senders for allowlists and labels. (#5838) Thanks @thewilloftheshadow.
- Tlon: add timeout to SSE client fetch calls (CWE-400). (#5926)
- Memory search: L2-normalize local embedding vectors to fix semantic search. (#5332)
- Agents: align embedded runner + typings with pi-coding-agent API updates (pi 0.51.0).
- Agents: ensure OpenRouter attribution headers apply in the embedded runner.
- Agents: cap context window resolution for compaction safeguard. (#6187) Thanks @iamEvanYT.
- System prompt: resolve overrides and hint using session_status for current date/time. (#1897, #1928, #2108, #3677)
- Agents: fix Pi prompt template argument syntax. (#6543)
- Subagents: fix announce failover race (always emit lifecycle end; timeout=0 means no-timeout). (#6621)
- Teams: gate media auth retries.
- Telegram: restore draft streaming partials. (#5543) Thanks @obviyus.
- Onboarding: friendlier Windows onboarding message. (#6242) Thanks @shanselman.
- TUI: prevent crash when searching with digits in the model selector.
- Agents: wire before_tool_call plugin hook into tool execution. (#6570, #6660) Thanks @ryancnelson.
- Browser: secure Chrome extension relay CDP sessions.
- Docker: use container port for gateway command instead of host port. (#5110) Thanks @mise42.
- Docker: start gateway CMD by default for container deployments. (#6635) Thanks @kaizen403.
- fix(lobster): block arbitrary exec via lobsterPath/cwd injection (GHSA-4mhr-g7xj-cg8j). (#5335) Thanks @vignesh07.
- Security: sanitize WhatsApp accountId to prevent path traversal. (#4610)
- Security: restrict MEDIA path extraction to prevent LFI. (#4930)
- Security: validate message-tool filePath/path against sandbox root. (#6398)
- Security: block LD*/DYLD* env overrides for host exec. (#4896) Thanks @HassanFleyah.
- Security: harden web tool content wrapping + file parsing safeguards. (#4058) Thanks @VACInc.
- Security: enforce Twitch `allowFrom` allowlist gating (deny non-allowlisted senders). Thanks @MegaManSec.

## 2026.1.31

### Changes

- Docs: onboarding/install/i18n/exec-approvals/Control UI/exe.dev/cacheRetention updates + misc nav/typos. (#3050, #3461, #4064, #4675, #4729, #4763, #5003, #5402, #5446, #5474, #5663, #5689, #5694, #5967, #6270, #6300, #6311, #6416, #6487, #6550, #6789)
- Telegram: use shared pairing store. (#6127) Thanks @obviyus.
- Agents: add OpenRouter app attribution headers. Thanks @alexanderatallah.
- Agents: add system prompt safety guardrails. (#5445) Thanks @joshp123.
- Agents: update pi-ai to 0.50.9 and rename cacheControlTtl -> cacheRetention (with back-compat mapping).
- Agents: extend CreateAgentSessionOptions with systemPrompt/skills/contextFiles.
- Agents: add tool policy conformance snapshot (no runtime behavior change). (#6011)
- Auth: update MiniMax OAuth hint + portal auth note copy.
- Discord: inherit thread parent bindings for routing. (#3892) Thanks @aerolalit.
- Gateway: inject timestamps into agent and chat.send messages. (#3705) Thanks @conroywhitney, @CashWilliams.
- Gateway: require TLS 1.3 minimum for TLS listeners. (#5970) Thanks @loganaden.
- Web UI: refine chat layout + extend session active duration.
- CI: add formal conformance + alias consistency checks. (#5723, #5807)

### Fixes

- Security: guard remote media fetches with SSRF protections (block private/localhost, DNS pinning).
- Updates: clean stale global install rename dirs and extend gateway update timeouts to avoid npm ENOTEMPTY failures.
- Plugins: validate plugin/hook install paths and reject traversal-like names.
- Telegram: add download timeouts for file fetches. (#6914) Thanks @hclsys.
- Telegram: enforce thread specs for DM vs forum sends. (#6833) Thanks @obviyus.
- Streaming: flush block streaming on paragraph boundaries for newline chunking. (#7014)
- Streaming: stabilize partial streaming filters.
- Auto-reply: avoid referencing workspace files in /new greeting prompt. (#5706) Thanks @bravostation.
- Tools: align tool execute adapters/signatures (legacy + parameter order + arg normalization).
- Tools: treat `"*"` tool allowlist entries as valid to avoid spurious unknown-entry warnings.
- Skills: update session-logs paths from .clawdbot to .openclaw. (#4502)
- Slack: harden media fetch limits and Slack file URL validation. (#6639) Thanks @davidiach.
- Lint: satisfy curly rule after import sorting. (#6310)
- Process: resolve Windows `spawn()` failures for npm-family CLIs by appending `.cmd` when needed. (#5815) Thanks @thejhinvirtuoso.
- Discord: resolve PluralKit proxied senders for allowlists and labels. (#5838) Thanks @thewilloftheshadow.
- Tlon: add timeout to SSE client fetch calls (CWE-400). (#5926)
- Memory search: L2-normalize local embedding vectors to fix semantic search. (#5332)
- Agents: align embedded runner + typings with pi-coding-agent API updates (pi 0.51.0).
- Agents: ensure OpenRouter attribution headers apply in the embedded runner.
- Agents: cap context window resolution for compaction safeguard. (#6187) Thanks @iamEvanYT.
- System prompt: resolve overrides and hint using session_status for current date/time. (#1897, #1928, #2108, #3677)
- Agents: fix Pi prompt template argument syntax. (#6543)
- Subagents: fix announce failover race (always emit lifecycle end; timeout=0 means no-timeout). (#6621)
- Teams: gate media auth retries.
- Telegram: restore draft streaming partials. (#5543) Thanks @obviyus.
- Onboarding: friendlier Windows onboarding message. (#6242) Thanks @shanselman.
- TUI: prevent crash when searching with digits in the model selector.
- Agents: wire before_tool_call plugin hook into tool execution. (#6570, #6660) Thanks @ryancnelson.
- Browser: secure Chrome extension relay CDP sessions.
- Docker: use container port for gateway command instead of host port. (#5110) Thanks @mise42.
- Docker: start gateway CMD by default for container deployments. (#6635) Thanks @kaizen403.
- fix(lobster): block arbitrary exec via lobsterPath/cwd injection (GHSA-4mhr-g7xj-cg8j). (#5335) Thanks @vignesh07.
- Security: sanitize WhatsApp accountId to prevent path traversal. (#4610)
- Security: restrict MEDIA path extraction to prevent LFI. (#4930)
- Security: validate message-tool filePath/path against sandbox root. (#6398)
- Security: block LD*/DYLD* env overrides for host exec. (#4896) Thanks @HassanFleyah.
- Security: harden web tool content wrapping + file parsing safeguards. (#4058) Thanks @VACInc.
- Security: enforce Twitch `allowFrom` allowlist gating (deny non-allowlisted senders). Thanks @MegaManSec.

## 2026.1.30

### Changes

- CLI: add `completion` command (Zsh/Bash/PowerShell/Fish) and auto-setup during postinstall/onboarding.
- CLI: add per-agent `models status` (`--agent` filter). (#4780) Thanks @jlowin.
- Agents: add Kimi K2.5 to the synthetic model catalog. (#4407) Thanks @manikv12.
- Auth: switch Kimi Coding to built-in provider; normalize OAuth profile email.
- Auth: add MiniMax OAuth plugin + onboarding option. (#4521) Thanks @Maosghoul.
- Agents: update pi SDK/API usage and dependencies.
- Web UI: refresh sessions after chat commands and improve session display names.
- Build: move TypeScript builds to `tsdown` + `tsgo` (faster builds, CI typechecks), update tsconfig target, and clean up lint rules.
- Build: align npm tar override and bin metadata so the `openclaw` CLI entrypoint is preserved in npm publishes.
- Docs: add pi/pi-dev docs and update OpenClaw branding + install links.
- Docker E2E: stabilize gateway readiness, plugin installs/manifests, and cleanup/doctor switch entrypoint checks.

### Fixes

- Security: restrict local path extraction in media parser to prevent LFI. (#4880)
- Gateway: prevent token defaults from becoming the literal "undefined". (#4873) Thanks @Hisleren.
- Control UI: fix assets resolution for npm global installs. (#4909) Thanks @YuriNachos.
- macOS: avoid stderr pipe backpressure in gateway discovery. (#3304) Thanks @abhijeet117.
- Telegram: normalize account token lookup for non-normalized IDs. (#5055) Thanks @jasonsschin.
- Telegram: preserve delivery thread fallback and fix threadId handling in delivery context.
- Telegram: fix HTML nesting for overlapping styles/links. (#4578) Thanks @ThanhNguyxn.
- Telegram: accept numeric messageId/chatId in react actions. (#4533) Thanks @Ayush10.
- Telegram: honor per-account proxy dispatcher via undici fetch. (#4456) Thanks @spiceoogway.
- Telegram: scope skill commands to bound agent per bot. (#4360) Thanks @robhparker.
- BlueBubbles: debounce by messageId to preserve attachments in text+image messages. (#4984)
- Routing: prefer requesterOrigin over stale session entries for sub-agent announce delivery. (#4957)
- Extensions: restore embedded extension discovery typings.
- CLI: fix `tui:dev` port resolution.
- LINE: fix status command TypeError. (#4651)
- OAuth: skip expired-token warnings when refresh tokens are still valid. (#4593)
- Build: skip redundant UI install step in Dockerfile. (#4584) Thanks @obviyus.

## 2026.1.29

### Changes

- Rebrand: rename the npm package/CLI to `openclaw`, add a `openclaw` compatibility shim, and move extensions to the `@openclaw/*` scope.
- Onboarding: strengthen security warning copy for beta + access control expectations.
- Onboarding: add Venice API key to non-interactive flow. (#1893) Thanks @jonisjongithub.
- Config: auto-migrate legacy state/config paths and keep config resolution consistent across legacy filenames.
- Gateway: warn on hook tokens via query params; document header auth preference. (#2200) Thanks @YuriNachos.
- Gateway: add dangerous Control UI device auth bypass flag + audit warnings. (#2248)
- Doctor: warn on gateway exposure without auth. (#2016) Thanks @Alex-Alaniz.
- Web UI: keep sub-agent announce replies visible in WebChat. (#1977) Thanks @andrescardonas7.
- Browser: route browser control via gateway/node; remove standalone browser control command and control URL config.
- Browser: route `browser.request` via node proxies when available; honor proxy timeouts; derive browser ports from `gateway.port`.
- Browser: fall back to URL matching for extension relay target resolution. (#1999) Thanks @jonit-dev.
- Telegram: allow caption param for media sends. (#1888) Thanks @mguellsegarra.
- Telegram: support plugin sendPayload channelData (media/buttons) and validate plugin commands. (#1917) Thanks @JoshuaLelon.
- Telegram: avoid block replies when streaming is disabled. (#1885) Thanks @ivancasco.
- Telegram: add optional silent send flag (disable notifications). (#2382) Thanks @Suksham-sharma.
- Telegram: support editing sent messages via message(action="edit"). (#2394) Thanks @marcelomar21.
- Telegram: support quote replies for message tool and inbound context. (#2900) Thanks @aduk059.
- Telegram: add sticker receive/send with vision caching. (#2629) Thanks @longjos.
- Telegram: send sticker pixels to vision models. (#2650)
- Telegram: keep topic IDs in restart sentinel notifications. (#1807) Thanks @hsrvc.
- Discord: add configurable privileged gateway intents for presences/members. (#2266) Thanks @kentaro.
- Slack: clear ack reaction after streamed replies. (#2044) Thanks @fancyboi999.
- Matrix: switch plugin SDK to @vector-im/matrix-bot-sdk.
- Tlon: format thread reply IDs as @ud. (#1837) Thanks @wca4a.
- Tools: add per-sender group tool policies and fix precedence. (#1757) Thanks @adam91holt.
- Agents: summarize dropped messages during compaction safeguard pruning. (#2509) Thanks @jogi47.
- Agents: expand cron tool description with full schema docs. (#1988) Thanks @tomascupr.
- Agents: honor tools.exec.safeBins in exec allowlist checks. (#2281)
- Memory Search: allow extra paths for memory indexing (ignores symlinks). (#3600) Thanks @kira-ariaki.
- Skills: add multi-image input support to Nano Banana Pro skill. (#1958) Thanks @tyler6204.
- Skills: add missing dependency metadata for GitHub, Notion, Slack, Discord. (#1995) Thanks @jackheuberger.
- Commands: group /help and /commands output with Telegram paging. (#2504) Thanks @hougangdev.
- Routing: add per-account DM session scope and document multi-account isolation. (#3095) Thanks @jarvis-sam.
- Routing: precompile session key regexes. (#1697) Thanks @Ray0907.
- CLI: use Node's module compile cache for faster startup. (#2808) Thanks @pi0.
- Auth: show copyable Google auth URL after ASCII prompt. (#1787) Thanks @robbyczgw-cla.
- TUI: avoid width overflow when rendering selection lists. (#1686) Thanks @mossein.
- macOS: finish OpenClaw app rename for macOS sources, bundle identifiers, and shared kit paths. (#2844) Thanks @fal3.
- Branding: update launchd labels, mobile bundle IDs, and logging subsystems to bot.molt (legacy bundle ID migrations). Thanks @thewilloftheshadow.
- macOS: limit project-local `node_modules/.bin` PATH preference to debug builds (reduce PATH hijacking risk).
- macOS: keep custom SSH usernames in remote target. (#2046) Thanks @algal.
- macOS: avoid crash when rendering code blocks by bumping Textual to 0.3.1. (#2033) Thanks @garricn.
- Update: ignore dist/control-ui for dirty checks and restore after ui builds. (#1976) Thanks @Glucksberg.
- Build: bundle A2UI assets during build and stop tracking generated bundles. (#2455) Thanks @0oAstro.
- CI: increase Node heap size for macOS checks. (#1890) Thanks @realZachi.
- Config: apply config.env before ${VAR} substitution. (#1813) Thanks @spanishflu-est1918.
- Gateway: prefer newest session metadata when combining stores. (#1823) Thanks @emanuelst.
- Docs: tighten Fly private deployment steps. (#2289) Thanks @dguido.
- Docs: add migration guide for moving to a new machine. (#2381)
- Docs: add Northflank one-click deployment guide. (#2167) Thanks @AdeboyeDN.
- Docs: add Vercel AI Gateway to providers sidebar. (#1901) Thanks @jerilynzheng.
- Docs: add Render deployment guide. (#1975) Thanks @anurag.
- Docs: add Claude Max API Proxy guide. (#1875) Thanks @atalovesyou.
- Docs: add DigitalOcean deployment guide. (#1870) Thanks @0xJonHoldsCrypto.
- Docs: add Oracle Cloud (OCI) platform guide + cross-links. (#2333) Thanks @hirefrank.
- Docs: add Raspberry Pi install guide. (#1871) Thanks @0xJonHoldsCrypto.
- Docs: add GCP Compute Engine deployment guide. (#1848) Thanks @hougangdev.
- Docs: add LINE channel guide. Thanks @thewilloftheshadow.
- Docs: credit both contributors for Control UI refresh. (#1852) Thanks @EnzeD.
- Docs: keep docs header sticky so navbar stays visible while scrolling. (#2445) Thanks @chenyuan99.
- Docs: update exe.dev install instructions. (#https://github.com/openclaw/openclaw/pull/3047) Thanks @zackerthescar.

### Breaking

- **BREAKING:** Gateway auth mode "none" is removed; gateway now requires token/password (Tailscale Serve identity still allowed).

### Fixes

- Skills: update session-logs paths to use ~/.openclaw. (#4502) Thanks @bonald.
- Telegram: avoid silent empty replies by tracking normalization skips before fallback. (#3796)
- Mentions: honor mentionPatterns even when explicit mentions are present. (#3303) Thanks @HirokiKobayashi-R.
- Discord: restore username directory lookup in target resolution. (#3131) Thanks @bonald.
- Agents: align MiniMax base URL test expectation with default provider config. (#3131) Thanks @bonald.
- Agents: prevent retries on oversized image errors and surface size limits. (#2871) Thanks @Suksham-sharma.
- Agents: inherit provider baseUrl/api for inline models. (#2740) Thanks @lploc94.
- Memory Search: keep auto provider model defaults and only include remote when configured. (#2576) Thanks @papago2355.
- Telegram: include AccountId in native command context for multi-agent routing. (#2942) Thanks @Chloe-VP.
- Telegram: handle video note attachments in media extraction. (#2905) Thanks @mylukin.
- TTS: read OPENAI_TTS_BASE_URL at runtime instead of module load to honor config.env. (#3341) Thanks @hclsys.
- macOS: auto-scroll to bottom when sending a new message while scrolled up. (#2471) Thanks @kennyklee.
- Web UI: auto-expand the chat compose textarea while typing (with sensible max height). (#2950) Thanks @shivamraut101.
- Gateway: prevent crashes on transient network errors (fetch failures, timeouts, DNS). Added fatal error detection to only exit on truly critical errors. Fixes #2895, #2879, #2873. (#2980) Thanks @elliotsecops.
- Agents: guard channel tool listActions to avoid plugin crashes. (#2859) Thanks @mbelinky.
- Discord: stop resolveDiscordTarget from passing directory params into messaging target parsers. Fixes #3167. Thanks @thewilloftheshadow.
- Discord: avoid resolving bare channel names to user DMs when a username matches. Thanks @thewilloftheshadow.
- Discord: fix directory config type import for target resolution. Thanks @thewilloftheshadow.
- Providers: update MiniMax API endpoint and compatibility mode. (#3064) Thanks @hlbbbbbbb.
- Telegram: treat more network errors as recoverable in polling. (#3013) Thanks @ryancontent.
- Discord: resolve usernames to user IDs for outbound messages. (#2649) Thanks @nonggialiang.
- Providers: update Moonshot Kimi model references to kimi-k2.5. (#2762) Thanks @MarvinCui.
- Gateway: suppress AbortError and transient network errors in unhandled rejections. (#2451) Thanks @Glucksberg.
- TTS: keep /tts status replies on text-only commands and avoid duplicate block-stream audio. (#2451) Thanks @Glucksberg.
- Security: pin npm overrides to keep tar@7.5.4 for install toolchains.
- Security: properly test Windows ACL audit for config includes. (#2403) Thanks @dominicnunez.
- CLI: recognize versioned Node executables when parsing argv. (#2490) Thanks @David-Marsh-Photo.
- CLI: avoid prompting for gateway runtime under the spinner. (#2874)
- BlueBubbles: coalesce inbound URL link preview messages. (#1981) Thanks @tyler6204.
- Cron: allow payloads containing "heartbeat" in event filter. (#2219) Thanks @dwfinkelstein.
- CLI: avoid loading config for global help/version while registering plugin commands. (#2212) Thanks @dial481.
- Agents: include memory.md when bootstrapping memory context. (#2318) Thanks @czekaj.
- Agents: release session locks on process termination and cover more signals. (#2483) Thanks @janeexai.
- Agents: skip cooldowned providers during model failover. (#2143) Thanks @YiWang24.
- Telegram: harden polling + retry behavior for transient network errors and Node 22 transport issues. (#2420) Thanks @techboss.
- Telegram: ignore non-forum group message_thread_id while preserving DM thread sessions. (#2731) Thanks @dylanneve1.
- Telegram: wrap reasoning italics per line to avoid raw underscores. (#2181) Thanks @YuriNachos.
- Telegram: centralize API error logging for delivery and bot calls. (#2492) Thanks @altryne.
- Voice Call: enforce Twilio webhook signature verification for ngrok URLs; disable ngrok free tier bypass by default.
- Security: harden Tailscale Serve auth by validating identity via local tailscaled before trusting headers.
- Media: fix text attachment MIME misclassification with CSV/TSV inference and UTF-16 detection; add XML attribute escaping for file output. (#3628) Thanks @frankekn.
- Build: align memory-core peer dependency with lockfile.
- Security: add mDNS discovery mode with minimal default to reduce information disclosure. (#1882) Thanks @orlyjamie.
- Security: harden URL fetches with DNS pinning to reduce rebinding risk. Thanks Chris Zheng.
- Web UI: improve WebChat image paste previews and allow image-only sends. (#1925) Thanks @smartprogrammer93.
- Security: wrap external hook content by default with a per-hook opt-out. (#1827) Thanks @mertcicekci0.
- Gateway: default auth now fail-closed (token/password required; Tailscale Serve identity remains allowed).
- Gateway: treat loopback + non-local Host connections as remote unless trusted proxy headers are present.
- Onboarding: remove unsupported gateway auth "off" choice from onboarding/configure flows and CLI flags.

## 2026.1.24-3

### Fixes

- Slack: fix image downloads failing due to missing Authorization header on cross-origin redirects. (#1936) Thanks @sanderhelgesen.
- Gateway: harden reverse proxy handling for local-client detection and unauthenticated proxied connects. (#1795) Thanks @orlyjamie.
- Security audit: flag loopback Control UI with auth disabled as critical. (#1795) Thanks @orlyjamie.
- CLI: resume claude-cli sessions and stream CLI replies to TUI clients. (#1921) Thanks @rmorse.

## 2026.1.24-2

### Fixes

- Packaging: include dist/link-understanding output in npm tarball (fixes missing apply.js import on install).

## 2026.1.24-1

### Fixes

- Packaging: include dist/shared output in npm tarball (fixes missing reasoning-tags import on install).

## 2026.1.24

### Highlights

- Providers: Ollama discovery + docs; Venice guide upgrades + cross-links. (#1606) Thanks @abhaymundhara. https://docs.openclaw.ai/providers/ollama https://docs.openclaw.ai/providers/venice
- Channels: LINE plugin (Messaging API) with rich replies + quick replies. (#1630) Thanks @plum-dawg.
- TTS: Edge fallback (keyless) + `/tts` auto modes. (#1668, #1667) Thanks @steipete, @sebslight. https://docs.openclaw.ai/tts
- Exec approvals: approve in-chat via `/approve` across all channels (including plugins). (#1621) Thanks @czekaj. https://docs.openclaw.ai/tools/exec-approvals https://docs.openclaw.ai/tools/slash-commands
- Telegram: DM topics as separate sessions + outbound link preview toggle. (#1597, #1700) Thanks @rohannagpal, @zerone0x. https://docs.openclaw.ai/channels/telegram

### Changes

- Channels: add LINE plugin (Messaging API) with rich replies, quick replies, and plugin HTTP registry. (#1630) Thanks @plum-dawg.
- TTS: add Edge TTS provider fallback, defaulting to keyless Edge with MP3 retry on format failures. (#1668) Thanks @steipete. https://docs.openclaw.ai/tts
- TTS: add auto mode enum (off/always/inbound/tagged) with per-session `/tts` override. (#1667) Thanks @sebslight. https://docs.openclaw.ai/tts
- Telegram: treat DM topics as separate sessions and keep DM history limits stable with thread suffixes. (#1597) Thanks @rohannagpal.
- Telegram: add `channels.telegram.linkPreview` to toggle outbound link previews. (#1700) Thanks @zerone0x. https://docs.openclaw.ai/channels/telegram
- Web search: add Brave freshness filter parameter for time-scoped results. (#1688) Thanks @JonUleis. https://docs.openclaw.ai/tools/web
- UI: refresh Control UI dashboard design system (colors, icons, typography). (#1745, #1786) Thanks @EnzeD, @mousberg.
- Exec approvals: forward approval prompts to chat with `/approve` for all channels (including plugins). (#1621) Thanks @czekaj. https://docs.openclaw.ai/tools/exec-approvals https://docs.openclaw.ai/tools/slash-commands
- Gateway: expose config.patch in the gateway tool with safe partial updates + restart sentinel. (#1653) Thanks @Glucksberg.
- Diagnostics: add diagnostic flags for targeted debug logs (config + env override). https://docs.openclaw.ai/diagnostics/flags
- Docs: expand FAQ (migration, scheduling, concurrency, model recommendations, OpenAI subscription auth, Pi sizing, hackable install, docs SSL workaround).
- Docs: add verbose installer troubleshooting guidance.
- Docs: add macOS VM guide with local/hosted options + VPS/nodes guidance. (#1693) Thanks @f-trycua.
- Docs: add Bedrock EC2 instance role setup + IAM steps. (#1625) Thanks @sergical. https://docs.openclaw.ai/bedrock
- Docs: update Fly.io guide notes.
- Dev: add prek pre-commit hooks + dependabot config for weekly updates. (#1720) Thanks @dguido.

### Fixes

- Web UI: fix config/debug layout overflow, scrolling, and code block sizing. (#1715) Thanks @saipreetham589.
- Web UI: show Stop button during active runs, swap back to New session when idle. (#1664) Thanks @ndbroadbent.
- Web UI: clear stale disconnect banners on reconnect; allow form saves with unsupported schema paths but block missing schema. (#1707) Thanks @Glucksberg.
- Web UI: hide internal `message_id` hints in chat bubbles.
- Gateway: allow Control UI token-only auth to skip device pairing even when device identity is present (`gateway.controlUi.allowInsecureAuth`). (#1679) Thanks @steipete.
- Matrix: decrypt E2EE media attachments with preflight size guard. (#1744) Thanks @araa47.
- BlueBubbles: route phone-number targets to DMs, avoid leaking routing IDs, and auto-create missing DMs (Private API required). (#1751) Thanks @tyler6204. https://docs.openclaw.ai/channels/bluebubbles
- BlueBubbles: keep part-index GUIDs in reply tags when short IDs are missing.
- iMessage: normalize chat_id/chat_guid/chat_identifier prefixes case-insensitively and keep service-prefixed handles stable. (#1708) Thanks @aaronn.
- Signal: repair reaction sends (group/UUID targets + CLI author flags). (#1651) Thanks @vilkasdev.
- Signal: add configurable signal-cli startup timeout + external daemon mode docs. (#1677) https://docs.openclaw.ai/channels/signal
- Telegram: set fetch duplex="half" for uploads on Node 22 to avoid sendPhoto failures. (#1684) Thanks @commdata2338.
- Telegram: use wrapped fetch for long-polling on Node to normalize AbortSignal handling. (#1639)
- Telegram: honor per-account proxy for outbound API calls. (#1774) Thanks @radek-paclt.
- Telegram: fall back to text when voice notes are blocked by privacy settings. (#1725) Thanks @foeken.
- Voice Call: return stream TwiML for outbound conversation calls on initial Twilio webhook. (#1634)
- Voice Call: serialize Twilio TTS playback and cancel on barge-in to prevent overlap. (#1713) Thanks @dguido.
- Google Chat: tighten email allowlist matching, typing cleanup, media caps, and onboarding/docs/tests. (#1635) Thanks @iHildy.
- Google Chat: normalize space targets without double `spaces/` prefix.
- Agents: auto-compact on context overflow prompt errors before failing. (#1627) Thanks @rodrigouroz.
- Agents: use the active auth profile for auto-compaction recovery.
- Media understanding: skip image understanding when the primary model already supports vision. (#1747) Thanks @tyler6204.
- Models: default missing custom provider fields so minimal configs are accepted.
- Messaging: keep newline chunking safe for fenced markdown blocks across channels.
- Messaging: treat newline chunking as paragraph-aware (blank-line splits) to keep lists and headings together. (#1726) Thanks @tyler6204.
- TUI: reload history after gateway reconnect to restore session state. (#1663)
- Heartbeat: normalize target identifiers for consistent routing.
- Exec: keep approvals for elevated ask unless full mode. (#1616) Thanks @ivancasco.
- Exec: treat Windows platform labels as Windows for node shell selection. (#1760) Thanks @ymat19.
- Gateway: include inline config env vars in service install environments. (#1735) Thanks @Seredeep.
- Gateway: skip Tailscale DNS probing when tailscale.mode is off. (#1671)
- Gateway: reduce log noise for late invokes + remote node probes; debounce skills refresh. (#1607) Thanks @petter-b.
- Gateway: clarify Control UI/WebChat auth error hints for missing tokens. (#1690)
- Gateway: listen on IPv6 loopback when bound to 127.0.0.1 so localhost webhooks work.
- Gateway: store lock files in the temp directory to avoid stale locks on persistent volumes. (#1676)
- macOS: default direct-transport `ws://` URLs to port 18789; document `gateway.remote.transport`. (#1603) Thanks @ngutman.
- Tests: cap Vitest workers on CI macOS to reduce timeouts. (#1597) Thanks @rohannagpal.
- Tests: avoid fake-timer dependency in embedded runner stream mock to reduce CI flakes. (#1597) Thanks @rohannagpal.
- Tests: increase embedded runner ordering test timeout to reduce CI flakes. (#1597) Thanks @rohannagpal.

## 2026.1.23-1

### Fixes

- Packaging: include dist/tts output in npm tarball (fixes missing dist/tts/tts.js).

## 2026.1.23

### Highlights

- TTS: move Telegram TTS into core + enable model-driven TTS tags by default for expressive audio replies. (#1559) Thanks @Glucksberg. https://docs.openclaw.ai/tts
- Gateway: add `/tools/invoke` HTTP endpoint for direct tool calls (auth + tool policy enforced). (#1575) Thanks @vignesh07. https://docs.openclaw.ai/gateway/tools-invoke-http-api
- Heartbeat: per-channel visibility controls (OK/alerts/indicator). (#1452) Thanks @dlauer. https://docs.openclaw.ai/gateway/heartbeat
- Deploy: add Fly.io deployment support + guide. (#1570) https://docs.openclaw.ai/platforms/fly
- Channels: add Tlon/Urbit channel plugin (DMs, group mentions, thread replies). (#1544) Thanks @wca4a. https://docs.openclaw.ai/channels/tlon

### Changes

- Channels: allow per-group tool allow/deny policies across built-in + plugin channels. (#1546) Thanks @adam91holt. https://docs.openclaw.ai/multi-agent-sandbox-tools
- Agents: add Bedrock auto-discovery defaults + config overrides. (#1553) Thanks @fal3. https://docs.openclaw.ai/bedrock
- CLI: add `openclaw system` for system events + heartbeat controls; remove standalone `wake`. (commit 71203829d) https://docs.openclaw.ai/cli/system
- CLI: add live auth probes to `openclaw models status` for per-profile verification. (commit 40181afde) https://docs.openclaw.ai/cli/models
- CLI: restart the gateway by default after `openclaw update`; add `--no-restart` to skip it. (commit 2c85b1b40)
- Browser: add node-host proxy auto-routing for remote gateways (configurable per gateway/node). (commit c3cb26f7c)
- Plugins: add optional `llm-task` JSON-only tool for workflows. (#1498) Thanks @vignesh07. https://docs.openclaw.ai/tools/llm-task
- Markdown: add per-channel table conversion (bullets for Signal/WhatsApp, code blocks elsewhere). (#1495) Thanks @odysseus0.
- Agents: keep system prompt time zone-only and move current time to `session_status` for better cache hits. (commit 66eec295b)
- Agents: remove redundant bash tool alias from tool registration/display. (#1571) Thanks @Takhoffman.
- Docs: add cron vs heartbeat decision guide (with Lobster workflow notes). (#1533) Thanks @JustYannicc. https://docs.openclaw.ai/automation/cron-vs-heartbeat
- Docs: clarify HEARTBEAT.md empty file skips heartbeats, missing file still runs. (#1535) Thanks @JustYannicc. https://docs.openclaw.ai/gateway/heartbeat

### Fixes

- Sessions: accept non-UUID sessionIds for history/send/status while preserving agent scoping. (#1518)
- Heartbeat: accept plugin channel ids for heartbeat target validation + UI hints.
- Messaging/Sessions: mirror outbound sends into target session keys (threads + dmScope), create session entries on send, and normalize session key casing. (#1520, commit 4b6cdd1d3)
- Sessions: reject array-backed session stores to prevent silent wipes. (#1469)
- Gateway: compare Linux process start time to avoid PID recycling lock loops; keep locks unless stale. (#1572) Thanks @steipete.
- Gateway: accept null optional fields in exec approval requests. (#1511) Thanks @pvoo.
- Exec approvals: persist allowlist entry ids to keep macOS allowlist rows stable. (#1521) Thanks @ngutman.
- Exec: honor tools.exec ask/security defaults for elevated approvals (avoid unwanted prompts). (commit 5662a9cdf)
- Daemon: use platform PATH delimiters when building minimal service paths. (commit a4e57d3ac)
- Linux: include env-configured user bin roots in systemd PATH and align PATH audits. (#1512) Thanks @robbyczgw-cla.
- Tailscale: retry serve/funnel with sudo only for permission errors and keep original failure details. (#1551) Thanks @sweepies.
- Docker: update gateway command in docker-compose and Hetzner guide. (#1514)
- Agents: show tool error fallback when the last assistant turn only invoked tools (prevents silent stops). (commit 8ea8801d0)
- Agents: ignore IDENTITY.md template placeholders when parsing identity. (#1556)
- Agents: drop orphaned OpenAI Responses reasoning blocks on model switches. (#1562) Thanks @roshanasingh4.
- Agents: add CLI log hint to "agent failed before reply" messages. (#1550) Thanks @sweepies.
- Agents: warn and ignore tool allowlists that only reference unknown or unloaded plugin tools. (#1566)
- Agents: treat plugin-only tool allowlists as opt-ins; keep core tools enabled. (#1467)
- Agents: honor enqueue overrides for embedded runs to avoid queue deadlocks in tests. (commit 084002998)
- Slack: honor open groupPolicy for unlisted channels in message + slash gating. (#1563) Thanks @itsjaydesu.
- Discord: limit autoThread mention bypass to bot-owned threads; keep ack reactions mention-gated. (#1511) Thanks @pvoo.
- Discord: retry rate-limited allowlist resolution + command deploy to avoid gateway crashes. (commit f70ac0c7c)
- Mentions: ignore mentionPattern matches when another explicit mention is present in group chats (Slack/Discord/Telegram/WhatsApp). (commit d905ca0e0)
- Telegram: render markdown in media captions. (#1478)
- MS Teams: remove `.default` suffix from Graph scopes and Bot Framework probe scopes. (#1507, #1574) Thanks @Evizero.
- Browser: keep extension relay tabs controllable when the extension reuses a session id after switching tabs. (#1160)
- Voice wake: auto-save wake words on blur/submit across iOS/Android and align limits with macOS. (commit 69f645c66)
- UI: keep the Control UI sidebar visible while scrolling long pages. (#1515) Thanks @pookNast.
- UI: cache Control UI markdown rendering + memoize chat text extraction to reduce Safari typing jank. (commit d57cb2e1a)
- TUI: forward unknown slash commands, include Gateway commands in autocomplete, and render slash replies as system output. (commit 1af227b61, commit 8195497ce, commit 6fba598ea)
- CLI: auth probe output polish (table output, inline errors, reduced noise, and wrap fixes in `openclaw models status`). (commit da3f2b489, commit 00ae21bed, commit 31e59cd58, commit f7dc27f2d, commit 438e782f8, commit 886752217, commit aabe0bed3, commit 81535d512, commit c63144ab1)
- Media: only parse `MEDIA:` tags when they start the line to avoid stripping prose mentions. (#1206)
- Media: preserve PNG alpha when possible; fall back to JPEG when still over size cap. (#1491) Thanks @robbyczgw-cla.
- Skills: gate bird Homebrew install to macOS. (#1569) Thanks @bradleypriest.

## 2026.1.22

### Changes

- Highlight: Compaction safeguard now uses adaptive chunking, progressive fallback, and UI status + retries. (#1466) Thanks @dlauer.
- Providers: add Antigravity usage tracking to status output. (#1490) Thanks @patelhiren.
- Slack: add chat-type reply threading overrides via `replyToModeByChatType`. (#1442) Thanks @stefangalescu.
- BlueBubbles: add `asVoice` support for MP3/CAF voice memos in sendAttachment. (#1477, #1482) Thanks @Nicell.
- Onboarding: add hatch choice (TUI/Web/Later), token explainer, background dashboard seed on macOS, and showcase link.

### Fixes

- BlueBubbles: stop typing indicator on idle/no-reply. (#1439) Thanks @Nicell.
- Message tool: keep path/filePath as-is for send; hydrate buffers only for sendAttachment. (#1444) Thanks @hopyky.
- Auto-reply: only report a model switch when session state is available. (#1465) Thanks @robbyczgw-cla.
- Control UI: resolve local avatar URLs with basePath across injection + identity RPC. (#1457) Thanks @dlauer.
- Agents: sanitize assistant history text to strip tool-call markers. (#1456) Thanks @zerone0x.
- Discord: clarify Message Content Intent onboarding hint. (#1487) Thanks @kyleok.
- Gateway: stop the service before uninstalling and fail if it remains loaded.
- Agents: surface concrete API error details instead of generic AI service errors.
- Exec: fall back to non-PTY when PTY spawn fails (EBADF). (#1484)
- Exec approvals: allow per-segment allowlists for chained shell commands on gateway + node hosts. (#1458) Thanks @czekaj.
- Agents: make OpenAI sessions image-sanitize-only; gate tool-id/repair sanitization by provider.
- Doctor: honor CLAWDBOT_GATEWAY_TOKEN for auth checks and security audit token reuse. (#1448) Thanks @azade-c.
- Agents: make tool summaries more readable and only show optional params when set.
- Agents: honor SOUL.md guidance even when the file is nested or path-qualified. (#1434) Thanks @neooriginal.
- Matrix (plugin): persist m.direct for resolved DMs and harden room fallback. (#1436, #1486) Thanks @sibbl.
- CLI: prefer `~` for home paths in output.
- Mattermost (plugin): enforce pairing/allowlist gating, keep @username targets, and clarify plugin-only docs. (#1428) Thanks @damoahdominic.
- Agents: centralize transcript sanitization in the runner; keep <final> tags and error turns intact.
- Auth: skip auth profiles in cooldown during initial selection and rotation. (#1316) Thanks @odrobnik.
- Agents/TUI: honor user-pinned auth profiles during cooldown and preserve search picker ranking. (#1432) Thanks @tobiasbischoff.
- Docs: fix gog auth services example to include docs scope. (#1454) Thanks @zerone0x.
- Slack: reduce WebClient retries to avoid duplicate sends. (#1481)
- Slack: read thread replies for message reads when threadId is provided (replies-only). (#1450) Thanks @rodrigouroz.
- Discord: honor accountId across message actions and cron deliveries. (#1492) Thanks @svkozak.
- macOS: prefer linked channels in gateway summary to avoid false “not linked” status.
- macOS/tests: fix gateway summary lookup after guard unwrap; prevent browser opens during tests. (ECID-1483)

## 2026.1.21-2

### Fixes

- Control UI: ignore bootstrap identity placeholder text for avatar values and fall back to the default avatar. https://docs.openclaw.ai/cli/agents https://docs.openclaw.ai/web/control-ui
- Slack: remove deprecated `filetype` field from `files.uploadV2` to eliminate API warnings. (#1447)

## 2026.1.21

### Changes

- Highlight: Lobster optional plugin tool for typed workflows + approval gates. https://docs.openclaw.ai/tools/lobster
- Lobster: allow workflow file args via `argsJson` in the plugin tool. https://docs.openclaw.ai/tools/lobster
- Heartbeat: allow running heartbeats in an explicit session key. (#1256) Thanks @zknicker.
- CLI: default exec approvals to the local host, add gateway/node targeting flags, and show target details in allowlist output.
- CLI: exec approvals mutations render tables instead of raw JSON.
- Exec approvals: support wildcard agent allowlists (`*`) across all agents.
- Exec approvals: allowlist matches resolved binary paths only, add safe stdin-only bins, and tighten allowlist shell parsing.
- Nodes: expose node PATH in status/describe and bootstrap PATH for node-host execution.
- CLI: flatten node service commands under `openclaw node` and remove `service node` docs.
- CLI: move gateway service commands under `openclaw gateway` and add `gateway probe` for reachability.
- Sessions: add per-channel reset overrides via `session.resetByChannel`. (#1353) Thanks @cash-echo-bot.
- Agents: add identity avatar config support and Control UI avatar rendering. (#1329, #1424) Thanks @dlauer.
- UI: show per-session assistant identity in the Control UI. (#1420) Thanks @robbyczgw-cla.
- CLI: add `openclaw update wizard` for interactive channel selection and restart prompts. https://docs.openclaw.ai/cli/update
- Signal: add typing indicators and DM read receipts via signal-cli.
- MSTeams: add file uploads, adaptive cards, and attachment handling improvements. (#1410) Thanks @Evizero.
- Onboarding: remove the run setup-token auth option (paste setup-token or reuse CLI creds instead).
- Docs: add troubleshooting entry for gateway.mode blocking gateway start. https://docs.openclaw.ai/gateway/troubleshooting
- Docs: add /model allowlist troubleshooting note. (#1405)
- Docs: add per-message Gmail search example for gog. (#1220) Thanks @mbelinky.

### Breaking

- **BREAKING:** Control UI now rejects insecure HTTP without device identity by default. Use HTTPS (Tailscale Serve) or set `gateway.controlUi.allowInsecureAuth: true` to allow token-only auth. https://docs.openclaw.ai/web/control-ui#insecure-http
- **BREAKING:** Envelope and system event timestamps now default to host-local time (was UTC) so agents don’t have to constantly convert.

### Fixes

- Nodes/macOS: prompt on allowlist miss for node exec approvals, persist allowlist decisions, and flatten node invoke errors. (#1394) Thanks @ngutman.
- Gateway: keep auto bind loopback-first and add explicit tailnet binding to avoid Tailscale taking over local UI. (#1380)
- Memory: prevent CLI hangs by deferring vector probes, adding sqlite-vec/embedding timeouts, and showing sync progress early.
- Agents: enforce 9-char alphanumeric tool call ids for Mistral providers. (#1372) Thanks @zerone0x.
- Embedded runner: persist injected history images so attachments aren’t reloaded each turn. (#1374) Thanks @Nicell.
- Nodes tool: include agent/node/gateway context in tool failure logs to speed approval debugging.
- macOS: exec approvals now respect wildcard agent allowlists (`*`).
- macOS: allow SSH agent auth when no identity file is set. (#1384) Thanks @ameno-.
- Gateway: prevent multiple gateways from sharing the same config/state at once (singleton lock).
- UI: remove the chat stop button and keep the composer aligned to the bottom edge.
- Typing: start instant typing indicators at run start so DMs and mentions show immediately.
- Configure: restrict the model allowlist picker to OAuth-compatible Anthropic models and preselect Opus 4.5.
- Configure: seed model fallbacks from the allowlist selection when multiple models are chosen.
- Model picker: list the full catalog when no model allowlist is configured.
- Discord: honor wildcard channel configs via shared match helpers. (#1334) Thanks @pvoo.
- BlueBubbles: resolve short message IDs safely and expose full IDs in templates. (#1387) Thanks @tyler6204.
- Infra: preserve fetch helper methods when wrapping abort signals. (#1387)
- macOS: default distribution packaging to universal binaries. (#1396) Thanks @JustYannicc.

## 2026.1.20

### Changes

- Control UI: add copy-as-markdown with error feedback. (#1345) https://docs.openclaw.ai/web/control-ui
- Control UI: drop the legacy list view. (#1345) https://docs.openclaw.ai/web/control-ui
- TUI: add syntax highlighting for code blocks. (#1200) https://docs.openclaw.ai/tui
- TUI: session picker shows derived titles, fuzzy search, relative times, and last message preview. (#1271) https://docs.openclaw.ai/tui
- TUI: add a searchable model picker for quicker model selection. (#1198) https://docs.openclaw.ai/tui
- TUI: add input history (up/down) for submitted messages. (#1348) https://docs.openclaw.ai/tui
- ACP: add `openclaw acp` for IDE integrations. https://docs.openclaw.ai/cli/acp
- ACP: add `openclaw acp client` interactive harness for debugging. https://docs.openclaw.ai/cli/acp
- Skills: add download installs with OS-filtered options. https://docs.openclaw.ai/tools/skills
- Skills: add the local sherpa-onnx-tts skill. https://docs.openclaw.ai/tools/skills
- Memory: add hybrid BM25 + vector search (FTS5) with weighted merging and fallback. https://docs.openclaw.ai/concepts/memory
- Memory: add SQLite embedding cache to speed up reindexing and frequent updates. https://docs.openclaw.ai/concepts/memory
- Memory: add OpenAI batch indexing for embeddings when configured. https://docs.openclaw.ai/concepts/memory
- Memory: enable OpenAI batch indexing by default for OpenAI embeddings. https://docs.openclaw.ai/concepts/memory
- Memory: allow parallel OpenAI batch indexing jobs (default concurrency: 2). https://docs.openclaw.ai/concepts/memory
- Memory: render progress immediately, color batch statuses in verbose logs, and poll OpenAI batch status every 2s by default. https://docs.openclaw.ai/concepts/memory
- Memory: add `--verbose` logging for memory status + batch indexing details. https://docs.openclaw.ai/concepts/memory
- Memory: add native Gemini embeddings provider for memory search. (#1151) https://docs.openclaw.ai/concepts/memory
- Browser: allow config defaults for efficient snapshots in the tool/CLI. (#1336) https://docs.openclaw.ai/tools/browser
- Nostr: add the Nostr channel plugin with profile management + onboarding defaults. (#1323) https://docs.openclaw.ai/channels/nostr
- Matrix: migrate to matrix-bot-sdk with E2EE support, location handling, and group allowlist upgrades. (#1298) https://docs.openclaw.ai/channels/matrix
- Slack: add HTTP webhook mode via Bolt HTTP receiver. (#1143) https://docs.openclaw.ai/channels/slack
- Telegram: enrich forwarded-message context with normalized origin details + legacy fallback. (#1090) https://docs.openclaw.ai/channels/telegram
- Discord: fall back to `/skill` when native command limits are exceeded. (#1287)
- Discord: expose `/skill` globally. (#1287)
- Zalouser: add channel dock metadata, config schema, setup wiring, probe, and status issues. (#1219) https://docs.openclaw.ai/plugins/zalouser
- Plugins: require manifest-embedded config schemas with preflight validation warnings. (#1272) https://docs.openclaw.ai/plugins/manifest
- Plugins: move channel catalog metadata into plugin manifests. (#1290) https://docs.openclaw.ai/plugins/manifest
- Plugins: align Nextcloud Talk policy helpers with core patterns. (#1290) https://docs.openclaw.ai/plugins/manifest
- Plugins/UI: let channel plugin metadata drive UI labels/icons and cron channel options. (#1306) https://docs.openclaw.ai/web/control-ui
- Agents/UI: add agent avatar support in identity config, IDENTITY.md, and the Control UI. (#1329) https://docs.openclaw.ai/gateway/configuration
- Plugins: add plugin slots with a dedicated memory slot selector. https://docs.openclaw.ai/plugins/agent-tools
- Plugins: ship the bundled BlueBubbles channel plugin (disabled by default). https://docs.openclaw.ai/channels/bluebubbles
- Plugins: migrate bundled messaging extensions to the plugin SDK and resolve plugin-sdk imports in the loader.
- Plugins: migrate the Zalo plugin to the shared plugin SDK runtime. https://docs.openclaw.ai/channels/zalo
- Plugins: migrate the Zalo Personal plugin to the shared plugin SDK runtime. https://docs.openclaw.ai/plugins/zalouser
- Plugins: allow optional agent tools with explicit allowlists and add the plugin tool authoring guide. https://docs.openclaw.ai/plugins/agent-tools
- Plugins: auto-enable bundled channel/provider plugins when configuration is present.
- Plugins: sync plugin sources on channel switches and update npm-installed plugins during `openclaw update`.
- Plugins: share npm plugin update logic between `openclaw update` and `openclaw plugins update`.

- Gateway/API: add `/v1/responses` (OpenResponses) with item-based input + semantic streaming events. (#1229)
- Gateway/API: expand `/v1/responses` to support file/image inputs, tool_choice, usage, and output limits. (#1229)
- Usage: add `/usage cost` summaries and macOS menu cost charts. https://docs.openclaw.ai/reference/api-usage-costs
- Security: warn when <=300B models run without sandboxing while web tools are enabled. https://docs.openclaw.ai/cli/security
- Exec: add host/security/ask routing for gateway + node exec. https://docs.openclaw.ai/tools/exec
- Exec: add `/exec` directive for per-session exec defaults (host/security/ask/node). https://docs.openclaw.ai/tools/exec
- Exec approvals: migrate approvals to `~/.openclaw/exec-approvals.json` with per-agent allowlists + skill auto-allow toggle, and add approvals UI + node exec lifecycle events. https://docs.openclaw.ai/tools/exec-approvals
- Nodes: add headless node host (`openclaw node start`) for `system.run`/`system.which`. https://docs.openclaw.ai/cli/node
- Nodes: add node daemon service install/status/start/stop/restart. https://docs.openclaw.ai/cli/node
- Bridge: add `skills.bins` RPC to support node host auto-allow skill bins.
- Sessions: add daily reset policy with per-type overrides and idle windows (default 4am local), preserving legacy idle-only configs. (#1146) https://docs.openclaw.ai/concepts/session
- Sessions: allow `sessions_spawn` to override thinking level for sub-agent runs. https://docs.openclaw.ai/tools/subagents
- Channels: unify thread/topic allowlist matching + command/mention gating helpers across core providers. https://docs.openclaw.ai/concepts/groups
- Models: add Qwen Portal OAuth provider support. (#1120) https://docs.openclaw.ai/providers/qwen
- Onboarding: add allowlist prompts and username-to-id resolution across core and extension channels. https://docs.openclaw.ai/start/onboarding
- Docs: clarify allowlist input types and onboarding behavior for messaging channels. https://docs.openclaw.ai/start/onboarding
- Docs: refresh Android node discovery docs for the Gateway WS service type. https://docs.openclaw.ai/platforms/android
- Docs: surface Amazon Bedrock in provider lists and clarify Bedrock auth env vars. (#1289) https://docs.openclaw.ai/bedrock
- Docs: clarify WhatsApp voice notes. https://docs.openclaw.ai/channels/whatsapp
- Docs: clarify Windows WSL portproxy LAN access notes. https://docs.openclaw.ai/platforms/windows
- Docs: refresh bird skill install metadata and usage notes. (#1302) https://docs.openclaw.ai/tools/browser-login
- Agents: add local docs path resolution and include docs/mirror/source/community pointers in the system prompt.
- Agents: clarify node_modules read-only guidance in agent instructions.
- Config: stamp last-touched metadata on write and warn if the config is newer than the running build.
- macOS: hide usage section when usage is unavailable instead of showing provider errors.
- Android: migrate node transport to the Gateway WebSocket protocol with TLS pinning support + gateway discovery naming.
- Android: send structured payloads in node events/invokes and include user-agent metadata in gateway connects.
- Android: remove legacy bridge transport code now that nodes use the gateway protocol.
- Android: bump okhttp + dnsjava to satisfy lint dependency checks.
- Build: update workspace + core/plugin deps.
- Build: use tsgo for dev/watch builds by default (opt out with `OPENCLAW_TS_COMPILER=tsc`).
- Repo: remove the Peekaboo git submodule now that the SPM release is used.
- macOS: switch PeekabooBridge integration to the tagged Swift Package Manager release.
- macOS: stop syncing Peekaboo in postinstall.
- Swabble: use the tagged Commander Swift package release.

### Breaking

- **BREAKING:** Reject invalid/unknown config entries and refuse to start the gateway for safety. Run `openclaw doctor --fix` to repair, then update plugins (`openclaw plugins update`) if you use any.

### Fixes

- Discovery: shorten Bonjour DNS-SD service type to `_moltbot-gw._tcp` and update discovery clients/docs.
- Diagnostics: export OTLP logs, correct queue depth tracking, and document message-flow telemetry.
- Diagnostics: emit message-flow diagnostics across channels via shared dispatch. (#1244)
- Diagnostics: gate heartbeat/webhook logging. (#1244)
- Gateway: strip inbound envelope headers from chat history messages to keep clients clean.
- Gateway: clarify unauthorized handshake responses with token/password mismatch guidance.
- Gateway: allow mobile node client ids for iOS + Android handshake validation. (#1354)
- Gateway: clarify connect/validation errors for gateway params. (#1347)
- Gateway: preserve restart wake routing + thread replies across restarts. (#1337)
- Gateway: reschedule per-agent heartbeats on config hot reload without restarting the runner.
- Gateway: require authorized restarts for SIGUSR1 (restart/apply/update) so config gating can't be bypassed.
- Cron: auto-deliver isolated agent output to explicit targets without tool calls. (#1285)
- Agents: preserve subagent announce thread/topic routing + queued replies across channels. (#1241)
- Agents: propagate accountId into embedded runs so sub-agent announce routing honors the originating account. (#1058)
- Agents: avoid treating timeout errors with "aborted" messages as user aborts, so model fallback still runs. (#1137)
- Agents: sanitize oversized image payloads before send and surface image-dimension errors.
- Sessions: fall back to session labels when listing display names. (#1124)
- Compaction: include tool failure summaries in safeguard compaction to prevent retry loops. (#1084)
- Config: log invalid config issues once per run and keep invalid-config errors stackless.
- Config: allow Perplexity as a web_search provider in config validation. (#1230)
- Config: allow custom fields under `skills.entries.<name>.config` for skill credentials/config. (#1226)
- Doctor: clarify plugin auto-enable hint text in the startup banner.
- Doctor: canonicalize legacy session keys in session stores to prevent stale metadata. (#1169)
- Docs: make docs:list fail fast with a clear error if the docs directory is missing.
- Plugins: add Nextcloud Talk manifest for plugin config validation. (#1297)
- Plugins: surface plugin load/register/config errors in gateway logs with plugin/source context.
- CLI: preserve cron delivery settings when editing message payloads. (#1322)
- CLI: keep `openclaw logs` output resilient to broken pipes while preserving progress output.
- CLI: avoid duplicating --profile/--dev flags when formatting commands.
- CLI: centralize CLI command registration to keep fast-path routing and program wiring in sync. (#1207)
- CLI: keep banners on routed commands, restore config guarding outside fast-path routing, and tighten fast-path flag parsing while skipping console capture for extra speed. (#1195)
- CLI: skip runner rebuilds when dist is fresh. (#1231)
- CLI: add WSL2/systemd unavailable hints in daemon status/doctor output.
- Status: route native `/status` to the active agent so model selection reflects the correct profile. (#1301)
- Status: show both usage windows with reset hints when usage data is available. (#1101)
- UI: keep config form enums typed, preserve empty strings, protect sensitive defaults, and deepen config search. (#1315)
- UI: preserve ordered list numbering in chat markdown. (#1341)
- UI: allow Control UI to read gatewayUrl from URL params for remote WebSocket targets. (#1342)
- UI: prevent double-scroll in Control UI chat by locking chat layout to the viewport. (#1283)
- UI: enable shell mode for sync Windows spawns to avoid `pnpm ui:build` EINVAL. (#1212)
- TUI: keep thinking blocks ordered before content during streaming and isolate per-run assembly. (#1202)
- TUI: align custom editor initialization with the latest pi-tui API. (#1298)
- TUI: show generic empty-state text for searchable pickers. (#1201)
- TUI: highlight model search matches and stabilize search ordering.
- Configure: hide OpenRouter auto routing model from the model picker. (#1182)
- Memory: show total file counts + scan issues in `openclaw memory status`.
- Memory: fall back to non-batch embeddings after repeated batch failures.
- Memory: apply OpenAI batch defaults even without explicit remote config.
- Memory: index atomically so failed reindex preserves the previous memory database. (#1151)
- Memory: avoid sqlite-vec unique constraint failures when reindexing duplicate chunk ids. (#1151)
- Memory: retry transient 5xx errors (Cloudflare) during embedding indexing.
- Memory: parallelize embedding indexing with rate-limit retries.
- Memory: split overly long lines to keep embeddings under token limits.
- Memory: skip empty chunks to avoid invalid embedding inputs.
- Memory: split embedding batches to avoid OpenAI token limits during indexing.
- Memory: probe sqlite-vec availability in `openclaw memory status`.
- Exec approvals: enforce allowlist when ask is off.
- Exec approvals: prefer raw command for node approvals/events.
- Tools: show exec elevated flag before the command and keep it outside markdown in tool summaries.
- Tools: return a companion-app-required message when node exec is requested with no paired node.
- Tools: return a companion-app-required message when `system.run` is requested without a supporting node.
- Exec: default gateway/node exec security to allowlist when unset (sandbox stays deny).
- Exec: prefer bash when fish is default shell, falling back to sh if bash is missing. (#1297)
- Exec: merge login-shell PATH for host=gateway exec while keeping daemon PATH minimal. (#1304)
- Streaming: emit assistant deltas for OpenAI-compatible SSE chunks. (#1147)
- Discord: make resolve warnings avoid raw JSON payloads on rate limits.
- Discord: process message handlers in parallel across sessions to avoid event queue blocking. (#1295)
- Discord: stop reconnecting the gateway after aborts to prevent duplicate listeners.
- Discord: only emit slow listener warnings after 30s.
- Discord: inherit parent channel allowlists for thread slash commands and reactions. (#1123)
- Telegram: honor pairing allowlists for native slash commands.
- Telegram: preserve hidden text_link URLs by expanding entities in inbound text. (#1118)
- Slack: resolve Bolt import interop for Bun + Node. (#1191)
- Web search: infer Perplexity base URL from API key source (direct vs OpenRouter).
- Web fetch: harden SSRF protection with shared hostname checks and redirect limits. (#1346)
- Browser: register AI snapshot refs for act commands. (#1282)
- Voice call: include request query in Twilio webhook verification when publicUrl is set. (#864)
- Anthropic: default API prompt caching to 1h with configurable TTL override.
- Anthropic: ignore TTL for OAuth.
- Auth profiles: keep auto-pinned preference while allowing rotation on failover. (#1138)
- Auth profiles: user pins stay locked. (#1138)
- Model catalog: avoid caching import failures, log transient discovery errors, and keep partial results. (#1332)
- Tests: stabilize Windows gateway/CLI tests by skipping sidecars, normalizing argv, and extending timeouts.
- Tests: stabilize plugin SDK resolution and embedded agent timeouts.
- Windows: install gateway scheduled task as the current user.
- Windows: show friendly guidance instead of failing on access denied.
- macOS: load menu session previews asynchronously so items populate while the menu is open.
- macOS: use label colors for session preview text so previews render in menu subviews.
- macOS: suppress usage error text in the menubar cost view.
- macOS: Doctor repairs LaunchAgent bootstrap issues for Gateway + Node when listed but not loaded. (#1166)
- macOS: avoid touching launchd in Remote over SSH so quitting the app no longer disables the remote gateway. (#1105)
- macOS: bundle Textual resources in packaged app builds to avoid code block crashes. (#1006)
- Daemon: include HOME in service environments to avoid missing HOME errors. (#1214)

Thanks @AlexMikhalev, @CoreyH, @John-Rood, @KrauseFx, @MaudeBot, @Nachx639, @NicholaiVogel, @RyanLisse, @ThePickle31, @VACInc, @Whoaa512, @YuriNachos, @aaronveklabs, @abdaraxus, @alauppe, @ameno-, @artuskg, @austinm911, @bradleypriest, @cheeeee, @dougvk, @fogboots, @gnarco, @gumadeiras, @jdrhyne, @joelklabo, @longmaba, @mukhtharcm, @odysseus0, @oscargavin, @rhjoh, @sebslight, @sibbl, @sleontenko, @steipete, @suminhthanh, @thewilloftheshadow, @tyler6204, @vignesh07, @visionik, @ysqander, @zerone0x.

## 2026.1.16-2

### Changes

- CLI: stamp build commit into dist metadata so banners show the commit in npm installs.
- CLI: close memory manager after memory commands to avoid hanging processes. (#1127) — thanks @NicholasSpisak.

## 2026.1.16-1

### Highlights

- Hooks: add hooks system with bundled hooks, CLI tooling, and docs. (#1028) — thanks @ThomsenDrake. https://docs.openclaw.ai/hooks
- Media: add inbound media understanding (image/audio/video) with provider + CLI fallbacks. https://docs.openclaw.ai/nodes/media-understanding
- Plugins: add Zalo Personal plugin (`@openclaw/zalouser`) and unify channel directory for plugins. (#1032) — thanks @suminhthanh. https://docs.openclaw.ai/plugins/zalouser
- Models: add Vercel AI Gateway auth choice + onboarding updates. (#1016) — thanks @timolins. https://docs.openclaw.ai/providers/vercel-ai-gateway
- Sessions: add `session.identityLinks` for cross-platform DM session li nking. (#1033) — thanks @thewilloftheshadow. https://docs.openclaw.ai/concepts/session
- Web search: add `country`/`language` parameters (schema + Brave API) and docs. (#1046) — thanks @YuriNachos. https://docs.openclaw.ai/tools/web

### Breaking

- **BREAKING:** `openclaw message` and message tool now require `target` (dropping `to`/`channelId` for destinations). (#1034) — thanks @tobalsan.
- **BREAKING:** Channel auth now prefers config over env for Discord/Telegram/Matrix (env is fallback only). (#1040) — thanks @thewilloftheshadow.
- **BREAKING:** Drop legacy `chatType: "room"` support; use `chatType: "channel"`.
- **BREAKING:** remove legacy provider-specific target resolution fallbacks; target resolution is centralized with plugin hints + directory lookups.
- **BREAKING:** `openclaw hooks` is now `openclaw webhooks`; hooks live under `openclaw hooks`. https://docs.openclaw.ai/cli/webhooks
- **BREAKING:** `openclaw plugins install <path>` now copies into `~/.openclaw/extensions` (use `--link` to keep path-based loading).

### Changes

- Plugins: ship bundled plugins disabled by default and allow overrides by installed versions. (#1066) — thanks @ItzR3NO.
- Plugins: add bundled Antigravity + Gemini CLI OAuth + Copilot Proxy provider plugins. (#1066) — thanks @ItzR3NO.
- Tools: improve `web_fetch` extraction using Readability (with fallback).
- Tools: add Firecrawl fallback for `web_fetch` when configured.
- Tools: send Chrome-like headers by default for `web_fetch` to improve extraction on bot-sensitive sites.
- Tools: Firecrawl fallback now uses bot-circumvention + cache by default; remove basic HTML fallback when extraction fails.
- Tools: default `exec` exit notifications and auto-migrate legacy `tools.bash` to `tools.exec`.
- Tools: add `exec` PTY support for interactive sessions. https://docs.openclaw.ai/tools/exec
- Tools: add tmux-style `process send-keys` and bracketed paste helpers for PTY sessions.
- Tools: add `process submit` helper to send CR for PTY sessions.
- Tools: respond to PTY cursor position queries to unblock interactive TUIs.
- Tools: include tool outputs in verbose mode and expand verbose tool feedback.
- Skills: update coding-agent guidance to prefer PTY-enabled exec runs and simplify tmux usage.
- TUI: refresh session token counts after runs complete or fail. (#1079) — thanks @d-ploutarchos.
- Status: trim `/status` to current-provider usage only and drop the OAuth/token block.
- Directory: unify `openclaw directory` across channels and plugin channels.
- UI: allow deleting sessions from the Control UI.
- Memory: add sqlite-vec vector acceleration with CLI status details.
- Memory: add experimental session transcript indexing for memory_search (opt-in via memorySearch.experimental.sessionMemory + sources).
- Skills: add user-invocable skill commands and expanded skill command registration.
- Telegram: default reaction level to minimal and enable reaction notifications by default.
- Telegram: allow reply-chain messages to bypass mention gating in groups. (#1038) — thanks @adityashaw2.
- iMessage: add remote attachment support for VM/SSH deployments.
- Messages: refresh live directory cache results when resolving targets.
- Messages: mirror delivered outbound text/media into session transcripts. (#1031) — thanks @TSavo.
- Messages: avoid redundant sender envelopes for iMessage + Signal group chats. (#1080) — thanks @tyler6204.
- Media: normalize Deepgram audio upload bytes for fetch compatibility.
- Cron: isolated cron jobs now start a fresh session id on every run to prevent context buildup.
- Docs: add `/help` hub, Node/npm PATH guide, and expand directory CLI docs.
- Config: support env var substitution in config values. (#1044) — thanks @sebslight.
- Health: add per-agent session summaries and account-level health details, and allow selective probes. (#1047) — thanks @gumadeiras.
- Hooks: add hook pack installs (npm/path/zip/tar) with `openclaw.hooks` manifests and `openclaw hooks install/update`.
- Plugins: add zip installs and `--link` to avoid copying local paths.

### Fixes

- macOS: drain subprocess pipes before waiting to avoid deadlocks. (#1081) — thanks @thesash.
- Verbose: wrap tool summaries/output in markdown only for markdown-capable channels.
- Tools: include provider/session context in elevated exec denial errors.
- Tools: normalize exec tool alias naming in tool error logs.
- Logging: reuse shared ANSI stripping to keep console capture lint-clean.
- Logging: prefix nested agent output with session/run/channel context.
- Telegram: accept tg/group/telegram prefixes + topic targets for inline button validation. (#1072) — thanks @danielz1z.
- Telegram: split long captions into follow-up messages.
- Config: block startup on invalid config, preserve best-effort doctor config, and keep rolling config backups. (#1083) — thanks @mukhtharcm.
- Sub-agents: normalize announce delivery origin + queue bucketing by accountId to keep multi-account routing stable. (#1061, #1058) — thanks @adam91holt.
- Sessions: include deliveryContext in sessions.list and reuse normalized delivery routing for announce/restart fallbacks. (#1058)
- Sessions: propagate deliveryContext into last-route updates to keep account/channel routing stable. (#1058)
- Sessions: preserve overrides on `/new` reset.
- Memory: prevent unhandled rejections when watch/interval sync fails. (#1076) — thanks @roshanasingh4.
- Memory: avoid gateway crash when embeddings return 429/insufficient_quota (disable tool + surface error). (#1004)
- Gateway: honor explicit delivery targets without implicit accountId fallback; preserve lastAccountId for implicit routing.
- Gateway: avoid reusing last-to/accountId when the requested channel differs; sync deliveryContext with last route fields.
- Build: allow `@lydell/node-pty` builds on supported platforms.
- Repo: fix oxlint config filename and move ignore pattern into config. (#1064) — thanks @connorshea.
- Messages: `/stop` now hard-aborts queued followups and sub-agent runs; suppress zero-count stop notes.
- Messages: honor message tool channel when deduping sends.
- Messages: include sender labels for live group messages across channels, matching queued/history formatting. (#1059)
- Sessions: reset `compactionCount` on `/new` and `/reset`, and preserve `sessions.json` file mode (0600).
- Sessions: repair orphaned user turns before embedded prompts.
- Sessions: hard-stop `sessions.delete` cleanup.
- Channels: treat replies to the bot as implicit mentions across supported channels.
- Channels: normalize object-format capabilities in channel capability parsing.
- Security: default-deny slash/control commands unless a channel computed `CommandAuthorized` (fixes accidental “open” behavior), and ensure WhatsApp + Zalo plugin channels gate inline `/…` tokens correctly. https://docs.openclaw.ai/gateway/security
- Security: redact sensitive text in gateway WS logs.
- Tools: cap pending `exec` process output to avoid unbounded buffers.
- CLI: speed up `openclaw sandbox-explain` by avoiding heavy plugin imports when normalizing channel ids.
- Browser: remote profile tab operations prefer persistent Playwright and avoid silent HTTP fallbacks. (#1057) — thanks @mukhtharcm.
- Browser: remote profile tab ops follow-up: shared Playwright loader, Playwright-based focus, and more coverage (incl. opt-in live Browserless test). (follow-up to #1057) — thanks @mukhtharcm.
- Browser: refresh extension relay tab metadata after navigation so `/json/list` stays current. (#1073) — thanks @roshanasingh4.
- WhatsApp: scope self-chat response prefix; inject pending-only group history and clear after any processed message.
- WhatsApp: include `linked` field in `describeAccount`.
- Agents: drop unsigned Gemini tool calls and avoid JSON Schema `format` keyword collisions.
- Agents: hide the image tool when the primary model already supports images.
- Agents: avoid duplicate sends by replying with `NO_REPLY` after `message` tool sends.
- Auth: inherit/merge sub-agent auth profiles from the main agent.
- Gateway: resolve local auth for security probe and validate gateway token/password file modes. (#1011, #1022) — thanks @ivanrvpereira, @kkarimi.
- Signal/iMessage: bound transport readiness waits to 30s with periodic logging. (#1014) — thanks @Szpadel.
- iMessage: avoid RPC restart loops.
- OpenAI image-gen: handle URL + `b64_json` responses and remove deprecated `response_format` (use URL downloads).
- CLI: auto-update global installs when installed via a package manager.
- Routing: migrate legacy `accountID` bindings to `accountId` and remove legacy fallback lookups. (#1047) — thanks @gumadeiras.
- Discord: truncate skill command descriptions to 100 chars for slash command limits. (#1018) — thanks @evalexpr.
- Security: bump `tar` to 7.5.3.
- Models: align ZAI thinking toggles.
- iMessage/Signal: include sender metadata for non-queued group messages. (#1059)
- Discord: preserve whitespace when chunking long lines so message splits keep spacing intact.
- Skills: fix skills watcher ignored list typing (tsc).

## 2026.1.15

### Highlights

- Plugins: add provider auth registry + `openclaw models auth login` for plugin-driven OAuth/API key flows.
- Browser: improve remote CDP/Browserless support (auth passthrough, `wss` upgrade, timeouts, clearer errors).
- Heartbeat: per-agent configuration + 24h duplicate suppression. (#980) — thanks @voidserf.
- Security: audit warns on weak model tiers; app nodes store auth tokens encrypted (Keychain/SecurePrefs).

### Breaking

- **BREAKING:** iOS minimum version is now 18.0 to support Textual markdown rendering in native chat. (#702)
- **BREAKING:** Microsoft Teams is now a plugin; install `@openclaw/msteams` via `openclaw plugins install @openclaw/msteams`.
- **BREAKING:** Channel auth now prefers config over env for Discord/Telegram/Matrix (env is fallback only). (#1040) — thanks @thewilloftheshadow.

### Changes

- UI/Apps: move channel/config settings to schema-driven forms and rename Connections → Channels. (#1040) — thanks @thewilloftheshadow.
- CLI: set process titles to `openclaw-<command>` for clearer process listings.
- CLI/macOS: sync remote SSH target/identity to config and let `gateway status` auto-infer SSH targets (ssh-config aware).
- Telegram: scope inline buttons with allowlist default + callback gating in DMs/groups.
- Telegram: default reaction notifications to own.
- Tools: improve `web_fetch` extraction using Readability (with fallback).
- Heartbeat: tighten prompt guidance + suppress duplicate alerts for 24h. (#980) — thanks @voidserf.
- Repo: ignore local identity files to avoid accidental commits. (#1001) — thanks @gerardward2007.
- Sessions/Security: add `session.dmScope` for multi-user DM isolation and audit warnings. (#948) — thanks @Alphonse-arianee.
- Plugins: add provider auth registry + `openclaw models auth login` for plugin-driven OAuth/API key flows.
- Onboarding: switch channels setup to a single-select loop with per-channel actions and disabled hints in the picker.
- TUI: show provider/model labels for the active session and default model.
- Heartbeat: add per-agent heartbeat configuration and multi-agent docs example.
- UI: show gateway auth guidance + doc link on unauthorized Control UI connections.
- UI: add session deletion action in Control UI sessions list. (#1017) — thanks @Szpadel.
- Security: warn on weak model tiers (Haiku, below GPT-5, below Claude 4.5) in `openclaw security audit`.
- Apps: store node auth tokens encrypted (Keychain/SecurePrefs).
- Daemon: share profile/state-dir resolution across service helpers and honor `CLAWDBOT_STATE_DIR` for Windows task scripts.
- Docs: clarify multi-gateway rescue bot guidance. (#969) — thanks @bjesuiter.
- Agents: add Current Date & Time system prompt section with configurable time format (auto/12/24).
- Tools: normalize Slack/Discord message timestamps with `timestampMs`/`timestampUtc` while keeping raw provider fields.
- macOS: add `system.which` for prompt-free remote skill discovery (with gateway fallback to `system.run`).
- Docs: add Date & Time guide and update prompt/timezone configuration docs.
- Messages: debounce rapid inbound messages across channels with per-connector overrides. (#971) — thanks @juanpablodlc.
- Messages: allow media-only sends (CLI/tool) and show Telegram voice recording status for voice notes. (#957) — thanks @rdev.
- Auth/Status: keep auth profiles sticky per session (rotate on compaction/new), surface provider usage headers in `/status` and `openclaw models status`, and update docs.
- CLI: add `--json` output for `openclaw daemon` lifecycle/install commands.
- Memory: make `node-llama-cpp` an optional dependency (avoid Node 25 install failures) and improve local-embeddings fallback/errors.
- Browser: add `snapshot refs=aria` (Playwright aria-ref ids) for self-resolving refs across `snapshot` → `act`.
- Browser: `profile="chrome"` now defaults to host control and returns clearer “attach a tab” errors.
- Browser: prefer stable Chrome for auto-detect, with Brave/Edge fallbacks and updated docs. (#983) — thanks @cpojer.
- Browser: increase remote CDP reachability timeouts + add `remoteCdpTimeoutMs`/`remoteCdpHandshakeTimeoutMs`.
- Browser: preserve auth/query tokens for remote CDP endpoints and pass Basic auth for CDP HTTP/WS. (#895) — thanks @mukhtharcm.
- Telegram: add bidirectional reaction support with configurable notifications and agent guidance. (#964) — thanks @bohdanpodvirnyi.
- Telegram: allow custom commands in the bot menu (merged with native; conflicts ignored). (#860) — thanks @nachoiacovino.
- Discord: allow allowlisted guilds without channel lists to receive messages when `groupPolicy="allowlist"`. — thanks @thewilloftheshadow.
- Discord: allow emoji/sticker uploads + channel actions in config defaults. (#870) — thanks @JDIVE.

### Fixes

- Messages: make `/stop` clear queued followups and pending session lane work for a hard abort.
- Messages: make `/stop` abort active sub-agent runs spawned from the requester session and report how many were stopped.
- WhatsApp: report linked status consistently in channel status. (#1050) — thanks @YuriNachos.
- Sessions: keep per-session overrides when `/new` resets compaction counters. (#1050) — thanks @YuriNachos.
- Skills: allow OpenAI image-gen helper to handle URL or base64 responses. (#1050) — thanks @YuriNachos.
- WhatsApp: default response prefix only for self-chat, using identity name when set.
- Signal/iMessage: bound transport readiness waits to 30s with periodic logging. (#1014) — thanks @Szpadel.
- iMessage: treat missing `imsg rpc` support as fatal to avoid restart loops.
- Auth: merge main auth profiles into per-agent stores for sub-agents and document inheritance. (#1013) — thanks @marcmarg.
- Agents: avoid JSON Schema `format` collisions in tool params by renaming snapshot format fields. (#1013) — thanks @marcmarg.
- Fix: make `openclaw update` auto-update global installs when installed via a package manager.
- Fix: list model picker entries as provider/model pairs for explicit selection. (#970) — thanks @mcinteerj.
- Fix: align OpenAI image-gen defaults with DALL-E 3 standard quality and document output formats. (#880) — thanks @mkbehr.
- Fix: persist `gateway.mode=local` after selecting Local run mode in `openclaw configure`, even if no other sections are chosen.
- Daemon: fix profile-aware service label resolution (env-driven) and add coverage for launchd/systemd/schtasks. (#969) — thanks @bjesuiter.
- Agents: avoid false positives when logging unsupported Google tool schema keywords.
- Agents: skip Gemini history downgrades for google-antigravity to preserve tool calls. (#894) — thanks @mukhtharcm.
- Status: restore usage summary line for current provider when no OAuth profiles exist.
- Fix: guard model fallback against undefined provider/model values. (#954) — thanks @roshanasingh4.
- Fix: refactor session store updates, add chat.inject, and harden subagent cleanup flow. (#944) — thanks @tyler6204.
- Fix: clean up suspended CLI processes across backends. (#978) — thanks @Nachx639.
- Fix: support MiniMax coding plan usage responses with `model_remains`/`current_interval_*` payloads.
- Fix: honor message tool channel for duplicate suppression (prefer `NO_REPLY` after `message` tool sends). (#1053) — thanks @sashcatanzarite.
- Fix: suppress WhatsApp pairing replies for historical catch-up DMs on initial link. (#904)
- Browser: extension mode recovers when only one tab is attached (stale targetId fallback).
- Browser: fix `tab not found` for extension relay snapshots/actions when Playwright blocks `newCDPSession` (use the single available Page).
- Browser: upgrade `ws` → `wss` when remote CDP uses `https` (fixes Browserless handshake).
- Telegram: skip `message_thread_id=1` for General topic sends while keeping typing indicators. (#848) — thanks @azade-c.
- Fix: sanitize user-facing error text + strip `<final>` tags across reply pipelines. (#975) — thanks @ThomsenDrake.
- Fix: normalize pairing CLI aliases, allow extension channels, and harden Zalo webhook payload parsing. (#991) — thanks @longmaba.
- Fix: allow local Tailscale Serve hostnames without treating tailnet clients as direct. (#885) — thanks @oswalpalash.
- Fix: reset sessions after role-ordering conflicts to recover from consecutive user turns. (#998)

## 2026.1.14-1

### Highlights

- Web search: `web_search`/`web_fetch` tools (Brave API) + first-time setup in onboarding/configure.
- Browser control: Chrome extension relay takeover mode + remote browser control support.
- Plugins: channel plugins (gateway HTTP hooks) + Zalo plugin + onboarding install flow. (#854) — thanks @longmaba.
- Security: expanded `openclaw security audit` (+ `--fix`), detect-secrets CI scan, and a `SECURITY.md` reporting policy.

### Changes

- Docs: clarify per-agent auth stores, sandboxed skill binaries, and elevated semantics.
- Docs: add FAQ entries for missing provider auth after adding agents and Gemini thinking signature errors.
- Agents: add optional auth-profile copy prompt on `agents add` and improve auth error messaging.
- Security: expand `openclaw security audit` checks (model hygiene, config includes, plugin allowlists, exposure matrix) and extend `--fix` to tighten more sensitive state paths.
- Security: add `SECURITY.md` reporting policy.
- Channels: add Matrix plugin (external) with docs + onboarding hooks.
- Plugins: add Zalo channel plugin with gateway HTTP hooks and onboarding install prompt. (#854) — thanks @longmaba.
- Onboarding: add a security checkpoint prompt (docs link + sandboxing hint); require `--accept-risk` for `--non-interactive`.
- Docs: expand gateway security hardening guidance and incident response checklist.
- Docs: document DM history limits for channel DMs. (#883) — thanks @pkrmf.
- Security: add detect-secrets CI scan and baseline guidance. (#227) — thanks @Hyaxia.
- Tools: add `web_search`/`web_fetch` (Brave API), auto-enable `web_fetch` for sandboxed sessions, and remove the `brave-search` skill.
- CLI/Docs: add a web tools configure section for storing Brave API keys and update onboarding tips.
- Browser: add Chrome extension relay takeover mode (toolbar button), plus `openclaw browser extension install/path` and remote browser control (standalone server + token auth).

### Fixes

- Sessions: refactor session store updates to lock + mutate per-entry, add chat.inject, and harden subagent cleanup flow. (#944) — thanks @tyler6204.
- Browser: add tests for snapshot labels/efficient query params and labeled image responses.
- Google: downgrade unsigned thinking blocks before send to avoid missing signature errors.
- Doctor: avoid re-adding WhatsApp config when only legacy ack reactions are set. (#927, fixes #900) — thanks @grp06.
- Agents: scrub tuple `items` schemas for Gemini tool calls. (#926, fixes #746) — thanks @grp06.
- Agents: harden Antigravity Claude history/tool-call sanitization. (#968) — thanks @rdev.
- Agents: stabilize sub-agent announce status from runtime outcomes and normalize Result/Notes. (#835) — thanks @roshanasingh4.
- Embedded runner: suppress raw API error payloads from replies. (#924) — thanks @grp06.
- Auth: normalize Claude Code CLI profile mode to oauth and auto-migrate config. (#855) — thanks @sebslight.
- Daemon: clear persisted launchd disabled state before bootstrap (fixes `daemon install` after uninstall). (#849) — thanks @ndraiman.
- Logging: tolerate `EIO` from console writes to avoid gateway crashes. (#925, fixes #878) — thanks @grp06.
- Sandbox: restore `docker.binds` config validation for custom bind mounts. (#873) — thanks @akonyer.
- Sandbox: preserve configured PATH for `docker exec` so custom tools remain available. (#873) — thanks @akonyer.
- Slack: respect `channels.slack.requireMention` default when resolving channel mention gating. (#850) — thanks @evalexpr.
- Telegram: aggregate split inbound messages into one prompt (reduces “one reply per fragment”).
- Auto-reply: treat trailing `NO_REPLY` tokens as silent replies.
- Config: prevent partial config writes from clobbering unrelated settings (base hash guard + merge patch for connection saves).

## 2026.1.14

### Changes

- Usage: add MiniMax coding plan usage tracking.
- Auth: label Claude Code CLI auth options. (#915) — thanks @SeanZoR.
- Docs: standardize Claude Code CLI naming across docs and prompts. (follow-up to #915)
- Telegram: add message delete action in the message tool. (#903) — thanks @sleontenko.
- Config: add `channels.<provider>.configWrites` gating for channel-initiated config writes; migrate Slack channel IDs.

### Fixes

- Mac: pass auth token/password to dashboard URL for authenticated access. (#918) — thanks @rahthakor.
- UI: use application-defined WebSocket close code (browser compatibility). (#918) — thanks @rahthakor.
- TUI: render picker overlays via the overlay stack so /models and /settings display. (#921) — thanks @grizzdank.
- TUI: add a bright spinner + elapsed time in the status line for send/stream/run states.
- TUI: show LLM error messages (rate limits, auth, etc.) instead of `(no output)`.
- Gateway/Dev: ensure `pnpm gateway:dev` always uses the dev profile config + state (`~/.openclaw-dev`).

#### Agents / Auth / Tools / Sandbox

- Agents: make user time zone and 24-hour time explicit in the system prompt. (#859) — thanks @CashWilliams.
- Agents: strip downgraded tool call text without eating adjacent replies and filter thinking-tag leaks. (#905) — thanks @erikpr1994.
- Agents: cap tool call IDs for OpenAI/OpenRouter to avoid request rejections. (#875) — thanks @j1philli.
- Agents: scrub tuple `items` schemas for Gemini tool calls. (#926, fixes #746) — thanks @grp06.
- Agents: stabilize sub-agent announce status from runtime outcomes and normalize Result/Notes. (#835) — thanks @roshanasingh4.
- Auth: normalize Claude Code CLI profile mode to oauth and auto-migrate config. (#855) — thanks @sebslight.
- Embedded runner: suppress raw API error payloads from replies. (#924) — thanks @grp06.
- Logging: tolerate `EIO` from console writes to avoid gateway crashes. (#925, fixes #878) — thanks @grp06.
- Sandbox: restore `docker.binds` config validation and preserve configured PATH for `docker exec`. (#873) — thanks @akonyer.
- Google: downgrade unsigned thinking blocks before send to avoid missing signature errors.

#### macOS / Apps

- macOS: ensure launchd log directory exists with a test-only override. (#909) — thanks @roshanasingh4.
- macOS: format ConnectionsStore config to satisfy SwiftFormat lint. (#852) — thanks @mneves75.
- macOS: pass auth token/password to dashboard URL for authenticated access. (#918) — thanks @rahthakor.
- macOS: reuse launchd gateway auth and skip wizard when gateway config already exists. (#917)
- macOS: prefer the default bridge tunnel port in remote mode for node bridge connectivity; document macOS remote control + bridge tunnels. (#960, fixes #865) — thanks @kkarimi.
- Apps: use canonical main session keys from gateway defaults across macOS/iOS/Android to avoid creating bare `main` sessions.
- macOS: fix cron preview/testing payload to use `channel` key. (#867) — thanks @wes-davis.
- Telegram: honor `channels.telegram.timeoutSeconds` for grammY API requests. (#863) — thanks @Snaver.
- Telegram: split long captions into media + follow-up text messages. (#907) - thanks @jalehman.
- Telegram: migrate group config when supergroups change chat IDs. (#906) — thanks @sleontenko.
- Messaging: unify markdown formatting + format-first chunking for Slack/Telegram/Signal. (#920) — thanks @TheSethRose.
- Slack: drop Socket Mode events with mismatched `api_app_id`/`team_id`. (#889) — thanks @roshanasingh4.
- Discord: isolate autoThread thread context. (#856) — thanks @davidguttman.
- WhatsApp: fix context isolation using wrong ID (was bot's number, now conversation ID). (#911) — thanks @tristanmanchester.
- WhatsApp: normalize user JIDs with device suffix for allowlist checks in groups. (#838) — thanks @peschee.

## 2026.1.13

### Fixes

- Postinstall: treat already-applied pnpm patches as no-ops to avoid npm/bun install failures.
- Packaging: pin `@mariozechner/pi-ai` to 0.45.7 and refresh patched dependency to match npm resolution.

## 2026.1.12-2

### Fixes

- Packaging: include `dist/memory/**` in the npm tarball (fixes `ERR_MODULE_NOT_FOUND` for `dist/memory/index.js`).
- Agents: persist sub-agent registry across gateway restarts and resume announce flow safely. (#831) — thanks @roshanasingh4.
- Agents: strip invalid Gemini thought signatures from OpenRouter history to avoid 400s. (#841, #845) — thanks @MatthieuBizien.

## 2026.1.12-1

### Fixes

- Packaging: include `dist/channels/**` in the npm tarball (fixes `ERR_MODULE_NOT_FOUND` for `dist/channels/registry.js`).

## 2026.1.12

### Highlights

- **BREAKING:** rename chat “providers” (Slack/Telegram/WhatsApp/…) to **channels** across CLI/RPC/config; legacy config keys auto-migrate on load (and are written back as `channels.*`).
- Memory: add vector search for agent memories (Markdown-only) with SQLite index, chunking, lazy sync + file watch, and per-agent enablement/fallback.
- Plugins: restore full voice-call plugin parity (Telnyx/Twilio, streaming, inbound policies, tools/CLI).
- Models: add Synthetic provider plus Moonshot Kimi K2 0905 + turbo/thinking variants (with docs). (#811) — thanks @siraht; (#818) — thanks @mickahouan.
- Cron: one-shot schedules accept ISO timestamps (UTC) with optional delete-after-run; cron jobs can target a specific agent (CLI + macOS/Control UI).
- Agents: add compaction mode config with optional safeguard summarization and per-agent model fallbacks. (#700) — thanks @thewilloftheshadow; (#583) — thanks @mitschabaude-bot.

### New & Improved

- Memory: add custom OpenAI-compatible embedding endpoints; support OpenAI/local `node-llama-cpp` embeddings with per-agent overrides and provider metadata in tools/CLI. (#819) — thanks @mukhtharcm.
- Memory: new `openclaw memory` CLI plus `memory_search`/`memory_get` tools with snippets + line ranges; index stored under `~/.openclaw/memory/{agentId}.sqlite` with watch-on-by-default.
- Agents: strengthen memory recall guidance; make workspace bootstrap truncation configurable (default 20k) with warnings; add default sub-agent model config.
- Tools/Sandbox: add tool profiles + group shorthands; support tool-policy groups in `tools.sandbox.tools`; drop legacy `memory` shorthand; allow Docker bind mounts via `docker.binds`. (#790) — thanks @akonyer.
- Tools: add provider/model-specific tool policy overrides (`tools.byProvider`) to trim tool exposure per provider.
- Tools: add browser `scrollintoview` action; allow Claude/Gemini tool param aliases; allow thinking `xhigh` for GPT-5.2/Codex with safe downgrades. (#793) — thanks @hsrvc; (#444) — thanks @grp06.
- Gateway/CLI: add Tailscale binary discovery, custom bind mode, and probe auth retry; add `openclaw dashboard` auto-open flow; default native slash commands to `"auto"` with per-provider overrides. (#740) — thanks @jeffersonwarrior.
- Auth/Onboarding: add Chutes OAuth (PKCE + refresh + onboarding choice); normalize API key inputs; default TUI onboarding to `deliver: false`. (#726) — thanks @FrieSei; (#791) — thanks @roshanasingh4.
- Providers: add `discord.allowBots`; trim legacy MiniMax M2 from default catalogs; route MiniMax vision to the Coding Plan VLM endpoint (also accepts `@/path/to/file.png` inputs). (#802) — thanks @zknicker.
- Gateway: allow Tailscale Serve identity headers to satisfy token auth; rebuild Control UI assets when protocol schema is newer. (#823) — thanks @roshanasingh4; (#786) — thanks @meaningfool.
- Heartbeat: default `ackMaxChars` to 300 so short `HEARTBEAT_OK` replies stay internal.

### Installer

- Install: run `openclaw doctor --non-interactive` after git installs/updates and nudge daemon restarts when detected.

### Fixes

- Doctor: warn on pnpm workspace mismatches, missing Control UI assets, and missing tsx binaries; offer UI rebuilds.
- Tools: apply global tool allow/deny even when agent-specific tool policy is set.
- Models/Providers: treat credential validation failures as auth errors to trigger fallback; normalize `${ENV_VAR}` apiKey values and auto-fill missing provider keys; preserve explicit GitHub Copilot provider config + agent-dir auth profiles. (#822) — thanks @sebslight; (#705) — thanks @TAGOOZ.
- Auth: drop invalid auth profiles from ordering so environment keys can still be used for providers like MiniMax.
- Gemini: normalize Gemini 3 ids to preview variants; strip Gemini CLI tool call/response ids; downgrade missing `thought_signature`; strip Claude `msg_*` thought_signature fields to avoid base64 decode errors. (#795) — thanks @thewilloftheshadow; (#783) — thanks @ananth-vardhan-cn; (#793) — thanks @hsrvc; (#805) — thanks @marcmarg.
- Agents: auto-recover from compaction context overflow by resetting the session and retrying; propagate overflow details from embedded runs so callers can recover.
- MiniMax: strip malformed tool invocation XML; include `MiniMax-VL-01` in implicit provider for image pairing. (#809) — thanks @latitudeki5223.
- Onboarding/Auth: honor `CLAWDBOT_AGENT_DIR` / `PI_CODING_AGENT_DIR` when writing auth profiles (MiniMax). (#829) — thanks @roshanasingh4.
- Anthropic: handle `overloaded_error` with a friendly message and failover classification. (#832) — thanks @danielz1z.
- Anthropic: merge consecutive user turns (preserve newest metadata) before validation to avoid incorrect role errors. (#804) — thanks @ThomsenDrake.
- Messaging: enforce context isolation for message tool sends; keep typing indicators alive during tool execution. (#793) — thanks @hsrvc; (#450, #447) — thanks @thewilloftheshadow.
- Auto-reply: `/status` allowlist behavior, reasoning-tag enforcement on fallback, and system-event enqueueing for elevated/reasoning toggles. (#810) — thanks @mcinteerj.
- System events: include local timestamps when events are injected into prompts. (#245) — thanks @thewilloftheshadow.
- Auto-reply: resolve ambiguous `/model` matches; fix streaming block reply media handling; keep >300 char heartbeat replies instead of dropping.
- Discord/Slack: centralize reply-thread planning; fix autoThread routing + add per-channel autoThread; avoid duplicate listeners; keep reasoning italics intact; allow clearing channel parents via message tool. (#800, #807) — thanks @davidguttman; (#744) — thanks @thewilloftheshadow.
- Telegram: preserve forum topic thread ids, persist polling offsets, respect account bindings in webhook mode, and show typing indicator in General topics. (#727, #739) — thanks @thewilloftheshadow; (#821) — thanks @gumadeiras; (#779) — thanks @azade-c.
- Slack: accept slash commands with or without leading `/` for custom command configs. (#798) — thanks @thewilloftheshadow.
- Cron: persist disabled jobs correctly; accept `jobId` aliases for update/run/remove params. (#205, #252) — thanks @thewilloftheshadow.
- Gateway/CLI: honor `CLAWDBOT_LAUNCHD_LABEL` / `CLAWDBOT_SYSTEMD_UNIT` overrides; `agents.list` respects explicit config; reduce noisy loopback WS logs during tests; run `openclaw doctor --non-interactive` during updates. (#781) — thanks @ronyrus.
- Onboarding/Control UI: refuse invalid configs (run doctor first); quote Windows browser URLs for OAuth; keep chat scroll position unless the user is near the bottom. (#764) — thanks @mukhtharcm; (#794) — thanks @roshanasingh4; (#217) — thanks @thewilloftheshadow.
- Tools/UI: harden tool input schemas for strict providers; drop null-only union variants for Gemini schema cleanup; treat `maxChars: 0` as unlimited; keep TUI last streamed response instead of "(no output)". (#782) — thanks @AbhisekBasu1; (#796) — thanks @gabriel-trigo; (#747) — thanks @thewilloftheshadow.
- Connections UI: polish multi-account account cards. (#816) — thanks @steipete.

### Maintenance

- Dependencies: bump Pi packages to 0.45.3 and refresh patched pi-ai.
- Testing: update Vitest + browser-playwright to 4.0.17.
- Docs: add Amazon Bedrock provider notes and link from models/FAQ.

## 2026.1.11

### Highlights

- Plugins are now first-class: loader + CLI management, plus the new Voice Call plugin.
- Config: modular `$include` support for split config files. (#731) — thanks @pasogott.
- Agents/Pi: reserve compaction headroom so pre-compaction memory writes can run before auto-compaction.
- Agents: automatic pre-compaction memory flush turn to store durable memories before compaction.

### Changes

- CLI/Onboarding: simplify MiniMax auth choice to a single M2.1 option.
- CLI: configure section selection now loops until Continue.
- Docs: explain MiniMax vs MiniMax Lightning (speed vs cost) and restore LM Studio example.
- Docs: add Cerebras GLM 4.6/4.7 config example (OpenAI-compatible endpoint).
- Onboarding/CLI: group model/auth choice by provider and label Z.AI as GLM 4.7.
- Onboarding/Docs: add Moonshot AI (Kimi K2) auth choice + config example.
- CLI/Onboarding: prompt to reuse detected API keys for Moonshot/MiniMax/Z.AI/Gemini/Anthropic/OpenCode.
- Auto-reply: add compact `/model` picker (models + available providers) and show provider endpoints in `/model status`.
- Control UI: add Config tab model presets (MiniMax M2.1, GLM 4.7, Kimi) for one-click setup.
- Plugins: add extension loader (tools/RPC/CLI/services), discovery paths, and config schema + Control UI labels (uiHints).
- Plugins: add `openclaw plugins install` (path/tgz/npm), plus `list|info|enable|disable|doctor` UX.
- Plugins: voice-call plugin now real (Twilio/log), adds start/status RPC/CLI/tool + tests.
- Docs: add plugins doc + cross-links from tools/skills/gateway config.
- Docs: add beginner-friendly plugin quick start + expand Voice Call plugin docs.
- Tests: add Docker plugin loader + tgz-install smoke test.
- Tests: extend Docker plugin E2E to cover installing from local folders (`plugins.load.paths`) and `file:` npm specs.
- Tests: add coverage for pre-compaction memory flush settings.
- Tests: modernize live model smoke selection for current releases and enforce tools/images/thinking-high coverage. (#769) — thanks @steipete.
- Agents/Tools: add `apply_patch` tool for multi-file edits (experimental; gated by tools.exec.applyPatch; OpenAI-only).
- Agents/Tools: rename the bash tool to exec (config alias maintained). (#748) — thanks @myfunc.
- Agents: add pre-compaction memory flush config (`agents.defaults.compaction.*`) with a soft threshold + system prompt.
- Config: add `$include` directive for modular config files. (#731) — thanks @pasogott.
- Build: set pnpm minimum release age to 2880 minutes (2 days). (#718) — thanks @dan-dr.
- macOS: prompt to install the global `openclaw` CLI when missing in local mode; install via `openclaw.ai/install-cli.sh` (no onboarding) and use external launchd/CLI instead of the embedded gateway runtime.
- Docs: add gog calendar event color IDs from `gog calendar colors`. (#715) — thanks @mjrussell.
- Cron/CLI: add `--model` flag to cron add/edit commands. (#711) — thanks @mjrussell.
- Cron/CLI: trim model overrides on cron edits and document main-session guidance. (#711) — thanks @mjrussell.
- Skills: bundle `skill-creator` to guide creating and packaging skills.
- Providers: add per-DM history limit overrides (`dmHistoryLimit`) with provider-level config. (#728) — thanks @pkrmf.
- Discord: expose channel/category management actions in the message tool. (#730) — thanks @NicholasSpisak.
- Docs: rename README “macOS app” section to “Apps”. (#733) — thanks @AbhisekBasu1.
- Gateway: require `client.id` in WebSocket connect params; use `client.instanceId` for presence de-dupe; update docs/tests.
- macOS: remove the attach-only gateway setting; local mode now always manages launchd while still attaching to an existing gateway if present.

### Installer

- Postinstall: replace `git apply` with builtin JS patcher (works npm/pnpm/bun; no git dependency) plus regression tests.
- Postinstall: skip pnpm patch fallback when the new patcher is active.
- Installer tests: add root+non-root docker smokes, CI workflow to fetch openclaw.ai scripts and run install sh/cli with onboarding skipped.
- Installer UX: support `CLAWDBOT_NO_ONBOARD=1` for non-interactive installs; fix npm prefix on Linux and auto-install git.
- Installer UX: add `install.sh --help` with flags/env and git install hint.
- Installer UX: add `--install-method git|npm` and auto-detect source checkouts (prompt to update git checkout vs migrate to npm).

### Fixes

- Models/Onboarding: configure MiniMax (minimax.io) via Anthropic-compatible `/anthropic` endpoint by default (keep `minimax-api` as a legacy alias).
- Models: normalize Gemini 3 Pro/Flash IDs to preview names for live model lookups. (#769) — thanks @steipete.
- CLI: fix guardCancel typing for configure prompts. (#769) — thanks @steipete.
- Gateway/WebChat: include handshake validation details in the WebSocket close reason for easier debugging; preserve close codes.
- Gateway/Auth: send invalid connect responses before closing the handshake; stabilize invalid-connect auth test.
- Gateway: tighten gateway listener detection.
- Control UI: hide onboarding chat when configured and guard the mobile chat sidebar overlay.
- Auth: read Codex keychain credentials and make the lookup platform-aware.
- macOS/Release: avoid bundling dist artifacts in relay builds and generate appcasts from zip-only sources.
- Doctor: surface plugin diagnostics in the report.
- Plugins: treat `plugins.load.paths` directory entries as package roots when they contain `package.json` + `openclaw.extensions`; load plugin packages from config dirs; extract archives without system tar.
- Config: expand `~` in `CLAWDBOT_CONFIG_PATH` and common path-like config fields (including `plugins.load.paths`); guard invalid `$include` paths. (#731) — thanks @pasogott.
- Agents: stop pre-creating session transcripts so first user messages persist in JSONL history.
- Agents: skip pre-compaction memory flush when the session workspace is read-only.
- Auto-reply: ignore inline `/status` directives unless the message is directive-only.
- Auto-reply: align `/think` default display with model reasoning defaults. (#751) — thanks @gabriel-trigo.
- Auto-reply: flush block reply buffers on tool boundaries. (#750) — thanks @sebslight.
- Auto-reply: allow sender fallback for command authorization when `SenderId` is empty (WhatsApp self-chat). (#755) — thanks @juanpablodlc.
- Auto-reply: treat whitespace-only sender ids as missing for command authorization (WhatsApp self-chat). (#766) — thanks @steipete.
- Heartbeat: refresh prompt text for updated defaults.
- Agents/Tools: use PowerShell on Windows to capture system utility output. (#748) — thanks @myfunc.
- Docker: tolerate unset optional env vars in docker-setup.sh under strict mode. (#725) — thanks @petradonka.
- CLI/Update: preserve base environment when passing overrides to update subprocesses. (#713) — thanks @danielz1z.
- Agents: treat message tool errors as failures so fallback replies still send; require `to` + `message` for `action=send`. (#717) — thanks @theglove44.
- Agents: preserve reasoning items on tool-only turns.
- Agents/Subagents: wait for completion before announcing, align wait timeout with run timeout, and make announce prompts more emphatic.
- Agents: route subagent transcripts to the target agent sessions directory and add regression coverage. (#708) — thanks @xMikeMickelson.
- Agents/Tools: preserve action enums when flattening tool schemas. (#708) — thanks @xMikeMickelson.
- Gateway/Agents: canonicalize main session aliases for store writes and add regression coverage. (#709) — thanks @xMikeMickelson.
- Agents: reset sessions and retry when auto-compaction overflows instead of crashing the gateway.
- Providers/Telegram: normalize command mentions for consistent parsing. (#729) — thanks @obviyus.
- Providers: skip DM history limit handling for non-DM sessions. (#728) — thanks @pkrmf.
- Sandbox: fix non-main mode incorrectly sandboxing the main DM session and align `/status` runtime reporting with effective sandbox state.
- Sandbox/Gateway: treat `agent:<id>:main` as a main-session alias when `session.mainKey` is customized (backwards compatible).
- Auto-reply: fast-path allowlisted slash commands (inline `/help`/`/commands`/`/status`/`/whoami` stripped before model).

## 2026.1.10

### Highlights

- CLI: `openclaw status` now table-based + shows OS/update/gateway/daemon/agents/sessions; `status --all` adds a full read-only debug report (tables, log tails, Tailscale summary, and scan progress via OSC-9 + spinner).
- CLI Backends: add Codex CLI fallback with resume support (text output) and JSONL parsing for new runs, plus a live CLI resume probe.
- CLI: add `openclaw update` (safe-ish git checkout update) + `--update` shorthand. (#673) — thanks @fm1randa.
- Gateway: add OpenAI-compatible `/v1/chat/completions` HTTP endpoint (auth, SSE streaming, per-agent routing). (#680).

### Changes

- Onboarding/Models: add first-class Z.AI (GLM) auth choice (`zai-api-key`) + `--zai-api-key` flag.
- CLI/Onboarding: add OpenRouter API key auth option in configure/onboard. (#703) — thanks @mteam88.
- Agents: add human-delay pacing between block replies (modes: off/natural/custom, per-agent configurable). (#446) — thanks @tony-freedomology.
- Agents/Browser: add `browser.target` (sandbox/host/custom) with sandbox host-control gating via `agents.defaults.sandbox.browser.allowHostControl`, allowlists for custom control URLs/hosts/ports, and expand browser tool docs (remote control, profiles, internals).
- Onboarding/Models: add catalog-backed default model picker to onboarding + configure. (#611) — thanks @jonasjancarik.
- Agents/OpenCode Zen: update fallback models + defaults, keep legacy alias mappings. (#669) — thanks @magimetal.
- CLI: add `openclaw reset` and `openclaw uninstall` flows (interactive + non-interactive) plus docker cleanup smoke test.
- Providers: move provider wiring to a plugin architecture. (#661).
- Providers: unify group history context wrappers across providers with per-provider/per-account `historyLimit` overrides (fallback to `messages.groupChat.historyLimit`). Set `0` to disable. (#672).
- Gateway/Heartbeat: optionally deliver heartbeat `Reasoning:` output (`agents.defaults.heartbeat.includeReasoning`). (#690)
- Docker: allow optional home volume + extra bind mounts in `docker-setup.sh`. (#679) — thanks @gabriel-trigo.

### Fixes

- Auto-reply: suppress draft/typing streaming for `NO_REPLY` (silent system ops) so it doesn’t leak partial output.
- CLI/Status: expand tables to full terminal width; clarify provider setup vs runtime warnings; richer per-provider detail; token previews in `status` while keeping `status --all` redacted; add troubleshooting link footer; keep log tails pasteable; show gateway auth used when reachable; surface provider runtime errors (Signal/iMessage/Slack); harden `tailscale status --json` parsing; make `status --all` scan progress determinate; and replace the footer with a 3-line “Next steps” recommendation (share/debug/probe).
- CLI/Gateway: clarify that `openclaw gateway status` reports RPC health (connect + RPC) and shows RPC failures separately from connect failures.
- CLI/Update: gate progress spinner on stdout TTY and align clean-check step label. (#701) — thanks @bjesuiter.
- Telegram: add `/whoami` + `/id` commands to reveal sender id for allowlists; allow `@username` and prefixed ids in `allowFrom` prompts (with stability warning).
- Heartbeat: strip markup-wrapped `HEARTBEAT_OK` so acks don’t leak to external providers (e.g., Telegram).
- Control UI: stop auto-writing `telegram.groups["*"]` and warn/confirm before enabling wildcard groups.
- WhatsApp: send ack reactions only for handled messages and ignore legacy `messages.ackReaction` (doctor copies to `whatsapp.ackReaction`). (#629) — thanks @pasogott.
- Sandbox/Skills: mirror skills into sandbox workspaces for read-only mounts so SKILL.md stays accessible.
- Terminal/Table: ANSI-safe wrapping to prevent table clipping/color loss; add regression coverage.
- Docker: allow optional apt packages during image build and document the build arg. (#697) — thanks @gabriel-trigo.
- Gateway/Heartbeat: deliver reasoning even when the main heartbeat reply is `HEARTBEAT_OK`. (#694) — thanks @antons.
- Agents/Pi: inject config `temperature`/`maxTokens` into streaming without replacing the session streamFn; cover with live maxTokens probe. (#732) — thanks @peschee.
- macOS: clear unsigned launchd overrides on signed restarts and warn via doctor when attach-only/disable markers are set. (#695) — thanks @jeffersonwarrior.
- Agents: enforce single-writer session locks and drop orphan tool results to prevent tool-call ID failures (MiniMax/Anthropic-compatible APIs).
- Docs: make `openclaw status` the first diagnostic step, clarify `status --deep` behavior, and document `/whoami` + `/id`.
- Docs/Testing: clarify live tool+image probes and how to list your testable `provider/model` ids.
- Tests/Live: make gateway bash+read probes resilient to provider formatting while still validating real tool calls.
- WhatsApp: detect @lid mentions in groups using authDir reverse mapping + resolve self JID E.164 for mention gating. (#692) — thanks @peschee.
- Gateway/Auth: default to token auth on loopback during onboarding, add doctor token generation flow, and tighten audio transcription config to Whisper-only.
- Providers: dedupe inbound messages across providers to avoid duplicate LLM runs on redeliveries/reconnects. (#689) — thanks @adam91holt.
- Agents: strip `<thought>`/`<antthinking>` tags from hidden reasoning output and cover tag variants in tests. (#688) — thanks @theglove44.
- macOS: save model picker selections as normalized provider/model IDs and keep manual entries aligned. (#683) — thanks @benithors.
- Agents: recognize "usage limit" errors as rate limits for failover. (#687) — thanks @evalexpr.
- CLI: avoid success message when daemon restart is skipped. (#685) — thanks @carlulsoe.
- Commands: disable `/config` + `/debug` by default; gate via `commands.config`/`commands.debug` and hide from native registration/help output.
- Agents/System: clarify that sub-agents remain sandboxed and cannot use elevated host access.
- Gateway: disable the OpenAI-compatible `/v1/chat/completions` endpoint by default; enable via `gateway.http.endpoints.chatCompletions.enabled=true`.
- macOS: stabilize bridge tunnels, guard invoke senders on disconnect, and drain stdout/stderr to avoid deadlocks. (#676) — thanks @ngutman.
- Agents/System: clarify sandboxed runtime in system prompt and surface elevated availability when sandboxed.
- Auto-reply: prefer `RawBody` for command/directive parsing (WhatsApp + Discord) and prevent fallback runs from clobbering concurrent session updates. (#643) — thanks @mcinteerj.
- WhatsApp: fix group reactions by preserving message IDs and sender JIDs in history; normalize participant phone numbers to JIDs in outbound reactions. (#640) — thanks @mcinteerj.
- WhatsApp: expose group participant IDs to the model so reactions can target the right sender.
- Cron: `wakeMode: "now"` waits for heartbeat completion (and retries when the main lane is busy). (#666) — thanks @roshanasingh4.
- Agents/OpenAI: fix Responses tool-only → follow-up turn handling (avoid standalone `reasoning` items that trigger 400 “required following item”) and replay reasoning items in Responses/Codex Responses history for tool-call-only turns.
- Sandbox: add `openclaw sandbox explain` (effective policy inspector + fix-it keys); improve “sandbox jail” tool-policy/elevated errors with actionable config key paths; link to docs.
- Hooks/Gmail: keep Tailscale serve path at `/` while preserving the public path. (#668) — thanks @antons.
- Hooks/Gmail: allow Tailscale target URLs to preserve internal serve paths.
- Auth: update Claude Code keychain credentials in-place during refresh sync; share JSON file helpers; add CLI fallback coverage.
- Auth: throttle external CLI credential syncs (Claude/Codex), reduce Keychain reads, and skip sync when cached credentials are still fresh.
- CLI: respect `CLAWDBOT_STATE_DIR` for node pairing + voice wake settings storage. (#664) — thanks @azade-c.
- Onboarding/Gateway: persist non-interactive gateway token auth in config; add WS wizard + gateway tool-calling regression coverage.
- Gateway/Control UI: make `chat.send` non-blocking, wire Stop to `chat.abort`, and treat `/stop` as an out-of-band abort. (#653)
- Gateway/Control UI: allow `chat.abort` without `runId` (abort active runs), suppress post-abort chat streaming, and prune stuck chat runs. (#653)
- Gateway/Control UI: sniff image attachments for chat.send, drop non-images, and log mismatches. (#670) — thanks @cristip73.
- macOS: force `restart-mac.sh --sign` to require identities and keep bundled Node signed for relay verification. (#580) — thanks @jeffersonwarrior.
- Gateway/Agent: accept image attachments on `agent` (multimodal message) and add live gateway image probe (`CLAWDBOT_LIVE_GATEWAY_IMAGE_PROBE=1`).
- CLI: `openclaw sessions` now includes `elev:*` + `usage:*` flags in the table output.
- CLI/Pairing: accept positional provider for `pairing list|approve` (npm-run compatible); update docs/bot hints.
- Branding: normalize legacy casing/branding to “OpenClaw” (CLI, status, docs).
- Auto-reply: fix native `/model` not updating the actual chat session (Telegram/Slack/Discord). (#646)
- Doctor: offer to run `openclaw update` first on git installs (keeps doctor output aligned with latest).
- Doctor: avoid false legacy workspace warning when install dir is `~/openclaw`. (#660)
- iMessage: fix reasoning persistence across DMs; avoid partial/duplicate replies when reasoning is enabled. (#655) — thanks @antons.
- Models/Auth: allow MiniMax API configs without `models.providers.minimax.apiKey` (auth profiles / `MINIMAX_API_KEY`). (#656) — thanks @mneves75.
- Agents: avoid duplicate replies when the message tool sends. (#659) — thanks @mickahouan.
- Agents: harden Cloud Code Assist tool ID sanitization (toolUse/toolCall/toolResult) and scrub extra JSON Schema constraints. (#665) — thanks @sebslight.
- Agents: sanitize tool results + Cloud Code Assist tool IDs at context-build time (prevents mid-run strict-provider request rejects).
- Agents/Tools: resolve workspace-relative Read/Write/Edit paths; align bash default cwd. (#642) — thanks @mukhtharcm.
- Discord: include forwarded message snapshots in agent session context. (#667) — thanks @rubyrunsstuff.
- Telegram: add `telegram.draftChunk` to tune draft streaming chunking for `streamMode: "block"`. (#667) — thanks @rubyrunsstuff.
- Tests/Agents: add regression coverage for workspace tool path resolution and bash cwd defaults.
- iOS/Android: enable stricter concurrency/lint checks; fix Swift 6 strict concurrency issues + Android lint errors (ExifInterface, obsolete SDK check). (#662) — thanks @KristijanJovanovski.
- Auth: read Codex CLI keychain tokens on macOS before falling back to `~/.codex/auth.json`, preventing stale refresh tokens from breaking gateway live tests.
- Security/Exec approvals: reject shell command substitution (`$()` and backticks) inside double quotes to prevent exec allowlist bypass when exec allowlist mode is explicitly enabled (the default configuration does not use this mode). Thanks @simecek.
- iOS/macOS: share `AsyncTimeout`, require explicit `bridgeStableID` on connect, and harden tool display defaults (avoids missing-resource label fallbacks).
- Telegram: serialize media-group processing to avoid missed albums under load.
- Signal: handle `dataMessage.reaction` events (signal-cli SSE) to avoid broken attachment errors. (#637) — thanks @neist.
- Docs: showcase entries for ParentPay, R2 Upload, iOS TestFlight, and Oura Health. (#650) — thanks @henrino3.
- Agents: repair session transcripts by dropping duplicate tool results across the whole history (unblocks Anthropic-compatible APIs after retries).
- Tests/Live: reset the gateway session between model runs to avoid cross-provider transcript incompatibilities (notably OpenAI Responses reasoning replay rules).

## 2026.1.9

### Highlights

- Microsoft Teams provider: polling, attachments, outbound CLI send, per-channel policy.
- Models/Auth expansion: OpenCode Zen + MiniMax API onboarding; token auth profiles + auth order; OAuth health in doctor/status.
- CLI/Gateway UX: message subcommands, gateway discover/status/SSH, /config + /debug, sandbox CLI.
- Provider reliability sweep: WhatsApp contact cards/targets, Telegram audio-as-voice + streaming, Signal reactions, Slack threading, Discord stability.
- Auto-reply + status: block-streaming controls, reasoning handling, usage/cost reporting.
- Control UI/TUI: queued messages, session links, reasoning view, mobile polish, logs UX.

### Breaking

- CLI: `openclaw message` now subcommands (`message send|poll|...`) and requires `--provider` unless only one provider configured.
- Commands/Tools: `/restart` and gateway restart tool disabled by default; enable with `commands.restart=true`.

### New Features and Changes

- Models/Auth: OpenCode Zen onboarding (#623) — thanks @magimetal; MiniMax Anthropic-compatible API + hosted onboarding (#590, #495) — thanks @mneves75, @tobiasbischoff.
- Models/Auth: setup-token + token auth profiles; `openclaw models auth order {get,set,clear}`; per-agent auth candidates in `/model status`; OAuth expiry checks in doctor/status.
- Agent/System: claude-cli runner; `session_status` tool (and sandbox allow); adaptive context pruning default; system prompt messaging guidance + no auto self-update; eligible skills list injection; sub-agent context trimmed.
- Commands: `/commands` list; `/models` alias; `/usage` alias; `/debug` runtime overrides + effective config view; `/config` chat updates + `/config get`; `config --section`.
- CLI/Gateway: unified message tool + message subcommands; gateway discover (local + wide-area DNS-SD) with JSON/timeout; gateway status human-readable + JSON + SSH loopback; wide-area records include gatewayPort/sshPort/cliPath + tailnet DNS fallback.
- CLI UX: logs output modes (pretty/plain/JSONL) + colorized health/daemon output; global `--no-color`; lobster palette in onboarding/config.
- Dev ergonomics: gateway `--dev/--reset` + dev profile auto-config; C-3PO dev templates; dev gateway/TUI helper scripts.
- Sandbox/Workspace: sandbox list/recreate commands; sync skills into sandbox workspace; sandbox browser auto-start.
- Config/Onboarding: inline env vars; OpenAI API key flow to shared `~/.openclaw/.env`; Opus 4.5 default prompt for Anthropic auth; QuickStart auto-install gateway (Node-only) + provider picker tweaks + skip-systemd flags; TUI bootstrap prompt (`tui --message`); remove Bun runtime choice.
- Providers: Microsoft Teams provider (polling, attachments, outbound sends, requireMention, config reload/DM policy). (#404) — thanks @onutc
- Providers: WhatsApp broadcast groups for multi-agent replies (#547) — thanks @pasogott; inbound media size cap configurable (#505) — thanks @koala73; identity-based message prefixes (#578) — thanks @p6l-richard.
- Providers: Telegram inline keyboard buttons + callback payload routing (#491) — thanks @azade-c; cron topic delivery targets (#474/#478) — thanks @mitschabaude-bot, @nachoiacovino; `[[audio_as_voice]]` tag support (#490) — thanks @jarvis-medmatic.
- Providers: Signal reactions + notifications with allowlist support.
- Status/Usage: /status cost reporting + `/cost` lines; auth profile snippet; provider usage windows.
- Control UI: mobile responsiveness (#558) — thanks @carlulsoe; queued messages + Enter-to-send (#527) — thanks @YuriNachos; session links (#471) — thanks @HazAT; reasoning view; skill install feedback (#445) — thanks @pkrmf; chat layout refresh (#475) — thanks @rahthakor; docs link + new session button; drop explicit `ui:install`.
- TUI: agent picker + agents list RPC; improved status line.
- Doctor/Daemon: audit/repair flows, permissions checks, supervisor config audits; provider status probes + warnings for Discord intents and Telegram privacy; last activity timestamps; gateway restart guidance.
- Docs: Hetzner Docker VPS guide + cross-links (#556/#592) — thanks @Iamadig; Ansible guide (#545) — thanks @pasogott; provider troubleshooting index; hook parameter expansion (#532) — thanks @mcinteerj; model allowlist notes; OAuth deep dive; showcase refresh.
- Apps/Branding: refreshed iOS/Android/macOS icons (#521) — thanks @fishfisher.

### Fixes

- Packaging: include MS Teams send module in npm tarball.
- Sandbox/Browser: auto-start CDP endpoint; proxy CDP out of container for attachOnly; relax Bun fetch typing; align sandbox list output with config images.
- Agents/Runtime: gate heartbeat prompt to default sessions; /stop aborts between tool calls; require explicit system-event session keys; guard small context windows; fix model fallback stringification; sessions_spawn inherits provider; failover on billing/credits; respect auth cooldown ordering; restore Anthropic OAuth tool dispatch + tool-name bypass; avoid OpenAI invalid reasoning replay; harden Gmail hook model defaults.
- Agent history/schema: strip/skip empty assistant/error blocks to prevent session corruption/Claude 400s; scrub unsupported JSON Schema keywords + sanitize tool call IDs for Cloud Code Assist; simplify Gemini-compatible tool/session schemas; require raw for config.apply.
- Auto-reply/Streaming: default audioAsVoice false; preserve audio_as_voice propagation + buffer audio blocks + guard voice notes; block reply ordering (timeout) + forced-block fence-safe; avoid chunk splits inside parentheses + fence-close breaks + invalid UTF-16 truncation; preserve inline directive spacing + allow whitespace in reply tags; filter NO_REPLY prefixes + normalize routed replies; suppress <think> leakage with separate Reasoning; block streaming defaults (off by default, minChars/idle tuning) + coalesced blocks; dedupe followup queue; restore explicit responsePrefix default.
- Status/Commands: provider prefix in /status model display; usage filtering + provider mapping; auth label + usage snapshots (claude-cli fallback + optional claude.ai); show Verbose/Elevated only when enabled; compact usage/cost line + restore emoji-rich status; /status in directive-only + multi-directive handling; mention-bypass elevated handling; surface provider usage errors; wire /usage to /status; restore hidden gateway-daemon alias; fallback /model list when catalog unavailable.
- WhatsApp: vCard/contact cards (prefer FN, include numbers, show all contacts, keep summary counts, better empty summaries); preserve group JIDs + normalize targets; resolve @lid mappings/JIDs (Baileys/auth-dir) + inbound mapping; route queued replies to sender; improve web listener errors + remove provider name from errors; record outbound activity account id; fix web media fetch errors; broadcast group history consistency.
- Telegram: keep streamMode draft-only; long-poll conflict retries + update dedupe; grammY fetch mismatch fixes + restrict native fetch to Bun; suppress getUpdates stack traces; include user id in pairing; audio_as_voice handling fixes.
- Discord/Slack: thread context helpers + forum thread starters; avoid category parent overrides; gateway reconnect logs + HELLO timeout + stop provider after reconnect exhaustion; DM recipient parsing for numeric IDs; remove incorrect limited warning; reply threading + mrkdwn edge cases; remove ack reactions after reply; gateway debug event visibility.
- Signal: reaction handling safety; own-reaction matching (uuid+phone); UUID-only senders accepted; ignore reaction-only messages.
- MS Teams: download image attachments reliably; fix top-level replies; stop on shutdown + honor chunk limits; normalize poll providers/deps; pairing label fixes.
- iMessage: isolate group-ish threads by chat_id.
- Gateway/Daemon/Doctor: atomic config writes; repair gateway service entrypoint + install switches; non-interactive legacy migrations; systemd unit alignment + KillMode=process; node bridge keepalive/pings; Launch at Login persistence; bundle MoltbotKit resources + Swift 6.2 compat dylib; relay version check + remove smoke test; regen Swift GatewayModels + keep agent provider string; cron jobId alias + channel alias migration + main session key normalization; heartbeat Telegram accountId resolution; avoid WhatsApp fallback for internal runs; gateway listener error wording; serveBaseUrl param; honor gateway --dev; fix wide-area discovery updates; align agents.defaults schema; provider account metadata in daemon status; refresh Carbon patch for gateway fixes; restore doctor prompter initialValue handling.
- Control UI/TUI: persist per-session verbose off + hide tool cards; logs tab opens at bottom; relative asset paths + landing cleanup; session labels lookup/persistence; stop pinning main session in recents; start logs at bottom; TUI status bar refresh + timeout handling + hide reasoning label when off.
- Onboarding/Configure: QuickStart single-select provider picker; avoid Codex CLI false-expiry warnings; clarify WhatsApp owner prompt; fix Minimax hosted onboarding (agents.defaults + msteams heartbeat target); remove configure Control UI prompt; honor gateway --dev flag.

### Maintenance

- Dependencies: bump pi-\* stack to 0.42.2.
- Dependencies: Pi 0.40.0 bump (#543) — thanks @mcinteerj.
- Build: Docker build cache layer (#605) — thanks @zknicker.

- Auth: enable OAuth token refresh for Claude Code CLI credentials (`anthropic:claude-cli`) with bidirectional sync back to Claude Code storage (file on Linux/Windows, Keychain on macOS). This allows long-running agents to operate autonomously without manual re-authentication (#654 — thanks @radek-paclt).

## 2026.1.8

### Highlights

- Security: DMs locked down by default across providers; pairing-first + allowlist guidance.
- Sandbox: per-agent scope defaults + workspace access controls; tool/session isolation tuned.
- Agent loop: compaction, pruning, streaming, and error handling hardened.
- Providers: Telegram/WhatsApp/Discord/Slack reliability, threading, reactions, media, and retries improved.
- Control UI: logs tab, streaming stability, focus mode, and large-output rendering fixes.
- CLI/Gateway/Doctor: daemon/logs/status, auth migration, and diagnostics significantly expanded.

### Breaking

- **SECURITY (update ASAP):** inbound DMs are now **locked down by default** on Telegram/WhatsApp/Signal/iMessage/Discord/Slack.
  - Previously, if you didn’t configure an allowlist, your bot could be **open to anyone** (especially discoverable Telegram bots).
  - New default: DM pairing (`dmPolicy="pairing"` / `discord.dm.policy="pairing"` / `slack.dm.policy="pairing"`).
  - To keep old “open to everyone” behavior: set `dmPolicy="open"` and include `"*"` in the relevant `allowFrom` (Discord/Slack: `discord.dm.allowFrom` / `slack.dm.allowFrom`).
  - Approve requests via `openclaw pairing list <provider>` + `openclaw pairing approve <provider> <code>`.
- Sandbox: default `agent.sandbox.scope` to `"agent"` (one container/workspace per agent). Use `"session"` for per-session isolation; `"shared"` disables cross-session isolation.
- Timestamps in agent envelopes are now UTC (compact `YYYY-MM-DDTHH:mmZ`); removed `messages.timestampPrefix`. Add `agent.userTimezone` to tell the model the user’s local time (system prompt only).
- Model config schema changes (auth profiles + model lists); doctor auto-migrates and the gateway rewrites legacy configs on startup.
- Commands: gate all slash commands to authorized senders; add `/compact` to manually compact session context.
- Groups: `whatsapp.groups`, `telegram.groups`, and `imessage.groups` now act as allowlists when set. Add `"*"` to keep allow-all behavior.
- Auto-reply: removed `autoReply` from Discord/Slack/Telegram channel configs; use `requireMention` instead (Telegram topics now support `requireMention` overrides).
- CLI: remove `update`, `gateway-daemon`, `gateway {install|uninstall|start|stop|restart|daemon status|wake|send|agent}`, and `telegram` commands; move `login/logout` to `providers login/logout` (top-level aliases hidden); use `daemon` for service control, `send`/`agent`/`wake` for RPC, and `nodes canvas` for canvas ops.

### Fixes

- **CLI/Gateway/Doctor:** daemon runtime selection + improved logs/status/health/errors; auth/password handling for local CLI; richer close/timeout details; auto-migrate legacy config/sessions/state; integrity checks + repair prompts; `--yes`/`--non-interactive`; `--deep` gateway scans; better restart/service hints.
- **Agent loop + compaction:** compaction/pruning tuning, overflow handling, safer bootstrap context, and per-provider threading/confirmations; opt-in tool-result pruning + compact tracking.
- **Sandbox + tools:** per-agent sandbox overrides, workspaceAccess controls, session tool visibility, tool policy overrides, process isolation, and tool schema/timeout/reaction unification.
- **Providers (Telegram/WhatsApp/Discord/Slack/Signal/iMessage):** retry/backoff, threading, reactions, media groups/attachments, mention gating, typing behavior, and error/log stability; long polling + forum topic isolation for Telegram.
- **Gateway/CLI UX:** `openclaw logs`, cron list colors/aliases, docs search, agents list/add/delete flows, status usage snapshots, runtime/auth source display, and `/status`/commands auth unification.
- **Control UI/Web:** logs tab, focus mode polish, config form resilience, streaming stability, tool output caps, windowed chat history, and reconnect/password URL auth.
- **macOS/Android/TUI/Build:** macOS gateway races, QR bundling, JSON5 config safety, Voice Wake hardening; Android EXIF rotation + APK naming/versioning; TUI key handling; tooling/bundling fixes.
- **Packaging/compat:** npm dist folder coverage, Node 25 qrcode-terminal import fixes, Bun/Playwright/WebSocket patches, and Docker Bun install.
- **Docs:** new FAQ/ClawHub/config examples/showcase entries and clarified auth, sandbox, and systemd docs.

### Maintenance

- Skills additions (Himalaya email, CodexBar, 1Password).
- Dependency refreshes (pi-\* stack, Slack SDK, discord-api-types, file-type, zod, Biome, Vite).
- Refactors: centralized group allowlist/mention policy; lint/import cleanup; switch tsx → bun for TS execution.

## 2026.1.5

### Highlights

- Models: add image-specific model config (`agent.imageModel` + fallbacks) and scan support.
- Agent tools: new `image` tool routed to the image model (when configured).
- Config: default model shorthands (`opus`, `sonnet`, `gpt`, `gpt-mini`, `gemini`, `gemini-flash`).
- Docs: document built-in model shorthands + precedence (user config wins).
- Bun: optional local install/build workflow without maintaining a Bun lockfile (see `docs/bun.md`).

### Fixes

- Control UI: render Markdown in tool result cards.
- Control UI: prevent overlapping action buttons in Discord guild rules on narrow layouts.
- Android: tapping the foreground service notification brings the app to the front. (#179) — thanks @Syhids
- Cron tool uses `id` for update/remove/run/runs (aligns with gateway params). (#180) — thanks @adamgall
- Control UI: chat view uses page scroll with sticky header/sidebar and fixed composer (no inner scroll frame).
- macOS: treat location permission as always-only to avoid iOS-only enums. (#165) — thanks @Nachx639
- macOS: make generated gateway protocol models `Sendable` for Swift 6 strict concurrency. (#195) — thanks @andranik-sahakyan
- macOS: bundle QR code renderer modules so DMG gateway boot doesn't crash on missing qrcode-terminal vendor files.
- macOS: parse JSON5 config safely to avoid wiping user settings when comments are present.
- WhatsApp: suppress typing indicator during heartbeat background tasks. (#190) — thanks @mcinteerj
- WhatsApp: mark offline history sync messages as read without auto-reply. (#193) — thanks @mcinteerj
- Discord: avoid duplicate replies when a provider emits late streaming `text_end` events (OpenAI/GPT).
- CLI: use tailnet IP for local gateway calls when bind is tailnet/auto (fixes #176).
- Env: load global `$OPENCLAW_STATE_DIR/.env` (`~/.openclaw/.env`) as a fallback after CWD `.env`.
- Env: optional login-shell env fallback (opt-in; imports expected keys without overriding existing env).
- Agent tools: OpenAI-compatible tool JSON Schemas (fix `browser`, normalize union schemas).
- Onboarding: when running from source, auto-build missing Control UI assets (`bun run ui:build`).
- Discord/Slack: route reaction + system notifications to the correct session (no main-session bleed).
- Agent tools: honor `agent.tools` allow/deny policy even when sandbox is off.
- Discord: avoid duplicate replies when OpenAI emits repeated `message_end` events.
- Commands: unify /status (inline) and command auth across providers; group bypass for authorized control commands; remove Discord /clawd slash handler.
- CLI: run `openclaw agent` via the Gateway by default; use `--local` to force embedded mode.
