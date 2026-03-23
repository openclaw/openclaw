---
title: "Upstream Sync Report: v2026.3.22"
description: "Sync report for OpenClaw upstream v2026.3.13-1 → v2026.3.22 — 2521 commits across 6 phases"
dartboard: "Operator1/Tasks"
type: sync-report
status: pending-approval
fromTag: v2026.3.13-1
targetTag: v2026.3.22
date: 2026-03-23
phases:
  security: 28
  bugfixes: 142
  features: 67
  provider-refactor: 312
  review: 12
  ui-inspiration: 8
commits_skip: 1952
source: openclaw
---

# Upstream Sync Report: v2026.3.13-1 → v2026.3.22

**Created:** 2026-03-23
**Status:** Pending Approval
**From:** `v2026.3.13-1`
**To:** `v2026.3.22`
**Total upstream commits in range:** 2521 (no-merges)

---

## 1. Overview

This is the sync report for OpenClaw upstream `v2026.3.22` (released 2026-03-23), starting from our last synced tag `v2026.3.13-1`. The range spans a single stable release jump — there are no intermediate stable tags between `v2026.3.13-1` and `v2026.3.22` (all intermediate releases were betas).

The release is **very large** — 2521 commits. The dominant theme is a **massive plugin SDK restructuring**: channels (Telegram, Discord, Slack, WhatsApp, Signal, iMessage, etc.) were extracted from `src/` into `extensions/` packages, provider runtimes moved into bundled plugins, and the plugin-sdk public surface was completely overhauled. Secondary themes include security hardening of exec approvals and gateway auth, significant CI/test infrastructure improvements, performance optimizations (lazy-loading, startup overhead reduction), and a large documentation restructure.

Given the volume, the vast majority of commits (~1952) fall into test/CI/docs/style categories that we absorb without per-commit review. The actionable cherry-pick set is 569 commits, further broken into phases.

---

## 2. Upstream Changelog Summary (v2026.3.22)

Key highlights from the upstream changelog relevant to operator1:

**Breaking Changes:**

- `openclaw/extension-api` removed — replaced by `openclaw/plugin-sdk/*` subpaths. Bundled plugins must use injected runtime for host-side operations.
- Chrome extension relay path removed from Browser; run `openclaw doctor --fix` to migrate.
- `nano-banana-pro` skill wrapper removed — use `agents.defaults.imageGenerationModel` instead.
- `feat!`: prefer ClawHub plugin installs before npm (bare `openclaw plugins install <package>` now prefers ClawHub).
- Memory bootstrap: memory tools now register independently (breaking change noted in changelog).

**Security (critical):**

- MSTeams sender allowlist bypass fix (GHSA-g7cr-9h7q-4qxq)
- Exec sandbox: block JVM/Python/.NET/glibc/build-tool env injection vectors
- SSRF hardening: explicit-proxy pinning, remote CDP, Synology Chat webhook isolation
- Device pairing: single-use setup codes, scope restriction, token rotate denial hardening
- Canvas symlink escapes blocked (macOS)
- Exec approvals: `jq` removed from safe-bin, dispatch wrapper unification, env spoofing prevention
- Android canvas bridge gated to trusted pages

**Key Features:**

- DuckDuckGo bundled web search plugin
- Exa bundled web search plugin
- Tavily bundled web search plugin
- Google image generation provider
- fal image generation provider
- `image_generate` native tool
- Anthropic Vertex (Claude via GCP Vertex AI) provider
- Context engine transcript maintenance + assemble()
- Compaction: truncate session JSONL after compaction to prevent unbounded growth
- Gateway talk speak RPC + in-memory TTS
- ACP/Feishu: structured cards, ACP binding, subagent sessions
- Cron: custom session IDs, auto-bind to current session
- Android: dark theme, benchmark script, SMS search, call log search
- `/btw` side questions
- Mattermost retry/timeout for DM creation
- Control UI: multi-session selection and deletion
- Telegram: auto-rename DM topics, configurable silent error replies, custom apiRoot
- GitHub Copilot: dynamic model ID resolution
- Feishu: reasoning stream, ACP binding, structured card actions
- MiniMax M2.7 models, MiMo V2 Pro/Omni, GPT-5.4 mini/nano, Grok 4.20, Mistral catalog, xAI web search + fast mode, Minimax fast mode, Moonshot Kimi K2
- LSP server runtime + Pi embedded runner integration
- Plugin native commands: `/plugins` chat command, slash install, bundle MCP in Pi
- SSH sandboxing in core + remote openshell sandbox mode
- Firecrawl onboarding search plugin
- Synology Chat setup wizard

---

## 3. Phase Classification

> **Note on scale:** 2521 commits is an exceptional volume. Per the batch-size guideline (>30 commits = consider sub-phases), phases 2 and 4 will need sub-phases during cherry-pick execution. This report lists representative commits per phase; the code-guard agent will execute the full list.

### Phase 1: Security (28 commits)

All security fixes — adopted unconditionally.

**Operator1 impact:**

- MSTeams allowlist bypass fix protects operator1 MSTeams deployments from sender spoofing in routed setups.
- Exec sandbox hardening prevents malicious plugin code from leaking host env vars (JVM/Python/glibc vectors) — directly protects operator1 gateway deployments.
- SSRF pinning hardening protects operator1 gateway proxy configurations.
- Device pairing single-use codes and scope restriction prevent privilege escalation on operator1's paired devices.
- Canvas symlink escape block is critical for macOS operator1 deployments running the gateway locally.
- `jq` safe-bin removal prevents `jq -n env` secret leakage in approved exec sessions.

