# Enhanced Logging Implementation - Phase 1

**Status:** ✅ Complete

This document describes the enhanced logging features implemented in Phase 1, including configuration, usage, and integration points.

---

## Overview

Enhanced logging provides detailed operational insights with full configurability through both environment variables and `openclaw.json`. All features default to **enabled** and can be toggled individually or globally disabled.

---

## Features Implemented

### 1. Tool Call Error Logging ✅

Logs detailed context when tool calls fail, including:

- Tool name and truncated input (first 500 chars)
- Error message, type, and stack trace (first 3 lines)
- Session context (agentId, sessionId, turnNumber)
- Duration and retry status

**Example log:**

```
[tools] Tool execution failed
  tool: "Read"
  input: "{\"file_path\":\"/nonexistent.txt\"}"
  error: "ENOENT: no such file or directory"
  errorType: "Error"
  stack: "Error: ENOENT: no such file or directory\n  at Object.openSync (...)"
  agentId: "main"
  sessionId: "telegram:123456"
  durationMs: 45
```

### 2. Performance Outlier Detection ✅

Logs operations exceeding thresholds:

**Default Thresholds:**

- Tool calls: 5000ms (5 seconds)
- Agent turns: 30000ms (30 seconds)
- Gateway requests: 10000ms (10 seconds)
- Database ops: 2000ms (2 seconds)

**Example log:**

```
[performance] Slow operation detected
  operation: "agent_turn"
  name: "main:telegram:123456"
  durationMs: 45000
  thresholdMs: 30000
  overageMs: 15000
  overagePct: 50
  model: "claude-sonnet-4-5"
```

### 3. Token Budget Warnings ✅

Warns when approaching context window limits:

**Default Thresholds:**

- Warning: 75% of context window
- Critical: 90% of context window

**Example log:**

```
[tokens] Approaching context limit
  currentTokens: 180000
  maxTokens: 200000
  percentUsed: 90
  tokensRemaining: 20000
  severity: "critical"
  suggestedAction: "reset"
```

**Note:** Currently integrated as a helper function. Full integration with SDK and Pi runners requires model context window info (deferred for future work).

### 4. Gateway Health Logging ✅

Logs gateway connection lifecycle:

**Events Logged:**

- `connected` - Gateway connection established
- `disconnected` - Gateway connection closed
- `reconnect_attempt` - Attempting to reconnect
- `rate_limit` - Rate limit encountered (not yet integrated)
- `health_check` - Health check performed (not yet integrated)

**Example logs:**

```
[gateway] connected
  event: "connected"
  url: "ws://127.0.0.1:18789"
  clientName: "cli"

[gateway] disconnected
  event: "disconnected"
  code: 1006
  reason: "abnormal closure"
  hint: "abnormal closure (no close frame)"

[gateway] reconnect_attempt
  event: "reconnect_attempt"
  delayMs: 2000
  nextBackoffMs: 4000
```

---

## Configuration

### Environment Variables

```bash
# Global override - disable ALL enhanced logging
CLAWDBRAIN_ENHANCED_LOGGING=0

# Toggle specific features (0 = disabled, 1 or unset = enabled)
CLAWDBRAIN_LOG_TOOL_ERRORS=0
CLAWDBRAIN_LOG_PERFORMANCE=0
CLAWDBRAIN_LOG_TOKEN_WARNINGS=0
CLAWDBRAIN_LOG_GATEWAY_HEALTH=0

# Adjust performance thresholds (milliseconds)
CLAWDBRAIN_PERF_TOOL_MS=10000      # Tool calls (default: 5000)
CLAWDBRAIN_PERF_TURN_MS=60000      # Agent turns (default: 30000)
CLAWDBRAIN_PERF_GATEWAY_MS=15000   # Gateway requests (default: 10000)
CLAWDBRAIN_PERF_DB_MS=3000         # Database ops (default: 2000)

# Adjust token warning thresholds (percentage, 0-100)
CLAWDBRAIN_TOKEN_WARN_PCT=80       # Warning threshold (default: 75)
CLAWDBRAIN_TOKEN_CRIT_PCT=95       # Critical threshold (default: 90)
```

### Config File (`openclaw.json`)

