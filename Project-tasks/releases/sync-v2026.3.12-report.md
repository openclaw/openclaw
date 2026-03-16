---
title: "Upstream Sync Report: v2026.3.12"
type: sync-report
status: pending-approval
fromTag: v2026.3.8
targetTag: v2026.3.12
date: 2026-03-16
commits_total: 427
phases:
  security: 34
  bugfixes: 75
  features: 11
  provider-refactor: 8
  review: 20
  ui-inspiration: 6
commits_skip: 30
---

# Upstream Sync Report: v2026.3.8 → v2026.3.12

**Date:** 2026-03-16
**Total upstream commits:** 427
**Upstream releases covered:** v2026.3.11 (235 commits), v2026.3.12 (192 additional)

---

## Phase 1: Security (34 commits)

Cherry-pick unconditionally. Branch: `sync/v2026.3.12-security`

```
496ca3a637 fix(feishu): fail closed on webhook signature checks
7844bc89a1 Security: require Feishu webhook encrypt key (#44087)
3e730c0332 Security: preserve Feishu reaction chat type (#44088)
eff0d5a947 Hardening: tighten preauth WebSocket handshake limits (#44089)
48cbfdfac0 Hardening: require LINE webhook signatures (#44090)
99170e2408 Hardening: normalize Unicode command obfuscation detection (#44091)
2504cb6a1e Security: escape invisible exec approval format chars (#43687)
1dcef7b644 Infra: block GIT_EXEC_PATH in host env sanitizer (#43685)
4f462facda Infra: cap device tokens to approved scopes (#43686)
d8d8dc7421 Infra: fail closed without device scope baseline
d30dc28b8c Secrets: reject exec SecretRef traversal ids (#42370)
8eac939417 fix(security): enforce target account configWrites
7289c19f1a fix(security): bind system.run approvals to exact argv text
702f6f3305 fix: fail closed for unresolved local gateway auth refs
11924a7026 fix(sandbox): pin fs-bridge staged writes
ecdbd8aa52 fix(security): restrict leaf subagent control scope
aad014c7c1 fix: harden subagent control boundaries
a0d5462571 fix(security): pin staged writes and fs mutations
0125ce1f44 Gateway: fail closed unresolved local auth SecretRefs (#42672)
b2e21e3792 fix(security): strip Mongolian selectors in exec obfuscation detector
9692dc7668 fix(security): harden nodes owner-only tool gating
bf89947a8e fix: switch pairing setup codes to bootstrap tokens
f37815b323 Gateway: block profile mutations via browser.request (#43800)
46a332385d Gateway: keep spawned workspace overrides internal (#43801)
36d2ae2a22 SecretRef: harden custom/provider secret persistence and reuse (#42554)
f0eb67923c fix(secrets): resolve web tool SecretRefs atomically at runtime
ebed3bbde1 fix(gateway): enforce browser origin check regardless of proxy headers
8661c271e9 Gateway: preserve trusted-proxy browser scopes
7dc447f79f fix(gateway): strip unbound scopes for shared-auth connects
5e389d5e7c Gateway/ws: clear unbound scopes for shared-token auth (#44306)
82e3ac21ee Infra: tighten exec allowlist glob matching (#43798)
62d5df28dc fix(agents): add nodes to owner-only tool policy fallbacks
dafd61b5c1 fix(gateway): enforce caller-scope subsetting in device.token.rotate
4da617e178 fix(gateway): honor trusted proxy hook auth rate limits
```

---

## Phase 2: Bug Fixes (~75 commits)

Cherry-pick if we're affected. Branch: `sync/v2026.3.12-bugfixes`

