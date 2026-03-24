---
title: "Upstream Sync Report: v2026.3.22"
type: sync-report
status: pending-approval
fromTag: v2026.3.13-1
targetTag: v2026.3.22
date: 2026-03-24
phases:
  security: 24
  bugfixes: 180
  features: 80
  provider-refactor: 220
  review: 12
  ui-inspiration: 9
commits_skip: 1996
---

# Upstream Sync Report: v2026.3.13-1 → v2026.3.22

**From:** `v2026.3.13-1` (synced 2026-03-17)
**To:** `v2026.3.22`
**Total commits in range:** 2,521 (no-merges)
**Commits touching core operator1 paths:** 1,477
**Planned phases:** 6

---

## Upstream Changelog Summary (v2026.3.22)

This is a major release spanning approximately 6 weeks of upstream development.
Key themes:

1. **Plugin SDK overhaul** — `openclaw/extension-api` removed; all bundled
   providers, channels, and media runtimes moved into plugin packages under
   `openclaw/plugin-sdk/*` subpaths. This is the largest structural change in
   the release.

2. **Security hardening batch** — exec sandbox environment variable injection
   blocks, SSRF pinning improvements, dispatch wrapper approval hardening,
   ACP scope enforcement, and webhook pre-auth guards.

3. **Channel-to-extensions migration complete** — legacy shim directories for
   Telegram, Discord, Slack, Signal, iMessage, and WhatsApp removed. All
   imports now go directly to `extensions/`.

4. **New bundled search providers** — Exa, Tavily, Firecrawl, and DuckDuckGo
   added as bundled plugins with dedicated tool schemas.

5. **Image generation** — new native `image_generate` tool backed by Google
   Gemini; legacy `nano-banana-pro` skill removed.

6. **Control UI improvements** — multi-session deletion, corner-radius slider,
   expand-to-canvas, usage view polish, and a critical missing-scope bug fix
   that was preventing webchat agent sends.

7. **Breaking env cleanup** — `CLAWDBOT_*` and `MOLTBOT_*` environment variable
   aliases removed. Legacy `.moltbot` state-dir detection removed.

---

## Breaking Changes Summary

These upstream breaking changes require operator1-side review before adopting
any phase that touches them:

| #   | Change                                                                   | Scope      | operator1 Impact                                                       |
| --- | ------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------- |
| 1   | `openclaw/extension-api` removed; use `openclaw/plugin-sdk/*`            | Plugin SDK | Any operator1 extensions importing `extension-api` break at build time |
| 2   | `CLAWDBOT_*` / `MOLTBOT_*` env var aliases removed                       | Config     | Low risk — operator1 uses `OPENCLAW_*` already                         |
| 3   | Legacy `.moltbot` state-dir detection removed                            | Config     | Harmless — operator1 migrated to SQLite                                |
| 4   | `nano-banana-pro` skill removed; use `image_generate` tool               | Skills     | If any operator1 skill uses nano-banana-pro, needs update              |
| 5   | Discord slash commands now use Carbon reconcile by default               | Discord    | Review Discord slash command deploy behavior                           |
| 6   | `time` treated as dispatch wrapper (not approved directly)               | Exec       | Exec allowlist entries using `time ...` need revalidation              |
| 7   | Voice-call: 64 KB / 5s pre-auth body budget (was 1 MB / 30s)             | Webhooks   | Any large pre-auth webhook payloads to voice-call break                |
| 8   | `listActions` / `getCapabilities` / `getToolSchema` removed from plugins | Plugin SDK | Operator1 plugins implementing these adapters must migrate             |
| 9   | Matrix plugin replaced with official `matrix-js-sdk` backend             | Matrix     | Only if operator1 uses Matrix channel                                  |

---

## Phase Classification

### Phase 1: Security (24 commits)

**Branch:** `sync/v2026.3.22-security`
**Risk:** Low to Medium — apply unconditionally, but review exec sandbox changes.

All security commits are adopted without debate per the sync policy. The
critical ones below are flagged with operator1 impact.

#### Commit List

```
55ad5d7bd7  fix(security): harden explicit-proxy SSRF pinning
f52eb934d6  fix(security): unify dispatch wrapper approval hardening
39409b6a6d  fix(security): unwrap time dispatch wrappers
a94ec3b79b  fix(security): harden exec approval boundaries
089a43f5e8  fix(security): block build-tool and glibc env injection vectors (#49702)
f84a41dcb8  fix(security): block JVM, Python, and .NET env injection vectors (#49025)
229426a257  ACP: require admin scope for mutating internal actions (#46789)
a47722de7e  Integrations: tighten inbound callback and allowlist checks (#46787)
7679eb3752  Subagents: restrict follow-up messaging scope (#46801)
5e78c8bc95  Webhooks: tighten pre-auth body handling (#46802)
8e04d1fe15  macOS: restrict canvas agent actions to trusted surfaces (#46790)
fc2d29ea92  Gateway: tighten forwarded client and pairing guards (#46800)
f0202264d0  Gateway: scrub credentials from endpoint snapshots (#46799)
c036e4d176  fix: restrict remote marketplace plugin sources
09faed6bd8  fix(gateway): gate internal command persistence mutations
980940aa58  fix(synology-chat): fail closed shared webhook paths
651dc7450b  fix(voice-call): harden webhook pre-auth guards
1ee9611079  fix(nostr): enforce inbound dm policy before decrypt
8b02ef1332  fix(android): gate canvas bridge to trusted pages (#52722)
c7137270d1  Security: split audit runtime surfaces
5f42389d8d  Security: lazy-load audit config snapshot IO
a2119efe1c  Security: lazy-load deep skill audit helpers
4cb46f223c  Security: trim audit policy import surfaces
093e51f2b3  Security: lazy-load channel audit provider helpers
```

