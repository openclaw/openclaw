# Fix Evidence: diagnostics-otel OpenTelemetry v2.x Compatibility

## Problem

The `diagnostics-otel` plugin fails to start due to API breaking changes in OpenTelemetry v2.x packages.

## Errors Before Fix

### Error 1: Resource constructor
```
[plugins] plugin service failed (diagnostics-otel): TypeError: _resources.Resource is not a constructor
```

**Root cause:** `@opentelemetry/resources@2.5.0` no longer exports `Resource` class.

### Error 2: addLogRecordProcessor method
```
[plugins] plugin service failed (diagnostics-otel): TypeError: logProvider.addLogRecordProcessor is not a function
```

**Root cause:** `@opentelemetry/sdk-logs@0.211.0` changed LoggerProvider API.

## Changes Made

### 1. Resource Creation (line 6, 65-67)
**Before:**
```typescript
import { Resource } from "@opentelemetry/resources";
// ...
const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
});
```

**After:**
```typescript
import { resourceFromAttributes } from "@opentelemetry/resources";
// ...
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: serviceName,
});
```

### 2. Semantic Conventions (line 11)
**Before:**
```typescript
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
```

**After:**
```typescript
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
```

### 3. LoggerProvider Processors (line 202-210)
**Before:**
```typescript
logProvider = new LoggerProvider({ resource });
logProvider.addLogRecordProcessor(
  new BatchLogRecordProcessor(logExporter, { ... }),
);
```

**After:**
```typescript
const logProcessor = new BatchLogRecordProcessor(logExporter, { ... });
logProvider = new LoggerProvider({
  resource,
  processors: [logProcessor],
});
```

## Testing

### Environment
- **OS:** Linux (WSL2)
- **Node:** v22.22.0
- **Docker:** moltbot:local image

### Test Results

**Before fix:**
```
[plugins] plugin service failed (diagnostics-otel): TypeError: _resources.Resource is not a constructor
[plugins] plugin service failed (diagnostics-otel): TypeError: logProvider.addLogRecordProcessor is not a function
```

**After fix:**
```
[plugins] diagnostics-otel: logs exporter enabled (OTLP/HTTP)
```

✅ Plugin loads successfully
✅ Logs exporter enabled
✅ No errors in gateway startup
✅ Telemetry pipeline ready

### Validation Commands
```bash
# Build
pnpm build  # ✅ No TypeScript errors

# Lint
npm run lint  # ✅ 0 warnings, 0 errors

# Runtime test
docker logs moltbot-moltbot-gateway-1 | grep diagnostic
# Output: "diagnostics-otel: logs exporter enabled (OTLP/HTTP)"
```

## References

- OpenTelemetry JS v2.0 migration guide: https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/upgrade-to-2.x.md
- Issue #3201: diagnostics-otel plugin fails: Resource is not a constructor
- Related PR #2574: Partial fix (only addresses Resource, not LoggerProvider)

## AI Disclosure

This fix was developed with AI assistance (Claude Sonnet 4.5) and has been:
- ✅ Fully tested locally
- ✅ Validated with linter
- ✅ Verified in production-like environment (Docker)
- ✅ Understood by contributor (architectural reasoning documented)