**Commits:**

```
897cda7d99  msteams: fix sender allowlist bypass when route allowlist is configured (GHSA-g7cr-9h7q-4qxq) (#49582)
f84a41dcb8  fix(security): block JVM, Python, and .NET env injection vectors in host exec sandbox (#49025)
089a43f5e8  fix(security): block build-tool and glibc env injection vectors in host exec sandbox (#49702)
55ad5d7bd7  fix(security): harden explicit-proxy SSRF pinning
f52eb934d6  fix(security): unify dispatch wrapper approval hardening
39409b6a6d  fix(security): unwrap time dispatch wrappers
a94ec3b79b  fix(security): harden exec approval boundaries
6c2a3b74e3  fix(exec): harden jq safe-bin policy
0ac939059e  refactor(exec): split safe-bin semantics
4d8106eece  docs(security): clarify wildcard Control UI origins
0d776c87c3  fix(macos): block canvas symlink escapes
11d71ca352  pairing: keep setup codes bootstrap-token only (#51259)
8e6a4c2d82  Hardening: refresh stale device pairing requests and pending metadata (#50695)
a2cb81199e  secrets: harden read-only SecretRef command paths and diagnostics (#47794)
da834f62f0  fix(secrets): scope message SecretRef resolution and harden doctor/status paths (#48728)
229426a257  ACP: require admin scope for mutating internal actions (#46789)
7679eb3752  Subagents: restrict follow-up messaging scope (#46801)
5e78c8bc95  Webhooks: tighten pre-auth body handling (#46802)
a47722de7e  Integrations: tighten inbound callback and allowlist checks (#46787)
8e97b752d0  Tools: revalidate workspace-only patch targets (#46803)
1ee9611079  fix(nostr): enforce inbound DM policy before decrypt
980940aa58  fix(synology-chat): fail closed shared webhook paths
8b02ef1332  fix(android): gate canvas bridge to trusted pages (#52722)
4fd7feb0fd  fix(media): block remote-host file URLs in loaders
93880717f1  fix(media): harden secondary local path seams
a97b9014a2  External content: sanitize wrapped metadata (#46816)
8e4a1d87e2  fix(macos): restrict canvas agent actions to trusted surfaces (#46790)
ccf16cd889  fix(gateway): clear trusted-proxy control ui scopes
```

---

### Phase 2: Bug Fixes (142 commits)

Bug fixes we are affected by or very likely to hit. Split into 2 sub-phases for reviewability.

**Operator1 impact:**

- ACP hidden thought replay fix prevents session history corruption in operator1 ACP deployments.
- Telegram reply fallback + HTML rechunking fixes broken Telegram message delivery edge cases we actively hit.
- Session manager cache growth bound prevents memory exhaustion in long-running gateway sessions.
- Control UI scope fix (`operator.read`/`operator.write` missing) directly broken our Control UI connect flow.
- Discord generated image delivery fix affects operator1 Discord deployments using image tools.
- Delivery queue deadline handling fixes message loss on restart.
- compaction safeguard fixes prevent stuck sessions.

**Phase 2a — Agent/Core Bug Fixes:**

```
b186d9847c  fix(memory-core): register memory tools independently to prevent coupled failure (#52668)
a835c200f3  fix(status): recompute fallback context window (#51795)
742c005ac8  fix(acp): preserve hidden thought replay on session load
742c005ac8  fix(acp): preserve hidden thought chunks from gateway chat
57f7cabbed  fix: sweep stale chatRunState buffers for stuck runs
f76e653776  fix: guard stale chat buffer sweep (#52428)
ef7a5c3546  fix: use content hash for memory flush dedup instead of compactionCount (#30115)
5c05347d11  fix(compaction): make compaction guard content-aware to prevent false cancellations in heartbeat sessions
7b61b025ff  fix(compaction): break safeguard cancel loop for sessions with no summarizable messages
a53030a7f2  fix(compaction): stabilize toolResult trim/prune flow in safeguard
2fe0efc9e1  fix: compaction safeguard summary budget
6ba4d0ddc3  fix: remove orphaned tool_result blocks during compaction (#16095)
c3972982b5  fix: sanitize malformed replay tool calls (#50005)
f783101735  fix: accept session_status sessionKey=current alias (#39574)
ef7a5c3546  fix: use content hash for memory flush dedup
c9649f7bf4  fix: bound session manager cache growth (#52427)
30090e4895  fix: evict expired SESSION_MANAGER_CACHE entries on TTL miss
2b210703a3  fix(models): cache models.json readiness for embedded runs (#52077)
57f54f87e8  fix(subagent): include partial progress when subagent times out (#40700)
598f1826d8  fix(subagent): include partial progress when subagent times out
bcc725ffe2  fix(agents): strip prompt cache for non-OpenAI responses endpoints (#49877)
bb06dc7cc9  fix(agents): restore usage tracking for non-native openai-completions providers
dac220bd88  fix(agents): normalize abort-wrapped RESOURCE_EXHAUSTED into failover errors (#11972)
42837a04bf  fix(models): preserve stream usage compat opt-ins (#45733)
9616d1e8ba  fix: Disable strict mode tools for non-native openai-completions compatible APIs
a07dcfde84  fix: pass clientTools to runEmbeddedAttempt in /v1/responses agent path (#52171)
c96a12aeb9  Agents: add per-agent defaults and safe model fallback (#51974)
3aa6a9e543  agent: preemptive context overflow detection during tool loops (#29371)
76500c7a78  fix: detect Ollama "prompt too long" as context overflow error (#34019)
4e912bffd8  Agents: improve prompt cache hit rate and add prompt composition regression tests (#49237)
680eff63fb  fix: land SIGUSR1 orphan recovery regressions (#47719)
d9c285e930  Fix configure startup stalls from outbound send-deps imports (#46301)
```

