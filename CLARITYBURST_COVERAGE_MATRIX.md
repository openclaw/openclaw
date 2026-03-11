# ClarityBurst Execution Boundary Coverage Matrix

**Analysis Date**: 2026-03-10  
**Scope**: Four completed execution-boundary ontologies  
**Status**: Identification of wiring completeness, gaps, and bypass risks

---

## Executive Summary

ClarityBurst gating infrastructure is **partially implemented** across the four ontologies. While wrapper functions exist and are tested in isolation, real-world call site coverage is **uneven**:

- **CRON_SCHEDULE**: ✅ **Fully wired** at gateway (centralized RPC dispatch)
- **NETWORK_IO**: ⚠️ **Partially wired** (2 OAuth paths verified; router self-call unwired; hundreds of raw `fetch()` calls)
- **FILE_SYSTEM_OPS**: ❌ **Mostly unwired** (wrappers exist; ~50+ call sites without gates)
- **BROWSER_AUTOMATE**: ⚠️ **Partially wired** (navigation gates applied; raw DOM mutations unverified)

**Critical Risk**: Router's own fetch call at `src/clarityburst/router-client.ts:187` bypasses gating (elevated privilege; self-referential path).

---

## Ontology Coverage Matrix

### 1. NETWORK_IO

| File | Line | Function | Operation | Status | Reason |
|------|------|----------|-----------|--------|--------|
| `src/providers/qwen-portal-oauth.ts` | 17 | `fetchOAuthToken()` | POST to OAuth endpoint | **Fully Wired** | Uses `applyNetworkIOGateAndFetch()` |
| `src/providers/github-copilot-auth.ts` | 47 | `getDeviceCode()` | POST to GitHub device code endpoint | **Fully Wired** | Uses `applyNetworkIOGateAndFetch()` |
| `src/providers/github-copilot-auth.ts` | 79 | `pollAccessToken()` | POST to GitHub token endpoint | **Fully Wired** | Uses `applyNetworkIOGateAndFetch()` |
| `src/clarityburst/router-client.ts` | 187 | `routeClarityBurst()` | POST to /api/route (self-call) | **UNWIRED** | Raw `fetch()` without gate; elevated bypass risk |
| `src/browser/client-fetch.ts` | 149 | `fetchUrl()` | Generic HTTP fetch | **Unwired** | Raw `fetch()` call in browser fetch helper |
| `src/browser/pw-session.ts` | 422 | `listSessions()` | GET to Chrome DevTools list endpoint | **Unwired** | Raw `fetch()` for CDP protocol |
| `src/browser/chrome.ts` | 86 | `fetchChromeVersion()` | GET /json/version | **Unwired** | Raw `fetch()` without gate |
| `src/browser/cdp.helpers.ts` | 125 | `fetchWithAuth()` | Generic CDP requests | **Unwired** | Raw `fetch()` wrapper without CB gate |
| `src/channels/telegram/api.ts` | 8 | `fetch()` | Telegram API calls | **Unwired** | Raw `fetch()` wrapper |
| `src/commands/signal-install.ts` | 219 | `fetch()` | GitHub releases API | **Unwired** | Raw `fetch()` without gate |
| `src/agents/huggingface-models.ts` | 165 | `listModels()` | GET /models | **Unwired** | Raw `fetch()` to HuggingFace |
| `src/agents/models-config.providers.ts` | 246,283,348 | Multiple model provider lookups | GET requests to various model APIs | **Unwired** | Raw `fetch()` without gating |
| `src/agents/ollama-stream.ts` | 455 | `chatStream()` | POST to Ollama chat endpoint | **Unwired** | Raw `fetch()` for streaming |
| `src/tts/tts-core.ts` | 557,612 | TTS requests | POST to TTS endpoints | **Unwired** | Raw `fetch()` without gate |
| `src/agents/sandbox/browser.ts` | 52 | `fetchUrl()` | Sandbox browser fetch | **Unwired** | Raw `fetch()` in sandbox context |
| `src/discord/voice-message.ts` | 267 | `uploadToDiscordCDN()` | PUT file upload | **Unwired** | Raw `fetch()` for CDN upload |

**Summary for NETWORK_IO**:

- **Total identified**: 16
- **Fully wired**: 3 (OAuth paths)
- **Partially wired**: 0
- **Unwired**: 12
- **Bypass risk**: 1 (router self-call)

**Key Gap**: Hundreds of raw `fetch()` calls across browser, media, agent model providers, and TTS without gate interception.

---

### 2. FILE_SYSTEM_OPS

| File | Line | Function | Operation | Status | Reason |
|------|------|----------|-----------|--------|--------|
| `src/config/io.ts` | 529 | `auditOpToLog()` | fs.appendFile audit log | **Unwired** | Raw `fs.promises.appendFile()` |
| `src/config/io.ts` | 1236 | `writeConfigFile()` | fs.writeFile temp file | **Unwired** | Raw `fs.promises.writeFile()` |
| `src/config/sessions/store.ts` | 781,821,836 | Session store writes | fs.writeFile (atomic via rename) | **Unwired** | Raw `fs.promises.writeFile()` calls |
| `src/browser/chrome.profile-decoration.ts` | 30,186 | `decorate()` | fs.writeFileSync user data | **Unwired** | Raw `fs.writeFileSync()` |
| `src/canvas-host/server.ts` | 185 | `defaultIndexHTML()` | fs.writeFile | **Unwired** | Raw `fs.writeFile()` |
| `src/agents/apply-patch.ts` | 154-180 | `applyPatch()` | fs.writeFile applied content | **Unwired** | Raw `fs.writeFile()` in patch wrapper |
| `src/agents/pi-tools.read.ts` | 774,813,839 | `writeFile()` tool | fs.writeFile in PI agent | **Unwired** | Raw `fs.writeFile()` |
| `src/agents/pi-model-discovery.ts` | 88 | `writeDiscovery()` | fs.writeFileSync | **Unwired** | Raw `fs.writeFileSync()` |
| `src/cli/completion-cli.ts` | 95,353,370 | `installCompletion()` | fs.writeFile shell completion | **Unwired** | Raw `fs.writeFile()` |
| `src/cli/dns-cli.ts` | 35,244 | `writeFileSudoIfNeeded()` | fs.writeFileSync DNS config | **Unwired** | Raw `fs.writeFileSync()` |
| `src/commands/doctor-config-flow.test.ts` | 215 | Test setup | fs.writeFile test config | **Unwired** | Test-only raw write |
| `src/config/sessions/transcript.ts` | 76 | `createSessionFile()` | fs.writeFile transcript header | **Unwired** | Raw `fs.promises.writeFile()` |
| `src/clarityburst/__tests__/memory_modify.hook_handler.router_outage.fail_closed.tripwire.test.ts` | 90,143,202 | `commitSessionChanges()` (test) | fs.writeFile mock tracking | **Fully Wired** (test) | Mocked gate + fail-closed assertion |
| `src/clarityburst/__tests__/file_system_ops.save_session_store.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts` | 135 | Session store save (test) | fs.writeFile mock tracking | **Fully Wired** (test) | Mocked gate + fail-closed assertion |
| `src/clarityburst/__tests__/file_system_ops.write_config_file.pack_incomplete.fail_closed.at_commit_point.tripwire.test.ts` | 102 | Config write (test) | fs.writeFile mock tracking | **Fully Wired** (test) | Mocked gate + fail-closed assertion |

**Summary for FILE_SYSTEM_OPS**:

- **Total identified**: 15+
- **Fully wired**: 3 (test scenarios only)
- **Partially wired**: 0
- **Unwired**: 12+ (production code)
- **Bypass risk**: High (config/session writes, user data)

**Key Gap**: Core infrastructure (config save, session persistence, user data writes) all bypass gates. Wrappers exist but **unused in production paths**.

---

### 3. BROWSER_AUTOMATE