```
309162f9a2 fix: strip leaked model control tokens from user-facing text (#42173)
2a18cbb110 fix(agents): prevent false billing error replacing valid response text (#40616)
58634c9c65 fix(agents): check billing errors before context overflow heuristics (#40409)
4473242b4f fix: use unknown instead of rate_limit as default cooldown reason (#42911)
e9e8b81939 fix(failover): classify Gemini MALFORMED_RESPONSE as retryable timeout (#42292)
c9a6c542ef Add HTTP 499 to transient error codes for model fallback (#41468)
7332e6d609 fix(failover): classify HTTP 422 as format and OpenRouter credits as billing (#43823)
fd568c4f74 fix(failover): classify ZenMux quota-refresh 402 as rate_limit (#43917)
d93db0fc13 fix(failover): classify z.ai network_error stop reason as retryable timeout (#43884)
f640326e31 fix(failover): add missing network errno patterns to text-based timeout classifier (#42830)
128e5bc317 fix: recognize Venice 402 billing errors for model fallback (#43205)
8bf64f219a fix: recognize Poe 402 'used up your points' as billing for fallback (#42278)
048e25c2b2 fix(agents): avoid duplicate same-provider cooldown probes in fallback runs (#41711)
5f90883ad3 fix(auth): reset cooldown error counters on expiry to prevent infinite escalation (#41028)
53374394fb Fix stale runtime model reuse on session reset (#41173)
4ca84acf24 fix(runtime): duplicate messages, share singleton state across bundled chunks (#43683)
54be30ef89 fix(agents): bound compaction retry wait and drain embedded runs on restart (#40324)
f01c41b27a fix(context-engine): guard compact() throw + fire hooks for ownsCompaction engines (#41361)
9cd54ea882 fix: skip cache-ttl append after compaction to prevent double compaction (#28548)
ff47876e61 fix: carry observed overflow token counts into compaction (#40357)
d68d4362ee fix(context-pruning): cover image-only tool-result pruning
a78674f115 fix(context-pruning): prune image-containing tool results instead of skipping them (#41789)
8306eabf85 fix(agents): forward memory flush write path (#41761)
96e4975922 fix: protect bootstrap files during memory flush (#38574)
c2d9386796 fix: log auth profile resolution failures instead of swallowing silently (#41271)
bc9b35d6ce fix(logging): include model and provider in overload/error log (#41236)
bfeea5d23f fix(agents): prevent /v1beta duplication in Gemini PDF URL (#34369)
25c2facc2b fix(agents): fix Brave llm-context empty snippets (#41387)
d8ee97c466 Agents: recover malformed Anthropic-compatible tool call args (#42835)
9aeaa19e9e Agents: clear invalidated Kimi tool arg repair (#43824)
0669b0ddc2 fix(agents): probe single-provider billing cooldowns (#41422)
cf9db91b61 fix(web-search): recover OpenRouter Perplexity citations from message annotations (#40881)
4133edb395 fix: restore web tools to coding profile (#43436)
cced1e0f76 preserve openai phase param
283570de4d fix: normalize stale openai completions transport
980619b9be fix: harden openai websocket replay
c8dd06cba2 fix(ws): preserve payload overrides
453c8d7c1b fix(hooks): add missing trigger and channelId to agent_end, llm_input, and llm_output hook contexts (#42362)
8cc0c9baf2 fix(gateway): run before_tool_call for HTTP tools
a1520d70ff fix(gateway): propagate real gateway client into plugin subagent runtime
a76e810193 fix(gateway): harden token fallback/reconnect behavior (#42507)
c91d1622d5 fix(gateway): split conversation reset from admin reset
20d097ac2f Gateway/Dashboard: surface config validation issues (#42664)
b3e6f92fd2 runner: infer names from malformed toolCallId variants (#34485)
0b34671de3 fix: canonicalize openrouter native model keys
f3be1c828c fix(status): resolve context window by provider-qualified key (#36389)
e525957b4f fix(sandbox): restore spawned workspace handoff (#44307)
8ea79b64d0 fix: preserve sandbox write payload stdin (#43876)
e95f2dcd6e fix(sandbox): anchor fs-bridge writeFile commit to canonical parent path
bd33a340fb fix(sandbox): sanitize Docker env before marking OPENCLAW_CLI (#42256)
3495563cfe fix(sandbox): pass real workspace to sessions_spawn when workspaceAccess is ro (#40757)
f604cbedf3 fix: remove stale allowlist matcher cache
f4a4b50cd5 refactor: compile allowlist matchers
d1a59557b5 fix(security): harden replaceMarkers() (#35983)
dc4441322f fix(agents): include azure-openai in Responses API store override (#42934)
2649c03cdb fix(hooks): dedupe repeated agent deliveries by idempotency key (#44438)
d4e59a3666 Cron: enforce cron-owned delivery contract (#40998)
2b2e5e2038 fix(cron): do not misclassify empty/NO_REPLY as interim acknowledgement (#41401)
382287026b cron: record lastErrorReason in job state (#14382)
6c196c913f fix(cron): prevent duplicate proactive delivery on transient retry (#40646)
99ec687d7a fix(agents): enforce sandboxed session_status visibility (#43754)
4790e40ac6 fix(plugins): expose model auth API to context-engine plugins (#41090)
10e6e27451 fix(models): guard optional model input capabilities (#42096)
115f24819e fix: make node-llama-cpp optional for npm installs
2f037f0930 Agents: adapt pi-ai oauth and payload hooks
ac88a39acc fix: align pi-ai 0.57.1 oauth imports and payload hooks
59bc3c6630 Agents: align onPayload callback and OAuth imports
43a10677ed fix: isolate plugin discovery env from global state
e74666cd0a build: raise extension openclaw peer floor
e6897c800b Plugins: fix env-aware root resolution and caching (#44046)
61d219cb39 feat: show status reaction during context compaction (#35474)
08aa57a3de Commands: require owner for /config and /debug (#44305)
4f620bebe5 fix(doctor): canonicalize gateway service entrypoint paths (#43882)
268a8592de fix: avoid ineffective dynamic imports
b31836317a fix(cli): handle scheduled gateway restarts consistently
7e3787517f fix: harden state dir permissions during onboard
e11be576fb fix: repair bundled plugin dirs after npm install
1435fce2de fix: tighten Ollama onboarding cloud handling (#41529)
620bae4ec7 fix(ollama): share model context discovery
e65011dc29 fix(onboard): default custom Ollama URL to native API
7217b97658 fix(onboard): avoid persisting talk fallback on fresh setup
ff2e7a2945 fix(acp): strip provider auth env for child ACP processes (#42250)
f2e28fc30f fix(telegram): allow fallback models in /model validation (#40105)
fbc66324ee fix: harden archive extraction destinations
201420a7ee fix: harden secret-file readers
87876a3e36 Fix env proxy bootstrap for model traffic (#43248)
6d4241cbd9 fix: wire modelstudio env discovery (#40634)
0bcb95e8fa Models: enforce source-managed SecretRef markers in models.json (#43759)
50cc375c11 feat(context-engine): plumb sessionKey into all ContextEngine methods (#44157)
143e593ab8 Compaction Runner: wire post-compaction memory sync (#25561)
688e3f0863 Compaction Runner: emit transcript updates post-compact (#25558)
8ad0ca309e Subagents: stop retrying external completion timeouts (#41235)
```

