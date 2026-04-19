# MCP Tools Profile Filtering Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable MCP tools to appear in Pi runtime tool_use schema for coding/messaging profiles by attaching plugin metadata and updating profile allowlists.

**Architecture:** Two-part fix: (1) Tag MCP tools with `pluginId: "bundle-mcp"` metadata in materialize function so policy system recognizes them as plugin tools, (2) Add `"bundle-mcp"` to coding/messaging profile allowlists so they pass through by default.

**Tech Stack:** TypeScript, existing plugin metadata WeakMap system, tool policy pipeline

---

## File Structure

**Core Implementation Files:**
- `src/agents/pi-bundle-mcp-materialize.ts` — Add metadata attachment to tool creation loop
- `src/agents/tool-catalog.ts` — Update CORE_TOOL_PROFILES with bundle-mcp in allowlists
- `src/plugins/tools.ts` — Export setPluginToolMeta if not already exported
- `src/agents/pi-embedded-runner/effective-tool-policy.ts` — Add degradation logging

**Test Files (all existing, will update):**
- `src/agents/pi-bundle-mcp-materialize.test.ts` — Add metadata attachment test
- `src/agents/tool-catalog.test.ts` — Add profile allowlist test
- `src/agents/pi-embedded-runner/effective-tool-policy.test.ts` — Add policy filtering test
- `src/agents/tool-policy-pipeline.test.ts` — Add deny list test
- `src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts` — Add E2E profile tests

---

### Task 1: Export setPluginToolMeta (if needed)

**Files:**
- Modify: `src/plugins/tools.ts:21-32`

- [ ] **Step 1: Check if setPluginToolMeta is already exported**

Run:
```bash
grep -n "export.*setPluginToolMeta" src/plugins/tools.ts
```

Expected: Either output showing export exists, or no output (needs export)

- [ ] **Step 2: If not exported, add export function**

If grep returned nothing, add after line 21 (after WeakMap declaration):

```typescript
export function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void {
  pluginToolMeta.set(tool, meta);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run:
```bash
pnpm typecheck
```

Expected: No errors related to setPluginToolMeta

- [ ] **Step 4: Commit export addition**

```bash
git add src/plugins/tools.ts
git commit -m "feat(plugins): export setPluginToolMeta for MCP tool metadata"
```

---

### Task 2: Add Plugin Metadata to MCP Tools

**Files:**
- Modify: `src/agents/pi-bundle-mcp-materialize.ts:1-15,99-112`
- Test: `src/agents/pi-bundle-mcp-materialize.test.ts`

- [ ] **Step 1: Write failing test for metadata attachment**

Add to `src/agents/pi-bundle-mcp-materialize.test.ts`:

```typescript
import { getPluginToolMeta } from "../../plugins/tools.js";