#### Operator1 Impact

- **SSRF pinning** (`55ad5d7bd7`): `src/infra/net/fetch-guard.ts` and
  `src/infra/net/ssrf.ts` are present in operator1. The Telegram fetch guard
  (`extensions/telegram/src/fetch.ts`) is also present. This fix prevents
  proxy-assisted SSRF through explicit-proxy configurations. High relevance.

- **Dispatch wrapper approval** (`f52eb934d6`, `39409b6a6d`): Hardens exec
  allowlist evaluation so `time ./approved-binary` no longer bypasses the
  approval check. Any exec tool use by operator1 agents is covered.

- **Exec env injection blocks** (`089a43f5e8`, `f84a41dcb8`): Blocks
  `MAVEN_OPTS`, `SBT_OPTS`, `GRADLE_OPTS`, `GLIBC_TUNABLES`,
  `DOTNET_ADDITIONAL_DEPS` from propagating into sandboxed exec. Affects
  operator1 dev/automation use cases running Java or .NET tools.

- **ACP admin scope** (`229426a257`): `src/auto-reply/reply/commands-acp.ts`
  adds admin-scope gates to mutating ACP actions. Critical for operator1's
  multi-agent ACP deployments via acpx extension.

- **Subagent messaging scope** (`7679eb3752`): `src/agents/subagent-control.ts`
  now prevents subagents from sending follow-up messages to sessions they were
  not spawned for. Closes a privilege escalation path in operator1's agent-chain
  workflows.

- **Webhook pre-auth** (`5e78c8bc95`): Synology Chat, Mattermost, MSTeams,
  NextCloud Talk, and Google Chat all get pre-auth body guards. operator1
  extension list includes all of these — direct protection.

- **Nostr inbound DM policy** (`1ee9611079`): The nostr extension in operator1
  (`extensions/nostr/`) is affected. Previously any sender could bypass pairing
  before DM decryption. Now enforced.

- **Synology Chat webhook fail-closed** (`980940aa58`): operator1 has
  `extensions/synology-chat/`. The fix prevents shared webhook paths from
  resolving to incorrect account contexts.

- **Voice-call pre-auth** (`651dc7450b`): operator1 has `extensions/voice-call/`
  and `extensions/talk-voice/`. Pre-auth body budget capped from 1 MB / 30s to
  64 KB / 5s; concurrent pre-auth per IP capped.

**Conflict risk:** Medium. `src/infra/net/fetch-guard.ts` was touched in
previous syncs. Review carefully.

---

### Phase 2: Bug Fixes (180 commits)

**Branch:** `sync/v2026.3.22-bugfixes`
**Risk:** Medium — large count; split into bugfixes-1 and bugfixes-2 if needed.

This is the largest single-phase category. The high-value subset is listed
below; the full list includes many test infrastructure and CI fixes that are
adopted wholesale under the inclusive sync philosophy.

#### Highest-Priority Bugfixes for operator1