---

## Phase 3: Features (11 commits)

Evaluate and adopt. Branch: `sync/v2026.3.12-features`

```
35aafd7ca8 feat: add Anthropic fast mode support
d5bffcdeab feat: add fast mode toggle for OpenAI models
60aed95346 feat(memory): add gemini-embedding-2-preview support (#42501)
d79ca52960 Memory: add multimodal image and audio indexing (#43460)
01ffc5db24 memory: normalize Gemini embeddings (#43409)
3fa91cd69d feat: add sessions_yield tool for cooperative turn-ending (#36537)
b77b7485e0 feat(push): add iOS APNs relay gateway (#43369)
aca216bfcf feat(acp): add resumeSessionId to sessions_spawn (#41847)
42efd98ff8 Slack: support Block Kit payloads in agent replies (#44592)
658bd54ecf feat(llm-task): add thinking override
de49a8b72c Telegram: exec approvals for OpenCode/Codex (#37233)
```

---

## Phase 4: Provider Plugin Refactor (8 commits)

Align with upstream architecture. Branch: `sync/v2026.3.12-provider-refactor`

Apply in this order (dependency chain):

```
d83491e751 feat: modularize provider plugin architecture
87ad1ce9b1 refactor: add non-interactive provider plugin setup
300a093121 refactor: split simple api-key auth providers
fd2b06d463 refactor: split non-interactive auth choice providers
21d1032ca4 refactor: remove legacy provider apply shims
7fd4dea1af refactor: share openai-compatible local discovery
5716e52417 refactor: unify gateway credential planning
c80da4e72f refactor: validate provider plugin metadata
```

---

## Phase 5: Review Items (~20 commits)

Need triage — adopt or skip. Branch: `sync/v2026.3.12-review`

```
9c81c31232 chore: refresh dependencies except carbon — REVIEW: check patched dep overlap
4dd4e36450 build: update deps and fix vitest 4 regressions — REVIEW: same concern
268e036172 refactor(test): share hook request handler fixtures — REVIEW: test infra
eece586747 refactor(security): reuse hook agent routing normalization — REVIEW: security dep
445ff0242e refactor(gateway): cache hook proxy config in runtime state — REVIEW: dep of 4da617e178
1d986f1c01 refactor(gateway): move request client ip resolution to net — REVIEW: gateway refactor
3c3474360b acp: harden follow-up reliability and attachments (#41464) — REVIEW: ACP path
425bd89b48 Allow ACP sessions.patch lineage fields on ACP session keys — REVIEW: ACP protocol
4aebff78bc acp: forward attachments into ACP runtime sessions — REVIEW: ACP
8e3f3bc3cf acp: enrich streaming updates for ide clients — REVIEW: ACP
d346f2d9ce acp: restore session context and controls — REVIEW: ACP
e6e4169e82 acp: fail honestly in bridge mode — REVIEW: ACP
1bc59cc09d Gateway: tighten node pending drain semantics — REVIEW: gateway
ef95975411 Gateway: add pending node work primitives — REVIEW: gateway
60c1577860 Gateway: preserve discovered session store paths — REVIEW: gateway
46f0bfc55b Gateway: harden custom session-store discovery (#44176) — REVIEW: gateway
5ca780fa78 feat: expose runtime version in gateway status — REVIEW: adds server-method
d4e59a3666 Cron/hooks delivery contract — REVIEW: touches hooks/cron
0687e04760 fix: thread runtime config through Discord/Telegram sends (#42352) — REVIEW: channel send path
904db27019 fix(security): audit unrestricted hook agent routing — REVIEW: security-adjacent
```

