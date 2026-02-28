# Next Step: FILE_SYSTEM_OPS Integration (Task #2)

**Status**: ⏳ Ready to Start  
**Priority**: 🔴 CRITICAL  
**Estimated Effort**: 3-5 days  
**Depends On**: ✅ Configuration Management (completed)  
**Blocks**: All other integrations

---

## Overview

The `applyFileSystemOverrides()` function exists in [`src/clarityburst/decision-override.ts`](src/clarityburst/decision-override.ts) (lines 556-601) but is **not wired into the platform**. No code currently calls this function when performing file operations.

Goal: **Find all file operation entry points in the codebase and add gating calls before irreversible operations**.

---

## Step-by-Step Detailed Plan

### Phase 1: Discover File Operation Entry Points (1-2 Days)

This phase involves searching the codebase to find where file operations happen.

#### 1.1 Search for File System Operations

Using grep/search, find all instances of:
- `fs.writeFile` / `fs.writeFileSync`
- `fs.appendFile` / `fs.appendFileSync`
- `fs.unlink` / `fs.unlinkSync`
- `fs.rmdir` / `fs.rmdirSync` / `fs.rm`
- `fs.mkdir` / `fs.mkdirSync`
- `fs.rename` / `fs.renameSync`
- `fs.chmod` / `fs.chmodSync`
- Any wrapper functions that abstract these operations

**Search Commands** (run in project root):
```bash
# Search for all fs module usage patterns
grep -r "fs\.write" src/ --include="*.ts" | grep -v test | grep -v ".test.ts"
grep -r "fs\.append" src/ --include="*.ts" | grep -v test
grep -r "fs\.unlink" src/ --include="*.ts" | grep -v test
grep -r "fs\.rm[^a-z]" src/ --include="*.ts" | grep -v test
grep -r "fs\.mkdir" src/ --include="*.ts" | grep -v test
grep -r "fs\.rename" src/ --include="*.ts" | grep -v test
grep -r "fs\.chmod" src/ --include="*.ts" | grep -v test

# Also search for common patterns
grep -r "writeFile" src/ --include="*.ts" | grep -v test
grep -r "appendFile" src/ --include="*.ts" | grep -v test
grep -r "unlinkSync" src/ --include="*.ts" | grep -v test
```

#### 1.2 Identify File Operation Utilities/Wrappers

Check if the project has abstracted file operations into utility functions:

**Typical locations to check**:
- `src/fs/` (if exists)
- `src/io/` (if exists)
- `src/file/` (if exists)
- `src/utils/` for file helpers
- `src/daemon/` for file operations
- `src/config/` for config file writes
- `src/memory/` for session file operations
- `src/sessions/` for session storage

**What to look for**:
- Wrapper functions like `writeConfigFile()`, `saveSession()`, `createDirectory()`
- These wrappers might be single points where we can add gating
- OR individual calls scattered throughout the codebase

#### 1.3 Categorize by Risk Level

Classify each file operation entry point:

**HIGH-RISK** (should require confirmation):
- Writing to sensitive config files (e.g., `.env`, credentials)
- Deleting any files or directories
- Modifying existing files that shouldn't be changed
- Writing to protected system directories

**MEDIUM-RISK** (should log and potentially gate):
- Creating new config files
- Writing session data
- Creating backup files
- Modifying user data directories

**LOW-RISK** (might skip gating):
- Creating temporary files (might be too noisy)
- Writing to `.git/` ignored directories
- Writing build artifacts

**Example Risk Classification**:
```
- fs.writeFile(path.join(config_dir, '.env')) → HIGH
- fs.unlink(old_session_file) → HIGH
- fs.mkdir(sessions_dir) → MEDIUM
- fs.writeFile(session_file) → MEDIUM
- fs.writeFile(temp_file) → LOW
```

---

### Phase 2: Understand Current Implementation (1 Day)

