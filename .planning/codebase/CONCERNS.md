# Codebase Concerns

**Analysis Date:** 2026-03-17

## Tech Debt

**Monolithic Agent Runner Implementation:**

- Issue: `src/agents/pi-embedded-runner/run/attempt.ts` is 2,900 lines with heavy responsibility coupling
- Files: `src/agents/pi-embedded-runner/run/attempt.ts`, `src/agents/pi-embedded-runner/run.ts` (1,700 lines)
- Impact: Difficult to test individual concerns, high risk of regression when modifying tool execution, session state management, or prompt building
- Fix approach: Extract tool state management, prompt building, and session lifecycle into separate modules with clear boundaries

**Large Configuration and Schema Files:**

- Issue: Configuration schema and help text scattered across large files without clear modularization
- Files: `src/config/schema.help.ts` (1,636 lines), `src/config/zod-schema.providers-core.ts` (1,537 lines), `src/config/io.ts` (1,559 lines)
- Impact: Hard to locate provider-specific config logic, increases merge conflicts, makes testing individual providers difficult
- Fix approach: Split provider schemas into separate modules per provider category (cloud providers, self-hosted, OAuth flows)

**Large Type Definition Files:**

- Issue: `src/plugins/types.ts` is 1,904 lines defining all plugin-related types in a single module
- Files: `src/plugins/types.ts`
- Impact: Slow editor autocomplete, difficult to find specific type definitions, interdependencies make refactoring risky
- Fix approach: Split into logical domains: `plugin-hooks.ts`, `plugin-runtime.ts`, `plugin-config.ts`, `plugin-metadata.ts`

**Markdown IR Rendering Bug:**

- Issue: Blockquote spacing produces triple newlines instead of double newlines
- Files: `src/markdown/ir.blockquote-spacing.test.ts`, `src/markdown/ir.ts` (implementation not yet fixed)
- Impact: Markdown display in chat shows incorrect whitespace between blockquotes and following content
- Fix approach: Fix `blockquote_close` handler to not add extra newline; `blockquote_close` should allow inner content's spacing to handle separation
- Status: Test written (documents expected behavior) but implementation not yet patched

**QMD Multi-Collection Workaround:**

- Issue: QMD doesn't support true multi-collection queries; implemented workaround that queries each collection separately
- Files: `src/memory/qmd-manager.ts` (lines 1932-1942), environment variable workaround at line 203-205
- Impact: Performance degradation with N collections (N separate qmd calls); workaround for upstream bug `https://github.com/tobi/qmd/issues/132`
- Current mitigation: Per-collection query aggregation with deduplication by result key
- Recommendations: Track upstream qmd issue; consider batching mechanism or migration to alternative vector search if multi-collection performance becomes bottleneck

**Chat Event Error Categorization:**

- Issue: ACP translator cannot distinguish between transient errors (timeouts, rate-limits) and deliberate refusals
- Files: `src/acp/translator.ts` (line 827)
- Impact: Clients treat all backend errors as intentional refusals rather than transient failures, preventing proper retry logic
- Fix approach: Add structured `errorKind` field to ChatEventSchema (e.g., "refusal" | "timeout" | "rate_limit")

## Known Bugs

**Typing Loop Restart After Run Completion:**

- Symptoms: Auto-reply typing loop can restart itself after the run is already marked complete, causing spurious `onReplyStart` calls
- Files: `src/auto-reply/reply/typing-persistence.test.ts` (test documents the bug), `src/auto-reply/reply/typing.ts` (implementation)
- Trigger: Call `markRunComplete()`, then advance time past the typing interval without calling `markDispatchIdle()`
- Workaround: Ensure both `markRunComplete()` and `markDispatchIdle()` are called in sequence before cleanup
- Root cause: Typing loop checks `runComplete` flag but doesn't immediately abort pending intervals; intervals can still fire if cleanup is delayed

**Bootstrap Prompt Warning Signature Deduplication:**