```
9d7719e8f0  fix(control-ui): add missing operator.read and operator.write scopes
fa0a9ce2af  fix(control-ui): add missing operator.read and operator.write scopes (ui/gateway.ts)
b186d9847c  fix(memory-core): register memory tools independently (#52668)
dac220bd88  fix(agents): normalize abort-wrapped RESOURCE_EXHAUSTED into failover (#11972)
ef3f64952a  fix: bound session manager cache growth (#52427)
30090e4895  fix: evict expired SESSION_MANAGER_CACHE entries on TTL miss
432e8943ad  fix(discord): dedupe inbound message deliveries (#51950)
d37e3d582f  Scope Control UI sessions per gateway (#47453)
5c05347d11  fix(compaction): make guard content-aware to prevent false cancellations
2fe0efc9e1  fix: compaction safeguard summary budget (#27727)
ef7a5c3546  fix: use content hash for memory flush dedup (#30115, #34222)
aaba1ae653  fix(mattermost): honor replyToMode off for threaded messages
9b9e1ae901  fix(discord): trim dm allowlist entries (#52354)
57267b23d5  fix(acp): restore inline delivery for run-mode spawns (#52426)
32fdd21c80  fix(acp): preserve hidden thought replay on session load
742c005ac8  fix(acp): preserve hidden thought chunks from gateway chat
bf12835995  fix(telegram): make buttons schema optional in message tool
b12dc4d04d  fix(telegram): update test expectations for allow_sending_without_reply
b264d73dc2  fix(telegram): add allow_sending_without_reply to prevent lost messages
6237cfc6a6  fix: finish telegram reply fallback landing (#52524)
95fec668a0  fix: preserve Telegram reply context text (#50500)
988bd782f7  fix: restore Telegram topic announce delivery (#51688)
8f8b79496f  fix: keep message-tool buttons optional for Telegram and Mattermost (#52589)
deecf68b59  fix(gateway): fail closed on unresolved discovery endpoints
e94ebfa084  fix: harden gateway SIGTERM shutdown (#51242)
8db6fcca77  fix(gateway/cli): relax local backend self-pairing and harden launchd restarts (#46290)
a835c200f3  fix(status): recompute fallback context window (#51795)
bb06dc7cc9  fix(agents): restore usage tracking for non-native openai-completions providers
5c65ba5f02  fix(agents): avoid model catalog startup tax on telegram replies
2b210703a3  fix(models): cache models.json readiness for embedded runs (#52077)
9616d1e8ba  fix: Disable strict mode tools for non-native openai-completions APIs (#45497)
a8e4d23d48  fix(agents): normalize abort-wrapped RESOURCE_EXHAUSTED into failover errors
5c9983618e  fix: deduplicate repeated tool call IDs for OpenAI-compatible APIs (#40996)
d88c68fec1  perf(core): narrow sandbox status imports (#51897)
8e568142f6  refactor: extract exec outcome and tool result helpers
40c81e9cd3  fix(ui): session dropdown shows label instead of key (#45130)
40c81e9cd3  fix(ui): session dropdown shows label instead of key (#45130)
3928b4872a  fix: persist context-engine auto-compaction counts (#42629)
d1e4ee03ff  fix(context): skip eager warmup for non-model CLI commands
e490f450f3  fix(auth): clear stale lockout state when user re-authenticates
4c265a5f16  fix: preserve Telegram word boundaries when rechunking HTML (#47274)
26e0a3ee9a  fix(gateway): skip Control UI pairing when auth.mode=none (#42931, #47148)
92fc8065e9  fix(gateway): remove re-introduced auth.mode=none pairing bypass
f783101735  fix: accept session_status sessionKey=current alias (#39574)
9d3e653ec9  fix(web): handle 515 Stream Error during WhatsApp QR pairing (#27910)
843e3c1efb  fix(whatsapp): restore append recency filter lost in extensions refactor
ce19a41f52  fix(synology-chat): scope DM sessions by account
abd948f2b7  fix(whatsapp): preserve watchdog message age across reconnects
6a458ef29e  fix: harden compaction timeout follow-ups
f4dbd78afd  Add Feishu reactions and card action support (#46692)
4bb8a65edd  fix(android): support android node calllog.search (#44073)
29f3b7f6eb  fix: harden image auth env lookups (#52552)
d9bc1920ed  fix(feishu): clear stale streamingStartPromise on card creation failure
8a607d7553  fix(feishu): fetch thread context so AI can see bot replies in topic threads
4fd7feb0fd  fix(media): block remote-host file URLs in loaders
93880717f1  fix(media): harden secondary local path seams
30ed4342b3  fix(agents): deny local MEDIA paths for MCP results
8701a224f8  fix(plugins): distinguish missing entry file from security violation
```

#### Operator1 Impact

- **Control UI scopes** (`9d7719e8f0`, `fa0a9ce2af`): **CONFIRMED operator1
  BUG**. Current `ui/src/ui/gateway.ts:245` only declares `["operator.admin",
"operator.approvals", "operator.pairing"]`. The dashboard webchat cannot send
  messages or read session state. Adopting this fix unblocks the built-in
  webchat. Priority: critical.

- **Memory tools coupled failure** (`b186d9847c`): `extensions/memory-core/` is
  present in operator1. If memory_get is missing, memory_search is also
  suppressed. Fix registers tools independently.

- **Session manager cache growth** (`ef3f64952a`, `30090e4895`): Prevents
  unbounded memory use in long-running gateway sessions. Directly relevant to
  operator1's production gateway.

- **ACP hidden thought chunks** (`32fdd21c80`, `742c005ac8`): Thought/reasoning
  content is lost when sessions are reloaded via acpx. operator1 uses acpx
  (`extensions/acpx/`). Fix preserves reasoning content through session reload.

- **Discord dedup inbound** (`432e8943ad`): operator1 has Discord channel
  (`extensions/discord/`). Prevents duplicate message processing on reconnect.

- **Compaction guards** (`5c05347d11`, `2fe0efc9e1`, `ef7a5c3546`): Fixes
  false-positive compaction cancellations in heartbeat sessions, budget overflow
  on large sessions, and memory flush dedup using content hash instead of
  compaction count. All affect operator1's long-running sessions.