```json
{
  "logging": {
    "level": "info",
    "enhanced": {
      "toolErrors": true,
      "performanceOutliers": true,
      "tokenWarnings": true,
      "gatewayHealth": false
    },
    "performanceThresholds": {
      "toolCall": 10000,
      "agentTurn": 60000,
      "gatewayRequest": 15000,
      "databaseOp": 3000
    },
    "tokenWarningThresholds": {
      "warning": 80,
      "critical": 95
    }
  }
}
```

### Priority Order

Configuration is resolved in this order (highest priority first):

1. **Environment variables** - Override everything
2. **Config file** (`openclaw.json`) - Override defaults
3. **Defaults** - All features enabled

---

## Integration Points

### 1. Tool Error Logging

**File:** `src/agents/pi-tool-definition-adapter.ts`
**Location:** Tool execution wrapper, error catch block

Logs detailed error context when tools fail, wrapped with performance measurement for slow tool detection.

### 2. Performance Outlier Detection

**Files:**

- `src/agents/pi-tool-definition-adapter.ts` - Tool execution performance
- `src/auto-reply/reply/agent-runner-execution.ts` - Agent turn performance

Measures operation duration and logs when thresholds are exceeded.

### 3. Token Budget Warnings

**Function:** `checkTokenUsage()` in `src/logging/enhanced-events.ts`

Ready for integration but requires model context window info. Can be called when usage stats are available:

```typescript
import { checkTokenUsage } from "../logging/enhanced-events.js";

checkTokenUsage({
  currentTokens: usage.total,
  maxTokens: modelContextWindow,
  sessionId: sessionKey,
  agentId: agentId,
  model: modelId,
});
```

### 4. Gateway Health Logging

**File:** `src/gateway/client.ts`
**Locations:**

- `ws.on("open")` - Connected event
- `ws.on("close")` - Disconnected event
- `scheduleReconnect()` - Reconnect attempt event

---

## Testing

### Manual Testing

#### Test configuration loading:

```bash
node --import tsx -e "
import { getEnhancedLoggingConfig, getPerformanceThresholds, getTokenWarningThresholds } from './src/logging/enhanced-logging-config.js';
console.log('Config:', getEnhancedLoggingConfig());
console.log('Perf thresholds:', getPerformanceThresholds());
console.log('Token thresholds:', getTokenWarningThresholds());
"
```

#### Test environment variable overrides:

```bash
CLAWDBRAIN_LOG_TOOL_ERRORS=0 CLAWDBRAIN_PERF_TOOL_MS=10000 \
  node --import tsx -e "
import { getEnhancedLoggingConfig, getPerformanceThresholds, resetEnhancedLoggingConfig } from './src/logging/enhanced-logging-config.js';
resetEnhancedLoggingConfig();
console.log('Tool errors disabled:', !getEnhancedLoggingConfig().toolErrors);
console.log('Tool threshold:', getPerformanceThresholds().toolCall);
"
```

#### Test global disable:

```bash
CLAWDBRAIN_ENHANCED_LOGGING=0 \
  node --import tsx -e "
import { getEnhancedLoggingConfig, resetEnhancedLoggingConfig } from './src/logging/enhanced-logging-config.js';
resetEnhancedLoggingConfig();
const config = getEnhancedLoggingConfig();
console.log('All disabled:', !config.toolErrors && !config.performanceOutliers && !config.tokenWarnings && !config.gatewayHealth);
"
```

#### Test logging functions:

```bash
node --import tsx -e "
import { logToolError, logPerformanceOutlier, logGatewayHealth, checkTokenUsage } from './src/logging/enhanced-events.js';

logToolError({
  toolName: 'test-tool',
  input: { test: true },
  error: new Error('Test error'),
  sessionContext: { agentId: 'test' },
});

logPerformanceOutlier({
  operation: 'tool',
  name: 'slow-tool',
  durationMs: 10000,
  threshold: 5000,
});

logGatewayHealth({
  event: 'connected',
  metadata: { url: 'ws://test' },
});

checkTokenUsage({
  currentTokens: 150000,
  maxTokens: 200000,
  sessionId: 'test',
  model: 'test-model',
});
"
```

### Integration Testing

#### Trigger tool error logging:

```bash
# Run an agent command that will fail
pnpm clawdbrain agent --message "read /nonexistent/file.txt" --local
# Look for enhanced tool error logs
```

