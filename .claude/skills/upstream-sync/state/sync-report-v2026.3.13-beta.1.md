# Sync Plan: v2026.3.12 → v2026.3.13-beta.1

Generated: 2026-03-16
Total upstream commits: 741 (no-merge)

---

## Phase 1: Security (22 commits)

Branch: `sync/v2026.3.13-beta.1-security`

These commits ship security hardening that must land first. All are net-new hardening — no operator1 customizations affected.

```
1803d16d5c fix(auth): make device bootstrap tokens single-use to prevent scope escalation
7e49e98f79 fix(telegram): validate webhook secret before reading request body
a54bf71b4c fix(imessage): sanitize SCP remote path to prevent shell metacharacter injection
8023f4c701 fix(telegram): thread media transport policy into SSRF (#44639)
25f458a907 macOS: respect exec-approvals.json settings in gateway prompter (#13707)
28a49aaa34 fix: harden powershell wrapper detection
e2fa47f5f2 fix: tighten exec approval reply coverage
be8d51c301 fix(node-host): harden perl approval binding
fd5243c27e refactor: share discord exec approval helpers
86caf454f4 refactor: share device pair ipv4 parsing
d5d2fe1b0e test: reduce webhook auth test duplication
d062252522 test: dedupe exec approvals analysis coverage
cfc9a21957 test: extract exec approvals shell analysis coverage
bde038527c test: extract exec approvals policy coverage
8b05cd4074 test: add exec approvals store helper coverage
5f0e97b22a test: extract exec approval session target coverage
8473a29da7 refactor: share exec approval session target routing
44e1c6cc21 refactor: share exec approval script fixtures
565dc0d17b refactor: share exec approval registration context
3bf3ebf514 refactor: share exec approval dm route checks
e6a26e82ca refactor: share memory ssrf test helper
f3d4bb4103 test: simplify ssrf hostname coverage
```

Notable:

- `1803d16d5c` — device bootstrap tokens now single-use; prevents scope escalation to admin before approval
- `7e49e98f79` — Telegram webhook secret validated before body read; blocks 1 MB pre-auth body consumption
- `a54bf71b4c` — iMessage SCP path sanitized; blocks shell metacharacter injection from sender-controlled filenames
- `28a49aaa34` / `be8d51c301` — PowerShell and Perl exec approval hardening; fail-closed for preload paths

---

## Phase 2: Core (675 commits)

Branch: `sync/v2026.3.13-beta.1-core`

The bulk of the release. All bug fixes, refactors, test helpers, dependency bumps, chore commits, and docs not touching operator1-modified areas.

Summary breakdown (approximate):

- Bug fixes: ~180
- Test helper extractions/refactors: ~310
- Chore/build/docs: ~90
- Dependency bumps (non-package.json integration): ~20
- Refactors: ~75

Notable items from changelog:

- Gateway/session reset: preserve lastAccountId/lastThreadId across resets (#44773)
- Gateway/Control UI: restore operator-only device-auth bypass (#45512)
- Agents/compaction: token sanity vs full-session pre-compaction totals (#28347)
- Agents/compaction: preserve safeguard language continuity post-compaction (#10456)
- Agents/memory bootstrap: prefer MEMORY.md, fallback to memory.md — no duplicate context on Docker mounts (#26054)
- Agents/custom providers: preserve blank API keys for loopback OpenAI-compatible providers (#45631)
- Agents/Azure OpenAI: rephrase startup instruction to avoid HTTP 400 content filter hits (#43403)
- Agents/tool warnings: distinguish gated core tools from unknown plugin tools
- Config/validation: accept agents.list[].params per-agent overrides (#41171)
- Config/validation: restore tools.web.fetch.readability/firecrawl settings (#42583)
- Config/discovery: accept discovery.wideArea.domain (#35615)
- Signal/config: add channels.signal.groups schema support (#27199)
- Slack/probe: keep auth.test() stable (#44775)
- Discord/gateway startup: transient metadata fetch failures no longer crash (#44397)
- Discord/allowlists: honor raw guild_id when hydrated guild objects missing
- Telegram/media errors: redact file URLs before logging
- Telegram/inbound media: IPv4 fallback retry for IPv6-broken hosts
- Ollama/reasoning: stop leaking internal thoughts in normal replies (#45330)
- Models/google-vertex: Gemini flash-lite normalization (#42435)
- Models/OpenRouter: canonicalize native model keys across all paths
- Build/plugin-sdk: bundle subpath entries in one shared pass; stops memory blow-up (#45426)
- Cron/isolated sessions: route nested cron onto nested lane; prevents deadlock
- Delivery/dedupe: trim completed direct-cron delivery cache correctly (#44666)
- CLI/thinking help: add missing xhigh level hints to cron and agent commands (#44819)
- Feishu/event dedupe: release pre-queue marker after failed dispatch so retries recover (#43762)
- Feishu/file uploads: preserve literal UTF-8 filenames in im.file.create (#34262)
- ACP/client final-message delivery: preserve terminal assistant text snapshots (#17615)
- Sessions: create transcript file on chat.inject when missing (#36645)
- Gateway: force-stop lingering client sockets

The core phase will be split into sub-phases of at most 50 commits each (approximately 14 sub-phases: core-1 through core-14). code-guard manages the split during cherry-pick.

---

## Phase 3: Features (6 commits)

Branch: `sync/v2026.3.13-beta.1-features`

New user-facing capabilities not touching operator1-modified files.

```
8410d5a050 feat: add node-connect skill
593964560b feat(browser): add chrome MCP existing-session support
5c40c1c78a fix(browser): add browser session selection
f4fef64fc1 Gateway: treat scope-limited probe RPC as degraded reachability (#45622)
4d3a2f674b Docker: add OPENCLAW_TZ timezone support (#34119)
6a1ba52ad5 refactor: share gateway probe auth warnings
```

Notes:

- 593964560b also touches package.json; the package.json chunk for that commit will be applied in the Integration phase to avoid double-conflict; features phase applies source-code changes only.
- 8410d5a050 node-connect skill is entirely new; no conflict risk.

---

## Phase 4: Integration-sensitive (11 commits)

Branch: `sync/v2026.3.13-beta.1-integration`

These commits touch package.json (exports/deps) and src/agents/openclaw-tools.ts, both of which have operator1 customizations. Each requires careful conflict resolution.

```
94a292686c build: prepare 2026.3.13-beta.1          (package.json — version bump)
16ececf0a6 chore: bump version to 2026.3.13          (package.json — version bump)
2ce6b77205 chore: bump pi to 0.58.0                  (package.json — pi deps)
27e863ce40 chore: update dependencies                (package.json — broad dep update)
3fb629219e build(android): add auto-bump signed aab   (package.json — scripts section)
d925b0113f test: add parallels linux smoke harness    (package.json — test scripts)
4dbab064f0 test: add parallels windows smoke harness  (package.json — test scripts)
e7863d7fdd test: add parallels macos smoke harness    (package.json — test scripts)
593964560b feat(browser): add chrome MCP existing-session support (package.json + openclaw-tools.ts)
0159269a51 refactor: share openclaw tool sandbox config (openclaw-tools.ts)
7cb6553ce8 fix: pass injected config to session tools (openclaw-tools.ts)
```

Integration risks:

- package.json exports: operator1 has 40+ ./plugin-sdk/\* subpath exports. Any dep-bump or restructure can silently drop them. Audit required post-pick: `grep "plugin-sdk" package.json | wc -l` must be 40+.
- openclaw-tools.ts: operator1 has custom before-tool-call hooks. Verify they survive 0159269a51 (sandbox config refactor) and 7cb6553ce8 (injected config fix).

Protected file status:

- src/gateway/server-methods.ts — 0 upstream commits (SAFE — no audit needed)
- src/gateway/server-methods-list.ts — 0 upstream commits (SAFE — no audit needed)
- src/gateway/method-scopes.ts — 0 upstream commits (SAFE — no audit needed)
- package.json exports — 9 upstream commits (REQUIRES AUDIT post-merge)
- src/agents/openclaw-tools.ts — 2 upstream commits (REQUIRES REVIEW)

---

## Phase 5: Platform (22 commits)

Branch: `sync/v2026.3.13-beta.1-platform`

Mobile, Windows, and macOS app-specific changes. Operator1 does not customize native Android/iOS apps; Windows changes are low-risk. macOS exec-approvals prompter commit is already in Phase 1 (Security) — do not double-apply.

iOS (1):

```
496176d738 feat(ios): add onboarding welcome pager (#45054)
```

Android (10):

```
aae75b5e57 feat(android): redesign onboarding flow UI
beff0cf02c feat(android): redesign Connect tab with unified status cards
720b9d2c45 feat(android): add speaker label and status pill to Voice tab
c761b5b8a8 feat(android): compact chat composer layout
8b0e16a1c8 feat(android): soften chat role labels and deduplicate session header
c04544891d feat(android): consolidate Settings into grouped card sections
b934cb49c7 fix(android): use Google Code Scanner for onboarding QR
402f2556b9 fix(android): clip CommandBlock accent bar to rounded container bounds
f1d9fcd407 build(android): strip unused dnsjava resolver service before R8
1ef0aa443b docs(android): note that app is not publicly released yet (#23051)
```

Windows (9):

```
ad65778818 fix: keep windows onboarding logs ascii-safe
5189ba851c fix: stop windows startup fallback gateways
6cb8729952 fix: harden windows gateway stop cleanup
5ea03efe92 fix: harden windows gateway lifecycle
202765c810 fix: quiet local windows gateway auth noise
9da06d918f fix(windows): add windowsHide to detached spawn calls (#44693)
32d8ec9482 fix: harden windows gateway fallback launch
a0f09a4589 test: fix windows startup fallback mock typing
```

macOS (2):

```
bed661609e fix(macos): align minimum Node.js version with runtime guard (22.16.0) (#45640)
2bfe188510 fix(macos): prevent PortGuard from killing Docker Desktop in remote mode (#13798)
```

---

## Phase 6: UI Reference (5 commits)

Branch: `sync/v2026.3.13-beta.1-ui-reference` (draft PR — reference only, not merged to main)

Upstream control-panel UI fixes. Draft PR documents what upstream changed so ui-next can be aligned.

```
0a3b9a9a09 fix(ui): keep shared auth on insecure control-ui connects (#45088)
e5fe818a74 fix(gateway/ui): restore control-ui auth bypass and classify connect failures (#45512)
40ab39b5ea fix(ui): keep oversized chat replies readable (#45559)
96c48f5566 fix(ui): restore chat-new-messages class on scroll pill button (#44856)
0e8672af87 fix(ui): stop dashboard chat history reload storm (#45541)
```

ui-next follow-up items:

- Chat history reload storm fix (#45541) and oversized reply fix (#45559): relevant to ui-next/src/pages/chat-messages.tsx
- Scroll pill class restore (#44856): may need mirroring in ui-next chat layout
- Insecure control-UI auth (#45088, #45512): review against ui-next WebSocket handshake path

---

## Integration Risk Summary

Protected files touched by upstream:

- package.json — 9 commits (AUDIT plugin-sdk exports count post-merge; must be 40+)
- src/agents/openclaw-tools.ts — 2 commits (VERIFY before-tool-call hooks survive)

Protected files NOT touched (safe):

- src/gateway/server-methods.ts — 0 commits
- src/gateway/server-methods-list.ts — 0 commits
- src/gateway/method-scopes.ts — 0 commits

Operator1-only files not touched by upstream:

- src/mcp/ — safe
- src/commands/mcp.commands.ts — safe
- ui-next/ — safe
- docs/operator1/ — safe

Schema migration conflicts: none (no upstream commits to src/infra/state-db/schema.ts)

Recommendation: PROCEED — gateway registries are untouched, security commits are well-scoped, integration surface is limited to package.json and one source file.