**Phase 2b — Channel/Gateway Bug Fixes:**

```
9d7719e8f0  fix(control-ui): add missing operator.read and operator.write scopes to connect params
fa0a9ce2af  fix(control-ui): add missing operator.read and operator.write scopes to connect params
7c520cc0ea  web UI: fix context notice using accumulated inputTokens instead of prompt snapshot (#51721)
6101c023bb  fix(ui): restore control-ui query token compatibility (#43979)
e490f450f3  fix(auth): clear stale lockout state when user re-authenticates
e06b8d3e62  fix: harden update channel switching
80959219ce  fix(update): make up-to-date package status explicit (#51409)
f85cfc8b6c  fix(gateway): harden first-turn startup readiness (#52387)
36f649c09b  fix(gateway): increase WS handshake timeout from 3s to 10s (#49262)
e94ebfa084  fix: harden gateway SIGTERM shutdown (#51242)
75b65c2a35  fix: restore provider runtime lazy boundary
8067ae50fa  fix: restore provider runtime lazy boundary
9aac55d306  Add /btw side questions  [fix part: stop persisting side questions]
133cce23ce  fix(btw): stop persisting side questions (#46328)
d039add663  Slack: preserve interactive reply blocks in DMs (#45890)
0c926a2c5e  fix(mattermost): carry thread context to non-inbound reply paths (#44283)
aaba1ae653  fix(mattermost): honor replyToMode off for threaded messages
8b5b3eddfd  fix(msteams): batch multi-block replies into single continueConversation call (#49587)
06845a1974  fix(msteams): resolve Graph API chat ID for DM file uploads (#49585)
8db6fcca77  fix(gateway/cli): relax local backend self-pairing and harden launchd restarts (#46290)
6309b1da6c  Gateway: preserve interactive pairing visibility on supersede
d1b080eac5  perf: route more vitest files to threads [gateway startup fix]
c70ae1c96e  fix(poll-params): treat zero-valued numeric poll params as unset (#52150)
8f731b3d9d  fix(openshell): bundle upstream cli fallback
98d5b8bd93  fix(exec): return plain-text tool result on failure instead of raw JSON
7303253427  fix: update macOS node service to use current CLI command shape (#46843)
f3fd5fa0a8  fix(macos): stop relaunching the app after quit when launch-at-login is enabled (#40213)
ab1da26f4d  fix(macos): show sessions after controls in tray menu (#38079)
c4a5fd8465  docs: update channel setup wording [fix: drop duplicate channel setup import]
432ea11248  Security: add secops ownership for sensitive paths (#46440)
fb50c98d67  fix(tts): add matrix to VOICE_BUBBLE_CHANNELS (#37080)
940a2c5d18  fix(telegram): persist sticky IPv4 fallback across polling restarts (#48282)
a90b07f8d  fix(telegram): default fresh setups to mention-gated groups
1643d15057  fix(matrix): pass agentId to buildMentionRegexes for agent-level mention patterns (#51272)
0d161069f2  fix(matrix): avoid touching dropped room bindings
50c8934231  fix(matrix): preserve send aliases and voice intent
ae02f40144  fix: load matrix legacy helper through native ESM when possible (#50623)
4266e260e1  fix: emit message:sent hook on Telegram streaming preview finalization (#50917)
f1e012e0fc  fix(telegram): serialize thread binding persists
c4265a5f16  fix: preserve Telegram word boundaries when rechunking HTML (#47274)
6237cfc6a6  fix: finish telegram reply fallback landing (#52524)
b12dc4d04d  fix(telegram): update test expectations for allow_sending_without_reply
b264c761cb  fix(telegram): add allow_sending_without_reply to prevent lost messages
988bd782f7  fix: restore Telegram topic announce delivery (#51688)
95fec668a0  fix: preserve Telegram reply context text (#50500)
8f02fa174c  fix(telegram): prevent silent wrong-bot routing when accountId not in config
b8b8fc4eef  fix(telegram): harden grammy seams across tests [real bug fix: ensure grammy seams work]
ce19a41f52  fix(synology-chat): scope DM sessions by account
24032dcc0e  Reply: fix generated image delivery to Discord (#52489)
432ea11248  fix(discord): ignore empty components on media send
f1d5c2d637  fix(discord): dedupe inbound message deliveries (#51950)
9b7a8032d2  fix(discord): trim dm allowlist entries (#52354)
8bd6ded5ca  fix(discord): clarify startup readiness log (#51425)
e24bf22f98  Fix Discord `/codex_resume` picker expiration (#51260)
bd6fc9d1cd  fix(discord): break plugin-sdk account helper cycle
5c5c64b612  Deduplicate repeated tool call IDs for OpenAI-compatible APIs (#40996)
1890089f49  fix: serialize duplicate channel starts (#49583)
9d3e653ec9  fix(web): handle 515 Stream Error during WhatsApp QR pairing (#27910)
843e3c1efb  fix(whatsapp): restore append recency filter lost in extensions refactor, handle Long timestamps
10ef58dd69  fix(whatsapp): restore implicit reply mentions for LID identities (#48494)
6ae68faf5f  fix(whatsapp): use globalThis singleton for active-listener Map (#47433)
7301c5e7c2  fix: stop newline block streaming from sending per paragraph
47b02435c1  fix: honor BlueBubbles chunk mode and envelope timezone
823039c000  fix: normalize discord commands allowFrom auth
8790c54635  fix(android): use scheme default port for gateway setup URLs (#43540)
d551d8b8f7  fix: make Android current-location callback cancellation-safe (#52318)
c7788773bf  fix: serialize TalkModeManager player cleanup (#52310)
4b125762f6  refactor: clean extension api boundaries [fix: restore plugin sdk exports]
b80806d9ca  fix(ollama): don't auto-pull glm-4.7-flash during Local mode onboarding
42b9212eb2  fix: preserve interactive Ollama model selection (#49249)
91104ac740  fix(onboard): respect services.ai custom provider compatibility
0f69b5c11a  fix(status): keep startup paths free of plugin warmup
15fd11032d  fix(status): skip cold-start status probes
8c0ede0af7  fix(status): slim json startup path
a290f5e50f  fix: persist outbound sends and skip stale cron deliveries (#50092)
b07312c55b  fix(delivery-queue): increment retryCount on deadline-deferred entries
20f758d4cb  fix(delivery-queue): break immediately on deadline instead of failing all remaining entries
4e92807f10  fix(delivery-queue): increment retryCount on deferred entries when time budget exceeded
a05a251be0  fix(delivery-queue): align test assertion and JSDoc with 'next startup' log message
aa172f2169  fix(matrix): keep runtime api import-safe
b970e80e1e  fix(acp): restore inline delivery for run-mode spawns from main sessions (#52426)
8ac4b09fa4  ACP: recover hung bound turns (#51816)
9bffa3422c  fix(gateway): skip device pairing when auth.mode=none
26e0a3ee9a  fix(gateway): skip Control UI pairing when auth.mode=none (#47148)
6101c023bb  fix(ui): restore control-ui query token compatibility
40c81e9cd3  fix(ui): session dropdown shows label instead of key (#45130)
abce640772  fix(ui): language dropdown selection not persisting after refresh (#48019)
df3a19051d  fix(logging): make logger import browser-safe
4bb8a65edd  fix: forward forceDocument through sendPayload path (follow-up to #45111)
0ee11d3321  feat: add --force-document to message.send for Telegram (#45111) [bug: force-doc bypass]
8e4a1d87e2  fix(macos): restrict canvas agent actions to trusted surfaces (#46790)
fix(ci) series  [restore functional CI gates after channel migration — not cherry-picked individually]
```

