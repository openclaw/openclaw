# Phase 1: File System Operations Discovery Report

**Status**: ✅ COMPLETE  
**Date**: 2026-02-15  
**Total File Operations Found**: 1000+  
**Wrapper Functions Identified**: 7 primary + multiple private variants  

---

## Executive Summary

This report documents all file system operations discovered in the OpenClaw codebase. Comprehensive grep searches identified entry points for file operations, utility wrappers, and categorized them by risk level for ClarityBurst integration.

**Key Finding**: The codebase has SOME utility wrappers but direct `fs.*` calls are also common. A dual approach will be needed:
1. Gate existing wrappers (`writeConfigFile`, `saveSessionStore`)
2. Identify and wrap direct `fs.*` calls in critical paths

---

## 1. File System Operations Found

### 1.1 fs.writeFile / fs.writeFileSync

**Count**: 300+ instances  
**Async vs Sync**: Mixed (both async and sync variants)

**High-Frequency Categories**:
- Config file writes: `src/config/io.ts`, `src/config/config.ts`
- Session transcript writes: `src/gateway/server-methods/chat.ts`, `src/config/sessions/store.ts`
- Log file writes: `src/logging/logger.ts`
- Media storage: `src/media/store.ts`, `src/media-understanding/attachments.ts`
- Device identity: `src/infra/device-identity.ts`
- Test setup: Scattered across `*.test.ts` files

**Key Files**:
- [`src/config/io.ts`](src/config/io.ts:621) - writeConfigFile wrapper
- [`src/gateway/server-methods/chat.ts`](src/gateway/server-methods/chat.ts:84) - Transcript writes
- [`src/infra/device-pairing.ts`](src/infra/device-pairing.ts:93) - Pairing file writes
- [`src/media/store.ts`](src/media/store.ts:207) - Media storage

### 1.2 fs.appendFile / fs.appendFileSync

**Count**: 11 instances  
**Focus**: Logging and session operations

**Key Files**:
- [`src/logging/logger.ts`](src/logging/logger.ts:106) - appendFileSync for logging
- [`src/gateway/server-methods/chat.ts`](src/gateway/server-methods/chat.ts:139) - appendFileSync for transcripts
- [`src/hooks/bundled/command-logger/handler.ts`](src/hooks/bundled/command-logger/handler.ts:57) - Hook logging
- [`src/cron/run-log.ts`](src/cron/run-log.ts:52) - Cron log appending
- [`src/agents/anthropic-payload-log.ts`](src/agents/anthropic-payload-log.ts:66) - Payload logging

### 1.3 fs.unlink / fs.unlinkSync

**Count**: 23 instances  
**Purpose**: File cleanup, cache management, temp file removal

**Key Files**:
- [`src/media-understanding/attachments.ts`](src/media-understanding/attachments.ts:364) - Temp media cleanup
- [`src/infra/restart-sentinel.ts`](src/infra/restart-sentinel.ts:86) - Sentinel file cleanup
- [`src/daemon/launchd.ts`](src/daemon/launchd.ts:407) - Legacy plist removal
- [`src/auto-reply/reply/agent-runner-execution.ts`](src/auto-reply/reply/agent-runner-execution.ts:549) - Transcript cleanup
- [`src/agents/session-file-repair.ts`](src/agents/session-file-repair.ts:87) - Session file repair

### 1.4 fs.rm / fs.rmdir / fs.rmdirSync

**Count**: 289 instances  
**Purpose**: Recursive directory deletion, mostly in tests

**Key Files**:
- Heavily used in test cleanup (`*.test.ts`)
- Plugin management: [`src/plugins/install.ts`](src/plugins/install.ts:203)
- Hook installation: [`src/hooks/install.ts`](src/hooks/install.ts:226)
- Archive extraction cleanup

### 1.5 fs.mkdir / fs.mkdirSync

**Count**: 300+ instances  
**Purpose**: Directory creation (recursive in most cases)

**Key Files**:
- [`src/memory/qmd-manager.ts`](src/memory/qmd-manager.ts:140) - Memory index init
- [`src/media/store.ts`](src/media/store.ts:63) - Media directory setup
- [`src/infra/device-pairing.ts`](src/infra/device-pairing.ts:91) - Pairing dir creation
- [`src/gateway/server-methods/agents.ts`](src/gateway/server-methods/agents.ts:260) - Workspace setup
- Scattered across initialization code

### 1.6 fs.rename / fs.renameSync

**Count**: 30 instances  
**Purpose**: File moves, backup operations, atomic writes