- Symptoms: Duplicate bootstrap truncation warnings shown across multiple agent runs
- Files: `src/agents/bootstrap-budget.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`
- Impact: Users see repetitive warnings for the same truncation condition
- Current state: Signature tracking mechanism in place but may not persist correctly across session boundaries

## Security Considerations

**Environment Variable Filtering in Bash Execution:**

- Risk: Dangerous environment variables (LD_PRELOAD, LD_LIBRARY_PATH, etc.) can be passed to bash tools if not properly filtered
- Files: `src/agents/bash-tools.exec-runtime.ts` (lines 61-70)
- Current mitigation: "Fail Closed" approach blocks known dangerous variables; custom PATH forbidden during host execution
- Recommendations: Whitelist known-safe variables instead of blacklist; regularly audit for new LD\_\* variables; document PATH policy in tool help text

**Secret Scanning in Skills:**

- Risk: Skill files may embed API keys or credentials that aren't caught by simple pattern matching
- Files: `src/security/skill-scanner.ts`
- Current mitigation: Pattern-based scanning for common secret formats
- Recommendations: Add entropy-based secret detection; consider scanning dependencies in skill node_modules; enforce `npm audit` in skill installs

**Plugin Code Execution:**

- Risk: Plugins can execute arbitrary untrusted code through unsafe operations
- Files: `src/plugins/loader.ts` (1,386 lines), `src/security/audit.ts` (1,318 lines)
- Current mitigation: Audit trail for plugin operations; restricted capabilities based on hook permissions
- Recommendations: Consider runtime sandboxing for untrusted plugins; document security model in plugin SDK

## Performance Bottlenecks

**Web Search Core Module:**

- Problem: `src/agents/tools/web-search-core.ts` is 2,242 lines with complex query parsing, filtering, and result ranking logic
- Files: `src/agents/tools/web-search-core.ts`
- Cause: Monolithic implementation handling provider selection, query normalization, ranking algorithms, and filtering all in one file
- Improvement path: Profile actual search latencies; extract ranking/filtering into pluggable strategies; cache provider selection decisions

**Agent Runner Session Management:**

- Problem: Session write lock acquired for entire agent run; potential contention under concurrent messages to same session
- Files: `src/agents/pi-embedded-runner/run/attempt.ts` (lines 85-87), `src/agents/session-write-lock.ts`
- Impact: Serializes agent runs on same session; under high load, lock hold time could block subsequent runs
- Improvement path: Analyze lock hold patterns; consider splitting into fine-grained locks (state lock, transcript lock); implement backpressure mechanisms

**QMD Vector Search:**

- Problem: Multi-collection search requires N separate qmd subprocess calls (documented at line 1937 of qmd-manager.ts)
- Impact: Scales linearly with collection count; each call incurs subprocess overhead
- Improvement path: Track upstream qmd multi-collection support; implement client-side result merging caching layer; consider batch API if qmd adds it

**Memory Embedding Generation:**

- Problem: Full embedding generation on large transcripts may be I/O and compute-intensive
- Files: `src/memory/embeddings-debug.ts`, `src/memory/manager-sync-ops.ts` (1,391 lines)
- Improvement path: Profile embedding latencies; implement chunking strategy; consider async embedding generation during idle periods

## Fragile Areas

**Session File Repair Logic:**

- Files: `src/agents/session-file-repair.ts`, `src/agents/session-transcript-repair.ts`
- Why fragile: Session files must recover from incomplete writes, tool result pairing errors, and transcript corruption; repair logic is complex
- Safe modification: Add new repair rules only after comprehensive testing with corrupted session corpus; maintain backward compatibility with older session formats
- Test coverage: Gaps in cross-database session format variations; coverage of edge cases like partial tool calls

**Tool Call ID Sanitization:**

- Files: `src/agents/tool-call-id.ts` (handles CloudCodeAssist-specific tool ID formats)
- Why fragile: Different AI providers format tool IDs differently; sanitization must preserve roundtrip identity without collision
- Safe modification: Test against all provider models before merging; maintain mapping table of known ID formats
- Test coverage: Missing tests for provider-specific ID collision scenarios