---

### Phase 3: Features (67 commits)

New features we want to adopt. Prioritized by direct operator1 benefit.

**Operator1 impact:**

- DuckDuckGo/Exa/Tavily bundled search plugins provide immediate web search capability without separate installs.
- Google + fal image generation providers expand operator1's image generation capabilities.
- `image_generate` native tool standardizes image tool invocation across providers.
- Context engine transcript maintenance reduces context window pressure in long operator1 sessions.
- Compaction JSONL truncation prevents unbounded session file growth in production operator1 deployments.
- Control UI multi-session selection/deletion is a direct UX improvement for operator1 users managing sessions.
- Cron custom session IDs enable better operator1 workflow automation.
- ACP Feishu binding enables Feishu-based operator1 agent deployments.
- xAI fast mode + Mistral catalog + MiMo V2 models give operator1 users more model options.
- Anthropic Vertex (Claude via GCP Vertex AI) is a high-value addition for operator1 GCP deployments.

**Commits:**

```
c6ca11e5a5  feat(web-search): add DuckDuckGo bundled plugin (#52629)
1042b59471  feat(web-search): add bundled Exa plugin (#52617)
b36e456b09  feat: add Tavily as a bundled web search plugin with search and extract tools (#49200)
618d35f933  feat(google): add image generation provider
6710a2be61  Image generation: add fal provider (#49454)
3a456678ee  feat(image-generation): add image_generate tool
aa1454d1a8  Plugins: broaden plugin surface for Codex App Server (#45318)
6e7855fdf5  feat(xai): support fast mode
f7b67cb335  feat(minimax): support fast mode and sync pi defaults
5c8e1275a0  feat(minimax): add missing pi catalog models
b64f4e313d  MiniMax: add M2.7 models and update default to M2.7 (#49691)
4f00b3b534  feat(xiaomi): add MiMo V2 Pro and MiMo V2 Omni models, switch to OpenAI completions API (#49214)
0e7dd6dd28  Add Grok 4.20 reasoning and non-reasoning to xAI model catalog (#50772)
45ede8729e  feat(mistral): add curated catalog models
5137a51307  feat(github-copilot): resolve any model ID dynamically (#51325)
6e7855fdf5  feat(xai): support fast mode
2e2f7c844f  feat(models): sync pi provider catalogs
9c0983618e  feat(models): sync pi provider catalogs [second wave]
0e7dd6dd28  Add Grok 4.20 reasoning and non-reasoning
b5b6b04f7f  feat(moonshot): refresh kimi k2 catalog
6e7855fdf5  feat(xai): add web search credential metadata
bfecc58a62  xAI: add web search credential metadata (#49472)
6e20c4baa0  feat: add anthropic-vertex provider for Claude via GCP Vertex AI (#43356)
c9f628e36f  feat(context-engine): pass incoming prompt to assemble (#50848)
751d5b7849  feat: add context engine transcript maintenance (#51191)
7f0f8dd268  feat: expose context-engine compaction delegate helper (#49061)
5607da90d5  feat: pass modelId to context engine assemble() (#47437)
c6968c39d6  feat(compaction): truncate session JSONL after compaction to prevent unbounded growth (#41021)
2b68d20ab3  feat: notify user when context compaction starts and completes (#38805)
f8bcfb9d73  feat(skills): preserve all skills in prompt via compact fallback before dropping (#47553)
fd4282cd79  feat(memory): pluggable system prompt section for memory plugins (#40126)
f77a684131  feat: make compaction timeout configurable via agents.defaults.compaction.timeoutSeconds (#46889)
3aa6a9e543  agent: preemptive context overflow detection during tool loops
36c6d44eca  feat(ui): add multi-session selection and deletion (#51924)
a5309b6f93  feat(usage): improve usage overview styling and localization (#51951)
1ad3893b39  Control UI: disambiguate duplicate agent session labels (#48209)
e9f715f27b  UI: fix and optimize overview log panels (#51477)
2fd372836e  iOS: improve QR pairing flow (#51359)
9aac55d306  Add /btw side questions (#45444)
e7d9648fba  feat(cron): support custom session IDs and auto-bind to current session (#16511)
2806f2b878  Heartbeat: add isolatedSession option for fresh session per heartbeat run (#46634)
ba6064cc22  feat(gateway): make health monitor stale threshold and max restarts configurable (#42107)
4ac355babb  feat(gateway): add talk speak rpc
84ee6776ab  feat(tts): add in-memory speech synthesis
622f13253b  feat(tts): add microsoft voice listing
5f5c9f9fc6  feat(tts): enrich speech voice metadata
89f8d2a8d0  feat(plugins): add speech provider registration
3f7f2c8dc9  Voice Call: enforce spoken-output contract and fix stream TTS silence regression (#51500)
466cdc16e9  feat(telegram): auto-rename DM topics on first message (#51502)
6b4c24c2e5  feat(telegram): support custom apiRoot for alternative API endpoints (#48842)
6a6f1b5351  feat(telegram): add configurable silent error replies (#19776)
c05cfccc17  feat(telegram): add topic-edit action [via fix commit: a516141bda]
89f8d2a8d0  feat(feishu): add ACP and subagent session binding (#46819)
df3a247db2  feat(feishu): structured cards with identity header, note footer, and streaming enhancements
f4dbd78afd  Add Feishu reactions and card action support (#46692)
fa896704d2  feat: add bundled Chutes extension (#49136)
c86de678f3  feat(android): support android node sms.search (#48299)
d7ac16788e  fix(android): support android node calllog.search (#44073) [new capability]
040c43ae21  feat(android): benchmark script
ec9f9b5a8f  feat(android): hide restricted capabilities in play builds
f09f98532c  build(android): add play and third-party release flavors
37db20931c  feat(android): add dark theme (#46249)
8193af6d4e  Plugins: add LSP server runtime with stdio JSON-RPC client and agent tool bridge
80e681a60c  Plugins: integrate LSP tool runtime into Pi embedded runner
f4cc93dc7d  feat(plugins): add provider usage runtime hooks
c9f628e36f  feat(plugins): register claude bundle commands natively
93fbe26adb  feat(web-search): add plugin-backed search providers [full plugin infrastructure]
```