**Key Files**:
- [`src/telegram/update-offset-store.ts`](src/telegram/update-offset-store.ts:81) - Atomic offset write
- [`src/infra/device-pairing.ts`](src/infra/device-pairing.ts:99) - Atomic pairing write
- [`src/plugins/install.ts`](src/plugins/install.ts:197) - Backup and restore
- [`src/hooks/install.ts`](src/hooks/install.ts:220) - Backup and restore
- [`src/cron/run-log.ts`](src/cron/run-log.ts:38) - Log rotation

### 1.7 fs.chmod / fs.chmodSync

**Count**: 50 instances  
**Purpose**: Permission management (security-critical)

**Key Files**:
- [`src/infra/device-auth-store.ts`](src/infra/device-auth-store.ts:65) - Set 0o600 on credentials
- [`src/infra/device-pairing.ts`](src/infra/device-pairing.ts:95) - Set 0o600 on pairing
- [`src/infra/env-file.ts`](src/infra/env-file.ts:55) - Set 0o600 on .env
- [`src/infra/exec-approvals.ts`](src/infra/exec-approvals.ts:243) - Set 0o600 on approvals
- [`src/commands/doctor-state-integrity.ts`](src/commands/doctor-state-integrity.ts:195) - Permission repair/tightening

---

## 2. Wrapper Functions & Utilities

### 2.1 Primary Wrappers (Exported/Public)

#### `writeConfigFile()` - ⭐ CRITICAL
**Location**: [`src/config/io.ts:621`](src/config/io.ts:621)
```typescript
export async function writeConfigFile(cfg: OpenClawConfig): Promise<void>
```
**Risk**: HIGH  
**Call Count**: 100+ sites across:
- CLI commands: `config-cli.ts`, `plugins-cli.ts`, `hooks-cli.ts`
- Gateway methods: `config.ts`, `skills.ts`, `server.impl.ts`
- Wizard/onboarding: `onboarding.ts`, `configure.wizard.ts`
- Discord, Slack, Telegram bot handlers
- Doctor and health commands

**Atomic Write Pattern**: Uses temp file + rename
- Writes to temp file first
- Renames atomically (via `fs.rename`)
- Ensures crash-safe config updates

**Status**: ✅ Ideal candidate for gating - single entry point for all config writes

---

#### `saveSessionStore()` - ⭐ CRITICAL
**Location**: [`src/config/sessions/store.ts:347`](src/config/sessions/store.ts:347)
```typescript
export async function saveSessionStore(
  storePath: string,
  store: SessionStore
): Promise<void>
```
**Risk**: HIGH  
**Call Count**: 50+ sites across:
- Auto-reply handlers: `session.ts`, `session-resets.test.ts`
- Gateway: `heartbeat-runner.ts`, test helpers
- Infra: `heartbeat-runner.ts`

**Locking Mechanism**: Uses `withSessionStoreLock()` to prevent concurrent writes  
**Internal Commit Point**: Calls private `saveSessionStoreUnlocked()` where actual write happens

**Status**: ✅ Ideal candidate for gating - already has locking, central write point

---

