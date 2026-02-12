# Technical Debt

## Active Items

### 2026-02-12: Bound Heimdall ACL Pattern Cache

**What:** Add size limit to aclPatternCache Map in tool-acl.ts to prevent unbounded memory growth

**Why deferred:** Low risk (requires very long toolACL config list), implementation works correctly without bounds

**Impact if not done:** In extreme misconfiguration scenarios (1000+ custom ACL patterns), cache could grow large. Not a security issue, just resource concern.

**Effort when ready:** Low risk, well-understood pattern (LRU cache or simple size cap)

**Context:** src/security/heimdall/tool-acl.ts:86, code review WARNING-1 from Phase 1 Task 1.3