- **Telegram message fixes** (`bf12835995`, `b264d73dc2`, `6237cfc6a6`,
  `95fec668a0`, `988bd782f7`, `4c265a5f16`): Multiple Telegram fixes critical
  for operator1's primary channel: optional buttons schema, allow-sending-
  without-reply to prevent message loss, reply context text preservation, topic
  announcement delivery, and HTML word boundary rechunking.

- **OpenAI-compatible tool dedup** (`5c9983618e`): Deduplicates repeated
  tool_call_id values for non-native OpenAI endpoints (many operator1 models
  use this path).

- **Strict mode tools for non-native APIs** (`9616d1e8ba`): Disables strict
  tool-definition fields for providers that reject the option. Affects operator1
  users on non-OpenAI-compatible providers.

- **Gateway Bonjour fail-closed** (`deecf68b59`): TXT-only service discovery
  hints can no longer steer routing. Relevant to operator1's local network
  gateway discovery.

- **WhatsApp append recency filter** (`843e3c1efb`): Fixes a regression from
  the channel-to-extensions refactor. operator1 has WhatsApp (`extensions/`).

- **Feishu thread context** (`8a607d7553`): Bot replies now visible in AI thread
  context for Feishu topic threads. operator1 uses Feishu (`extensions/feishu/`).

**Conflict risk:** Medium-high. Expect conflicts in `extensions/telegram/`,
`src/auto-reply/`, `src/agents/`, and `src/gateway/`.

**Recommendation:** If this phase exceeds 30 conflicts, split into:

- `bugfixes-1`: gateway, agent, compaction, control-ui fixes
- `bugfixes-2`: channel-specific (telegram, discord, whatsapp, feishu) fixes

---

### Phase 3: Features (80 commits)

**Branch:** `sync/v2026.3.22-features`
**Risk:** High — many features depend on the Phase 4 provider-refactor landing
first. Review dependency order carefully.

The features list is large but partitioned into two tiers: operator1 wants
(high adoption priority) and operator1 will evaluate (lower priority).

#### Tier 1 — Adopt (direct operator1 value)

```
2b68d20ab3  feat: notify user when context compaction starts and completes (#38805)
fd2b3ed6af  feat(memory): pluggable system prompt section for memory plugins (#40126)
9aac55d306  Add /btw side questions (#45444)
ba6064cc22  feat(gateway): make health monitor stale/max-restarts configurable (#42107)
2806f2b878  Heartbeat: add isolatedSession option for fresh session per heartbeat
f8bcfb9d73  feat(skills): preserve all skills in prompt via compact fallback (#47553)
c6968c39d6  feat(compaction): truncate session JSONL after compaction (#41021)
faa8907dd8  feat: make compaction timeout configurable via agents.defaults (#46889)
6e7855fdf5  feat(xai): support fast mode
9c0983618e  feat(models): sync pi provider catalogs
f7bc9818b5  feat(minimax): support fast mode and sync pi defaults
45ede8729e  feat(mistral): add curated catalog models
5c8e1275a0  feat(minimax): add missing pi catalog models
466debb75c  feat(telegram): auto-rename DM topics on first message (#51502)
6b4c24c2e5  feat(telegram): support custom apiRoot for alternative API endpoints (#48842)
6a8f5bc12f  feat(telegram): add configurable silent error replies (#19776)
e78129a4d9  feat(context-engine): pass incoming prompt to assemble (#50848)
751d5b7849  feat: add context engine transcript maintenance (#51191)
5607da90d5  feat: pass modelId to context engine assemble() (#47437)
7f0f8dd268  feat: expose context-engine compaction delegate helper (#49061)
e7d9648fba  feat(cron): support custom session IDs and auto-bind to current session (#16511)
c9449d77b4  feat(gateway): persist webchat inbound images to disk (#51324)
36c6d44eca  feat(ui): add multi-session selection and deletion (#51924)
a5309b6f93  feat(usage): improve usage overview styling and localization (#51951)
5137a51307  feat(github-copilot): resolve any model ID dynamically (#51325)
df3a247db2  feat(feishu): structured cards with identity header/note footer (#29938)
89e3969d64  feat(feishu): add ACP and subagent session binding (#46819)
9e8df16732  feat(feishu): add reasoning stream support to streaming cards (#46029)
f4dbd78afd  Add Feishu reactions and card action support (#46692)
```

#### Tier 2 — Evaluate (operator1-specific decision needed)

