# Plugin Catalog Lifecycle Final Scope Document

## Investigation Summary

This document provides a comprehensive analysis of the plugin catalog lifecycle issues identified through five rounds of ClawSweeper findings, focusing on the `owner.registry` transfer mechanism introduced in commit `70bde83f850`. The goal is to identify all remaining gaps and propose complete, final fixes that address the systemic issues rather than piecemeal patches.

## 1. Inventory of `owner.registry` Consumers and Dependencies

### Direct `owner.registry` Reads/Writes

1. **`transferPluginInstanceOwner` (`src/plugins/plugin-instance-scope.ts:92-95`)**
   - **Purpose**: Moves `owner.registry` pointer during successor handoff
   - **Status**: Already implemented but causes Findings A & B
   - **Impact**: Central to both broken paths

2. **`loader-runtime-load.ts:138-143` (Inspection Retire Callback)**
   - **Purpose**: Filters instances for disposal: `if (instance && instance.owner?.registry === registry)`
   - **Status**: **BROKEN for Finding A** - uses `owner.registry` but registration resources tracked separately
   - **Impact**: Predecessor disposal tears down transferred instances' resources

3. **`isPluginRecordActive` (`src/plugins/registry-lifecycle.ts:466-482`)**
   - **Purpose**: Determines if a plugin record is active for its registry
   - **Status**: Correctly uses `getPluginRecordRegistry` which follows `owner.registry`
   - **Impact**: Already ownership-aware

4. **`getPluginRecordRegistry` (`src/plugins/registry-lifecycle.ts:458-464`)**
   - **Purpose`: Resolves current registry for a record via `owner.registry`
   - **Status**: Correctly follows transferred ownership
   - **Impact`: Core dependency for correct filtering

5. **Plugin Cache Retirement (`src/plugins/registry-lifecycle.ts:188-192`)**
   - **Purpose`: `isPluginRecordActive(owner.registry, owner.record)` check
   - **Status**: Already ownership-aware
   - **Impact`: Cache cleanup respects transferred ownership

6. **`capturePluginLifecycleAuthority` (`src/plugins/registry-lifecycle.ts:482`)**
   - **Purpose**: `return owner.registry === registry && usable()`
   - **Status**: Already ownership-aware
   - **Impact`: Authority checks respect transferred ownership

7. **HTTP Registry Route Replacement (`src/plugins/http-registry.ts:200`)**
   - **Purpose**: `owner.registry = next` during HTTP route updates
   - **Status**: Already handles ownership transfer
   - **Impact`: HTTP routing respects transferred ownership

### Indirect but Affected Systems

8. **`PluginRegistrationResourceSource` (`src/plugins/registry-registration-resources.ts`)**
   - **Purpose**: Tracks registration-specific disposers (databases, clients, etc.)
   - **Status**: **BROKEN for Finding A** - Separate from `owner.registry` tracking
   - **Impact**: Transferred instances' resources disposed by predecessor

9. **`PluginRegistryInspectionResources` (`src/plugins/registry-inspection-resources.ts`)**
   - **Purpose**: Manages inspection-scoped resources including registration disposers
   - **Status**: **BROKEN for Finding A** - Uses separate tracking system
   - **Impact`: Registration resource lifecycle independent of `owner.registry`

10. **Plugin Cache Instance Management (`src/plugins/plugin-cache.ts`)**
    - **Purpose**: `releasePluginCacheInstance`, `retainPluginCacheInstance`, `retirePluginCache`
    - **Status**: Already uses `isPluginRecordActive` checks → ownership-aware
    - **Impact`: Correctly respects transferred ownership

11. **Channel/Callback Fencing (`src/plugins/registry-contributions.ts`)**
    - **Purpose`: `capturePluginLifecycleAuthority(target, record, { scopedRuntime: true })`
    - **Status**: Already ownership-aware via `capturePluginLifecycleAuthority`
    - **Impact`: Borrowed channel runtime respects ownership boundaries