#### 2.1 Review `applyFileSystemOverrides()`

Location: [`src/clarityburst/decision-override.ts`](src/clarityburst/decision-override.ts) lines 556-601

**What it does**:
- Takes `FileSystemContext` as input
- Extracts operation type and path
- Calls router with stage `FILE_SYSTEM_OPS`
- Checks router response against thresholds
- Returns `PROCEED`, `ABSTAIN_CONFIRM`, or `ABSTAIN_CLARIFY`

**Input Interface** (`FileSystemContext`):
```typescript
interface FileSystemContext {
  operation: 'read' | 'write' | 'delete' | 'mkdir' | 'rename' | 'chmod';
  path: string;
  // context for router (optional)
  context?: { 
    targetPath?: string;  // for rename
    mode?: number;        // for chmod
    [key: string]: unknown;
  };
  capabilities: RuntimeCapabilities; // from agent execution context
}
```

**Return Type** (`OverrideOutcome`):
- `PROCEED` → Safe to continue with file operation
- `ABSTAIN_CONFIRM` → Need user confirmation before proceeding
- `ABSTAIN_CLARIFY` → Block operation, unclear policy

#### 2.2 Review FILE_SYSTEM_OPS.json Pack

Location: `ontology-packs/FILE_SYSTEM_OPS.json`

**What to verify**:
- Does it exist? If not, needs to be created
- Does it have comprehensive contracts for different file operations?
- Does it define thresholds (min_confidence_T, dominance_margin_Delta)?
- Does it cover different operation types (write to config, delete, etc.)?

**Expected Pack Structure**:
```json
{
  "pack_id": "file-system-ops",
  "pack_version": "1.0",
  "stage_id": "FILE_SYSTEM_OPS",
  "contracts": [
    {
      "contract_id": "fs_write_safe",
      "risk_class": "LOW",
      "required_fields": ["operation", "path"],
      "limits": { "max_file_size": 10485760 },
      "needs_confirmation": false,
      "deny_by_default": false,
      "capability_requirements": ["fs_write"]
    },
    {
      "contract_id": "fs_delete_sensitive",
      "risk_class": "CRITICAL",
      "required_fields": ["operation", "path"],
      "limits": {},
      "needs_confirmation": true,
      "deny_by_default": true,
      "capability_requirements": ["fs_write"]
    }
    // ... more contracts
  ],
  "thresholds": {
    "min_confidence_T": 0.75,
    "dominance_margin_Delta": 0.15
  }
}
```

---

### Phase 3: Design Integration Strategy (1 Day)

#### 3.1 Decide: Wrapper vs Distributed Integration

**Option A: Wrapper Functions (RECOMMENDED)**
- Create utility functions that wrap fs operations
- Add gating inside the wrapper
- Export from `src/fs-utils.ts` or similar
- Change all call sites to use wrapper instead of direct `fs.writeFile()`

**Pros**:
- Single point of gating per operation type
- Easy to test
- Easy to disable/enable gating

**Cons**:
- Requires refactoring all existing code
- Potential breaking changes

**Example**:
```typescript
// src/fs-utils.ts
async function writeConfigFile(filePath: string, content: string) {
  const outcome = await applyFileSystemOverrides({
    operation: 'write',
    path: filePath,
    capabilities: getCurrentCapabilities(),
  });
  
  if (outcome.outcome === 'ABSTAIN_CONFIRM') {
    throw outcome; // User confirmation required
  }
  
  await fs.writeFile(filePath, content);
}

// Usage (before): await fs.writeFile(configPath, data);
// Usage (after): await writeConfigFile(configPath, data);
```

**Option B: Distributed Integration**
- Add gating calls at each file operation site
- No wrapper layer
- Direct calls to `applyFileSystemOverrides()`

**Pros**:
- No need to create abstraction layer
- Works with existing code structure

**Cons**:
- Duplicated gating logic across codebase
- Hard to maintain consistency
- Easy to miss some operations