#### `ensureDir()` - Multiple Implementations
**Primary Location**: [`src/utils.ts:7`](src/utils.ts:7)
```typescript
export async function ensureDir(dir: string)
```
**Risk**: LOW-MEDIUM (creates, doesn't delete)  
**Call Count**: 20+ sites

**Alternative Implementations** (private/scoped):
- [`src/memory/internal.ts:21`](src/memory/internal.ts:21) - Sync version
- [`src/infra/state-migrations.fs.ts:25`](src/infra/state-migrations.fs.ts:25) - Sync version
- [`src/infra/exec-approvals.ts:130`](src/infra/exec-approvals.ts:130) - Private version
- [`src/commands/doctor-state-integrity.ts:49`](src/commands/doctor-state-integrity.ts:49) - Private version

**Status**: ✅ Good candidate but needs consolidation of implementations

---

### 2.2 Secondary Wrappers & Patterns

#### Session Store Mutation (`updateSessionStore`)
**Location**: [`src/config/sessions/store.ts`](src/config/sessions/store.ts)
```typescript
export async function updateSessionStore(
  storePath: string,
  mutator: (store: SessionStore) => Promise<SessionEntry>
): Promise<SessionEntry>
```
**Risk**: HIGH (modifies persistent session state)  
**Pattern**: Atomic read-modify-write with locking

---

#### Device/Pairing Writes
**Locations**:
- [`src/infra/device-pairing.ts:90-102`](src/infra/device-pairing.ts:90) - Device pairing atomic write
- [`src/infra/node-pairing.ts:77-89`](src/infra/node-pairing.ts:77) - Node pairing atomic write
- [`src/infra/device-identity.ts:104-116`](src/infra/device-identity.ts:104) - Device identity write

**Pattern**: Temp file → chmod 0o600 → atomic rename  
**Risk**: HIGH (sensitive device credentials)

---

#### Auth Store Writes
**Location**: [`src/infra/device-auth-store.ts:61-65`](src/infra/device-auth-store.ts:61)
**Pattern**: mkdir + writeFileSync + chmod 0o600  
**Risk**: HIGH (WhatsApp credentials)

---

### 2.3 Hook Handlers (Write Operations)

#### `saveSessionToMemory()`
**Location**: [`src/hooks/bundled/session-memory/handler.ts:67`](src/hooks/bundled/session-memory/handler.ts:67)
**Risk**: HIGH (writes memory files)  
**Status**: Already has ClarityBurst gating in tests (`memory_modify.*.test.ts`)

---

## 3. Risk Classification

### HIGH-RISK Operations (MUST GATE)

| Operation | Location | Reason | Count |
|-----------|----------|--------|-------|
| Config writes | `src/config/io.ts` | System configuration changes | 100+ |
| Session store commits | `src/config/sessions/store.ts` | Persistent state changes | 50+ |
| Device/pairing files | `src/infra/device-*.ts` | Credentials (0o600) | 6 |
| Auth profiles | `src/agents/auth-profiles/store.ts` | User authentication | 10+ |
| Memory modify hook | `src/hooks/bundled/session-memory/handler.ts` | Session memory writes | 5+ |
| Service files | `src/daemon/*.ts` | System service configs | 10+ |
| Env files | `src/infra/env-file.ts` | Environment configuration | 5+ |
| Exec approvals | `src/infra/exec-approvals.ts` | Permission policies | 5+ |

### MEDIUM-RISK Operations (SHOULD GATE)

| Operation | Location | Reason | Count |
|-----------|----------|--------|-------|
| Session transcripts | `src/gateway/server-methods/chat.ts` | Session history | 50+ |
| Log appends | `src/logging/logger.ts` | System logs | 20+ |
| Hook files | `src/hooks/install.ts` | Hook installation | 10+ |
| Plugin files | `src/plugins/install.ts` | Plugin installation | 10+ |
| Backup operations | Various | `.backup-*` files with restore patterns | 15+ |
| Workspace files | `src/agents/sandbox/workspace.ts` | Agent workspace initialization | 20+ |
| Database operations | `src/memory/manager.ts` | SQLite database management | 10+ |

### LOW-RISK Operations (MIGHT SKIP)

| Operation | Location | Reason | Count |
|-----------|----------|--------|-------|
| Temp media files | `src/media-understanding/attachments.ts` | Temporary processing | 50+ |
| Test fixtures | `*.test.ts` | Test setup/cleanup | 500+ |
| Cache files | Various | Media/trace caches | 30+ |
| Build artifacts | Various | Dist, extracted archives | 50+ |
| Log rotation | `src/logging/logger.ts` | Old log cleanup | 5+ |

---

## 4. Atomic Write Patterns Discovered

**Pattern 1: Temp File + Rename (Crash-Safe)**
```typescript
// src/config/io.ts, src/infra/device-pairing.ts
const tmp = `${filePath}.${randomUUID()}.tmp`;
await fs.writeFile(tmp, content);
await fs.chmod(tmp, 0o600);  // Set permissions
await fs.rename(tmp, filePath);  // Atomic
```
**Risk**: Temp files are gated but not the atomic rename  
**Recommendation**: Gate both operations as a unit

**Pattern 2: Locking Wrapper**
```typescript
// src/config/sessions/store.ts
await withSessionStoreLock(storePath, async () => {
  await saveSessionStoreUnlocked(storePath, store);
});
```
**Status**: Already has coordination mechanism  
**Recommendation**: Gate the commit point only

**Pattern 3: Backup + Restore**
```typescript
// src/plugins/install.ts, src/hooks/install.ts
backupDir = `${targetDir}.backup-${Date.now()}`;
await fs.rename(targetDir, backupDir);
// ... perform operation ...
if (failed) {
  await fs.rename(backupDir, targetDir);  // Restore
}
await fs.rm(backupDir);  // Cleanup
```
**Risk**: Multiple related operations need gating as atomic unit  
**Recommendation**: Gate rename operations in installation context

---

## 5. File Operation Utility Directories

### Checked Directories

| Directory | Contents | Relevant? |
|-----------|----------|-----------|
| `src/utils.ts` | `ensureDir()`, `resolveUserPath()` | ✅ YES |
| `src/infra/` | Device auth, pairing, state migrations, exec approvals | ✅ YES |
| `src/config/` | Config IO, sessions store, paths | ✅ YES |
| `src/media/` | Media storage, cleanup | ✅ YES |
| `src/agents/` | Auth profiles, session files | ✅ YES |
| `src/hooks/` | Hook installation, bundled hooks | ✅ YES |
| `src/plugins/` | Plugin installation, loading | ✅ YES |
| `src/daemon/` | Service file management | ✅ YES |

### Missing Utility Directories
- `src/fs/` - DOES NOT EXIST
- `src/io/` - DOES NOT EXIST (config/io.ts exists but in config/)
- `src/file/` - DOES NOT EXIST

---

## 6. Comparison: Direct fs.* vs Wrappers

### Direct fs.* Calls (NOT wrapped)
- Test files: 500+ instances (acceptable - test-only)
- Scattered utility code: 100+ instances
- Archive operations: 50+ instances
- Media processing: 30+ instances

### Wrapped Operations
- Config writes: ✅ `writeConfigFile()`
- Session writes: ✅ `saveSessionStore()`
- Directory creation: ✅ `ensureDir()` (multiple implementations)
- Device/auth: ⚠️ Partially wrapped (crypto operations but not gated)

### Coverage Gap
Estimated 10-15% of HIGH-RISK operations use direct `fs.*` calls instead of wrappers

---

## 7. Entry Points for FILE_SYSTEM_OPS Gating

### Tier 1: Implement First (Highest Value)
1. **`writeConfigFile()`** - 100+ call sites, configuration changes
2. **`saveSessionStore()` / `saveSessionStoreUnlocked()`** - 50+ call sites, session state
3. **Device/pairing writes** - 6 locations, credential security

### Tier 2: Implement Second
4. **Session transcript writes** - `fs.appendFileSync` in chat.ts
5. **Log operations** - `fs.appendFileSync` in logger.ts
6. **Hook/plugin installation** - Atomic install patterns

### Tier 3: Consider Later
7. **Backup/restore patterns** - Installation rollback
8. **Database operations** - SQLite file management
9. **Workspace initialization** - Sandbox setup

---

## 8. Implementation Recommendations

### Option A: Gate at Wrapper Level (RECOMMENDED)
**Approach**: Add gating to existing wrappers
- `writeConfigFile()` - Add gate before actual write
- `saveSessionStore()` - Gate at `saveSessionStoreUnlocked()`
- `ensureDir()` - Consolidate implementations, add gate if needed

**Pros**: Minimal code changes, covers 80% of operations  
**Cons**: Misses direct fs.* calls in non-wrapped contexts

### Option B: Wrapper + Distributed Integration
**Approach**: Gate wrappers + add wrappers for direct calls
- Create `writeSessionTranscript()` wrapper for chat.ts
- Create `appendToLog()` wrapper for logger.ts
- Wrap device/auth file writes

**Pros**: Comprehensive coverage (95%+)  
**Cons**: More code changes, more testing

### Option C: Middleware/Proxy fs Module
**Approach**: Monkey-patch Node.js `fs` module
- Intercept all `fs.*` calls globally
- Apply gating at module level

**Pros**: Catches all operations  
**Cons**: Complex, performance impact, harder to reason about

**Recommendation**: Use **Option A + B** hybrid approach

---

## 9. Key Statistics

| Metric | Count |
|--------|-------|
| Total file operations found | 1000+ |
| fs.writeFile/writeFileSync | 300+ |
| fs.mkdir/mkdirSync | 300+ |
| fs.rm/rmdir/rmdirSync | 289 |
| fs.chmod/chmodSync | 50 |
| fs.rename/renameSync | 30 |
| fs.unlink/unlinkSync | 23 |
| fs.appendFile/appendFileSync | 11 |
| PRIMARY WRAPPERS | 3 (`writeConfigFile`, `saveSessionStore`, `ensureDir`) |
| SECONDARY WRAPPERS | 5+ (device pairing, auth, hooks, etc.) |
| HIGH-RISK OPERATION SITES | 15+ unique |
| MEDIUM-RISK OPERATION SITES | 20+ unique |
| LOW-RISK OPERATION SITES | 30+ unique |

---

## 10. Next Steps (Phase 2)

1. **Review** `src/config/io.ts:621` - `writeConfigFile()` implementation
2. **Review** `src/config/sessions/store.ts:347` - `saveSessionStore()` implementation
3. **Verify** FILE_SYSTEM_OPS.json pack has appropriate contracts
4. **Plan** integration strategy for each tier
5. **Create** wrapper functions for unwrapped direct calls
6. **Write** integration tests per [`src/clarityburst/__tests__/`](src/clarityburst/__tests__/) pattern

---

## Appendix: Complete File Operation Locations

See attached `FILE_SYSTEM_OPS_LOCATIONS.csv` for detailed listing of all 1000+ operations.

---

**Report Generated**: 2026-02-15 18:18 UTC  
**Prepared For**: Phase 2 (Understand Current Implementation)