describe("materializeBundleMcpToolsForRun", () => {
  it("attaches bundle-mcp plugin metadata to materialized tools", async () => {
    const mockRuntime: SessionMcpRuntime = {
      sessionId: "test-session",
      workspaceDir: "/test",
      configFingerprint: "abc123",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      getCatalog: async () => ({
        version: 1,
        generatedAt: Date.now(),
        servers: {
          testserver: {
            serverName: "testserver",
            launchSummary: "test server",
            toolCount: 1,
          },
        },
        tools: [
          {
            serverName: "testserver",
            safeServerName: "testserver",
            toolName: "test_tool",
            title: "Test Tool",
            description: "A test tool",
            inputSchema: {},
            fallbackDescription: "Test tool from testserver",
          },
        ],
      }),
      markUsed: () => {},
      callTool: async () => ({ content: [] }),
      dispose: async () => {},
    };

    const result = await materializeBundleMcpToolsForRun({
      runtime: mockRuntime,
      reservedToolNames: [],
    });

    expect(result.tools.length).toBe(1);
    const tool = result.tools[0];
    const meta = getPluginToolMeta(tool);
    expect(meta).toBeDefined();
    expect(meta?.pluginId).toBe("bundle-mcp");
    expect(meta?.optional).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test src/agents/pi-bundle-mcp-materialize.test.ts
```

Expected: FAIL with "Expected meta to be defined" or similar

- [ ] **Step 3: Add import for setPluginToolMeta**

In `src/agents/pi-bundle-mcp-materialize.ts`, add after line 12 (after existing imports):

```typescript
import { setPluginToolMeta } from "../../plugins/tools.js";
```

- [ ] **Step 4: Add metadata attachment in tool creation loop**

In `src/agents/pi-bundle-mcp-materialize.ts`, after line 112 (after tool object creation, before `tools.push(tool)`):

```typescript
    // Attach plugin metadata so policy system recognizes MCP tools
    try {
      setPluginToolMeta(tool, {
        pluginId: "bundle-mcp",
        optional: false,
      });
    } catch (error) {
      logWarn(`bundle-mcp: failed to attach metadata to tool ${safeToolName}: ${error}`);
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
pnpm test src/agents/pi-bundle-mcp-materialize.test.ts
```

Expected: PASS

- [ ] **Step 6: Run full test suite to check for regressions**

Run:
```bash
pnpm test
```

Expected: All tests pass

- [ ] **Step 7: Commit metadata attachment**

```bash
git add src/agents/pi-bundle-mcp-materialize.ts src/agents/pi-bundle-mcp-materialize.test.ts
git commit -m "feat(mcp): attach bundle-mcp plugin metadata to MCP tools"
```

---

### Task 3: Update Profile Allowlists

**Files:**
- Modify: `src/agents/tool-catalog.ts:316-327`
- Test: `src/agents/tool-catalog.test.ts`

- [ ] **Step 1: Write failing test for profile allowlist inclusion**

Add to `src/agents/tool-catalog.test.ts`:

```typescript
describe("CORE_TOOL_PROFILES", () => {
  it("includes bundle-mcp in coding profile allowlist", () => {
    const codingProfile = CORE_TOOL_PROFILES.coding;
    expect(codingProfile.allow).toBeDefined();
    expect(codingProfile.allow).toContain("bundle-mcp");
  });

  it("includes bundle-mcp in messaging profile allowlist", () => {
    const messagingProfile = CORE_TOOL_PROFILES.messaging;
    expect(messagingProfile.allow).toBeDefined();
    expect(messagingProfile.allow).toContain("bundle-mcp");
  });

  it("does not include bundle-mcp in minimal profile allowlist", () => {
    const minimalProfile = CORE_TOOL_PROFILES.minimal;
    expect(minimalProfile.allow).toBeDefined();
    expect(minimalProfile.allow).not.toContain("bundle-mcp");
  });

  it("full profile has empty allowlist (allows everything)", () => {
    const fullProfile = CORE_TOOL_PROFILES.full;
    expect(fullProfile.allow).toBeUndefined();
    expect(fullProfile.deny).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test src/agents/tool-catalog.test.ts
```

Expected: FAIL with "Expected array to contain 'bundle-mcp'"

- [ ] **Step 3: Update CORE_TOOL_PROFILES definition**

In `src/agents/tool-catalog.ts`, replace lines 316-327:

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

- [ ] **Step 4: Add dev-time validation after CORE_TOOL_PROFILES**

After the CORE_TOOL_PROFILES definition (around line 328):

```typescript
// Dev-time validation to catch accidental removal
if (process.env.NODE_ENV !== "production") {
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

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
pnpm test src/agents/tool-catalog.test.ts
```

Expected: PASS

- [ ] **Step 6: Verify TypeScript compiles**

Run:
```bash
pnpm typecheck
```

Expected: No errors

- [ ] **Step 7: Commit profile allowlist updates**

```bash
git add src/agents/tool-catalog.ts src/agents/tool-catalog.test.ts
git commit -m "feat(tools): add bundle-mcp to coding/messaging profile allowlists"
```

---

### Task 4: Add Graceful Degradation Logging

**Files:**
- Modify: `src/agents/pi-embedded-runner/effective-tool-policy.ts:172-178`
- Test: `src/agents/pi-embedded-runner/effective-tool-policy.test.ts`

- [ ] **Step 1: Write test for MCP tool filtering warning**

Add to `src/agents/pi-embedded-runner/effective-tool-policy.test.ts`:

```typescript
import { setPluginToolMeta } from "../../../plugins/tools.js";

describe("applyFinalEffectiveToolPolicy", () => {
  it("warns when MCP tools are filtered by policy", () => {
    const warnings: string[] = [];
    const mockWarn = (msg: string) => warnings.push(msg);

    const mcpTool1 = {
      name: "testserver__tool1",
      label: "Tool 1",
      description: "Test tool 1",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const mcpTool2 = {
      name: "testserver__tool2",
      label: "Tool 2",
      description: "Test tool 2",
      parameters: {},
      execute: async () => ({ content: [] }),
    };

    setPluginToolMeta(mcpTool1, { pluginId: "bundle-mcp", optional: false });
    setPluginToolMeta(mcpTool2, { pluginId: "bundle-mcp", optional: false });

    const result = applyFinalEffectiveToolPolicy({
      bundledTools: [mcpTool1, mcpTool2],
      config: {
        tools: {
          profile: "minimal", // Minimal profile excludes MCP tools
        },
      },
      sessionKey: undefined,
      agentId: undefined,
      modelProvider: undefined,
      modelId: undefined,
      messageProvider: undefined,
      agentAccountId: null,
      groupId: null,
      groupChannel: null,
      groupSpace: null,
      spawnedBy: null,
      senderId: null,
      senderName: null,
      senderUsername: null,
      senderE164: null,
      senderIsOwner: true,
      warn: mockWarn,
    });

    expect(result.length).toBe(0); // All MCP tools filtered
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes("MCP tools filtered by policy"))).toBe(true);
    expect(warnings.some(w => w.includes('tools.profile="full"'))).toBe(true);
  });

  it("does not warn when no MCP tools are filtered", () => {
    const warnings: string[] = [];
    const mockWarn = (msg: string) => warnings.push(msg);

    const mcpTool = {
      name: "testserver__tool",
      label: "Tool",
      description: "Test tool",
      parameters: {},
      execute: async () => ({ content: [] }),
    };

    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const result = applyFinalEffectiveToolPolicy({
      bundledTools: [mcpTool],
      config: {
        tools: {
          profile: "coding", // Coding profile includes MCP tools
        },
      },
      sessionKey: undefined,
      agentId: undefined,
      modelProvider: undefined,
      modelId: undefined,
      messageProvider: undefined,
      agentAccountId: null,
      groupId: null,
      groupChannel: null,
      groupSpace: null,
      spawnedBy: null,
      senderId: null,
      senderName: null,
      senderUsername: null,
      senderE164: null,
      senderIsOwner: true,
      warn: mockWarn,
    });

    expect(result.length).toBe(1); // MCP tool passed through
    expect(warnings.some(w => w.includes("MCP tools filtered"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm test src/agents/pi-embedded-runner/effective-tool-policy.test.ts
```

Expected: FAIL with "Expected warnings to include MCP tools filtered"

- [ ] **Step 3: Add degradation logging to applyFinalEffectiveToolPolicy**

In `src/agents/pi-embedded-runner/effective-tool-policy.ts`, replace the return statement (around line 172):

```typescript
  const filtered = applyToolPolicyPipeline({
    tools: ownerFiltered,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: params.warn,
    steps: pipelineSteps,
  });

  // Log when MCP tools are filtered by policy
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

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
pnpm test src/agents/pi-embedded-runner/effective-tool-policy.test.ts
```

Expected: PASS

- [ ] **Step 5: Verify TypeScript compiles**

Run:
```bash
pnpm typecheck
```

Expected: No errors

- [ ] **Step 6: Commit degradation logging**

```bash
git add src/agents/pi-embedded-runner/effective-tool-policy.ts src/agents/pi-embedded-runner/effective-tool-policy.test.ts
git commit -m "feat(tools): add warning when MCP tools filtered by policy"
```

---

### Task 5: Add E2E Tests for Profile Behavior

**Files:**
- Modify: `src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts`

- [ ] **Step 1: Write E2E test for coding profile includes MCP tools**

Add to `src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts`:

```typescript
describe("MCP tools with tool profiles", () => {
  it("includes MCP tools in coding profile", async () => {
    const mockMcpServer = createMockMcpServer({
      tools: [
        {
          name: "test_tool",
          title: "Test Tool",
          description: "A test tool",
          inputSchema: {},
        },
      ],
    });

    const config: OpenClawConfig = {
      tools: {
        profile: "coding",
      },
    };

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "test-coding-profile",
      workspaceDir: "/test",
      cfg: config,
    });

    const catalog = await runtime.getCatalog();
    expect(catalog.tools.length).toBeGreaterThan(0);

    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: ["read", "write", "exec"],
    });

    expect(materialized.tools.length).toBeGreaterThan(0);
    
    // Verify tools have metadata
    const tool = materialized.tools[0];
    const meta = getPluginToolMeta(tool);
    expect(meta?.pluginId).toBe("bundle-mcp");

    // Verify tools pass through policy filter
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: materialized.tools,
      config,
      sessionKey: undefined,
      agentId: undefined,
      modelProvider: undefined,
      modelId: undefined,
      messageProvider: undefined,
      agentAccountId: null,
      groupId: null,
      groupChannel: null,
      groupSpace: null,
      spawnedBy: null,
      senderId: null,
      senderName: null,
      senderUsername: null,
      senderE164: null,
      senderIsOwner: true,
      warn: () => {},
    });

    expect(filtered.length).toBe(materialized.tools.length);
  });

  it("excludes MCP tools in minimal profile", async () => {
    const mockMcpServer = createMockMcpServer({
      tools: [
        {
          name: "test_tool",
          title: "Test Tool",
          description: "A test tool",
          inputSchema: {},
        },
      ],
    });

    const config: OpenClawConfig = {
      tools: {
        profile: "minimal",
      },
    };

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "test-minimal-profile",
      workspaceDir: "/test",
      cfg: config,
    });

    const materialized = await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: ["read", "write"],
    });

    expect(materialized.tools.length).toBeGreaterThan(0);

    // Verify tools are filtered out by minimal profile
    const filtered = applyFinalEffectiveToolPolicy({
      bundledTools: materialized.tools,
      config,
      sessionKey: undefined,
      agentId: undefined,
      modelProvider: undefined,
      modelId: undefined,
      messageProvider: undefined,
      agentAccountId: null,
      groupId: null,
      groupChannel: null,
      groupSpace: null,
      spawnedBy: null,
      senderId: null,
      senderName: null,
      senderUsername: null,
      senderE164: null,
      senderIsOwner: true,
      warn: () => {},
    });

    expect(filtered.length).toBe(0); // All MCP tools filtered
  });
});
```

- [ ] **Step 2: Run E2E test to verify it fails**

Run:
```bash
pnpm test src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts
```

Expected: FAIL (tests rely on previous implementation)

- [ ] **Step 3: Run E2E test to verify it passes after all changes**

Run:
```bash
pnpm test src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts
```

Expected: PASS (all previous tasks completed)

- [ ] **Step 4: Commit E2E tests**

```bash
git add src/agents/pi-embedded-runner.bundle-mcp.e2e.test.ts
git commit -m "test(mcp): add E2E tests for MCP tools with profiles"
```

---

### Task 6: Add Deny List Override Test

**Files:**
- Modify: `src/agents/tool-policy-pipeline.test.ts`

- [ ] **Step 1: Write test for deny list blocking MCP tools**

Add to `src/agents/tool-policy-pipeline.test.ts`:

```typescript
import { setPluginToolMeta } from "../plugins/tools.js";

describe("applyToolPolicyPipeline with MCP tools", () => {
  it("blocks MCP tools when bundle-mcp is in deny list", () => {
    const mcpTool = {
      name: "testserver__tool",
      label: "Test Tool",
      description: "A test tool",
      parameters: {},
      execute: async () => ({ content: [] }),
    };

    const coreTool = {
      name: "read",
      label: "Read",
      description: "Read files",
      parameters: {},
      execute: async () => ({ content: [] }),
    };

    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const tools = [coreTool, mcpTool];
    const warnings: string[] = [];

    const filtered = applyToolPolicyPipeline({
      tools,
      toolMeta: (tool) => getPluginToolMeta(tool),
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: {
            allow: ["read", "bundle-mcp"],
            deny: ["bundle-mcp"], // Deny overrides allow
          },
          label: "test policy",
        },
      ],
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("read");
    expect(filtered.find(t => t.name === "testserver__tool")).toBeUndefined();
  });

  it("allows MCP tools when bundle-mcp is in allow list and not denied", () => {
    const mcpTool = {
      name: "testserver__tool",
      label: "Test Tool",
      description: "A test tool",
      parameters: {},
      execute: async () => ({ content: [] }),
    };

    setPluginToolMeta(mcpTool, { pluginId: "bundle-mcp", optional: false });

    const tools = [mcpTool];
    const warnings: string[] = [];

    const filtered = applyToolPolicyPipeline({
      tools,
      toolMeta: (tool) => getPluginToolMeta(tool),
      warn: (msg) => warnings.push(msg),
      steps: [
        {
          policy: {
            allow: ["bundle-mcp"],
          },
          label: "test policy",
        },
      ],
    });

    expect(filtered.length).toBe(1);
    expect(filtered[0].name).toBe("testserver__tool");
  });
});
```

- [ ] **Step 2: Run test to verify behavior**

Run:
```bash
pnpm test src/agents/tool-policy-pipeline.test.ts
```

Expected: PASS (implementation already supports deny override)

- [ ] **Step 3: Commit deny list tests**

```bash
git add src/agents/tool-policy-pipeline.test.ts
git commit -m "test(tools): add deny list override tests for MCP tools"
```

---

### Task 7: Run Full CI Validation

**Files:**
- None (validation only)

- [ ] **Step 1: Run full build**

Run:
```bash
pnpm build
```

Expected: Build succeeds with no errors

- [ ] **Step 2: Run type checking**

Run:
```bash
pnpm check
```

Expected: No type errors

- [ ] **Step 3: Run full test suite**

Run:
```bash
pnpm test
```

Expected: All tests pass

- [ ] **Step 4: Run linting**

Run:
```bash
pnpm lint
```

Expected: No lint errors

- [ ] **Step 5: Run extension-specific tests if available**

Run:
```bash
pnpm test:extension bundle-mcp 2>/dev/null || echo "No extension-specific test lane"
```

Expected: Tests pass or command not found (acceptable)

- [ ] **Step 6: Verify all commits follow conventional commit format**

Run:
```bash
git log --oneline -7
```

Expected: All commit messages start with `feat:`, `test:`, or similar conventional prefix

---

### Task 8: Manual Verification

**Files:**
- None (manual testing only)

- [ ] **Step 1: Register test MCP server**

Run:
```bash
openclaw mcp set testserver '{"command":"npx","args":["-y","@modelcontextprotocol/server-everything"]}'
```

Expected: Success message

- [ ] **Step 2: Verify MCP server registered**

Run:
```bash
openclaw mcp list
```

Expected: Output shows `testserver` in list

- [ ] **Step 3: Set coding profile in config**

Edit `~/.openclaw/openclaw.json` or workspace config:
```json
{
  "tools": {
    "profile": "coding"
  }
}
```

- [ ] **Step 4: Start agent session and list tools**

Run:
```bash
openclaw agent --agent main -m "List all your available tools by name, one per line"
```

Expected: Output includes MCP tools with `testserver__` prefix

- [ ] **Step 5: Test deny list override**

Edit config to add deny rule:
```json
{
  "tools": {
    "profile": "coding",
    "deny": ["bundle-mcp"]
  }
}
```

- [ ] **Step 6: Restart session and verify MCP tools blocked**

Run:
```bash
openclaw agent --agent main -m "List all your available tools by name"
```

Expected: Output does NOT include `testserver__` tools

- [ ] **Step 7: Clean up test config**

Remove deny rule from config, unset test MCP server:
```bash
openclaw mcp unset testserver
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Component 1 (metadata attachment): Task 2
- ✅ Component 2 (profile allowlists): Task 3
- ✅ Component 3 (export function): Task 1
- ✅ Component 4 (degradation logging): Task 4
- ✅ Test 1 (metadata attachment): Task 2 Step 1
- ✅ Test 2 (profile allowlist): Task 3 Step 1
- ✅ Test 3 (policy filtering): Task 4 Step 1
- ✅ Test 4 (deny list): Task 6
- ✅ Test 5 (E2E coding profile): Task 5
- ✅ Test 6 (E2E minimal profile): Task 5
- ✅ CI/CD validation: Task 7
- ✅ Manual testing: Task 8

**Placeholder scan:**
- ✅ No TBD/TODO markers
- ✅ All code blocks complete
- ✅ All test expectations specified
- ✅ All file paths exact

**Type consistency:**
- ✅ `setPluginToolMeta` signature consistent across all tasks
- ✅ `pluginId: "bundle-mcp"` used consistently
- ✅ `optional: false` used consistently
- ✅ Tool structure matches across tests

**Task granularity:**
- ✅ Each step is 2-5 minutes
- ✅ Test-first approach (write failing test, implement, verify pass)
- ✅ Frequent commits after each component