**Sandbox Filesystem Policy:**

- Files: `src/agents/sandbox.ts`, `src/agents/sandbox/runtime-status.ts`, `src/agents/tool-fs-policy.ts`
- Why fragile: Policy decisions affect security boundary; mistakes can allow tool escape or data exfiltration
- Safe modification: Changes require security review; test with intentional escape attempts; verify policy still blocks known exploits
- Test coverage: Limited end-to-end sandbox escape testing; coverage of symlink traversal, bind mount attacks

**Plugin Hook Execution:**

- Files: `src/plugins/hook-runner-global.ts`, `src/plugins/hook-runner.ts`
- Why fragile: Hooks can modify core behavior (message routing, tool execution); errors in hook execution can cascade
- Safe modification: Wrap hook calls in try-catch; add hook execution timeouts; log all hook invocations; implement hook dry-run mode
- Test coverage: Limited testing of hook error propagation; coverage of hook order dependencies

**Routing Bindings Cache:**

- Files: `src/routing/resolve-route.ts` (bindings cache at WeakMap)
- Why fragile: Cache invalidation tied to config object identity; if config mutated, cache becomes stale
- Safe modification: Document that config objects must be immutable; add cache invalidation hooks on config changes
- Test coverage: Missing tests for cache invalidation after config updates; coverage of binding resolution consistency under config churn

## Scaling Limits

**Session Key Uniqueness:**

- Current capacity: Session keys based on UUID4 (2^122 theoretical space)
- Limit: No known hard limit; distributed session storage (multi-gateway) requires unique key coordination
- Scaling path: Implement distributed session ID generation (snowflake-style) if multi-gateway mode becomes default; add session key collision detection

**QMD Collection Count:**

- Current capacity: Per-database limits not documented; empirical testing needed
- Limit: Linear degradation observed when querying 10+ collections (requires N subprocess calls)
- Scaling path: Implement collection sharding strategy; investigate qmd batching; consider alternative vector store (lancedb, pgvector) if single-database bottleneck

**Agent Bootstrap File Injection:**

- Current capacity: Bootstrap truncation warnings at 100KB total (configurable)
- Limit: Large workspaces with many .clawcode files can exceed injection budget without warning until runtime
- Scaling path: Implement pre-flight bootstrap budget check during session startup; add analytics for bootstrap utilization per workspace

**Memory Manager Sync Operations:**

- Current capacity: Synchronous QMD operations block gateway on memory writes
- Limit: High latency (>100ms) observed under load with large embeddings
- Scaling path: Implement async embedding pipeline; use worker threads for embedding computation; add memory operation queueing with backpressure

**Plugin Loader Initialization:**

- Current capacity: Plugin discovery and loading is synchronous; scales with plugin count
- Limit: >50 plugins can add 2-5s to startup time
- Scaling path: Implement lazy plugin loading; parallelize plugin discovery; cache plugin metadata

## Dependencies at Risk

**QMD Upstream Bug #132:**

- Risk: Multi-collection query support missing; workaround implemented but inelegant
- Impact: Performance degradation with multiple collections; complexity in memory manager
- Migration plan: Monitor upstream qmd repository; implement fallback to lancedb if qmd unmaintained; evaluate alternative vector stores (pgvector, weaviate)

**File-Type Library:**

- Risk: File type detection via magic bytes can be slow on large files; dependency actively maintained but narrow scope
- Impact: Media upload processing latency; potential for false positives on edge case formats
- Monitoring: Track file-type version updates; test with problematic file formats in CI

**Sharp Image Library:**

- Risk: Native binding dependency; compilation issues on edge platforms (M1/M2, Windows ARM64)
- Impact: Deployment failures on non-x86 systems; versioning must match native binary availability
- Monitoring: Test builds across platforms in CI; maintain platform-specific override in package.json

**Hono Framework Pinning:**

- Risk: Pinned to exact version 4.12.7 (package.json override); prevents security updates to minor/patch releases
- Impact: If critical vulnerability in Hono discovered, requires manual version bump and testing
- Recommendations: Audit why exact pinning necessary; move to semver range if possible; set up Dependabot alerts for overridden dependencies