12. **`isPluginRecordBorrowed` Path (`src/plugins/registry-lifecycle.ts`)**
    - **Purpose**: Identifies borrowed vs owned records
    - **Status**: Explicitly excluded from ownership transfer (lines 319-320 in `registry-lifecycle.ts`)
    - **Impact`: Unaffected by `transferPluginInstanceOwner` (as intended)

### Summary of Ownership-Awareness Status

| System                            | Already Ownership-Aware | Recently Fixed           | Still Broken  | Reason                                                 |
| --------------------------------- | ----------------------- | ------------------------ | ------------- | ------------------------------------------------------ |
| `transferPluginInstanceOwner`     | ✓                       | Already in `70bde83f850` | -             | Core transfer mechanism                                |
| Inspection retire callback        | ✗                       | ✗                        | ✓ (Finding A) | Uses `owner.registry` but resources tracked separately |
| `isPluginRecordActive`            | ✓                       | ✓                        | -             | Uses `getPluginRecordRegistry`                         |
| `getPluginRecordRegistry`         | ✓                       | ✓                        | -             | Follows `owner.registry`                               |
| Plugin cache retirement           | ✓                       | ✓                        | -             | Uses `isPluginRecordActive`                            |
| `capturePluginLifecycleAuthority` | ✓                       | ✓                        | -             | Checks `owner.registry === registry`                   |
| HTTP registry route updates       | ✓                       | ✓                        | -             | Already transfers ownership                            |
| Registration resources            | ✗                       | ✗                        | ✓ (Finding A) | Separate `PluginRegistrationResourceSource`            |
| Inspection resources              | ✗                       | ✗                        | ✓ (Finding A) | Uses separate tracking                                 |
| Plugin cache instance mgmt        | ✓                       | ✓                        | -             | Uses ownership-aware checks                            |
| Channel fencing                   | ✓                       | ✓                        | -             | Uses `capturePluginLifecycleAuthority`                 |
| `isPluginRecordBorrowed` path     | ✓                       | ✓                        | -             | Explicitly excluded                                    |

## 2. Complete Fix Design for Finding A (Registration Resource Transfer)

### Problem Analysis

Registration resources (database connections, HTTP clients, etc.) are tracked in `PluginRegistrationResourceSource` via `PluginRegistryInspectionResources`, separate from `owner.registry`. When a predecessor retires, its inspection retire callback runs disposers for ALL resources tracked under that inspection, regardless of `owner.registry` transfer.

### Design Options

#### Option 1: Move Registration Resource Custody Alongside Instance

**Approach**: Extend `transferPluginInstanceOwner` to also transfer registration resources from predecessor's inspection to successor's inspection.

**Implementation**:

1. Add `transferPluginRegistrationResources(record, targetRegistry)` called from `resolvePluginRecordRetention`
2. This function would:
   - Locate source inspection via `getPluginRegistryInspectionResources(sourceRegistry)`
   - Locate target inspection via `getPluginRegistryInspectionResources(targetRegistry)`
   - Transfer disposer registrations for the plugin ID from source to target
   - Update `PluginRegistrationResourceSource` internal tracking

**Challenges**:

- Registration resources are per-plugin-ID in `PluginRegistrationResourceSource`
- Need to handle case where target has no inspection (regular non-inspection loads)
- Must maintain disposer ordering guarantees

#### Option 2: Teach Predecessor Cleanup to Skip Transferred Resources

**Approach**: Modify inspection retire callback to filter based on `owner.registry` for registration resources too.

**Implementation**:

1. Update `PluginRegistrationResourceSource.#dispose` to check `owner.registry`
2. For each plugin's disposers, verify current `owner.registry` matches disposal registry
3. Skip disposal if instance has been transferred to a different registry

**Challenges**:

- Registration resources exist independently of instances (can be registered without instance)
- Need to handle rollback resources separately
- Must maintain the "exactly once" disposal guarantee

### Recommended Solution: Option 2 with Registry Check

**Rationale**:

- Keeps registration resource tracking simple - no transfer mechanism needed
- Aligns with existing `owner.registry === registry` pattern used elsewhere
- Maintains the architectural separation between instance ownership and resource tracking
- Minimal code changes

**Implementation Plan**:

1. **Add registry awareness to `PluginRegistrationResourceSource`**:
   - Modify `#dispose` method to accept current disposal registry context
   - Check `owner.registry` for each disposer's plugin before running disposal
   - Skip disposers where instance ownership has transferred away

