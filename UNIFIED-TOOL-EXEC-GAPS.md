# Unified Tool Execution - Coverage Analysis

This document identifies all code paths that execute tools outside the unified error handling layer.

## ✅ Covered by Unified Execution

### 1. Pi Runtime (via `pi-tool-definition-adapter.ts`)

- **File**: `src/agents/pi-tool-definition-adapter.ts`
- **Function**: `toToolDefinitions()`
- **Status**: ✅ USES `executeToolWithErrorHandling()`
- **Coverage**: All tools executed through Pi Agent Core runtime

### 2. Claude SDK Runtime (via `tool-bridge.ts`)

- **File**: `src/agents/claude-agent-sdk/tool-bridge.ts`
- **Function**: `wrapToolHandler()`
- **Status**: ✅ USES `executeToolWithErrorHandling()`
- **Coverage**: All tools executed through Claude Agent SDK runtime

## ⚠️ NOT Covered - Direct Tool Execution Bypasses

### 1. ✅ FIXED - Inline Skill Command Tool Execution

- **File**: `src/auto-reply/reply/get-reply-inline-actions.ts`
- **Status**: ✅ **FIXED** - Now uses `executeToolWithErrorHandling()`
- **Fix Commit**: `e56818efa` - "fix(auto-reply): use unified tool execution for inline skill commands"
- **Test Coverage**: `src/auto-reply/reply/get-reply-inline-actions.skill-tool-error-handling.test.ts`
- **Previous Issue**: Direct `tool.execute()` call bypassed unified error handling
- **Current Implementation**:
  ```typescript
  const { result, error, aborted } = await executeToolWithErrorHandling(tool, {
    toolCallId,
    toolName: tool.name,
    normalizedToolName: normalizeToolName(tool.name),
    params: { command: rawArgs, commandName, skillName },
    sessionKey,
    agentId,
  });
  ```
- **Benefits**:
  - ✅ Unified error handling
  - ✅ `logToolError()` structured logging
  - ✅ Error message truncation for multi-line errors
  - ✅ Exec command context in logs
  - ✅ Performance measurement via `measureOperation()`

### 2. ✅ DOCUMENTED - Tool Parameter Normalization Wrapper

- **File**: `src/agents/pi-tools.read.ts`
- **Function**: `wrapToolParamNormalization()`
- **Status**: ⚠️ **DOCUMENTED** - Wrapper behavior and runtime adapter requirement documented
- **Fix Commit**: `e703bcc17` - "docs(tools): document wrapper reliance on runtime adapters"
- **Line**: 249
- **Code**:
  ```typescript
  return tool.execute(toolCallId, normalized ?? params, signal, onUpdate);
  ```
- **Impact**:
  - ⚠️ No unified error handling if called directly
  - ✅ Has unified error handling when used via runtime adapters (normal path)
- **Context**: Wraps tools to normalize Claude Code parameter conventions
- **Documentation**: JSDoc explains that tools created by this function should be passed to runtime adapters
- **Risk**: Low - wrappers are typically used to create tool instances passed to runtime adapters

### 3. ✅ DOCUMENTED - Sandbox Path Guard Wrapper

- **File**: `src/agents/pi-tools.read.ts`
- **Function**: `wrapSandboxPathGuard()`
- **Status**: ⚠️ **DOCUMENTED** - Wrapper behavior documented
- **Fix Commit**: `e703bcc17` - "docs(tools): document wrapper reliance on runtime adapters"
- **Line**: 266
- **Code**:
  ```typescript
  return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
  ```
- **Impact**: Same as #2
- **Context**: Wraps tools to enforce sandbox path restrictions
- **Documentation**: JSDoc explains reliance on runtime adapters

### 4. ✅ DOCUMENTED - OpenClaw Read Tool Wrapper

- **File**: `src/agents/pi-tools.read.ts`
- **Function**: `createOpenClawReadTool()`
- **Status**: ⚠️ **DOCUMENTED** - Wrapper behavior documented
- **Fix Commit**: `e703bcc17` - "docs(tools): document wrapper reliance on runtime adapters"
- **Line**: 296
- **Code**:
  ```typescript
  const result = await base.execute(toolCallId, normalized ?? params, signal);
  ```