```
6e20c4baa0  feat: add anthropic-vertex provider for Claude via GCP Vertex AI (#43356)
4f00b3b534  feat(xiaomi): add MiMo V2 Pro and MiMo V2 Omni models (#49214)
c57b750be4  feat(provider): support new model zai glm-5-turbo (#46670)
b36e456b09  feat: add Tavily as a bundled web search plugin (#49200)
1042b59471  feat(web-search): add bundled Exa plugin (#52617)
c6ca11e5a5  feat(web-search): add DuckDuckGo bundled plugin (#52629)
ae7f18e503  feat: add firecrawl onboarding search plugin
a724bbce1a  feat: add bundled Chutes extension (#49136)
0aff1c7630  feat(agents): infer image generation defaults
3a456678ee  feat(image-generation): add image_generate tool
618d35f933  feat(google): add image generation provider
aa2d5aaa0c  feat(plugins): add image generation capability
50c3321d2e  feat(media): route image tool through media providers
f4fa84aea7  feat(plugins): tighten media runtime integration
c081dc52b7  feat(plugins): move media understanding into vendor plugins
3e010e280a  feat(plugins): add media understanding provider registration
57f1ab1fca  feat(tts): enrich speech voice metadata
622f13253b  feat(tts): add microsoft voice listing
85781353ec  feat(plugins): expand speech runtime ownership
662031a88e  feat(plugins): add speech provider registration
4ac355babb  feat(gateway): add talk speak rpc
84ee6fbb76  feat(tts): add in-memory speech synthesis
aa28d1c711  feat: add firecrawl onboarding search plugin
46482a283a  feat: add nostr setup and unify channel setup discovery
a8907d80dd  feat: finish xai provider integration
2145eb5908  feat(mattermost): add retry logic and timeout handling for DM creation (#42398)
```

#### Operator1 Impact

- **Compaction user notifications** (`2b68d20ab3`): Users in long sessions now
  get a status message when compaction starts and ends. Directly improves UX for
  operator1's power users who run multi-hour sessions.

- **Memory plugin system prompt** (`fd2b3ed6af`): `extensions/memory-core/` and
  `extensions/memory-lancedb/` in operator1 can now register their own system
  prompt section. Critical for memory-backed agents.

- **Heartbeat isolatedSession** (`2806f2b878`): Each heartbeat run gets a fresh
  session, reducing per-heartbeat token cost from ~100K to ~2-5K. Major cost
  reduction for operator1's scheduled heartbeat agents.

- **Health monitor configurable** (`ba6064cc22`): Per-channel and per-account
  health monitor overrides. Directly addresses operator1's need to tune
  `channelHealthCheckMinutes` per channel.

- **JSONL truncation after compaction** (`c6968c39d6`): Prevents unbounded
  session file growth in long-running operator1 agents. This is a must-have.

- **Skills prompt compact fallback** (`f8bcfb9d73`): Prevents skill catalog
  truncation from dropping entries. operator1's multi-skill agents benefit
  directly.

- **Telegram topic auto-rename** (`466debb75c`): Operators using Telegram forum
  topics get LLM-generated labels — improves discoverability.

- **Telegram custom apiRoot** (`6b4c24c2e5`): Supports proxied or self-hosted
  Telegram Bot API. Useful for operator1 deployments behind firewalls.

- **Context engine transcript maintenance** (`751d5b7849`): Fixes transcript
  overflow recovery. Relevant to any operator1 custom context engine plugin.

- **Image generation native tool** (`3a456678ee`, `618d35f933`): Replaces
  nano-banana-pro skill with a proper `image_generate` tool. If operator1 uses
  image generation, adopt this. Note: the old skill is removed (breaking change).

- **Cron custom session IDs** (`e7d9648fba`): Allows cron tasks to bind to
  specific sessions and inherit session context. Improves operator1's scheduling
  workflows.

**Dependency note:** Many Phase 3 feature commits depend on the Phase 4
provider-plugin refactor being in place. In particular:

- `feat(plugins): add image generation capability` requires `feat(plugins): move
media understanding into vendor plugins`
- Speech/TTS features require the speech provider plugin registration
- Web search features require bundled plugin infrastructure

**Conflict risk:** Medium. Concentrated in `src/auto-reply/`, `extensions/telegram/`,
`src/agents/`, `src/gateway/`. The image generation feature cluster touches many
new files (low conflict, high integration risk).

---

### Phase 4: Provider Refactor (220 commits)

**Branch:** `sync/v2026.3.22-provider-refactor`
**Risk:** Very high — this is the largest structural change in the release.
Split into two sub-phases is strongly recommended.

#### Sub-phase 4a: Channel-to-Extensions Migration

The channel shim directories (`src/telegram/`, `src/discord/`, `src/slack/`,
`src/signal/`, `src/imessage/`, `src/web/`) were removed upstream. All imports
now go directly to `extensions/`. This was a 112+ file update in one commit.

```
439c21e078  refactor: remove channel shim directories, point all imports to extensions (#45967)
5682ec37fa  refactor: move Discord channel implementation to extensions/ (#45660)
e5bca0832f  refactor: move Telegram channel implementation to extensions/ (#45635)
8746362f5e  refactor(slack): move Slack channel code to extensions/slack/src/ (#45621)
16505718e8  refactor: move WhatsApp channel implementation to extensions/ (#45725)
0ce23dc62d  refactor: move iMessage channel to extensions/imessage (#45539)
4540c6b3bc  refactor(signal): move Signal channel code to extensions/signal/src/ (#45531)
7764f717e9  refactor: make OutboundSendDeps dynamic with channel-ID keys (#45517)
62b7b350c9  refactor: move bundled channel deps to plugin packages
8240fd900a  Plugin SDK: route core channel runtimes through public subpaths
27f655ed11  refactor: deduplicate channel runtime helpers
```

