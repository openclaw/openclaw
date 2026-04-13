## Summary

Report multiple instances of console debugging statements in production code that should be replaced with proper logging.

## Problem

The codebase contains numerous instances of `console.log`, `console.error`, `console.warn`, and `console.debug` statements that are used for debugging purposes. These statements should be replaced with a proper logging system.

**Affected files:**
- `src/acp/client.ts` - Multiple console.log and console.error statements
- `src/acp/server.ts` - console.error statements
- `src/agents/agent-command.ts` - console.error statement
- `src/acp/client.test.ts` - console.log in test code

**Impact:**
- May leak sensitive information in production
- Affects production performance
- Does not follow logging best practices
- Inconsistent logging across the codebase
- No log level control
- No structured logging

## Proposed Solution

### Replace console statements with proper logging

1. **Use a unified logging system**
   - Replace all `console.log` with proper logger calls
   - Use appropriate log levels (debug, info, warn, error)
   - Implement structured logging

2. **Add log level control**
   - Support different log levels for different environments
   - Allow runtime log level configuration
   - Support per-module log level control

3. **Improve log messages**
   - Add context to log messages
   - Use structured logging with key-value pairs
   - Add correlation IDs for request tracking

### Example migration

```typescript
// Current code
console.log(`[tool] ${update}`);
console.error(`[permission denied] ${action}`);

// Better approach
logger.debug({ event: "tool_update", update });
logger.error({ event: "permission_denied", action });
```

## Alternatives Considered

1. **Keep console statements** - Not recommended for production code
2. **Use console only in development** - Better, but still not ideal
3. **Use a proper logging library** - Recommended approach

## Impact

### Benefits
- **Better security** - No accidental information leakage
- **Better performance** - Controlled logging overhead
- **Better observability** - Structured logs for monitoring
- **Better debugging** - Correlation IDs and context
- **Better maintainability** - Consistent logging across codebase

### Affected Users
- All users of OpenClaw
- Developers debugging issues
- Operations teams monitoring production

### Migration Path
- Audit all console statements
- Replace with logger calls
- Add log level configuration
- Update documentation
- Test in development and staging

## Evidence/Examples

### Example 1: console.log in ACP client

```typescript
// Current code (src/acp/client.ts)
console.log(`\n[tool] ${update}`);
console.log(`[tool update] ${toolId}`);
console.log(`\n[commands] ${JSON.stringify(commands)}`);

// Better approach
logger.debug({ event: "tool_update", toolId, update });
logger.debug({ event: "commands", commands });
```

### Example 2: console.error in ACP server

```typescript
// Current code (src/acp/server.ts)
console.error(
  "Usage: openclaw acp server [--port <port>] [--host <host>] [--session <session>]",
);
console.error(String(err));

// Better approach
logger.error({
  event: "acp_server_usage_error",
  error: err.message,
  stack: err.stack,
});
```

### Example 3: console.error in agent command

```typescript
// Current code (src/agents/agent-command.ts)
console.error(`[agent] runtime error: ${err}`);

// Better approach
logger.error({
  event: "agent_runtime_error",
  error: err.message,
  stack: err.stack,
});
```

## Additional Information

### Dependencies
- Existing logging infrastructure (if any)
- Consider using: pino, winston, or bunyan
- Or use OpenClaw's existing logger if available

### Configuration
```json5
{
  "logging": {
    "level": "info",  // debug, info, warn, error
    "format": "json",  // json, text
    "output": "stdout",  // stdout, stderr, file
    "modules": {
      "acp": "debug",
      "agents": "info",
      "gateway": "warn"
    }
  }
}
```

### Best Practices
1. Use appropriate log levels
2. Add context to log messages
3. Use structured logging
4. Avoid logging sensitive information
5. Use correlation IDs for request tracking
6. Test logging in different environments

### Backward Compatibility
- Most changes are backward compatible
- Some changes may require updates to monitoring tools
- Gradual migration path available

## Next Steps

1. **Audit console statements** - Find all instances of console usage
2. **Choose logging library** - Select or create a logging solution
3. **Replace console statements** - Migrate to proper logging
4. **Add log level control** - Implement runtime configuration
5. **Update documentation** - Document logging best practices
6. **Test in production** - Verify logging works correctly

## References

- Node.js Best Practices: https://github.com/goldbergyoni/nodebestpractices
- Pino Logging: https://getpino.io/
- Winston Logging: https://github.com/winstonjs/winston
- 12-Factor App Logging: https://12factor.net/logs

---

**Contributor**: Erbing (717986230)
**Experience**: 2 PRs submitted to OpenClaw (#65669, #65675)
**Analysis**: Comprehensive code analysis of OpenClaw codebase