---

## Phase 6: UI Inspiration (6 commits)

Dashboard-v2 commits for reference. Branch: `sync/v2026.3.12-ui-inspiration` (draft PR)

```
5a659b0b61 feat(ui): add chat infrastructure modules (slice 1 of dashboard-v2)
6b87489890 Revert "feat(ui): add chat infrastructure modules (slice 1 of dashboard-v2)"
c5ea6134d0 feat(ui): add chat infrastructure modules (slice 1/3 of dashboard-v2) (#41497)
46cb73da37 feat(ui): utilities, theming, and i18n updates (slice 2/3 of dashboard-v2) (#41500)
f76a3c5225 feat(ui): dashboard-v2 views refactor (slice 3/3 of dashboard-v2) (#41503)
2d42588a18 chore(changelog): update CHANGELOG.md to include new features in dashboard-v2 (#41503)
```

---

## Skip (not cherry-picked)

### Refactors (no user-visible value, high conflict risk)

```
3a39dc4e18 refactor(security): unify config write target policy
68c674d37c refactor(security): simplify system.run approval model
72b0e00eab refactor: unify sandbox fs bridge mutations
20237358d9 refactor: clarify archive staging intent
0bac47de51 refactor: split tar.bz2 extraction helpers
9c64508822 refactor: rename tar archive preflight checker
6565ae1857 refactor: extract archive staging helpers
1df78202b9 refactor: share approval gateway client setup
bc1cc2e50f refactor: share telegram payload send flow
a455c0cc3d refactor: share passive account lifecycle helpers
50ded5052f refactor: share channel config schema fragments
4a8e039a5f refactor: share channel config security scaffolding
725958c66f refactor: share onboarding secret prompt flows
00170f8e1a refactor: share scoped account config patching
212afb6950 refactor: clarify pairing setup auth labels
01e4845f6d refactor: extract websocket handshake auth helpers
1c7ca391a8 refactor: trim bootstrap token metadata
589aca0e6d refactor: unify gateway connect auth selection
7c889e7113 Refactor: trim duplicate gateway/onboarding helpers and dead utils (#43871)
23c7fc745f refactor(agents): replace console.warn with SubsystemLogger
3ba6491659 Infra: extract backup and plugin path helpers
```

### Features we don't use

```
77a35025e8 feat: integrate Alibaba Bailian Coding Plan into onboarding wizard
2d91284fdb feat(ios): add local beta release flow
171d2df9e0 feat(mattermost): add replyToMode support
a6711afdc2 feat(zalouser): add markdown-to-Zalo text style parsing
f36d8c09f1 feat(zalouser): audit mutable group allowlists
783a0d540f fix: add zalouser outbound chunker
95eaa08781 refactor: rename bailian to modelstudio and fix review issues
```

### Build/version/docs (operator1 has own versioning)

```
f9706fde6a build: bump/sync versions
ce5dd742f8 build: bump/sync versions
c25e46a433 chore: prepare 2026.3.12 release
4fb3b88e57 docs: reorder latest release changelog
```

---

## Conflict Hotspots

| File                                 | Local commits since v2026.3.8 | Strategy                                      |
| ------------------------------------ | ----------------------------- | --------------------------------------------- |
| `src/gateway/server-methods.ts`      | 15                            | Append-only — keep operator1 handlers         |
| `src/gateway/server-methods-list.ts` | 21                            | Append-only — union both method lists         |
| `src/gateway/method-scopes.ts`       | 15                            | Append-only — merge scope entries             |
| `src/infra/state-db/schema.ts`       | 13                            | Our migration numbers win — renumber upstream |
| `package.json`                       | 18                            | Take changes, regenerate lockfile             |
| `src/gateway/server-startup.ts`      | 16                            | Manual merge                                  |

## Dependencies

- Security fix `4da617e178` (honor trusted proxy hook auth rate limits) may depend on gateway refactor `445ff0242e` (cache hook proxy config). If it doesn't apply cleanly in Phase 1, move `445ff0242e` from REVIEW to Phase 1.
- Provider refactor chain (Phase 4) must be applied in exact order shown above.
- `f4a4b50cd5` (compile allowlist matchers) is a prerequisite for `f604cbedf3` (remove stale cache) — both in Phase 2.