2. **Update `PluginRegistryInspectionResources.retire` callback**:
   - Pass the retiring registry context to `PluginRegistrationResourceSource.#dispose`
   - Ensure rollback resources are always disposed (they're construction failures)

3. **Files to modify**:
   - `src/plugins/registry-registration-resources.ts` - Add registry parameter to `#dispose`
   - `src/plugins/registry-inspection-resources.ts` - Pass registry to source disposal
   - `src/plugins/loader-runtime-load.ts` - Ensure retire callback uses correct registry

## 3. Complete Fix Design for Finding B (Transactional Ownership Transfer)

### Problem Analysis

`transferPluginInstanceOwner` runs during loading (`resolvePluginRecordRetention`), before generation promotion is confirmed. If generation build fails, the `finally` block in `runCatalogRequest` releases `acquiredGeneration` without promoting it, incorrectly disposing transferred instances.

### Design Options

#### Option A: Defer Transfer Until Promotion

Move `transferPluginInstanceOwner` call from `resolvePluginRecordRetention` to worker's post-promotion point.

**Analysis**:

- `resolvePluginRecordRetention` is used by multiple callers, not just model-catalog worker
- Generic loader function shouldn't know about worker promotion lifecycle
- Would require refactoring to pass "commit callback" through loader stack

#### Option B: Rollback Ownership on Failure

Add rollback mechanism that restores `owner.registry` to predecessor if generation fails.

**Implementation**:

1. Track transferred records during `resolvePluginRecordRetention`
2. In `runCatalogRequest`'s error path, restore `owner.registry` before releasing
3. Need to handle nested/complex error scenarios

### Recommended Solution: Hybrid Approach

**Rationale**:

- Keeps `resolvePluginRecordRetention` generic
- Uses worker-specific rollback for failed generations
- Maintains simple, single-direction transfer during normal flow

**Implementation Plan**:

1. **Extend `transferPluginInstanceOwner` with optional rollback**:

   ```typescript
   export function transferPluginInstanceOwner(
     record: PluginRecord,
     registry: PluginRegistry,
     options?: { temporary?: boolean },
   ): { rollback: () => void } | void;
   ```
   - When `temporary: true`, returns rollback function
   - Normal transfers remain permanent

2. **Modify `resolvePluginRecordRetention`**:
   - Call `transferPluginInstanceOwner` with `temporary: true` during retention
   - Return rollback function alongside retained record
   - Store rollbacks for potential rollback

3. **Update `runCatalogRequest`**:
   - Collect rollbacks during generation building
   - On success (`contexts.set`): discard rollbacks (transfer becomes permanent)
   - On failure: execute all rollbacks before releasing `acquiredGeneration`

4. **Files to modify**:
   - `src/plugins/plugin-instance-scope.ts` - Add temporary transfer with rollback
   - `src/plugins/loader-runtime-core.ts` - Return rollbacks from retention
   - `src/agents/prepared-model-catalog.worker.ts` - Collect and conditionally execute rollbacks

## 4. Examination of Additional Potential Problems

### 4.1 Concurrent Catalog Requests

**Finding**: Worker-task-server guarantees serial dispatch per worker ("Pool dispatch is serial per worker; handlers finish cleanup before returning their result"). However:

1. **Multiple workers could build different targets from same predecessor** - Each would call `transferPluginInstanceOwner`, creating ownership conflicts
2. **Non-worker callers** (doctor/CLI) could call `acquireAgentRuntimePluginRegistry` concurrently

**Risk Assessment**:

- Worker serialization prevents intra-worker races
- Inter-worker races possible but unlikely in practice (predecessor pinned to workspace)
- CLI/doctor calls are synchronous and wouldn't race with worker

**Fix Needed**: Add synchronization for inter-worker cases

- Use registry as synchronization token
- Or document limitation (single concurrent expansion per workspace)

### 4.2 In-flight Channel/Callback Invocations During Transfer

**Analysis**: When `owner.registry` changes mid-invocation:

1. Existing `capturePluginLifecycleAuthority` checks `owner.registry === registry`
2. Current invocation's authority captured at call start remains valid
3. New invocations after transfer use new registry

**Risk**: Low - authority capture happens at invocation start

### 4.3 `isPluginRecordBorrowed` Path

**Analysis**: `borrowRegistry` path explicitly excluded from `transferPluginInstanceOwner` (see `loader-runtime-core.ts:414-420` comment "... Never used for `borrowRegistry` loans"). Shared logic in `projectPluginContributions` already handles borrowing correctly.

**Risk**: None - already correctly excluded

### 4.4 New `withRemoteModelCatalogSnapshot` Wrapper

**Analysis**: Added in main merge, wraps worker request handler. Doesn't affect ownership timing - just adds catalog snapshot context.

**Risk**: None - doesn't interact with registry transfer

### 4.5 Registration Resource Race During Transfer

**New Finding**: If a plugin registration is in progress (async disposer registration) exactly when transfer occurs:

1. Disposer could be registered to wrong `PluginRegistrationResourceSource`
2. Or registration could fail due to inspection state mismatch

**Mitigation**:

- Registration happens during plugin load, before retention/transfer
- Should be safe, but worth noting

## 5. Complete Code Change Plan

### Finding A: Registration Resource Transfer Fix

**File**: `src/plugins/registry-registration-resources.ts`

1. **Add registry parameter to disposal**:

```typescript
async #dispose(
  pluginId: string,
  entry: RegistrationResources,
  currentRegistry: PluginRegistry | undefined
): Promise<Error[]> {
  // Check if instance has been transferred away
  const owner = pluginInstanceState.records.get(/* get record for pluginId */);
  if (owner && owner.registry !== currentRegistry) {
    // Skip - instance belongs to different registry now
    return [];
  }
  // ... existing disposal logic
}
```

2. **Update call sites in `PluginRegistryInspectionResources`**:

```typescript
// In retire() method
const failures = await this.#source.disposeWithRegistryCheck(
  registry,
  rollbackInstances,
  retainedInstances,
);
```

**File**: `src/plugins/registry-inspection-resources.ts`

3. **Modify retire callback signature**:

```typescript
constructor(
  private readonly retire: (
    registry: PluginRegistry | undefined,
    rollbackInstances: ReadonlySet<object>,
    retainedInstances: ReadonlySet<object>,
    currentRegistry: PluginRegistry | undefined  // NEW
  ) => Promise<void>,
) {}
```

**File**: `src/plugins/loader-runtime-load.ts`

4. **Update retire callback usage**:

```typescript
const resources = new PluginRegistryInspectionResources(
  async (registry, rollbackInstances, retainedInstances, currentRegistry) => {
    // Pass currentRegistry to source disposal
    // ...
  },
);
```

### Finding B: Transactional Ownership Transfer Fix

**File**: `src/plugins/plugin-instance-scope.ts`

1. **Extend `transferPluginInstanceOwner`**:

```typescript
export function transferPluginInstanceOwner(
  record: PluginRecord,
  registry: PluginRegistry,
  options?: { temporary?: boolean },
): { rollback: () => void } | void {
  const owner = pluginInstanceState.records.get(record);
  if (owner && !owner.revoked) {
    const previousRegistry = owner.registry;
    owner.registry = registry;

    if (options?.temporary) {
      return {
        rollback: () => {
          if (owner.registry === registry && !owner.revoked) {
            owner.registry = previousRegistry;
          }
        },
      };
    }
  }
}
```

**File**: `src/plugins/loader-runtime-core.ts`

2. **Update `resolvePluginRecordRetention` return type**:

```typescript
return {
  registry: previousRegistry,
  record: previous,
  input: previousInput,
  transferRollback: transferPluginInstanceOwner(previous, registry, { temporary: true }),
};
```

3. **Collect rollbacks in caller**:

```typescript
const rollbacks: Array<() => void> = [];
if (retention.transferRollback) {
  rollbacks.push(retention.transferRollback.rollback);
}
```

**File**: `src/agents/prepared-model-catalog.worker.ts`

4. **Execute rollbacks on failure**:

```typescript
} catch (error) {
  // Execute rollbacks before cleanup
  for (const rollback of rollbacks) {
    try {
      rollback();
    } catch {}
  }
  // ... existing error handling
}
```

## 6. Required Test Additions

### Test 1: Real Registered Disposer for Finding A

**Purpose**: Catch registration resource transfer gap

**Implementation**:

```typescript
it("transfers registered disposers alongside instance ownership", async () => {
  // Plugin that registers a real disposer (e.g., closes a mock DB connection)
  // Transfer instance via previousRegistry retention
  // Release predecessor and verify disposer NOT called
  // Release successor and verify disposer called exactly once
});
```

**Location**: Extend `src/agents/prepared-model-runtime.plugin-lifetime.generation-handoff.test.ts`

### Test 2: Transactional Rollback for Finding B

**Purpose**: Verify failed generation restores ownership

**Implementation**:

```typescript
it("rolls back ownership transfer when generation build fails", async () => {
  // Build generation that fails after transfer
  // Verify predecessor still has working instances
  // Verify cleanup doesn't dispose transferred instances
});
```

**Location**: New file `src/agents/prepared-model-runtime.plugin-lifetime.transactional-rollback.test.ts`

### Test 3: Concurrent Expansion Prevention

**Purpose**: Ensure safe concurrent access

**Implementation**:

```typescript
it("handles concurrent catalog requests from same predecessor", async () => {
  // Simulate concurrent requests (may need async coordination)
  // Verify only one succeeds or they serialize correctly
});
```

### Test 4: Registration During Transfer Race

**Purpose**: Test async registration during ownership transfer

**Implementation**:

```typescript
it("handles async disposer registration during transfer", async () => {
  // Plugin with async registration that overlaps with transfer
  // Verify registration completes correctly on successor side
});
```

## Summary and Recommendations

### Critical Issues to Fix

1. **Finding A (Registration Resources)**: Highest priority - causes resource double-disposal
2. **Finding B (Transactional Transfer)**: High priority - causes premature disposal on failure
3. **Concurrent Access**: Medium priority - potential race in edge cases

### Implementation Order

1. Implement Finding A fix (registration resource filtering)
2. Implement Finding B fix (transactional transfer with rollback)
3. Add concurrent access safeguards
4. Add comprehensive tests

### Risk Assessment

- **Finding A fix**: Low risk - adds registry check to existing disposal logic
- **Finding B fix**: Medium risk - modifies core transfer function signature
- **Testing**: Essential for all fixes

This complete scope document provides the foundation for final implementation that addresses the systemic issues rather than individual symptoms.
