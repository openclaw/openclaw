# Phase 3: Outbound Surface Catalog - Research

**Researched:** 2026-03-08
**Domain:** Security audit / documentation -- cataloging gateway outbound HTTP surfaces
**Confidence:** HIGH

## Summary

This phase is a documentation/audit phase, not an implementation phase. The work involves tracing all outbound HTTP call sites in the gateway codebase, classifying each by whether it flows through the SSRF chokepoint (`fetchWithSsrFGuard`), and producing a Markdown catalog document. One spot-check test confirms the catalog's claims for the highest-risk surface (the web fetch tool).

The codebase has a clear separation between guarded paths (using `fetchWithSsrFGuard` from `src/infra/net/fetch-guard.ts`) and unguarded paths (using bare `fetch()` directly). Guarded paths flow through `resolvePinnedHostnameWithPolicy()` which includes the DNS blocklist check from Phase 2. Unguarded paths fall into two categories: (1) channel APIs calling hardcoded vendor endpoints with operator tokens (Telegram, Discord, Slack, MS Graph), and (2) provider/model discovery calls to operator-configured or hardcoded SaaS endpoints (Ollama, Firecrawl, Vercel AI Gateway, etc.).

**Primary recommendation:** Produce the catalog by grep-tracing `fetchWithSsrFGuard` callers (guarded) and bare `fetch()` callers (unguarded), then write a single Markdown file at `docs/reference/outbound-surfaces.md` with per-category tables.

<user_constraints>

## User Constraints (from CONTEXT.md)

### Locked Decisions

- Markdown document in `docs/` (e.g. `docs/reference/outbound-surfaces.md`)
- Grouped by category: Agent Tools, Channel APIs, Provider APIs, Media Pipeline, Plugins/Extensions
- Each category gets its own table
- Minimal table columns: Surface | Source | Guarded | Notes
- Binary Yes/No for the Guarded column -- no tiers, no N/A
- "Guarded" means: flows through SSRF chokepoint (fetchWithSsrFGuard) OR uses hardcoded/operator-configured URLs with auth tokens
- Notes column shows the guard type briefly (e.g. "SSRF chokepoint", "Hardcoded endpoint", "Operator token")
- No intent markers -- catalog states facts, not judgments about whether gaps are intentional
- Agent-controlled URLs (where the AI picks the URL) should be flagged/annotated distinctly from operator-configured ones
- Document only -- no recommendations section, no GitHub issues, no TODO comments
- The catalog is an audit artifact stating what IS, not what SHOULD BE
- Include 3-5 representative extensions (e.g. Telegram, Discord, Matrix) to show the plugin pattern -- don't catalog all 40+
- Code trace via grep/read for each HTTP call site to confirm guard status
- One spot-check test targeting the web fetch tool (highest-risk: agent-controlled URLs)
- Spot-check test goes in a new file (e.g. `src/infra/net/outbound-surfaces.test.ts`)
- Test proves that a blocked domain actually triggers DnsBlocklistError through the web fetch tool path

### Claude's Discretion

- Exact category names and grouping boundaries
- How many extensions to sample and which ones
- Test implementation details for the spot-check
- Document title and section headings
- Whether to include a "How to update this catalog" note for future maintainers

### Deferred Ideas (OUT OF SCOPE)

None -- discussion stayed within phase scope

</user_constraints>

<phase_requirements>

## Phase Requirements

| ID      | Description                                                           | Research Support                                                                                                                                                               |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TEST-03 | Catalog of all outbound HTTP paths documented (hook one, note others) | Full codebase trace of `fetchWithSsrFGuard` callers (guarded) and bare `fetch()` callers (unguarded); spot-check test pattern established from existing `ssrf.pinning.test.ts` |

</phase_requirements>

## Standard Stack

### Core

No new libraries needed. This phase produces a documentation artifact and one test file.

| Tool      | Purpose                             | Why Standard                            |
| --------- | ----------------------------------- | --------------------------------------- |
| Vitest    | Test framework for spot-check test  | Already used project-wide (`pnpm test`) |
| grep/read | Code tracing to identify call sites | Tooling already available               |

### Supporting

| Tool                            | Purpose                             | When to Use                                         |
| ------------------------------- | ----------------------------------- | --------------------------------------------------- |
| `DnsBlocklistError`             | Assertion target in spot-check test | Import from `src/infra/net/domain-filter.ts`        |
| `fetchWithSsrFGuard`            | Mock target in spot-check test      | Import from `src/infra/net/fetch-guard.ts`          |
| `fetchWithWebToolsNetworkGuard` | The web fetch tool's guard wrapper  | Import from `src/agents/tools/web-guarded-fetch.ts` |

