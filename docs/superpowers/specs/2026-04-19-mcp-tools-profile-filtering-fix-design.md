# MCP Tools Profile Filtering Fix Design

**Date:** 2026-04-19  
**Issue:** #68875  
**Related Issue:** #68246 (MCP tools not exposed to main agent)

## Problem Statement

MCP servers registered via `openclaw mcp set` don't expose tools to Pi runtime sessions (isolated, cron, main). Tools are loaded from the MCP servers but filtered out by tool profile policies before reaching the model's tool_use schema.

**Root cause:** MCP tools created in `materializeBundleMcpToolsForRun` lack plugin metadata. When `applyFinalEffectiveToolPolicy` checks `getPluginToolMeta(tool)`, it returns `undefined` → MCP tools treated as unknown tools → filtered by profile allowlists like `"coding"`.

**Impact:** Users with non-`"full"` profiles can't use MCP tools despite registering them. Issue affects all Pi runtime session types (isolated, cron, main).

## Success Criteria

1. MCP tools appear in tool_use schema for coding/messaging/full profiles
2. Minimal profile excludes MCP tools (explicit minimal behavior)
3. Users can deny MCP tools via `tools.deny: ["bundle-mcp"]`
4. No breaking changes to existing tool policy system
5. All GitHub CI checks pass (build, test, lint, typecheck)

## Design

### Architecture

**Two-part fix:**

1. **Metadata attachment** — Tag MCP tools with plugin metadata in `materializeBundleMcpToolsForRun` so the policy system recognizes them as plugin tools

2. **Profile inclusion** — Add `"bundle-mcp"` to coding/messaging profile allowlists so MCP tools pass through by default

**Data flow:**
```
openclaw mcp set
  ↓
mcp.servers config
  ↓
loadEmbeddedPiMcpConfig
  ↓
createSessionMcpRuntime
  ↓
materializeBundleMcpToolsForRun → [NEW] attach pluginId: "bundle-mcp"
  ↓
applyFinalEffectiveToolPolicy → getPluginToolMeta returns {pluginId: "bundle-mcp"}
  ↓
buildPluginToolGroups → MCP tools added to plugin tool set
  ↓
applyToolPolicyPipeline → [NEW] coding/messaging profiles include "bundle-mcp"
  ↓
MCP tools pass allowlist check ✓
```

**Why this works:** Plugin metadata makes MCP tools visible to policy system. Profile allowlist inclusion makes them available by default. Users retain full policy control via deny lists or profile switching.

### Components

#### Component 1: Plugin Metadata Attachment

**File:** `src/agents/pi-bundle-mcp-materialize.ts`

**Change:** In `materializeBundleMcpToolsForRun`, after creating each tool object, attach plugin metadata using the existing `pluginToolMeta` WeakMap.

**Implementation:**
```typescript
// Add import at top of file (after existing imports, around line 12):
import { setPluginToolMeta } from "../../plugins/tools.js";

// Inside the tool creation loop (line ~99-112):
const tool = {
  name: safeToolName,
  label: tool.title ?? tool.toolName,
  description: tool.description || tool.fallbackDescription,
  parameters: tool.inputSchema,
  execute: async (_toolCallId: string, input: unknown) => { ... }
};

// NEW: Attach plugin metadata with defensive error handling
try {
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false
  });
} catch (error) {
  // Log but don't fail - tool still usable, just won't have metadata
  logWarn(`bundle-mcp: failed to attach metadata to tool ${safeToolName}: ${error}`);
}

tools.push(tool);
```

**Why `pluginId: "bundle-mcp"`:** Identifies all MCP tools as coming from the bundle-mcp subsystem. Allows policy rules like `tools.allow: ["bundle-mcp"]` or `tools.deny: ["bundle-mcp"]`.

**Why `optional: false`:** MCP tools are explicitly registered by user via `openclaw mcp set`, not optional plugin features.

**Why try/catch:** Defensive - if metadata attachment fails, tool creation doesn't fail. Tool works but gets filtered by policy (degraded but not broken).

#### Component 2: Profile Allowlist Updates

**File:** `src/agents/tool-catalog.ts`

**Change:** Add `"bundle-mcp"` to coding and messaging profile allowlists.

**Before:**
```typescript
const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: listCoreToolIdsForProfile("coding"),
  },
  messaging: {
    allow: listCoreToolIdsForProfile("messaging"),
  },
  full: {},
};
```