**operator1 Architectural Divergence Alert:** operator1 completed the channels-
to-extensions migration in the v2026.3.13-1 sync. Check whether operator1's
shim directories already point to extensions or if this refactor conflicts with
our existing structure. Verify:

```bash
ls src/telegram/ src/discord/ src/slack/ src/signal/ src/imessage/ 2>/dev/null
```

#### Sub-phase 4b: Provider-to-Plugins Migration

Providers (Anthropic, OpenAI, OpenRouter, Codex, MiniMax, etc.) moved from
`src/agents/models-config.providers.ts` into bundled plugin packages under
`extensions/`. This is the `openclaw/plugin-sdk/*` breaking change.

```
ee7ecb2dd4  feat(plugins): move anthropic and openai vendors to plugins
4adcfa3256  feat(plugins): move provider runtimes into bundled plugins
4a0f72866b  feat(plugins): move provider runtimes into bundled plugins (v2)
684e5ea249  build(plugins): add bundled provider plugin packages
392ddb56e2  build(plugins): add bundled provider plugin manifests
8d9686bd0f  feat!: prefer clawhub plugin installs before npm
aa80b1eb7c  feat(cli): unify hook pack installs under plugins
91b2800241  feat: add native clawhub install flows
265386cd6b  feat(plugins): register claude bundle commands natively
a83b7bca15  refactor(plugin-sdk): route core provider and telegram seams through sdk barrels
2131981230  refactor(plugins): move remaining channel and provider ownership out of src
42837a04bf  fix(models): preserve stream usage compat opt-ins (#45733)
c74042ba04  Commands: lazy-load auth choice plugin provider runtime (#47692)
b810e94a17  Commands: lazy-load non-interactive plugin provider runtime (#47593)
438991b6a4  Commands: lazy-load model picker provider runtime (#47536)
```

#### Sub-phase 4c: Chat Plugin Builder Pattern

Multiple channels adopt the new `chat plugin builder` pattern, replacing
per-channel manual plugin wiring:

```
c454fe0fb3  refactor: adopt chat plugin builder in whatsapp
ec232aca39  refactor: adopt chat plugin builder in twitch
18c4a00b6f  refactor: adopt chat plugin builder in synology chat
7f65b3463b  refactor: simplify chat plugin pairing configs
3365f2e157  refactor: adopt chat plugin builder in feishu
ad5e3f0cd5  refactor: adopt chat plugin builder in msteams
7709aa33d8  refactor: adopt chat plugin builder in matrix
5a8f77aa6a  refactor: adopt chat plugin builder in zalouser
8395d5cca2  refactor: adopt chat plugin builder in bluebubbles
6ba9764b0f  refactor: adopt chat plugin builder in zalo
523b76c6c1  refactor: adopt chat plugin builder in slack
f1975c0c0a  refactor: adopt chat plugin builder in discord
a4047bf148  refactor: move telegram onboarding to setup wizard
```

#### Sub-phase 4d: TTS / Media / Image Providers-to-Plugins

```
3dcc802fe5  refactor(media): move deepgram and groq providers into plugins
0f54ca20aa  refactor(image-generation): move provider builders into plugins
de6bf58e79  refactor(tts): move speech providers into plugins
1d08ad4bac  refactor(tts): remove legacy core speech builders
```

#### Sub-phase 4e: Outbound and Delivery Refactors

```
562e4a1791  refactor(outbound): split delivery queue storage and recovery
c5a941a506  refactor!: remove moltbot state-dir migration fallback
6b9915a106  refactor!: drop legacy CLAWDBOT env compatibility
03f18ec043  Outbound: remove channel-specific message action fallbacks
5e417b44e1  Outbound: skip broadcast channel scan when channel is explicit
```

#### Operator1 Impact

- **Plugin SDK breaking change**: operator1's custom extensions that import
  from `openclaw/extension-api` will fail at build time. Must audit all
  operator1-specific extensions (especially `extensions/diagnostics-otel/`,
  `extensions/thread-ownership/`, `extensions/llm-task/`) before adopting.

- **Provider migration**: `src/agents/models-config.providers.ts` will be
  significantly smaller. The Anthropic, OpenAI, MiniMax, and OpenRouter
  providers now load via plugin hooks. This changes how provider errors surface
  and how model catalogs are rebuilt. Verify `pnpm test` after this phase.

- **OutboundSendDeps dynamic**: The `{sendTelegram, sendDiscord, ...}` static
  struct is replaced with `{[channelId: string]: unknown}`. If operator1 has
  any custom code that references these fields directly, it will break.

- **MOLTBOT/CLAWDBOT removal**: Low risk for operator1 — already using
  OPENCLAW\_\* env vars.

**Batch recommendation:** Split into 4a+4b as Phase 4, then 4c+4d+4e as
Phase 4 part 2 if conflicts are high. Keep provider-to-plugins (4b) together
as it has many cross-file dependencies.

**Protected files to watch:**

- `src/agents/models-config.providers.ts` — verify operator1 model overrides
  survive the migration