- **Impact**: Same as #2
- **Context**: Wraps read tool to normalize image results and sanitize oversized images
- **Documentation**: JSDoc explains reliance on runtime adapters

## Analysis

### Critical Issues

1. **Inline skill commands** (#1) completely bypass unified error handling
   - Users invoking `/skill-name` will see inconsistent error logging
   - Errors won't appear in `logToolError()` structured logs
   - Multi-line subprocess errors won't be truncated for console readability

2. **Tool wrappers** (#2-4) create a layering issue:
   - These wrappers add validation/normalization logic BEFORE execution
   - They then call the base tool directly
   - When these wrapped tools go through the runtime adapters, they get unified handling
   - BUT if called directly (like in #1), they bypass it

### Flow Analysis

```
Skill Command Execution (BYPASSES):
  User types: /my-skill
  → get-reply-inline-actions.ts
  → tool.execute() DIRECT CALL ❌
  → No unified error handling

Normal Agent Tool Execution (COVERED):
  Agent decides to use tool
  → Runtime adapter (Pi or SDK)
  → executeToolWithErrorHandling() ✅
  → Unified error handling

Wrapped Tool via Runtime (COVERED):
  Agent decides to use read/write/edit
  → Runtime adapter
  → executeToolWithErrorHandling()
  → Calls wrapped tool
  → Wrapper calls base tool
  → Still within unified try/catch ✅
```

### Why Wrappers (#2-4) Are Lower Priority

The wrappers in `pi-tools.read.ts` are typically used by creating tool instances that then get passed to the runtime adapters. Example:

```typescript
// Tools are created with wrappers
const tools = [
  createSandboxedReadTool(workspaceDir),
  createSandboxedWriteTool(workspaceDir),
  // ...
];

// Then passed to runtime adapter
const toolDefs = toToolDefinitions(tools, hookContext);
```

When `toToolDefinitions()` wraps each tool, it calls `executeToolWithErrorHandling()`, which then calls the wrapped tool's execute method. The unified error handler's try/catch will catch any errors from the wrapper OR the base tool.

**However**, if someone calls these wrapped tools directly (like in #1), they bypass unified handling.

## Optional Enhancement: Runtime Detection Mechanism

The following proposes a runtime detection system to catch direct tool execution in dev/test builds.

## Summary

### ✅ Completed Actions (as of commits e56818efa, e703bcc17, 6c8bd262c)

1. ✅ **Fixed inline skill commands** to use `executeToolWithErrorHandling()`
   - File: `src/auto-reply/reply/get-reply-inline-actions.ts`
   - Now has unified error handling, structured logging, error truncation
   - Test coverage: `get-reply-inline-actions.skill-tool-error-handling.test.ts`

2. ✅ **Documented** wrapper behavior and runtime adapter requirement
   - File: `src/agents/pi-tools.read.ts`
   - Added JSDoc to `wrapToolParamNormalization()`, `wrapSandboxPathGuard()`, `createOpenClawReadTool()`
   - Explains that wrappers rely on callers using runtime adapters

3. ✅ **Added tests** verifying inline skill command error handling
   - 4 tests covering error handling, abort handling, multi-line truncation, session context

### Covered Execution Paths

- ✅ All Pi runtime agent tool executions
- ✅ All Claude SDK runtime agent tool executions
- ✅ Wrapped tools when used via runtime adapters
- ✅ **Inline skill command tool execution** (NOW FIXED)

### Remaining Low-Risk Items

- ⚠️ **Direct calls to wrapped tools outside runtime adapters** (low probability, now documented)
  - Risk mitigated by: documentation, typical usage pattern through runtime adapters
  - If needed: runtime detection can be added (see Optional Enhancement below)

### Optional Enhancement: Runtime Detection

See proposal below for runtime detection mechanism to catch direct tool execution in dev/test builds.
