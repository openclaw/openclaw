# PR: Agent-specific Sandbox and Tool Configuration

## Summary

Adds support for per-agent sandbox and tool configurations in multi-agent setups. This allows running multiple agents with different security profiles (e.g., personal assistant with full access, family bot with read-only restrictions).

## Changes

### Core Implementation (5 files, +49 LoC)

1. **`src/config/types.ts`** (+4 lines)
   - Added `sandbox` and `tools` fields to `routing.agents[agentId]` type

2. **`src/config/zod-schema.ts`** (+6 lines)
   - Added Zod validation for `routing.agents[].sandbox` and `routing.agents[].tools`

3. **`src/agents/agent-scope.ts`** (+12 lines)
   - Extended `resolveAgentConfig()` to return `sandbox` and `tools` fields

4. **`src/agents/sandbox.ts`** (+12 lines)
   - Modified `defaultSandboxConfig()` to accept `agentId` parameter
   - Added logic to prefer agent-specific sandbox config over global config
   - Updated `resolveSandboxContext()` and `ensureSandboxWorkspaceForSession()` to extract and pass `agentId`

5. **`src/agents/pi-tools.ts`** (+15 lines)
   - Added agent-specific tool filtering before sandbox tool filtering
   - Imports `resolveAgentConfig` and `resolveAgentIdFromSessionKey`

### Tests (3 new test files, 18 tests)

1. **`src/agents/agent-scope.test.ts`** (7 tests)
   - Tests for `resolveAgentConfig()` with sandbox and tools fields

2. **`src/agents/sandbox-agent-config.test.ts`** (6 tests)
   - Tests for agent-specific sandbox mode, scope, and workspaceRoot overrides
   - Tests for multiple agents with different sandbox configs

3. **`src/agents/pi-tools-agent-config.test.ts`** (5 tests)
   - Tests for agent-specific tool filtering
   - Tests for combined global + agent + sandbox tool policies

### Documentation (3 files)

1. **`docs/multi-agent-sandbox-tools.md`** (new)
   - Comprehensive guide for per-agent sandbox and tool configuration
   - Examples for common use cases
   - Migration guide from single-agent configs

2. **`docs/concepts/multi-agent.md`** (updated)
   - Added section on per-agent sandbox and tool configuration
   - Link to detailed guide

3. **`docs/gateway/configuration.md`** (updated)
   - Added documentation for `routing.agents[].sandbox` and `routing.agents[].tools` fields

## Features

### Agent-specific Sandbox Config

```json
{
  "routing": {
    "agents": {
      "main": {
        "workspace": "~/clawd",
        "sandbox": { "mode": "off" }
      },
      "family": {
        "workspace": "~/clawd-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        }
      }
    }
  }
}
```

**Result:**
- `main` agent runs on host (no Docker)
- `family` agent runs in Docker with one container per agent

### Agent-specific Tool Restrictions

```json
{
  "routing": {
    "agents": {
      "family": {
        "workspace": "~/clawd-family",
        "tools": {
          "allow": ["read"],
          "deny": ["bash", "write", "edit", "process"]
        }
      }
    }
  }
}
```

**Result:**
- `family` agent can only use the `read` tool
- All other tools are denied

## Configuration Precedence

### Sandbox Config
Agent-specific settings override global:
- `routing.agents[id].sandbox.mode` > `agent.sandbox.mode`
- `routing.agents[id].sandbox.scope` > `agent.sandbox.scope`
- `routing.agents[id].sandbox.workspaceRoot` > `agent.sandbox.workspaceRoot`

Note: `docker`, `browser`, `tools`, and `prune` settings from `agent.sandbox` remain global.

### Tool Filtering
Filtering order (each level can only further restrict):
1. Global tool policy (`agent.tools`)
2. **Agent-specific tool policy** (`routing.agents[id].tools`) ← NEW
3. Sandbox tool policy (`agent.sandbox.tools`)
4. Subagent tool policy (if applicable)

## Backward Compatibility

✅ **100% backward compatible**
- All existing configs work unchanged
- New fields (`routing.agents[].sandbox`, `routing.agents[].tools`) are optional
- Default behavior: if no agent-specific config exists, use global config
- All 1325 existing tests pass

## Testing

### New Tests: 18 tests, all passing
```
✓ src/agents/agent-scope.test.ts (7 tests)
✓ src/agents/sandbox-agent-config.test.ts (6 tests)
✓ src/agents/pi-tools-agent-config.test.ts (5 tests)
```

### Existing Tests: All passing
```
Test Files  227 passed | 2 skipped (229)
Tests      1325 passed | 2 skipped (1327)
```

Specifically verified:
- Discord provider tests: ✓ 23 tests
- Telegram provider tests: ✓ 42 tests
- Routing tests: ✓ 7 tests
- Gateway tests: ✓ All passed

## Use Cases

### Use Case 1: Personal Assistant + Restricted Family Bot
- Personal agent: Host, all tools
- Family agent: Docker, read-only

### Use Case 2: Work Agent with Limited Access
- Personal agent: Full access
- Work agent: Docker, no browser/gateway tools

### Use Case 3: Public-facing Bot
- Main agent: Trusted, full access
- Public agent: Always sandboxed, minimal tools

## Migration Path

**Before (global config):**
```json
{
  "agent": {
    "sandbox": { "mode": "non-main" }
  }
}
```

**After (per-agent config):**
```json
{
  "routing": {
    "agents": {
      "main": { "sandbox": { "mode": "off" } },
      "family": { "sandbox": { "mode": "all", "scope": "agent" } }
    }
  }
}
```

## Related Issues

- Addresses need for per-agent security policies in multi-agent setups
- Complements existing multi-agent routing feature (introduced in 7360abad)
- Prepares for upcoming `clawdbot agents` CLI (announced 2026-01-07)

## Checklist

- [x] Code changes implemented
- [x] Tests written and passing
- [x] Documentation updated
- [x] Backward compatibility verified
- [x] No breaking changes
- [x] TypeScript types updated
- [x] Zod schema validation added