| File | Line | Function | Operation | Status | Reason |
|------|------|----------|-----------|--------|--------|
| `src/browser/pw-session.ts` | 751 | `navigateWithTimeout()` | page.goto() | **Fully Wired** | Uses `applyBrowserAutomateGateAndNavigate()` |
| `src/browser/pw-tools-core.snapshot.ts` | 180 | `captureSnapshot()` | page.goto() navigation | **Fully Wired** | Uses `applyBrowserAutomateGateAndNavigate()` |
| `src/browser/pw-session.ts` | Various | `click()`, `fill()`, `press()` | Page DOM mutations | **Partially Wired** | Navigation gated; direct mutations not verified |
| `src/clarityburst/__tests__/browser_automate.gating.simple.test.ts` | 51,64,77,93,107 | Test cases | page.goto, page.click | **Fully Wired** (test) | All action wrappers tested in isolation |

**Summary for BROWSER_AUTOMATE**:

- **Total identified**: 4+ call patterns
- **Fully wired**: 2 (critical navigation paths)
- **Partially wired**: 1 (DOM interaction missing granular gates)
- **Unwired**: 0 (identified)
- **Bypass risk**: 1 (direct page mutations without per-action gating)

**Key Gap**: Page navigation is gated; but intermediate DOM interactions (click, fill, press, evaluate) may occur after initial navigation without per-action gating (depends on control flow).

---

### 4. CRON_SCHEDULE

| File | Line | Function | Operation | Status | Reason |
|------|------|----------|-----------|--------|--------|
| `src/gateway/server-methods/cron.ts` | 120-122 | `cron.add` RPC | Job creation via gateway | **Fully Wired** | Uses `applyCronScheduleGateAndAdd()` |
| `src/gateway/server-methods/cron.ts` | 185-189 | `cron.update` RPC | Job update/enable via gateway | **Fully Wired** | Uses `applyCronScheduleGateAndUpdate()` |
| `src/agents/tools/cron-tool.ts` | 431,443 | Cron tool wrapper | callGateway("cron.add/update") | **Fully Wired** | Delegates to gateway RPC (gated there) |
| `src/cron/service.ts` | Various | `cron.add()`, `cron.update()` | In-memory service | **Partially Wired** | Gateway gates; service calls direct |
| `src/clarityburst/__tests__/cron_schedule.gating.simple.test.ts` | 55,79,102,126,175,215,233 | Test cases | applyCronScheduleGateAndAdd/Update | **Fully Wired** (test) | All operations tested with gate mocks |

**Summary for CRON_SCHEDULE**:

- **Total identified**: 5 operational patterns
- **Fully wired**: 3 (gateway RPC dispatch + tool delegation)
- **Partially wired**: 1 (in-memory service)
- **Unwired**: 0
- **Bypass risk**: 0 (centralized at gateway layer)

**Key Gap**: In-memory cron service (used by gateway internally) calls `context.cron.add/update()` directly; gate applies to RPC boundary. Asymmetry if service is called from non-RPC context (currently appears not to be, but not explicitly enforced).

---

## Bypass Risk Inventory

### Critical Risks (Elevated/Full Bypass)

#### 1. Router Self-Call (NETWORK_IO)

- **File**: `src/clarityburst/router-client.ts`
- **Line**: 187
- **Risk Level**: **CRITICAL**
- **Description**: The ClarityBurst router client calls its own `/api/route` endpoint with raw `fetch()`. This is a self-referential network call that:
  - Bypasses the NETWORK_IO gate entirely
  - Operates at elevated privilege (router service)
  - Could be exploited if router process is compromised
- **Impact**: Router availability/routing decisions influence gating decisions; a bypass here could enable upstream decision manipulation
- **Recommendation**: Either:
  1. Route router requests through a non-gated internal channel (preferred)
  2. Apply gate with exemption flag for self-calls
  3. Implement loopback detection at gate layer

#### 2. Config/Session Persistence (FILE_SYSTEM_OPS)

- **Files**: `src/config/io.ts`, `src/config/sessions/store.ts`
- **Lines**: 529, 781, 821, 836, 1236
- **Risk Level**: **CRITICAL**
- **Description**: Core infrastructure state (user config, session transcripts, audit logs) all write via raw `fs.promises.writeFile()` without gates. These writes:
  - Persist decisions and state
  - Are not subject to ClarityBurst review
  - Could be exploited to corrupt/modify audit trails
- **Impact**: Full bypass of FILE_SYSTEM_OPS ontology for critical state
- **Recommendation**: Wrap all config/session writes with gate; expect high volume of CLARIFY outcomes until policy matures

