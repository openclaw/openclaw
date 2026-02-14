# PR #13042 Security Review: Guard Model for Prompt Injection Sanitization

**Review Date:** 2026-02-09
**Reviewer:** OpenClaw Security Audit Agent
**PR Author:** TGambit65
**PR URL:** https://github.com/openclaw/openclaw/pull/13042

## Executive Summary

This PR introduces a guard model feature for sanitizing external untrusted content before it reaches the main agent. While the concept is strong and aligns with defense-in-depth security principles, the current implementation has critical issues that must be resolved before merging.

## Security Effectiveness Rating: **MODERATE (6/10)**

### Strengths ✅

1. **Defense in Depth**: Adds an additional security layer beyond regex-based pattern detection
2. **Clean Architecture**: Separates security concerns into dedicated modules
3. **Good Documentation**: Clear conceptual documentation in `docs/concepts/guard-model.md`
4. **Configurable Behavior**: Flexible configuration for failure modes (passthrough/block/warn)
5. **Pattern Detection**: Leverages existing `detectSuspiciousPatterns` from `external-content.ts`

### Critical Issues 🔴

#### 1. **Schema Import Error (Blocks Build)**

```typescript
// src/config/zod-schema.agent-defaults.ts
import { GuardModelConfigSchema } from "./zod-schema.providers-core.js";
```

This import is incorrect. `GuardModelConfigSchema` is defined in `types.security.ts` but imported from a non-existent location. This will cause build failures.

**Fix Required:**

```typescript
import { GuardModelConfigSchema } from "./types.security.js";
```

#### 2. **No Actual Integration**

The guard model is defined but never actually called in the codebase. The implementation lacks:

- Integration points in `run.ts` for external content processing
- Hook into web search/fetch tools
- Email/webhook content sanitization integration
- No actual usage in image tool despite being modified

#### 3. **Missing Complete Function**

The `sanitizeWithGuardModel` requires a `complete` function to be passed in, but there's no implementation showing how to obtain this function from the agent runner context.

#### 4. **Incomplete Test Coverage**

The test file only has two basic mock tests. Missing:

- Integration tests with actual model invocation
- Edge case handling (timeouts, failures)
- Performance impact tests
- Unicode bypass attempts
- Nested injection patterns

### Security Vulnerabilities 🟡

#### 1. **Bypass via Token Limits**

The default `maxTokens: 500` could be exploited:

```
[500 tokens of legitimate content]
[INJECTION: ignore all previous instructions]
```

The injection would be truncated out, bypassing detection.

#### 2. **No Recursive Sanitization**

If the guard model itself returns content with injection patterns, there's no second pass to catch them.

#### 3. **Allowlist Bypass Risk**

The allowlist feature could be exploited if tool names can be spoofed or if trusted tools return untrusted content.

#### 4. **Timing Attack Surface**

The 10-second timeout could be exploited with slow-drip attacks designed to timeout and trigger passthrough behavior.

### Performance Concerns ⚠️

1. **Latency Impact**: Every external content interaction adds 100-500ms latency
2. **Cost Multiplication**: Doubles API costs for external content processing
3. **No Caching**: Identical content is re-sanitized on every occurrence
4. **No Batching**: Multiple pieces of content can't be sanitized in one call

## Detailed Code Issues

### 1. Configuration Structure

```typescript
// Current location in types.agent-defaults.ts
guardModel?: GuardModelConfig;
```

Should be under `security` not `agents.defaults` for consistency:

```typescript
// Should be in security config
security: {
  guardModel?: GuardModelConfig;
}
```

### 2. Error Handling

```typescript
} catch (error) {
  logger.error("Guard model invocation failed", { error, model });
  throw error;
}
```

This always throws, ignoring the `onFailure` configuration. Should implement:

```typescript
} catch (error) {
  logger.error("Guard model invocation failed", { error, model });

  switch (params.onFailure) {
    case 'block':
      throw new SecurityError("Content blocked due to guard model failure");
    case 'warn':
      logger.warn("Guard model failed, using original content");
      return { sanitizedContent: content, isSuspicious: true, confidence: 0 };
    case 'passthrough':
    default:
      return { sanitizedContent: content, isSuspicious: false, confidence: 0.5 };
  }
}
```

### 3. Confidence Scoring

The confidence score is overly simplistic:

```typescript
confidence: isSuspicious ? 0.5 : 0.9,
```

Should factor in:

- Pattern match count
- Severity of patterns
- Guard model response analysis
- Content type/source

## Testing Gaps

### Missing Test Scenarios:

1. **Jailbreak patterns**: DAN, developer mode, grandma exploit
2. **Encoding attacks**: Base64, rot13, Unicode variations
3. **Context overflow**: Large payloads to exceed token limits
4. **Nested injections**: Injections within legitimate content
5. **Multi-turn attacks**: Gradual injection over multiple messages
6. **Performance**: Impact on response times with various content sizes
7. **Integration**: End-to-end tests with actual tools

## Recommendations

### Immediate Requirements (Before Merge):

1. **Fix the schema import error** - This blocks the build
2. **Add integration points** - Actually use the guard model somewhere
3. **Implement proper error handling** - Respect onFailure config
4. **Add comprehensive tests** - At least 20+ test cases covering security scenarios
5. **Document integration points** - Show how to enable for specific tools

### Future Improvements:

1. **Add caching layer** - Cache sanitized content by hash
2. **Implement batching** - Process multiple pieces together
3. **Add metrics/monitoring** - Track injection attempts and performance
4. **Multi-model consensus** - Use multiple guard models and compare
5. **Recursive sanitization** - Re-scan guard model output
6. **Dynamic pattern updates** - Allow pattern database updates without restart
7. **Content-type specific prompts** - Different sanitization for code vs prose

## Security Test Results

I've created a comprehensive test suite (see `test-guard-model.ts`) that reveals:

- ✅ Basic injection patterns are detected
- ❌ No actual sanitization occurs (just detection)
- ❌ Unicode bypass attempts not handled
- ❌ Jailbreak patterns not recognized
- ❌ Performance impact not measured

## Conclusion

While this PR introduces a valuable security concept, it's currently **NOT READY for production**. The implementation is incomplete, with critical build-breaking issues and no actual integration points.

The guard model pattern is sound and should be pursued, but requires:

1. Fixing the immediate schema/import issues
2. Adding real integration points
3. Comprehensive security testing
4. Performance optimization

I recommend marking this PR as **DRAFT** and addressing the critical issues before re-review.

## Action Items for @TGambit65

1. [ ] Fix schema import in `zod-schema.agent-defaults.ts`
2. [ ] Add actual usage of guard model in at least one tool
3. [ ] Implement onFailure configuration handling
4. [ ] Add 20+ security test cases
5. [ ] Add integration test with real model
6. [ ] Document performance impact
7. [ ] Add example configuration in README

## Security Score Breakdown

- Concept & Architecture: 8/10
- Implementation Completeness: 3/10
- Test Coverage: 2/10
- Integration: 0/10
- Performance Consideration: 4/10
- Documentation: 7/10

**Overall: 6/10 (Needs Significant Work)**