## Architecture Patterns

### Catalog Document Structure

```
docs/reference/outbound-surfaces.md
```

The catalog is a Mintlify-compatible Markdown doc with tables grouped by category. No code changes outside the test file.

### Outbound HTTP Surface Categories (from code trace)

**Category 1: Agent Tools (agent-controlled URLs)**
These are the highest-risk surfaces because the AI agent picks the URL.

| Surface                    | Source File                                                | Guarded                              |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Web Fetch tool             | `src/agents/tools/web-fetch.ts` via `web-guarded-fetch.ts` | Yes (SSRF chokepoint)                |
| Web Search redirect follow | `src/agents/tools/web-search.redirect.test.ts` pattern     | Yes (SSRF chokepoint)                |
| Skills download            | `src/agents/skills-install-download.ts`                    | Yes (SSRF chokepoint)                |
| Firecrawl fallback         | `src/agents/tools/web-fetch.ts:379`                        | No (bare `fetch()` to Firecrawl API) |

**Category 2: Channel APIs (vendor-fixed endpoints)**
Channels call their vendor's API with operator-provided tokens. URLs are hardcoded to vendor domains.

| Surface           | Source File                                | Guarded                                                         |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------- |
| Telegram Bot API  | `src/telegram/bot.ts` via grammy           | No (grammy SDK, hardcoded `api.telegram.org`)                   |
| Discord REST API  | `src/discord/monitor/rest-fetch.ts`        | No (bare `fetch()`, hardcoded Discord API)                      |
| Slack Web API     | `src/slack/client.ts` via `@slack/web-api` | No (SDK-managed, hardcoded Slack API)                           |
| Slack file upload | `src/slack/send.ts`                        | Yes (SSRF chokepoint via `withTrustedEnvProxyGuardedFetchMode`) |
| Signal            | `src/signal/`                              | No outbound HTTP (local CLI subprocess)                         |
| iMessage          | `src/imessage/client.ts`                   | No outbound HTTP (local RPC subprocess)                         |

**Category 3: Provider APIs (operator-configured endpoints)**
LLM provider calls use operator-configured base URLs with auth tokens.

| Surface              | Source File                                                            | Guarded                                      |
| -------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| Ollama API           | `src/agents/models-config.providers.ts`, `src/agents/ollama-stream.ts` | No (bare `fetch()`, operator-configured URL) |
| TTS providers        | `src/tts/tts-core.ts`                                                  | No (bare `fetch()`, operator-configured URL) |
| Vercel AI Gateway    | `src/agents/vercel-ai-gateway.ts`                                      | No (bare `fetch()`, hardcoded endpoint)      |
| Venice models        | `src/agents/venice-models.ts`                                          | No (bare `fetch()`, hardcoded endpoint)      |
| HuggingFace models   | `src/agents/huggingface-models.ts`                                     | No (bare `fetch()`, hardcoded endpoint)      |
| Kilocode models      | `src/agents/kilocode-models.ts`                                        | No (bare `fetch()`, hardcoded endpoint)      |
| OpenCode Zen models  | `src/agents/opencode-zen-models.ts`                                    | No (bare `fetch()`, hardcoded endpoint)      |
| Minimax VLM          | `src/agents/minimax-vlm.ts`                                            | No (bare `fetch()`, operator token)          |
| PDF native providers | `src/agents/tools/pdf-native-providers.ts`                             | No (bare `fetch()`, operator-configured)     |
| Bedrock discovery    | `src/agents/bedrock-discovery.ts`                                      | No (AWS SDK pattern)                         |

**Category 4: Media Pipeline**

| Surface                   | Source File                                   | Guarded                                                |
| ------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Media fetch (input files) | `src/media/input-files.ts`                    | Yes (SSRF chokepoint)                                  |
| Media fetch (general)     | `src/media/fetch.ts`                          | Yes (SSRF chokepoint via `withStrictGuardedFetchMode`) |
| Media understanding       | `src/media-understanding/providers/shared.ts` | Yes (SSRF chokepoint)                                  |
| Camera node fetch         | `src/cli/nodes-camera.ts`                     | Yes (SSRF chokepoint)                                  |

**Category 5: Infrastructure**

| Surface               | Source File                     | Guarded                              |
| --------------------- | ------------------------------- | ------------------------------------ |
| Cron webhook delivery | `src/gateway/server-cron.ts`    | Yes (SSRF chokepoint)                |
| Remote memory HTTP    | `src/memory/remote-http.ts`     | Yes (SSRF chokepoint)                |
| Gateway probe         | `src/gateway/probe.ts`          | No (bare `fetch()`, localhost probe) |
| Browser sandbox       | `src/agents/sandbox/browser.ts` | No (bare `fetch()`, localhost)       |