#### 3. Browser User Data (FILE_SYSTEM_OPS)

- **File**: `src/browser/chrome.profile-decoration.ts`
- **Lines**: 30, 186
- **Risk Level**: **HIGH**
- **Description**: Chrome user data directory writes (preferences, profile metadata) bypass gates
- **Impact**: Browser state manipulation without ClarityBurst review
- **Recommendation**: Wrap Chrome profile writes with gate

---

### Sandbox vs Gateway Asymmetry

#### Browser Automation (BROWSER_AUTOMATE)

- **Gap**: Gateway uses gated navigation; but:
  - Direct Playwright calls in `pw-session.ts` are wrapped
  - But intermediate DOM actions (click, fill, press) called without per-action gating
  - Sandbox browser context may not have gating at all
- **Implication**: Attack surface is per-action granularity; navigation gate alone does not block post-navigation attacks
- **Recommendation**: Add per-action gating for all page mutations; or document that initial navigation gate is sufficient

#### File System Ops (FILE_SYSTEM_OPS)

- **Gap**: Gateway methods don't directly call fs; but:
  - Config save happens at gateway startup/shutdown (unwired)
  - Session persistence is embedded in session manager (unwired)
  - No RPC boundary forcing gate application like CRON_SCHEDULE
- **Implication**: fs gates exist but are dead code; production paths ignore them
- **Recommendation**: Refactor session/config I/O to use gated wrappers; consider RPC boundary enforcement like CRON_SCHEDULE

---

### Hook-Handler and Alternate Execution Domains

#### Memory Modify Tests (Implicit Bypass Risk)

- **Test Files**: `src/clarityburst/__tests__/memory_modify.hook_handler.*.tripwire.test.ts`
- **Risk**: Tests explicitly verify that hook handlers (agent run lifecycle hooks) can bypass MEMORY_MODIFY gating
- **Note**: MEMORY_MODIFY is not in the four completed ontologies, but tests show alternate domain (hook system) intentionally bypasses central gating
- **Implication**: Similar pattern may exist for other ontologies; wiring should account for all execution domains (RPC, CLI, hooks, embedded)

---

### Helper Paths Avoiding Wrapper Layer

#### Network Requests via Wrapper Functions

- **Files**: `src/browser/client-fetch.ts`, `src/browser/cdp.helpers.ts`, `src/slack/monitor/media.ts`, `src/channels/telegram/api.ts`
- **Risk**: These modules provide fetch wrappers (e.g., `fetchWithAuth()`, `fetch()`) that add auth/timeout but bypass NETWORK_IO gates
- **Implication**: Downstream code calls these helpers instead of bare `fetch()`, hiding raw calls behind a veneer of abstraction
- **Recommendation**: Refactor helpers to internally use `applyNetworkIOGateAndFetch()`, or enforce gate at all call sites

#### File System Wrappers

- **Files**: `src/infra/fs-safe.ts` (hypothetical boundary checks), `src/agents/pi-tools.read.ts`
- **Risk**: Helper functions that add safety checks (path canonicalization) but not ClarityBurst gating
- **Implication**: Code may call `openFileWithinRoot()` or `writeFileWithinRoot()` believing they enforce security; they don't apply ClarityBurst gates
- **Recommendation**: Integrate gate calls into boundary-checking helpers, or ensure gates are applied before helper calls

---

## Top Remaining Gaps (Prioritized by Risk)

### 1. Config/Session Store Writes (Critical)

- **Ontology**: FILE_SYSTEM_OPS
- **Impact**: Highest-impact unwired operation; affects state persistence
- **Effort**: Medium (refactor config I/O, session store)
- **Action**:
  - Wrap `src/config/io.ts` write calls with gate
  - Refactor session store to gate before atomic write
  - Add integration tests verifying gate blocks corrupt state

### 2. Router Self-Call Bypass (Critical)

- **Ontology**: NETWORK_IO
- **Impact**: Elevated privilege; could manipulate routing decisions
- **Effort**: Low (add exemption flag or internal channel)
- **Action**:
  - Either: Add internal loopback detection in gate layer
  - Or: Route router calls through non-gated channel (e.g., Unix socket)
  - Verify router cannot be exploited via compromised route lookup