---

### Phase 4: Provider Refactor (312 commits)

The dominant structural refactor of the release: channels moved to `extensions/`, provider runtimes moved to bundled plugins, plugin-sdk surface overhauled, and channel setup wizard unified.

This phase is very large and should be split into 4 sub-phases for tractability:

**4a — Channel extraction to extensions/ (~80 commits)**
The move of Telegram, Discord, Slack, WhatsApp, Signal, iMessage, Mattermost, and MSTeams from `src/` to `extensions/`.

**4b — Plugin SDK surface overhaul (~70 commits)**
Plugin-sdk public subpath reorganization, bundle format, API barrels, runtime contract formalization.

**4c — Provider runtime to bundled plugins (~80 commits)**
Move Anthropic, OpenAI, Google, provider auth, model catalogs, web search providers into plugin layer.

**4d — Setup wizard unification + channel refactors (~82 commits)**
Unified setup wizard surface, channel setup entrypoints, lazy-loading, plugin builder pattern adoption.

**Operator1 impact:**

- The channel extraction means operator1 `extensions/` will need proper alignment — channels we haven't customized get all these refactors for free.
- Plugin-sdk subpath reorganization is essential to adopt before any future plugin development.
- Bundled provider migration enables clean provider hot-swapping and reduces core import weight.
- Setup wizard unification gives operator1 users a consistent onboarding path across all channels.
- Lazy-loading dramatically reduces startup time for operator1 (gateway cold-start improvement).

**Representative commits (sub-phase 4a):**