- `package.json` exports — new `./plugin-sdk/*` subpaths added; missing = all
  extensions fail
- `src/gateway/server-methods.ts` — new handlers may be added
- `src/gateway/method-scopes.ts` — new method scopes required

---

### Phase 5: Review Items (12 commits)

**Branch:** `sync/v2026.3.22-review`
**Risk:** Varies. User decision required before cherry-picking.

These commits require a deliberate operator1 decision: they touch architectural
patterns where operator1 has diverged, or they involve trade-offs.

#### Review Items

| SHA           | Commit                                                                                              | Decision needed                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `c5a941a506`  | `refactor!: remove moltbot state-dir migration fallback`                                            | Safe to take — operator1 already uses SQLite. Confirm no `.moltbot` dir on any deployment.                                                             |
| `6b9915a106`  | `refactor!: drop legacy CLAWDBOT env compatibility`                                                 | Safe to take — operator1 uses `OPENCLAW_*`.                                                                                                            |
| `3704293e6f`  | `browser: drop headless/remote MCP attach modes (#46596)`                                           | **EVALUATE**. If any operator1 agents use headless browser MCP, this removes that path. Only `existing-session` / `user` profiles survive.             |
| `b1d8737017`  | `browser: drop chrome-relay auto-creation`                                                          | Bundled Chrome extension relay removed. If operator1 uses browser tools, verify workflows still work.                                                  |
| `8d9686bd0f`  | `feat!: prefer clawhub plugin installs before npm`                                                  | ClawHub-first install order is a behavior change for `openclaw plugins install`. Review impact on operator1's deployment automation.                   |
| `c6e32835d4`  | `fix(gateway): skip device pairing when auth.mode=none`                                             | **CONFLICTING** with later `92fc8065e9` which reverts this. Cherry-pick `92fc8065e9` only (reverted version). Confirm auth.mode=none behavior desired. |
| `9bffa3422c`  | `fix(gateway): skip device pairing when auth.mode=none` (original)                                  | Do NOT cherry-pick — superseded by `92fc8065e9` revert.                                                                                                |
| `92fc8065e9`  | `fix(gateway): remove re-introduced auth.mode=none pairing bypass`                                  | Take this — it is the correct final state.                                                                                                             |
| `7abfff756d`  | `Exec: harden host env override handling (#51207)`                                                  | Tightens env propagation in gateway and node. Verify operator1's LaunchAgent env setup still works.                                                    |
| `f77a684131`  | `feat: make compaction timeout configurable via agents.defaults.compaction.timeoutSeconds (#46889)` | Adopt — adds config knob.                                                                                                                              |
| `26e0a3ee9a`  | `fix(gateway): skip Control UI pairing when auth.mode=none (#42931, #47148)`                        | Take this — fixes pairing bypass. Aligns with the `92fc8065e9` final state.                                                                            |
| `d9039add663` | `Slack: preserve interactive reply blocks in DMs (#45890)`                                          | Take — operator1 uses Slack.                                                                                                                           |

#### Operator1 Impact

- **Browser MCP path removal**: If any operator1 automation uses
  `driver: "extension"` or `browser.relayBindHost`, these config keys are now
  dead. Run `openclaw doctor --fix` on adoption.

- **auth.mode=none pairing behavior**: The commit/revert pair means the final
  correct behavior is: pairing IS skipped when `auth.mode=none`. Take only
  `92fc8065e9` and `26e0a3ee9a`; skip `9bffa3422c` and `c6e32835d4`.

- **Exec env override**: `7abfff756d` changes how the gateway populates the
  process env in node mode. Verify the LaunchAgent `EnvironmentVariables` plist
  still propagates correctly post-adoption.

---

### Phase 6: UI Inspiration (9 commits)

**Branch:** `sync/v2026.3.22-ui-inspiration` (draft PR)
**Risk:** Low — reference only.

These commits are cherry-picked to a draft branch as design reference for
ui-next development. Build must pass but test failures from incomplete
integration are acceptable.

```
e9f715f27b  UI: fix and optimize overview log panels (#51477)
5eea523f39  UI: remove dead control UI modules
5464ad113e  UI: expand-to-canvas, session navigation, plugin SDK fixes (#49483)
4e94f3aa02  UI: mute colored focus ring on agent chat textarea
e5eda19db2  UI: fix redundant applyBorderRadius call (#49443)
df72ca1ece  UI: add corner radius slider and appearance polish (#49436)
25e6cd38b6  UI: mute sidebar and chat input accent colors (#49390)
30c31d4efd  UI: keep thinking helpers browser-safe
39377b7a20  UI: surface gateway restart reasons in dashboard disconnect state (#46580)
```

#### Operator1 Impact

- **Corner radius slider** (`df72ca1ece`): New Appearance settings UI — good
  inspiration for ui-next theme controls.
- **Expand-to-canvas** (`5464ad113e`): In-app session navigation from Sessions
  and Cron views — directly applicable to ui-next chat page.
- **Gateway restart reason** (`39377b7a20`): Better disconnect state UX — model
  for ui-next dashboard connection indicator.