#### 3.2 Identify High-Value Integration Points

Start with the **highest-risk, highest-frequency** file operations:

**Priority 1** (Do first):
- Session file writes (`src/sessions/` or similar)
- Config file writes (`.env`, credentials)
- Database file operations

**Priority 2** (Do next):
- User data directory operations
- Cache directory operations
- Backup/archive operations

**Priority 3** (Lower priority):
- Build artifacts
- Log files
- Temporary files

---

### Phase 4: Identify Blocking/Unblocking Points (1 Day)

#### 4.1 Determine Async vs Sync Operations

Check if file operations are:
- **Async** (`fs.writeFile`, `fs.promises.writeFile`) → Can call `await applyFileSystemOverrides()`
- **Sync** (`fs.writeFileSync`) → Cannot await, need to handle differently

**For Sync Operations**:
- Option 1: Convert to async (if feasible)
- Option 2: Create a sync version of gating (or skip gating for sync ops)
- Option 3: Keep existing behavior, add gating only to async operations

#### 4.2 Check for Nested/Dependent Operations

Some file operations might:
- Create parent directories automatically
- Trigger other file operations
- Be called from async contexts vs sync contexts

**Example**:
```typescript
// Single operation that triggers multiple file ops
async function saveSessionWithBackup(session, path) {
  // Operation 1: Write backup of old file
  if (fs.existsSync(path)) {
    await fs.copyFile(path, path + '.bak');  // Gate this?
  }
  
  // Operation 2: Write new session
  await fs.writeFile(path, JSON.stringify(session));  // Gate this!
}
```

---

### Phase 5: Implementation Plan (3-5 Days)

#### 5.1 Create File System Utilities (1-2 Days)

If using Wrapper approach:
1. Create `src/fs-utils.ts` or extend existing utility module
2. Implement wrapper functions:
   - `writeConfigFile(path, data)`
   - `writeSessionFile(path, data)`
   - `deleteFile(path)`
   - `createDirectory(path)`
   - `renameFile(oldPath, newPath)`
   - etc.
3. Each wrapper:
   - Calls `applyFileSystemOverrides()` with appropriate context
   - Handles `ABSTAIN_CONFIRM` by throwing error (user confirmation needed)
   - Handles `ABSTAIN_CLARIFY` by logging and throwing
   - Proceeds on `PROCEED`

#### 5.2 Find and Replace Call Sites (1-2 Days)

For each identified file operation:
1. Replace direct `fs.writeFile()` calls with `writeConfigFile()`
2. Replace `fs.unlink()` calls with `deleteFile()`
3. Replace `fs.mkdir()` calls with `createDirectory()`
4. Test each change to ensure no breaking changes

**Search and Replace Pattern**:
```
FIND:    await fs.writeFile(configPath, content)
REPLACE: await writeConfigFile(configPath, content)
```

#### 5.3 Update FILE_SYSTEM_OPS.json Pack (1 Day)

If pack needs updating:
1. Review existing contracts
2. Add missing operation types
3. Define appropriate risk classes (LOW, MEDIUM, HIGH, CRITICAL)
4. Set sensible thresholds:
   - `min_confidence_T`: 0.70-0.80 (router must be confident)
   - `dominance_margin_Delta`: 0.10-0.20 (clear winner among contracts)

---

### Phase 6: Testing (1-2 Days)

#### 6.1 Unit Tests

Create `src/clarityburst/__tests__/file_system_ops.test.ts`:

1. **Test each wrapper function**:
   - Test `writeConfigFile()` with various inputs
   - Test `deleteFile()` with various inputs
   - Verify gating is called with correct context

2. **Test gating outcomes**:
   - Mock router to return `PROCEED` → operation succeeds
   - Mock router to return `ABSTAIN_CONFIRM` → throws error
   - Mock router to return `ABSTAIN_CLARIFY` → throws error