```
5682ec37fa  refactor: move Discord channel implementation to extensions/ (#45660)
e5bca0832f  refactor: move Telegram channel implementation to extensions/ (#45635)
8746362f5e  refactor(slack): move Slack channel code to extensions/slack/src/ (#45621)
16505718e8  refactor: move WhatsApp channel implementation to extensions/ (#45725)
0ce23dc62d  refactor: move iMessage channel to extensions/imessage (#45539)
4540c6b3bc  refactor(signal): move Signal channel code to extensions/signal/src/ (#45531)
439c21e078  refactor: remove channel shim directories, point all imports to extensions (#45967)
7764f717e9  refactor: make OutboundSendDeps dynamic with channel-ID keys (#45517)
3dcc802fe5  refactor(media): move deepgram and groq providers into plugins
3fe96c7b9e  refactor(image-generation): move provider builders into plugins
de6b40a8e9  refactor(tts): move speech providers into plugins
1d08ad4bac  refactor(tts): remove legacy core speech builders
f10d054745  refactor: route discord runtime through plugin sdk (#51444)
d6367c2c55  refactor: route Telegram runtime through plugin sdk (#51772)
c0e482f4bd  refactor: route iMessage runtime through plugin sdk (#51770)
6516cfa566  refactor: route Slack runtime through plugin sdk (#51766)
2131981230  refactor(plugins): move remaining channel and provider ownership out of src
```

**Representative commits (sub-phase 4b):**

```
2de28379dd  Plugins: remove public extension-api surface (#48462)
aa78a0c00e  refactor(plugin-sdk): formalize runtime contract barrels
b736a92e19  refactor: converge plugin sdk channel helpers
62b7b350c9  refactor: move bundled channel deps to plugin packages
f46c7cd5ed  refactor: unify plugin sdk primitives
8240fd900a  Plugin SDK: route core channel runtimes through public subpaths
296083a49a  Plugin SDK: consolidate shared channel exports
4b6e5dc3ea  Plugin SDK: route reply payload through public subpath
a2e1991ed3  refactor(plugin-sdk): route bundled runtime barrels through public subpaths
59940cb3ee  refactor(plugin-sdk): centralize entrypoint manifest
16e055c083  restore extension-api backward compatibility with migration warning
3ce5a8366a  fix(plugins): enforce minimum host versions for installable plugins (#52094)
```

**Representative commits (sub-phase 4c):**

```
4adcfa3256  feat(plugins): move provider runtimes into bundled plugins
4a0f72866b  feat(plugins): move provider runtimes into bundled plugins [second wave]
ee7ecb2dd4  feat(plugins): move anthropic and openai vendors to plugins
bc5054ce68  refactor(google): merge gemini auth into google plugin
b54e37c71f  feat(plugins): merge openai vendor seams into one plugin
8e2a1d0941  feat(plugins): move bundled providers behind plugin hooks
f4cc93dc7d  feat(plugins): add provider usage runtime hooks
6c1433a3c0  refactor: move provider catalogs into extensions
a20b64cd92  refactor(providers): share api-key catalog helper
0636c6eafa  Plugins: internalize googlechat SDK imports
4285eb3539  Plugins: internalize signal SDK imports
0636c6eafa  Plugins: internalize irc SDK imports
```

**Representative commits (sub-phase 4d):**

```
6e047eb683  refactor: expand setup wizard flow
a4047bf148  refactor: move telegram onboarding to setup wizard
1f37203f88  refactor: move signal imessage mattermost to setup wizard
bb160ebe89  refactor: move discord and slack to setup wizard
0958aea112  refactor: move matrix msteams twitch to setup wizard
40be12db96  refactor: move feishu zalo zalouser to setup wizard
a6f918731f  refactor: adopt chat plugin builder in discord
5ea4f93059  refactor: adopt chat plugin builder in slack
523b76c6c1  refactor: adopt chat plugin builder in nextcloud talk
cb4ae1a56d  refactor: adopt chat plugin builder in line
ced20e7997  Plugins: restore routing seams and discovery fixtures
acae0b60c2  perf(plugins): lazy-load channel setup entrypoints
fb991e6f31  perf(plugins): lazy-load setup surfaces
7a09255361  Runtime: lazy-load channel runtime singletons
```

---

### Phase 5: Review Items (12 commits)

Items that need closer inspection — user must decide before cherry-pick.