**After:**
```typescript
const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"],
  },
  messaging: {
    allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"],
  },
  full: {},
};
```

**Why coding profile gets MCP:** Coding workflows often need external API calls (GitHub, databases, cloud services via MCP).

**Why messaging profile gets MCP:** Messaging integrations often need external services (CRM, ticketing, webhooks via MCP).

**Why minimal profile doesn't:** Minimal means minimal — only essential core tools.

**Why full profile unchanged:** Empty allowlist = allow everything, already includes MCP tools.

**Dev-time validation:**
```typescript
// After CORE_TOOL_PROFILES definition
if (process.env.NODE_ENV !== "production") {
  // Dev-time assertion
  const codingAllowlist = CORE_TOOL_PROFILES.coding.allow ?? [];
  const messagingAllowlist = CORE_TOOL_PROFILES.messaging.allow ?? [];
  
  if (!codingAllowlist.includes("bundle-mcp")) {
    console.warn("bundle-mcp missing from coding profile allowlist");
  }
  if (!messagingAllowlist.includes("bundle-mcp")) {
    console.warn("bundle-mcp missing from messaging profile allowlist");
  }
}
```

**Why validation:** Catches accidental removal during refactoring. Dev-only check, zero runtime cost in production.

#### Component 3: Export setPluginToolMeta

**File:** `src/plugins/tools.ts`

**Check:** Verify `setPluginToolMeta` is exported. 

**Verification command:**
```bash
grep -n "export.*setPluginToolMeta" src/plugins/tools.ts
```

**If not exported (grep returns nothing), add export after the WeakMap declaration (around line 21):**

```typescript
export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}
```

**Why:** Allows `pi-bundle-mcp-materialize.ts` to attach metadata to tools.

#### Component 4: Graceful Degradation Logging

**File:** `src/agents/pi-embedded-runner/effective-tool-policy.ts`

**Change:** Add structured logging when MCP tools filtered by policy.

**Location:** In `applyFinalEffectiveToolPolicy` function, after the `applyToolPolicyPipeline` call (around line 172), before the return statement.

**Implementation:**
```typescript
// After: return applyToolPolicyPipeline({ ... });
// Add this before the return:

const filtered = applyToolPolicyPipeline({
  tools: ownerFiltered,
  toolMeta: (tool) => getPluginToolMeta(tool),
  warn: params.warn,
  steps: pipelineSteps,
});

// NEW: Log MCP tool filtering
const mcpToolsBefore = params.bundledTools.filter(tool => {
  const meta = getPluginToolMeta(tool);
  return meta?.pluginId === "bundle-mcp";
}).length;

const mcpToolsAfter = filtered.filter(tool => {
  const meta = getPluginToolMeta(tool);
  return meta?.pluginId === "bundle-mcp";
}).length;

const mcpToolsFiltered = mcpToolsBefore - mcpToolsAfter;

if (mcpToolsFiltered > 0) {
  params.warn(
    `${mcpToolsFiltered} MCP tools filtered by policy. ` +
    `To enable: set tools.profile="full" or add "bundle-mcp" to tools.allow`
  );
}

return filtered;
```

**Why:** Users get actionable feedback when MCP tools blocked by policy. Improves debuggability.

### Error Handling & Edge Cases

**Edge case 1: MCP server connection failure**

**Current behavior:** `materializeBundleMcpToolsForRun` already handles this — failed servers logged, session disposed, no tools added for that server.

**No change needed:** Plugin metadata only attached to successfully created tools.

**Edge case 2: User wants to block MCP tools**

**Solution:** Use deny list:
```json
{
  "tools": {
    "profile": "coding",
    "deny": ["bundle-mcp"]
  }
}
```

**Result:** All MCP tools filtered out despite being in coding profile allowlist.

**Edge case 3: User wants specific MCP server only**

**Solution:** Use explicit allowlist with server name:
```json
{
  "tools": {
    "allow": ["read", "write", "exec", "myserver__*"]
  }
}
```

**Result:** Only tools from `myserver` MCP server allowed (glob pattern matches `myserver__toolname`).

**Edge case 4: Backward compatibility**

**Impact:** Users with existing `tools.profile = "coding"` config get MCP tools automatically after upgrade.

**Mitigation:** This is desired behavior (fixes the bug). Users who don't want MCP tools can add deny rule.