#### Trigger performance outlier:

```bash
# Set very low threshold to trigger outlier detection
CLAWDBRAIN_PERF_TOOL_MS=1 pnpm clawdbrain agent --message "test" --local
# Look for performance outlier warnings
```

#### Trigger gateway health logs:

```bash
# Start gateway and watch logs
pnpm clawdbrain gateway run
# Look for "Gateway connected" log
# Stop gateway and look for "Gateway disconnected" log
```

---

## Files Modified

### Configuration Layer

1. ✅ `src/config/types.base.ts` - Extended `LoggingConfig` type
2. ✅ `src/config/zod-schema.ts` - Added Zod validation schemas
3. ✅ `src/logging/enhanced-logging-config.ts` - Added config file loading

### Integration Points

4. ✅ `src/agents/pi-tool-definition-adapter.ts` - Tool error + performance logging
5. ✅ `src/auto-reply/reply/agent-runner-execution.ts` - Agent turn performance logging
6. ✅ `src/gateway/client.ts` - Gateway health logging

### Core Logging

- ✅ `src/logging/enhanced-events.ts` - Already created (logging functions)
- ✅ `src/logging/enhanced-logging-config.ts` - Already created (configuration)
- ✅ `src/logging/test-logger.ts` - Already created (test logging)
- ✅ `src/logging/test-log-file.ts` - Already created (test log files)

---

## Performance Impact

- **Disabled features:** Zero overhead (checks return immediately)
- **Enabled features:** Minimal overhead
  - Config caching: Config loaded once on first access
  - Conditional logging: No-op if feature disabled
  - Structured logs: Uses existing subsystem loggers

---

## Future Work (Phase 2)

Deferred features (complexity > 5):

- **Configuration fallback logging** (6/10) - Log when config values are missing/invalid
- **Session lifecycle events** (7/10) - Track session creation, reset, destruction
- **Structured error categories** (8/10) - Categorize errors for better filtering
- **Multi-agent handoff tracking** (6/10) - Log when agents hand off to each other

Additional improvements:

- Full token budget integration with SDK and Pi embedded runners (needs model context window info)
- Gateway rate limit event logging (when implemented)
- Gateway health check event logging (when implemented)
- Database operation performance tracking (when DB operations are identified)

---

## Success Criteria

All criteria met ✅:

- [x] All enhanced logging features are toggleable via both env vars and openclaw.json
- [x] Config file settings override defaults, env vars override config file
- [x] Tool errors are logged with full context when they occur
- [x] Slow operations (tools, agent turns) are detected and logged
- [x] Token budget warning functions are available for integration
- [x] Gateway connection lifecycle events are logged
- [x] All features can be disabled individually or globally
- [x] No performance impact when features are disabled
- [x] Build succeeds with no TypeScript errors
- [x] Enhanced logging functions execute without errors

---

## Usage Examples

### Example 1: Disable all enhanced logging

```bash
CLAWDBRAIN_ENHANCED_LOGGING=0 pnpm clawdbrain agent --message "test" --local
```

### Example 2: Increase performance thresholds for long-running operations

```bash
CLAWDBRAIN_PERF_TOOL_MS=30000 \
CLAWDBRAIN_PERF_TURN_MS=120000 \
  pnpm clawdbrain agent --message "analyze large codebase" --local
```

### Example 3: Enable only gateway health logging

```json
{
  "logging": {
    "enhanced": {
      "toolErrors": false,
      "performanceOutliers": false,
      "tokenWarnings": false,
      "gatewayHealth": true
    }
  }
}
```

### Example 4: Strict performance monitoring

```json
{
  "logging": {
    "enhanced": {
      "performanceOutliers": true
    },
    "performanceThresholds": {
      "toolCall": 2000,
      "agentTurn": 10000,
      "gatewayRequest": 5000,
      "databaseOp": 500
    }
  }
}
```

---

## Notes

- All features default to **enabled** for better observability
- Environment variables take precedence over config file
- Global disable (`CLAWDBRAIN_ENHANCED_LOGGING=0`) overrides everything
- Config is cached after first load for performance
- Use `resetEnhancedLoggingConfig()` in tests to clear cache
- Logs use subsystem loggers for consistent formatting
- Performance tracking uses `Date.now()` for minimal overhead