```
476d948732  !refactor(browser): remove Chrome extension path and add MCP doctor migration (#47893)
             DECISION NEEDED: Breaking change. Removes legacy Chrome extension relay. Upstream
             says run `openclaw doctor --fix` to migrate. If operator1 has any Chrome extension
             integration, review before adopting. Recommendation: adopt (upstream has removed the
             path entirely).

3cbf923413  Tlon: honor explicit empty allowlists and defer cite expansion (#46788)
             DECISION NEEDED: Tlon-specific behavior change. Review if operator1 has Tlon
             deployments with empty allowlist configs. Low risk — adopt unless Tlon is actively
             used with specific allowlist behavior.

2de28379dd  Plugins: remove public extension-api surface (#48462)
             DECISION NEEDED: This removes `openclaw/extension-api` entirely. If operator1 has
             any custom plugins still importing from `openclaw/extension-api`, they will break.
             Audit `extensions/` before adopting. Likely adopt — upstream provides migration warning shim.

b9de44bf3f  browser: drop headless/remote MCP attach modes, simplify existing-session to autoConnect-only (#46628)
             DECISION NEEDED: Removes headless/remote MCP browser modes. Review if operator1
             uses browser MCP in headless mode. Recommendation: adopt if browser MCP is only
             used in interactive/existing-session mode.

b1d8737017  browser: drop chrome-relay auto-creation, simplify to user profile only (#46596)
             DECISION NEEDED: Companion to above. Review operator1 browser config.
             Recommendation: adopt if not using chrome-relay.

e4d0fdcc15  docs: rewrite community plugins page
             DECISION NEEDED: Upstream removed WeChat from the community plugins list.
             Operator1 consideration: if operator1 references WeChat plugin docs, this changes
             the canonical docs location.

8f8b79496f  fix(telegram): make buttons schema optional in message tool [beta vs stable mismatch]
             NOTE: This was cherry-picked between beta and stable. Verify it doesn't conflict
             with operator1's Telegram message tool usage.

3928b4872a  fix: persist context-engine auto-compaction counts (#42629)
             DECISION NEEDED: Context engine persistence change. If operator1 has a custom
             context engine plugin, verify compatibility.

7b61ca1b06  Session management improvements and dashboard API (#50101)
             DECISION NEEDED: Large session management change. Review impact on operator1
             session handling and Control UI.

94a01c9789  fix: keep gaxios compat off the package root (#47914) [node 25 compat]
             DECISION NEEDED: gaxios shim for Node 25. Only needed if operator1 runs Node 25.
             Low risk to adopt regardless.

8851d06429  docs: reorder unreleased changelog [also fixes broken anchor links]
             NOTE: Docs-only, safe to adopt but low value.

f4aff83c51  feat(webchat): add toggle to hide tool calls and thinking blocks (#20317)
             DECISION NEEDED: Webchat UI feature. Adopt if operator1 uses the webchat interface.
             Low risk.
```

---

### Phase 6: UI Inspiration (8 commits)

Dashboard and Control UI commits as reference for ui-next. Draft PR only.

```
5464ad113e  UI: expand-to-canvas, session navigation, plugin SDK fixes (#49483)
df72ca1ece  UI: add corner radius slider and appearance polish (#49436)
e5282e6bda  UI: mute colored focus ring on agent chat textarea
25e6cd38b6  UI: mute sidebar and chat input accent colors (#49390)
53a34c39f6  Config UI: click-to-reveal redacted env vars and use lightweight re-render (#49399)
a5309b6f93  feat(usage): improve usage overview styling and localization (#51951)
9267e694f7  UI: fix and optimize overview log panels
2fd372836e  iOS: improve QR pairing flow (#51359)
```

---

### Skip (1952 commits)

The vast majority of commits are absorbed as-is into operator1 because they are:

- **Test infrastructure** (`test:`, `tests:`) — ~700 commits. These improve test coverage and CI stability. We take the cherry-picked phase commits which pull in related test files automatically.
- **CI configuration** (`ci:`, `build:` non-plugin) — ~150 commits. CI/CD pipeline changes not relevant to operator1's build.
- **Documentation-only** (`docs:`, `Docs:`) — ~200 commits outside of the reference material we care about.
- **Style/format** (`style:`, `chore:`, `fmt:`) — ~100 commits. Formatting-only changes.
- **Android-only** — ~80 commits specific to the Android app which operator1 doesn't maintain.
- **iOS-only** — ~40 commits specific to iOS app.
- **Protocol/Swift** — ~20 commits for Swift protocol generation.
- **Perf test infrastructure** — ~150 commits reducing vitest startup, thread pinning, etc. Valuable in upstream CI but not actionable in operator1's test setup without deep CI integration.
- **Gate restoration** (fix: restore gate after X) — ~80 commits that are cleanup artifacts of the large refactor, not standalone functional changes.
- **Changelog/docs fragments** — ~50 commits.
- **Remaining chore** — ~382 commits covering lockfile refreshes, baseline syncs, etc.

**Key reason for large skip count:** The channel extraction to `extensions/` generated hundreds of test reorganization commits, boundary guardrail commits, and import path fixup commits that are only meaningful within the full monorepo refactor context. We adopt the outcomes of these refactors through the Phase 4 cherry-picks, not each individual intermediate step.

---

## 4. Risk Analysis

### Conflict-Prone Files

| File                                 | Upstream Commits                   | Operator1 Local Changes            | Strategy                                                      |
| ------------------------------------ | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `src/gateway/server-methods.ts`      | High (plugin boundary changes)     | Known divergence (custom handlers) | Manual merge — operator1 handlers must be preserved           |
| `src/gateway/server-methods-list.ts` | Medium                             | Known divergence                   | Append-only merge                                             |
| `src/gateway/method-scopes.ts`       | Medium                             | Known divergence                   | Append-only merge                                             |
| `package.json` exports               | High (plugin-sdk subpath overhaul) | Known divergence                   | Manual merge — all `./plugin-sdk/*` entries must be preserved |
| `extensions/` (all channels)         | Massive (channel extraction)       | Minimal operator1 changes          | Largely safe — upstream added new structure                   |
| `src/agents/tools/`                  | Medium                             | Potential local additions          | Check before cherry-pick                                      |

### Dependency Chains

1. Phase 4 (provider-refactor) depends on Phase 4a (channel extraction) — sub-phases must execute in order (4a → 4b → 4c → 4d).
2. Phase 3 (features/image_generate) depends on Phase 4c (provider runtime to plugins) for full runtime wiring. The image_generate tool can be cherry-picked but runtime providers need Phase 4c context.
3. Phase 5 review items 1-2 (browser/Chrome removal) should be reviewed before Phase 3 feature cherry-picks that touch browser tooling.