**Edge case 5: Plugin metadata WeakMap survival**

**Concern:** Does metadata survive tool wrapping/normalization in policy pipeline?

**Answer:** Yes — `copyPluginToolMeta` function already exists in `plugins/tools.ts` for this purpose. Policy pipeline uses it when wrapping tools.

**Edge case 6: Metadata attachment failure**

**Handling:** Try/catch around `setPluginToolMeta` logs warning but doesn't fail tool creation. Tool works but may be filtered by policy (degraded gracefully).

### Testing Strategy

**Unit Tests:**

**Test 1: Metadata attachment**
- File: `src/agents/pi-bundle-mcp-materialize.test.ts`
- Verify: Tools created by `materializeBundleMcpToolsForRun` have `pluginId: "bundle-mcp"` metadata
- Method: Call `getPluginToolMeta(tool)` on materialized tools, assert metadata present

**Test 2: Profile allowlist inclusion**
- File: `src/agents/tool-catalog.test.ts`
- Verify: Coding/messaging profiles include `"bundle-mcp"` in allowlist
- Method: Check `CORE_TOOL_PROFILES.coding.allow` contains `"bundle-mcp"`

**Test 3: Policy filtering with metadata**
- File: `src/agents/pi-embedded-runner/effective-tool-policy.test.ts`
- Verify: MCP tools with metadata pass through coding profile filter
- Method: Create mock MCP tools with metadata, run through `applyFinalEffectiveToolPolicy` with coding profile, assert tools present in output

**Test 4: Deny list override**
- File: `src/agents/tool-policy-pipeline.test.ts`
- Verify: `tools.deny: ["bundle-mcp"]` blocks MCP tools even in coding profile
- Method: Apply pipeline with deny rule, assert MCP tools filtered out

**Integration Tests:**

**Test 5: End-to-end MCP tool availability**
- File: `src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts` (already exists)
- Verify: MCP tools appear in tool_use schema for coding profile session
- Method: Create session with coding profile, register mock MCP server, run attempt, assert MCP tools in effective tools list

**Test 6: Minimal profile excludes MCP**
- File: Same as Test 5
- Verify: Minimal profile doesn't include MCP tools
- Method: Create session with minimal profile, register mock MCP server, assert MCP tools NOT in effective tools list

**Manual Testing:**

1. Register MCP server: `openclaw mcp set testserver '{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}'`
2. Set coding profile: `tools.profile = "coding"` in config
3. Start isolated session: `openclaw agent --agent main -m "List your tools"`
4. Verify: MCP tools from testserver appear in output

**Expected output (partial):**
```
Tools available:
- read
- write
- edit
- exec
- process
- testserver__get_weather    # MCP tool
- testserver__search_web     # MCP tool
- testserver__fetch_data     # MCP tool
...
```

5. Add deny rule: `tools.deny = ["bundle-mcp"]` to config
6. Restart session, verify: MCP tools gone (only core tools remain)

**Expected output after deny:**
```
Tools available:
- read
- write
- edit
- exec
- process
(no testserver__ tools)
```

### CI/CD Integration

**GitHub Checks Coverage:**

**Check 1: Type checking**
- Command: `pnpm typecheck` or `pnpm check`
- Validates: Plugin metadata types, profile allowlist types
- Ensures: No TypeScript errors from new exports or type changes

**Check 2: Unit test suite**
- Command: `pnpm test`
- Runs: All unit tests including new metadata/policy tests
- Coverage: Must maintain or improve coverage percentage

**Check 3: Lint checks**
- Command: `pnpm lint`
- Validates: Code style, import order, unused variables
- Ensures: New code follows repo conventions

**Check 4: Build validation**
- Command: `pnpm build`
- Validates: All TypeScript compiles, no build errors
- Ensures: Changes don't break production build

**Check 5: Integration test lane**
- Command: `pnpm test:integration` or specific bundle-mcp test
- Runs: E2E tests including `pi-embedded-runner.bundle-mcp.e2e.test.ts`
- Validates: MCP tools actually appear in runtime

**Pre-commit Hook Compliance:**

From CONTRIBUTING.md line 104:
```bash
pnpm build && pnpm check && pnpm test
```

**Our changes must pass:**
1. `pnpm build` — TypeScript compilation
2. `pnpm check` — Type checking + linting
3. `pnpm test` — Full test suite

**Pre-PR checklist:**