3. **Test edge cases**:
   - Missing paths
   - Permission errors
   - Router timeouts
   - Invalid paths

#### 6.2 Integration Tests

Create actual file operations and verify gating:

1. Create temporary test files
2. Try to write/delete them with gating enabled
3. Verify operations are blocked when expected
4. Verify operations proceed when expected
5. Clean up test files

#### 6.3 Regression Tests

Ensure existing functionality still works:

1. Run full test suite with gating enabled
2. Verify no existing tests break
3. Check error messages are helpful
4. Verify performance impact is minimal

---

### Phase 7: Documentation (1 Day)

#### 7.1 Code Documentation

Add JSDoc comments:
```typescript
/**
 * Write a configuration file with ClarityBurst gating.
 * 
 * @param filePath - Path to the config file
 * @param content - Content to write
 * @throws {ClarityBurstAbstainError} if gating blocks the operation
 * @throws {Error} if file write fails for other reasons
 */
async function writeConfigFile(filePath: string, content: string): Promise<void>
```

#### 7.2 Usage Guide

Document how to use the new file utilities:

```markdown
## File System Operations Gating

All file write/delete operations are now gated through ClarityBurst.

### API

```typescript
// Write operations
await writeConfigFile(path, content);
await writeSessionFile(sessionPath, sessionData);

// Delete operations
await deleteFile(path);

// Directory operations
await createDirectory(dirPath);
await renameFile(oldPath, newPath);
```

### Error Handling

```typescript
try {
  await writeConfigFile(configPath, newConfig);
} catch (error) {
  if (error instanceof ClarityBurstAbstainError) {
    if (error.outcome === 'ABSTAIN_CONFIRM') {
      // User confirmation required
      console.log('Configuration change requires user approval');
    } else {
      // Policy violation
      console.log('Configuration change blocked by policy');
    }
  } else {
    // Other file I/O error
    console.error('Failed to write config:', error);
  }
}
```

---

## Success Criteria

✅ All HIGH-RISK file operations have gating calls  
✅ All file operation wrappers are tested (unit + integration)  
✅ FILE_SYSTEM_OPS.json has comprehensive contracts  
✅ No breaking changes to existing functionality  
✅ Error messages are clear and actionable  
✅ Documentation is complete  
✅ Full test suite passes  

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Breaking existing code | HIGH | Careful refactoring, comprehensive test suite, gradual rollout |
| Performance impact | MEDIUM | Profile async calls, optimize hot paths, add caching if needed |
| Router timeout delays | MEDIUM | Configurable timeout already in place, fallback to fail-closed |
| Incomplete coverage | MEDIUM | Careful search/grep, code review to find missed operations |
| Difficulty testing async ops | MEDIUM | Use test fixtures, mock fs operations, isolate gating logic |

---

## Files Affected

### To Create:
- `src/fs-utils.ts` (file system wrapper utilities)
- `src/clarityburst/__tests__/file_system_ops.test.ts` (tests)

### To Modify:
- `ontology-packs/FILE_SYSTEM_OPS.json` (if contracts incomplete)
- Various files with file operations (to use wrappers)

### To Review:
- `src/clarityburst/decision-override.ts` (verify applyFileSystemOverrides works correctly)
- `src/sessions/` (likely needs integration)
- `src/config/` (likely needs integration)
- `src/daemon/` (likely needs integration)

---

## Recommendation

**Suggested Approach**:

1. **Day 1-2**: Search codebase, identify all file operations, categorize by risk
2. **Day 2-3**: Create file system utilities wrapper layer
3. **Day 3-4**: Refactor call sites to use wrappers (start with HIGH-RISK)
4. **Day 4-5**: Test, document, update FILE_SYSTEM_OPS.json pack

**Start with**: Session file operations and config file writes (highest value, easiest to test)

---

Would you like me to proceed with implementation, or would you like to review anything else first?
