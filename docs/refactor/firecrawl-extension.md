---
summary: "Design for an opt-in Firecrawl extension that adds search/scrape value without hardwiring Firecrawl into core defaults"
read_when:
  - Designing Firecrawl integration work
  - Evaluating web_search/web_fetch plugin seams
  - Deciding whether Firecrawl belongs in core or as an extension
title: "Firecrawl Extension Design"
---

# Firecrawl Extension Design

## Goal

Ship Firecrawl as an **opt-in extension** that adds:

- explicit Firecrawl tools for agents,
- optional Firecrawl-backed `web_search` integration,
- self-hosted support,
- stronger security defaults than the current core fallback path,

without pushing Firecrawl into the default setup/onboarding path.

## Why this shape

Recent Firecrawl issues/PRs cluster into three buckets:

1. **Release/schema drift**
   - Several releases rejected `tools.web.fetch.firecrawl` even though docs and runtime code supported it.
2. **Security hardening**
   - Current `fetchFirecrawlContent()` still posts to the Firecrawl endpoint with raw `fetch()`, while the main web-fetch path uses the SSRF guard.
3. **Product pressure**
   - Users want Firecrawl-native search/scrape flows, especially for self-hosted/private setups.
   - Maintainers explicitly rejected wiring Firecrawl deeply into core defaults, setup flow, and browser behavior.

That combination argues for an extension, not more Firecrawl-specific logic in the default core path.

## Design principles

- **Opt-in, vendor-scoped**: no auto-enable, no setup hijack, no default tool-profile widening.
- **Extension owns Firecrawl-specific config**: prefer plugin config over growing `tools.web.*` again.
- **Useful on day one**: works even if core `web_search` / `web_fetch` seams stay unchanged.
- **Security-first**: endpoint fetches use the same guarded networking posture as other web tools.
- **Self-hosted-friendly**: config + env fallback, explicit base URL, no hosted-only assumptions.

## Proposed extension

Plugin id: `firecrawl`

### MVP capabilities

Register explicit tools:

- `firecrawl_search`
- `firecrawl_scrape`

Optional later:

- `firecrawl_crawl`
- `firecrawl_map`

Do **not** add Firecrawl browser automation in the first version. That was the part of PR #32543 that pulled Firecrawl too far into core behavior and raised the most maintainership concern.

## Config shape

Use plugin-scoped config:

```json5
{
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          apiKey: "FIRECRAWL_API_KEY",
          baseUrl: "https://api.firecrawl.dev",
          timeoutSeconds: 60,
          maxAgeMs: 172800000,
          proxy: "auto",
          storeInCache: true,
          onlyMainContent: true,
          search: {
            enabled: true,
            defaultLimit: 5,
            sources: ["web"],
            categories: [],
            scrapeResults: false,
          },
          scrape: {
            formats: ["markdown"],
            fallbackForWebFetchLikeUse: false,
          },
        },
      },
    },
  },
}
```

### Credential resolution

Precedence:

1. `plugins.entries.firecrawl.config.apiKey`
2. `FIRECRAWL_API_KEY`

Base URL precedence:

1. `plugins.entries.firecrawl.config.baseUrl`
2. `FIRECRAWL_BASE_URL`
3. `https://api.firecrawl.dev`

### Compatibility bridge

For the first release, the extension may also **read** existing core config at `tools.web.fetch.firecrawl.*` as a fallback source so existing users do not need to migrate immediately.

Write path stays plugin-local. Do not keep expanding core Firecrawl config surfaces.

## Tool design

### `firecrawl_search`

Inputs:

- `query`
- `limit`
- `sources`
- `categories`
- `scrapeResults`
- `timeoutSeconds`

Behavior:

- Calls Firecrawl `v2/search`
- Returns normalized OpenClaw-friendly result objects:
  - `title`
  - `url`
  - `snippet`
  - `source`
  - optional `content`
- Wraps result content as untrusted external content
- Cache key includes query + relevant provider params

Why explicit tool first:

- Works today without changing `tools.web.search.provider`
- Avoids current schema/loader constraints
- Gives users Firecrawl value immediately

### `firecrawl_scrape`

Inputs:

- `url`
- `formats`
- `onlyMainContent`
- `maxAgeMs`
- `proxy`
- `storeInCache`
- `timeoutSeconds`

Behavior:

- Calls Firecrawl `v2/scrape`
- Returns markdown/text plus metadata:
  - `title`
  - `finalUrl`
  - `status`
  - `warning`
- Wraps extracted content the same way `web_fetch` does
- Shares cache semantics with web tool expectations where practical

Why explicit scrape tool:

- Sidesteps the unresolved `Readability -> Firecrawl -> basic HTML cleanup` ordering bug in core `web_fetch`
- Gives users a deterministic “always use Firecrawl” path for JS-heavy/bot-protected sites

## What the extension should not do

- No auto-adding `browser`, `web_search`, or `web_fetch` to `tools.alsoAllow`
- No default onboarding step in `openclaw setup`
- No Firecrawl-specific browser session lifecycle in core
- No change to built-in `web_fetch` fallback semantics in the extension MVP

## Phase plan

### Phase 1: extension-only, no core schema changes

Implement:

- `extensions/firecrawl/`
- plugin config schema
- `firecrawl_search`
- `firecrawl_scrape`
- tests for config resolution, endpoint selection, caching, error handling, and SSRF guard usage

This phase is enough to ship real user value.

### Phase 2: optional `web_search` provider integration

Support `tools.web.search.provider = "firecrawl"` only after fixing two core constraints:

1. `src/plugins/web-search-providers.ts` must load configured/installed web-search-provider plugins instead of a hardcoded bundled list.
2. `src/config/types.tools.ts` and `src/config/zod-schema.agent-runtime.ts` must stop hardcoding the provider enum in a way that blocks plugin-registered ids.

Recommended shape:

- keep built-in providers documented,
- allow any registered plugin provider id at runtime,
- validate provider-specific config via the provider plugin or a generic provider bag.

### Phase 3: optional `web_fetch` provider seam

Do this only if maintainers want vendor-specific fetch backends to participate in `web_fetch`.

Needed core addition:

- `registerWebFetchProvider` or equivalent fetch-backend seam

Without that seam, the extension should keep `firecrawl_scrape` as an explicit tool rather than trying to patch built-in `web_fetch`.

## Security requirements

The extension must treat Firecrawl as a **trusted operator-configured endpoint**, but still harden transport:

- Use SSRF-guarded fetch for the Firecrawl endpoint call, not raw `fetch()`
- Preserve self-hosted/private-network compatibility using the same trusted-web-tools endpoint policy used elsewhere
- Never log the API key
- Keep endpoint/base URL resolution explicit and predictable
- Treat Firecrawl-returned content as untrusted external content

This mirrors the intent behind the SSRF hardening PRs without assuming Firecrawl is a hostile multi-tenant surface.

## Why not a skill

The repo already closed a Firecrawl skill PR in favor of ClawHub distribution. That is fine for optional user-installed prompt workflows, but it does not solve:

- deterministic tool availability,
- provider-grade config/credential handling,
- self-hosted endpoint support,
- caching,
- stable typed outputs,
- security review on network behavior.

This belongs as an extension, not a prompt-only skill.

## Success criteria

- Users can install/enable one extension and get reliable Firecrawl search/scrape without touching core defaults.
- Self-hosted Firecrawl works with config/env fallback.
- Extension endpoint fetches use guarded networking.
- No new Firecrawl-specific core onboarding/default behavior.
- Core can later adopt plugin-native `web_search` / `web_fetch` seams without redesigning the extension.

## Recommended implementation order

1. Build `firecrawl_scrape`
2. Build `firecrawl_search`
3. Add docs and examples
4. If desired, generalize `web_search` provider loading so the extension can back `web_search`
5. Only then consider a true `web_fetch` provider seam