```bash
# Local validation before pushing
pnpm build          # Must pass
pnpm check          # Must pass
pnpm test           # Must pass
pnpm test:extension bundle-mcp  # If extension-specific tests exist
```

**GitHub PR template compliance:**

From CONTRIBUTING.md line 160-167, PR must include:
- [ ] Mark as AI-assisted in PR description
- [ ] Note testing degree (fully tested)
- [ ] Confirm understanding of code changes
- [ ] Include before/after proof (tool list output)
- [ ] Screenshots showing MCP tools appearing in tool_use schema

**Expected CI checks:**
- ✅ Build (ubuntu-latest, Node 20)
- ✅ Test (ubuntu-latest, Node 20)
- ✅ Lint
- ✅ Type check
- ✅ Integration tests (if separate lane)

**Failure scenarios to test:**

1. **Missing metadata export** → Type check fails
2. **Profile allowlist typo** → Unit test fails
3. **Policy filtering regression** → Integration test fails
4. **Import cycle** → Build fails

## Implementation Notes

**Files to modify:**
1. `src/agents/pi-bundle-mcp-materialize.ts` — Add metadata attachment
2. `src/agents/tool-catalog.ts` — Update profile allowlists
3. `src/plugins/tools.ts` — Export `setPluginToolMeta` if needed
4. `src/agents/pi-embedded-runner/effective-tool-policy.ts` — Add degradation logging

**Files to create/update for tests:**
1. `src/agents/pi-bundle-mcp-materialize.test.ts` — **UPDATE EXISTING** — Add metadata attachment test
2. `src/agents/tool-catalog.test.ts` — **UPDATE EXISTING** — Add profile allowlist test
3. `src/agents/pi-embedded-runner/effective-tool-policy.test.ts` — **UPDATE EXISTING** — Add policy filtering test
4. `src/agents/tool-policy-pipeline.test.ts` — **UPDATE EXISTING** — Add deny list test
5. `src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts` — **UPDATE EXISTING** — Add E2E test for coding/minimal profiles

**Estimated complexity:** Low-medium
- Core changes: ~20 lines across 3 files
- Test changes: ~100 lines across 5 test files
- No breaking changes to public APIs
- No database migrations or config schema changes

## Alternatives Considered

**Alternative 1: MCP tools bypass all filtering**
- Always available regardless of profile
- Simplest code change
- ❌ No policy control, inconsistent with plugin system
- **Rejected:** Doesn't maintain architectural consistency

**Alternative 2: MCP tools as plugins, manual config**
- Attach plugin metadata, users add to allowlist manually
- Architecturally correct
- ❌ Requires user config, breaks existing workflows
- **Rejected:** Poor user experience for common case

**Alternative 3: MCP tools as plugins, auto-included in profiles (SELECTED)**
- Attach `pluginId: "bundle-mcp"` metadata to MCP tools
- Add `"bundle-mcp"` to coding/messaging profile allowlists
- Keep minimal profile without MCP tools
- ✅ Zero config for most users
- ✅ Maintains policy flexibility
- ✅ Architecturally correct
- **Selected:** Best balance of usability and correctness

## Migration Path

**For users with `tools.profile = "coding"`:**
- Before: MCP tools filtered out (bug)
- After: MCP tools available automatically (fix)
- Action required: None (desired behavior)

**For users with `tools.profile = "full"`:**
- Before: MCP tools available (already worked)
- After: MCP tools available (no change)
- Action required: None

**For users with `tools.profile = "minimal"`:**
- Before: MCP tools filtered out (expected)
- After: MCP tools filtered out (no change)
- Action required: None

**For users who want to block MCP tools:**
- Before: Not possible without switching to minimal profile
- After: Add `tools.deny: ["bundle-mcp"]` to config
- Action required: Add deny rule if desired

## Rollback Plan

If issues discovered post-merge:

1. **Immediate:** Revert the two-line profile allowlist change in `tool-catalog.ts`
   - Restores pre-fix behavior (MCP tools filtered in coding/messaging profiles)
   - Users can still use `tools.profile = "full"` as workaround

2. **If metadata causes issues:** Revert metadata attachment in `pi-bundle-mcp-materialize.ts`
   - Restores original behavior completely
   - No data loss, no config migration needed

3. **Clean rollback:** Both changes are additive, no destructive operations
   - No database state to clean up
   - No config migrations to reverse
   - Simple git revert of commits