**Category 6: Plugin/Extension Samples**

| Surface                | Source File                                     | Guarded                                   |
| ---------------------- | ----------------------------------------------- | ----------------------------------------- |
| Matrix client config   | `extensions/matrix/src/matrix/client/config.ts` | Yes (via plugin-sdk `fetchWithSsrFGuard`) |
| Matrix directory       | `extensions/matrix/src/directory-live.ts`       | No (bare `fetch()`, operator homeserver)  |
| MS Teams Graph API     | `extensions/msteams/src/graph.ts`               | No (bare `fetch()`, hardcoded MS Graph)   |
| MS Teams attachments   | `extensions/msteams/src/attachments/graph.ts`   | Yes (via plugin-sdk `fetchWithSsrFGuard`) |
| Feishu streaming cards | `extensions/feishu/src/streaming-card.ts`       | Yes (via plugin-sdk `fetchWithSsrFGuard`) |

### Plugin SDK Exports

The plugin SDK re-exports `fetchWithSsrFGuard` for extensions that need it:

- `src/plugin-sdk/index.ts` (general)
- `src/plugin-sdk/matrix.ts`
- `src/plugin-sdk/msteams.ts`
- `src/plugin-sdk/feishu.ts`
- `src/plugin-sdk/googlechat.ts`
- `src/plugin-sdk/voice-call.ts`
- `src/plugin-sdk/tlon.ts`
- `src/plugin-sdk/nextcloud-talk.ts`

Extensions that use the plugin-sdk export get SSRF guarding. Extensions using bare `fetch()` do not.

### Spot-Check Test Pattern

The test should prove that the web fetch tool path triggers `DnsBlocklistError` when fetching a blocked domain. The existing test pattern from `ssrf.pinning.test.ts` shows:

```typescript
import { DnsBlocklistError } from "./domain-filter.js";
import { resolvePinnedHostnameWithPolicy, SsrFBlockedError } from "./ssrf.js";

// Mock DNS lookup to return a public IP (so only blocklist blocks it)
function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

it("rejects a blocked domain with DnsBlocklistError", async () => {
  const lookup = createPublicLookupMock();
  await expect(
    resolvePinnedHostnameWithPolicy("malware.test", { lookupFn: lookup }),
  ).rejects.toThrow(DnsBlocklistError);
  expect(lookup).not.toHaveBeenCalled();
});
```

For the spot-check test in `src/infra/net/outbound-surfaces.test.ts`, the approach is:

1. Mock `fetchWithSsrFGuard` at the module level (pattern from `web-guarded-fetch.test.ts`)
2. Or test at a higher level: call the web fetch tool's `fetchWithWebToolsNetworkGuard` with a blocked domain and assert `DnsBlocklistError`
3. The simplest approach: test `fetchWithSsrFGuard` directly with a blocked domain (like `malware.test`) and a mocked DNS lookup, asserting `DnsBlocklistError` is thrown -- this proves the pipeline from fetch-guard through SSRF to blocklist works end-to-end

## Don't Hand-Roll

| Problem                       | Don't Build                               | Use Instead              | Why                                                         |
| ----------------------------- | ----------------------------------------- | ------------------------ | ----------------------------------------------------------- |
| Automated call-site detection | AST parser to find all fetch calls        | Manual grep + read trace | One-time audit; automation would be over-engineering        |
| Coverage percentage calc      | Script to compute guarded/unguarded ratio | Manual count in catalog  | Numbers change as code evolves; the catalog is the artifact |

## Common Pitfalls

### Pitfall 1: Missing Indirect Fetch Calls

**What goes wrong:** Grep for `fetch(` misses calls through SDK clients (grammy, @slack/web-api, OpenAI SDK) that make HTTP requests internally.
**Why it happens:** SDK libraries hide their HTTP calls behind method APIs.
**How to avoid:** For each channel/provider, identify which SDK is used and note that HTTP is SDK-managed. The catalog should name the SDK and note the hardcoded endpoint.
**Warning signs:** A channel has no `fetch()` calls but clearly communicates with an external service.

### Pitfall 2: Firecrawl as Unguarded Agent-Controlled Path