### 3. Unverified Raw fetch() Calls (High)

- **Ontology**: NETWORK_IO
- **Impact**: Model provider/TTS/external API calls bypass gating
- **Effort**: High (audit ~50+ call sites)
- **Action**:
  - Catalog all raw `fetch()` calls
  - Determine which represent high-risk I/O (external APIs, token exchanges)
  - Prioritize OAuth / credential-sensitive paths (already partially done)
  - Wrap lower-risk calls gradually

### 4. Browser DOM Mutations Without Per-Action Gating (Medium)

- **Ontology**: BROWSER_AUTOMATE
- **Impact**: Post-navigation DOM manipulation not gated individually
- **Effort**: Medium (add granular gates to click/fill/press)
- **Action**:
  - Evaluate whether per-action gating is needed or if navigation gate is sufficient
  - If needed, wrap `applyBrowserAutomateGateAndClick()` etc. at all call sites
  - Otherwise, document that granular gating is out of scope

### 5. Unverified File Writes (High)

- **Ontology**: FILE_SYSTEM_OPS
- **Impact**: User data (Chrome profiles, completion scripts, DNS config) written without review
- **Effort**: High (audit ~50+ call sites)
- **Action**:
  - Catalog all `fs.writeFile()` and `fs.writeFileSync()` calls
  - Classify by impact (config, user data, logs, temp)
  - Wrap high-impact paths with gate
  - Consider batch wiring via automated refactoring

---

## Summary Counts by Ontology

| Ontology | Total | Fully Wired | Partially Wired | Unwired | Bypass Risk |
|----------|-------|-----------|-----------------|---------|------------|
| **NETWORK_IO** | 16 | 3 | 0 | 12 | 1 critical |
| **FILE_SYSTEM_OPS** | 15+ | 3 (test) | 0 | 12+ | 3 critical |
| **BROWSER_AUTOMATE** | 4+ | 2 | 1 | 0 | 1 (granularity) |
| **CRON_SCHEDULE** | 5 | 3 | 1 | 0 | 0 |
| **TOTAL** | 40+ | 11 | 2 | 24+ | 5 |

---

## Wiring Completeness Assessment

### By Stage of Implementation

| Stage | Ontologies | Status |
|-------|-----------|--------|
| **Wrappers Exist & Tested** | All 4 | ✅ Complete |
| **Gateway RPC Dispatch Gated** | CRON_SCHEDULE | ✅ Complete |
| **OAuth/Credential Paths Gated** | NETWORK_IO (partial) | ⚠️ 50% |
| **Core Production I/O Gated** | FILE_SYSTEM_OPS | ❌ 0% |
| **Per-Action Gating** | BROWSER_AUTOMATE | ⚠️ 50% (navigation only) |

---

## Recommended Next Wiring Order

### Phase 1: Critical Path Closure (2-3 days)

1. **Router self-call exemption** (NETWORK_IO) — 2 hours
2. **Config store write gating** (FILE_SYSTEM_OPS) — 4 hours
3. **Session store atomic write gating** (FILE_SYSTEM_OPS) — 4 hours

### Phase 2: High-Impact Wiring (1 week)

4. **Audit and gate chrome profile writes** (FILE_SYSTEM_OPS)
5. **Audit and gate TTS/model provider calls** (NETWORK_IO)
6. **Per-action browser DOM gating decision** (BROWSER_AUTOMATE)

### Phase 3: Systematic Coverage (2 weeks)

7. **Batch refactor raw fetch() calls** (NETWORK_IO)
8. **Batch refactor fs.writeFile() calls** (FILE_SYSTEM_OPS)
9. **Establish "no raw fetch/fs calls" linting rule** (All)

---

## Success Metrics

- [ ] Router self-call either exempted or routed through non-gated channel
- [ ] Config and session persistence both use gated writes
- [ ] Zero raw `fs.writeFile()` calls in critical paths (config, session, user data)
- [ ] At least 80% of identified NETWORK_IO call sites either gated or documented as out-of-scope
- [ ] All four ontologies have consistent gating at RPC boundary (gateway method level)
- [ ] Test coverage for bypass scenarios: router outage, pack incomplete, router mismatch, empty allowlist
