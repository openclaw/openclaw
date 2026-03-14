# Phase 3: Outbound Surface Catalog - Context

**Gathered:** 2026-03-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Map all gateway outbound HTTP paths, verify chokepoint coverage, and document gaps. This is a documentation/audit phase — catalog what exists, don't add new guards or fix gaps. One spot-check test confirms the catalog's claims for the highest-risk surface.

</domain>

<decisions>
## Implementation Decisions

### Catalog Format & Location

- Markdown document in `docs/` (e.g. `docs/reference/outbound-surfaces.md`)
- Grouped by category: Agent Tools, Channel APIs, Provider APIs, Media Pipeline, Plugins/Extensions
- Each category gets its own table
- Minimal table columns: Surface | Source | Guarded | Notes

### Coverage Classification

- Binary Yes/No for the Guarded column — no tiers, no N/A
- "Guarded" means: flows through SSRF chokepoint (fetchWithSsrFGuard) OR uses hardcoded/operator-configured URLs with auth tokens
- Notes column shows the guard type briefly (e.g. "SSRF chokepoint", "Hardcoded endpoint", "Operator token")
- No intent markers — catalog states facts, not judgments about whether gaps are intentional
- Agent-controlled URLs (where the AI picks the URL) should be flagged/annotated distinctly from operator-configured ones

### Gap Handling

- Document only — no recommendations section, no GitHub issues, no TODO comments
- The catalog is an audit artifact stating what IS, not what SHOULD BE
- Include 3-5 representative extensions (e.g. Telegram, Discord, Matrix) to show the plugin pattern — don't catalog all 40+

### Verification Approach

- Code trace via grep/read for each HTTP call site to confirm guard status
- One spot-check test targeting the **web fetch tool** (highest-risk: agent-controlled URLs)
- Spot-check test goes in a new catalog-specific test file (e.g. `src/infra/net/outbound-surfaces.test.ts`), not in existing SSRF suite
- Test proves that a blocked domain actually triggers DnsBlocklistError through the web fetch tool path

### Claude's Discretion

- Exact category names and grouping boundaries
- How many extensions to sample and which ones
- Test implementation details for the spot-check
- Document title and section headings
- Whether to include a "How to update this catalog" note for future maintainers

</decisions>

<specifics>
## Specific Ideas

- The codebase scout found clear categories: fetchWithSsrFGuard paths (web fetch, media), direct globalThis.fetch paths (Telegram, Discord, Slack), SDK-managed paths (Anthropic, OpenAI client libraries), and operator-configured paths (Ollama, TTS providers)
- `src/infra/net/fetch-guard.ts` is the primary SSRF chokepoint — trace from there to find guarded surfaces
- Channel-specific fetch wrappers exist (e.g. `src/telegram/fetch.ts` with `resolveTelegramFetch()`) that add network workarounds but NOT SSRF guarding
- Firecrawl API calls in the web fetch fallback chain go through standard fetch without SSRF guard — worth noting in the catalog

</specifics>

<code_context>

## Existing Code Insights

### Reusable Assets

- `src/infra/net/fetch-guard.ts`: `fetchWithSsrFGuard()` — the SSRF chokepoint to trace from
- `src/infra/net/ssrf.ts`: `resolvePinnedHostnameWithPolicy()` — Phase 2 blocklist integration point
- `src/infra/net/domain-filter.ts`: `isDomainBlocked()`, `DnsBlocklistError` — blocklist primitives for test assertions
- `src/agents/tools/web-fetch.ts`: web fetch tool implementation — spot-check test target

### Established Patterns

- SSRF test suite: `ssrf.test.ts`, `ssrf.dispatcher.test.ts`, `ssrf.pinning.test.ts` — reference for test style
- Channel fetch wrappers: `src/telegram/fetch.ts`, `src/discord/api.ts` — direct fetch patterns to document
- Media pipeline: `src/media/fetch.ts` uses `withStrictGuardedFetchMode()` — example of guarded surface

### Integration Points

- `docs/` directory for the catalog document (Mintlify site)
- `src/infra/net/` for the spot-check test file
- Extensions directory for sampling plugin HTTP patterns

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

_Phase: 03-outbound-surface-catalog_
_Context gathered: 2026-03-08_