**What goes wrong:** Firecrawl fallback in `web-fetch.ts:379` uses bare `fetch()` to call the Firecrawl API with the agent-provided URL embedded in the request body. This is NOT the same risk as SSRF (the fetch goes to Firecrawl's API, not the target URL directly), but the agent controls which URL Firecrawl scrapes.
**Why it happens:** Firecrawl is a SaaS API with its own auth token; the SSRF guard protects the direct fetch, not the Firecrawl relay.
**How to avoid:** Annotate clearly in the catalog: "Firecrawl API (agent-controlled URL in body, Firecrawl endpoint hardcoded)".

### Pitfall 3: Confusing "Guarded" with "Safe"

**What goes wrong:** Marking something as "No" (unguarded) implies it is unsafe, when many unguarded paths are fine (e.g., Telegram Bot API with operator token to `api.telegram.org`).
**Why it happens:** The catalog is about SSRF chokepoint coverage, not risk assessment.
**How to avoid:** The Notes column should make the guard type clear. "Hardcoded endpoint" or "Operator token" explains why SSRF guarding is not needed for vendor-API calls.

### Pitfall 4: Mintlify Table Formatting

**What goes wrong:** Tables with pipes in code paths or long lines break Mintlify rendering.
**Why it happens:** Mintlify Markdown has strict table formatting requirements.
**How to avoid:** Keep table cells short. Use backtick code formatting for file paths. Test locally if possible.

## Code Examples

### Spot-Check Test (recommended pattern)

```typescript
// Source: based on src/infra/net/ssrf.pinning.test.ts patterns
import { describe, expect, it, vi } from "vitest";
import { DnsBlocklistError } from "./domain-filter.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import type { LookupFn } from "./ssrf.js";

function createPublicLookupMock(): LookupFn {
  return vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) as unknown as LookupFn;
}

describe("outbound surface catalog spot-check", () => {
  it("web fetch tool path rejects blocked domain with DnsBlocklistError", async () => {
    const lookup = createPublicLookupMock();

    await expect(
      fetchWithSsrFGuard({
        url: "https://malware.test/path",
        lookupFn: lookup,
      }),
    ).rejects.toThrow(DnsBlocklistError);

    // DNS lookup should never be called -- blocklist fires first
    expect(lookup).not.toHaveBeenCalled();
  });
});
```

### Catalog Table Format

```markdown
## Agent Tools

| Surface            | Source                          | Guarded | Notes                                              |
| ------------------ | ------------------------------- | ------- | -------------------------------------------------- |
| Web Fetch          | `src/agents/tools/web-fetch.ts` | Yes     | SSRF chokepoint (agent-controlled URL)             |
| Firecrawl fallback | `src/agents/tools/web-fetch.ts` | No      | Hardcoded Firecrawl API; agent URL in request body |
```

## Validation Architecture

### Test Framework

| Property           | Value                                               |
| ------------------ | --------------------------------------------------- |
| Framework          | Vitest (project standard)                           |
| Config file        | `vitest.config.ts` (root)                           |
| Quick run command  | `pnpm test src/infra/net/outbound-surfaces.test.ts` |
| Full suite command | `pnpm test`                                         |

### Phase Requirements -> Test Map

| Req ID  | Behavior                                                     | Test Type | Automated Command                                   | File Exists?    |
| ------- | ------------------------------------------------------------ | --------- | --------------------------------------------------- | --------------- |
| TEST-03 | Catalog exists and one path confirmed guarded via spot-check | unit      | `pnpm test src/infra/net/outbound-surfaces.test.ts` | Wave 0 (create) |

### Sampling Rate

- **Per task commit:** `pnpm test src/infra/net/outbound-surfaces.test.ts`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/infra/net/outbound-surfaces.test.ts` -- new file, covers TEST-03 spot-check
- [ ] `docs/reference/outbound-surfaces.md` -- new file, the catalog document itself

## Sources

### Primary (HIGH confidence)

- Direct code reading of `src/infra/net/fetch-guard.ts`, `src/infra/net/ssrf.ts`, `src/infra/net/domain-filter.ts`
- Grep trace of all `fetchWithSsrFGuard` callers across `src/` and `extensions/`
- Grep trace of bare `fetch()` callers across `src/agents/`, `src/tts/`, `src/telegram/`, `src/discord/`, `src/slack/`
- Existing test patterns in `src/infra/net/ssrf.pinning.test.ts`, `src/agents/tools/web-guarded-fetch.test.ts`

### Secondary (MEDIUM confidence)

- Extension sampling (Matrix, MS Teams, Feishu) -- representative but not exhaustive

## Metadata

**Confidence breakdown:**

- Surface catalog completeness: HIGH -- systematic grep trace of all fetch callers
- Guard classification: HIGH -- direct code reading of each call site
- Spot-check test pattern: HIGH -- follows established patterns from Phase 2 tests
- Extension sampling: MEDIUM -- 3 extensions sampled; 40+ exist but pattern is consistent

**Research date:** 2026-03-08
**Valid until:** 2026-04-08 (stable -- code paths change slowly)