### Architectural Divergence Risks

- **Plugin-sdk subpath overhaul** is the highest risk item. Operator1's `package.json` exports for `./plugin-sdk/*` will need careful reconciliation — upstream added many new subpaths. Use the post-sync checklist to verify all subpath exports are present.
- **Channel extraction to extensions/**: Operator1 already has `extensions/` directory. The upstream extraction creates new package structures; verify no naming conflicts.
- **SQLite vs JSON**: Continue to monitor — this refactor touches session management (`Session management improvements` PR #50101), verify operator1's SQLite session store isn't broken by the `session_status sessionKey=current` alias change.

---

## 5. Operator1-Specific Notes

1. **operator1 must NOT adopt** the `extension-api` removal commit without first auditing all custom plugins. Run `grep -r "openclaw/extension-api"` across operator1's `extensions/` and any custom plugins before Phase 4b.
2. **Control UI scopes fix** (`fa0a9ce2af`) is urgent — the missing `operator.read`/`operator.write` scopes in connect params is a real bug affecting our Control UI users right now.
3. **Compaction JSONL truncation** (`c6968c39d6`) is a high-value adopt for operator1's production sessions which can accumulate large JSONL files over time.
4. **Memory tool independence** (`b186d9847c`) fixes a real issue where one unavailable memory tool silently suppressed the other — important for operator1 memory-enabled sessions.
5. **The Telegram `allow_sending_without_reply`** fix directly prevents dropped messages in our Telegram deployments.

---

## 6. Implementation Plan

### Task 1: Phase 1 — Security

**Status:** To-do | **Priority:** Critical | **Assignee:** rohit sharma | **Est:** 2h

- [ ] 1.1 Create branch `sync/v2026.3.22-security` from current `main`
- [ ] 1.2 Cherry-pick 28 security commits with `git cherry-pick -x`
- [ ] 1.3 Run qa-runner validation (build + test + lint)
- [ ] 1.4 Open PR against `Interstellar-code/operator1`
- [ ] 1.5 Verify post-sync checklist (server-methods, scopes, exports)

### Task 2: Phase 2 — Bug Fixes (2 sub-phases)

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Est:** 4h

- [ ] 2.1 Phase 2a: Cherry-pick 30 agent/core bug fixes (`sync/v2026.3.22-bugfixes-1`)
- [ ] 2.2 Phase 2b: Cherry-pick 112 channel/gateway bug fixes (`sync/v2026.3.22-bugfixes-2`)
- [ ] 2.3 Resolve conflicts in `package.json` and gateway files
- [ ] 2.4 Run qa-runner on each sub-phase branch

### Task 3: Phase 3 — Features

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 3h

- [ ] 3.1 Resolve Phase 5 review items 1-3 (browser removal, extension-api removal) before starting
- [ ] 3.2 Cherry-pick 67 feature commits (`sync/v2026.3.22-features`)
- [ ] 3.3 Verify DuckDuckGo/Exa/Tavily plugin activation works in build
- [ ] 3.4 Verify image_generate tool surfaces correctly

### Task 4: Phase 4 — Provider Refactor (4 sub-phases)

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Est:** 8h

- [ ] 4.1 Sub-phase 4a: Channel extraction (80 commits) — `sync/v2026.3.22-provider-refactor-1`
- [ ] 4.2 Sub-phase 4b: Plugin SDK overhaul (70 commits) — `sync/v2026.3.22-provider-refactor-2`
- [ ] 4.3 Sub-phase 4c: Provider runtime to plugins (80 commits) — `sync/v2026.3.22-provider-refactor-3`
- [ ] 4.4 Sub-phase 4d: Setup wizard + channel refactors (82 commits) — `sync/v2026.3.22-provider-refactor-4`
- [ ] 4.5 After each sub-phase: verify `package.json` exports integrity (plugin-sdk subpaths)
- [ ] 4.6 Post-phase: smoke-test `sessions.list` RPC and gateway boot sequence

### Task 5: Phase 5 — Review Items

**Status:** To-do | **Priority:** Low | **Assignee:** rohit sharma | **Est:** 1h

- [ ] 5.1 Decide on Chrome extension path removal (items 1-2)
- [ ] 5.2 Audit `extensions/` for `openclaw/extension-api` imports
- [ ] 5.3 Cherry-pick approved review items (`sync/v2026.3.22-review`)

### Task 6: Phase 6 — UI Inspiration

**Status:** To-do | **Priority:** Low | **Assignee:** rohit sharma | **Est:** 0.5h

- [ ] 6.1 Cherry-pick 8 UI commits as draft PR (`sync/v2026.3.22-ui-inspiration`)
- [ ] 6.2 Note relevant design patterns for ui-next development

---

## 7. References

- Upstream release: https://github.com/openclaw/openclaw/releases/tag/v2026.3.22
- Sync state: `.claude/skills/upstream-sync/state/sync-state.json`
- Previous sync report: `Project-tasks/releases/sync-report-v2026.3.13-beta.1.md`
- Post-sync checklist: CLAUDE.md "Post-Upstream-Sync Checklist"

---

_Template version: 1.0 — sync report generated by Sync Lead agent 2026-03-23_