- **Overview log panel** (`e9f715f27b`): CSS improvements for event log display.

---

## Risk Assessment

### Conflict-Prone Files

| File                                    | Risk      | Strategy                                                                                                              |
| --------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/agents/models-config.providers.ts` | Very high | Provider-to-plugins refactor restructures this file. Keep operator1 model overrides; take upstream structure.         |
| `src/gateway/server-methods.ts`         | High      | New handlers for image_generate, talk.speak, plugin commands. Use append-only strategy — take all upstream additions. |
| `src/gateway/method-scopes.ts`          | High      | New scopes for new methods. Append-only.                                                                              |
| `package.json` exports                  | High      | New `./plugin-sdk/*` subpaths. Append-only — do not drop any.                                                         |
| `ui/src/ui/gateway.ts`                  | Medium    | Scope fix is critical; take it.                                                                                       |
| `extensions/telegram/src/`              | Medium    | Multiple Telegram fixes touch fetch.ts and channel.ts.                                                                |
| `src/auto-reply/reply/commands-acp.ts`  | Medium    | ACP scope gates and ACP hidden thought fix.                                                                           |
| `src/infra/net/fetch-guard.ts`          | Medium    | SSRF pinning changes.                                                                                                 |
| `src/agents/failover-error.ts`          | Low       | RESOURCE_EXHAUSTED normalization.                                                                                     |

### Protected-Files Verification Checklist

After each phase merge:

1. `src/gateway/server-methods.ts` — all handlers imported and spread
2. `src/gateway/server-methods-list.ts` — all method names in BASE_METHODS
3. `src/gateway/method-scopes.ts` — all methods have scope entries
4. `package.json` exports — all `./plugin-sdk/*` subpaths present

### Dependency Chains

The following commit dependencies must be respected:

- Phase 4 (provider-to-plugins) must complete before Phase 3 image generation
  features can be tested cleanly.
- The auth.mode=none commits must be taken as a group: take `26e0a3ee9a` + `92fc8065e9`,
  skip `9bffa3422c` + `c6e32835d4`.
- `439c21e078` (remove shim dirs) depends on individual channel moves
  (`5682ec37fa`, `e5bca0832f`, `8746362f5e`, `16505718e8`, `0ce23dc62d`,
  `4540c6b3bc`) — cherry-pick all channel moves before the shim removal.

---

## Estimated Effort

| Phase                       | Commits   | Estimated Days | Notes                                               |
| --------------------------- | --------- | -------------- | --------------------------------------------------- |
| Phase 1 — Security          | 24        | 0.5            | Mostly clean; few conflict-prone files              |
| Phase 2 — Bug Fixes         | 180       | 2-3            | Large; likely needs 2 sub-phases                    |
| Phase 3 — Features          | 80        | 2              | Depends on Phase 4; image_generate integration risk |
| Phase 4 — Provider Refactor | 220       | 3-4            | Very large; recommend 2 sub-phases                  |
| Phase 5 — Review            | 12        | 0.5            | Small; user decisions needed first                  |
| Phase 6 — UI Inspiration    | 9         | 0.5            | Draft only; reference branch                        |
| **Total**                   | **525\*** | **~9 days**    |                                                     |

\*525 is the planned cherry-pick count. The remaining ~1,996 commits are test
infrastructure, documentation, CI, style/format changes that are adopted
wholesale as part of the provider-refactor and bug-fix phases (they come along
with the commits they support).

---

## Recommended Phasing Order

Given the dependency graph above, the recommended execution order is:

1. **Phase 1 (Security)** — no dependencies; execute first
2. **Phase 4 (Provider Refactor)** — must come before image generation features
3. **Phase 2 (Bug Fixes)** — most fixes work after the refactor is in
4. **Phase 3 (Features)** — now that providers are plugins, features wire cleanly
5. **Phase 5 (Review)** — small batch, user decisions first
6. **Phase 6 (UI Inspiration)** — draft branch; can run anytime

---

## Pre-Sync Checklist

Before starting Phase 1:

- [ ] Confirm backup tag created: `backup/pre-sync-v2026.3.22-<date>`
- [ ] Verify no local uncommitted changes on main
- [ ] Record test baseline: `pnpm test 2>&1 | grep "Test Files"`
- [ ] Check for any `extensions/` imports of `openclaw/extension-api` (will break)
- [ ] Verify `ls src/telegram/ src/discord/` returns empty or non-existent
      (confirms prior channel migration is complete)
- [ ] Confirm `OPENCLAW_*` env vars in use (not `CLAWDBOT_*` / `MOLTBOT_*`)

---

## Post-Sync Verification

After each phase merge:

1. `pnpm build` must pass
2. `pnpm test` — compare against baseline
3. `cd ui-next && pnpm build` must pass
4. Check `sessions.list` RPC returns correct results (smoke test SQLite/JSON
   divergence)
5. Verify `src/gateway/server-methods.ts` append-only registry is complete
6. Check `package.json` exports for `./plugin-sdk/*` completeness

---

_Report generated 2026-03-24. Status: pending-approval._