**@mariozechner/pi-coding-agent Package Extension:**

- Risk: Package extensions applied (see packageExtensions in package.json); these are workarounds for upstream package issues
- Impact: Upgrades may require re-applying extensions; extension drift not tracked separately
- Recommendations: Document what each extension fixes; monitor upstream for resolution; test extension removal periodically

## Missing Critical Features

**Distributed Session Storage:**

- Problem: Session files are local filesystem only; multi-gateway deployments cannot share sessions
- Blocks: Horizontal scaling for reliability; load balancing across gateway instances
- Impact: Single-machine bottleneck for session storage and retrieval

**Multi-Collection Vector Search API:**

- Problem: QMD workaround queries collections serially; no batch API
- Blocks: Efficient memory search across large document collections; semantic cross-collection queries
- Impact: Performance degradation proportional to collection count

**Hook Execution Ordering:**

- Problem: Plugin hook execution order not documented or guaranteed; hook dependencies not expressible
- Blocks: Complex multi-plugin setups; plugin hooks cannot safely depend on other plugin hooks executing first
- Impact: Plugin interaction matrix grows exponentially with plugin count

**Sandbox Capability Grants:**

- Problem: Sandbox restrictions are all-or-nothing (ro vs rw); fine-grained capability model not available
- Blocks: Sophisticated security policies (e.g., allow read-only access to /tmp but deny home directory)
- Impact: Operators must choose between full sandbox (restrictive) or no sandbox (permissive)

## Test Coverage Gaps

**Plugin Interaction Matrix:**

- What's not tested: Interactions between pairs of plugins that modify shared state (routing, config, tool behavior)
- Files: `src/plugins/` test files; missing comprehensive multi-plugin integration tests
- Risk: Plugin A works alone, Plugin B works alone, but A+B together deadlock or corrupt config
- Priority: High (plugin ecosystem is critical extension point)

**Session File Corruption Recovery:**

- What's not tested: Recovery from various corruption scenarios (truncated JSON, missing tool results, malformed timestamps)
- Files: `src/agents/session-file-repair.ts`, missing edge case test suite
- Risk: Silent data loss or corruption during repair; repair logic could make things worse
- Priority: High (data integrity)

**Sandbox Escape Scenarios:**

- What's not tested: Deliberate sandbox escape attempts (symlink traversal, bind mount abuse, setuid escalation)
- Files: `src/agents/sandbox.ts` integration tests
- Risk: Sandbox can be bypassed by determined agent; security boundary not validated
- Priority: Critical (security boundary)

**Memory Manager Embedding Inconsistency:**

- What's not tested: Consistency of embeddings across multiple QMD instances or after database corruption
- Files: `src/memory/qmd-manager.test.ts` (2,805 lines but gaps in consistency tests)
- Risk: Embeddings go out of sync with transcript content; memory search returns incorrect context
- Priority: High (core feature reliability)

**ACP Protocol Edge Cases:**

- What's not tested: Handling of out-of-order events, missing events, duplicate events in ACP stream
- Files: `src/acp/translator.ts` (1,224 lines)
- Risk: Protocol state machine mishandles edge cases; messages lost or duplicated
- Priority: Medium (reliability under network issues)

**Tool Execution Timeout and Interruption:**

- What's not tested: Behavior when tool timeout fires while result is being processed; interruption during cleanup
- Files: `src/agents/pi-embedded-runner/run/attempt.ts` (sparse timeout test coverage)
- Risk: Tool results lost or partially applied; state corruption during timeout race
- Priority: Medium (reliability under load)

**Configuration Reload Safety:**

- What's not tested: Config reload while agent is running; reload with conflicting provider changes
- Files: `src/config/io.ts`, `src/gateway/server-methods/` (config mutation points)
- Risk: Agent uses stale config; new config conflicts with in-flight operations
- Priority: Medium (operational safety)

---

_Concerns audit: 2026-03-17_
