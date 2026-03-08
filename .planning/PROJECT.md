# OpenClaw DNS Blocklist Filter

## What This Is

A DNS blocklist filter for OpenClaw's outbound HTTP path that blocks requests to known-malicious domains before any network call is made. It extends the existing SSRF protection infrastructure (`src/infra/net/ssrf.ts`) with configurable domain blocklists, starting as a hard-coded spike and evolving into a PR-ready feature with config integration and remote list fetching.

## Core Value

Outbound HTTP requests from the gateway must be checked against DNS blocklists before any network call, preventing AI agents from contacting known-malicious domains.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] `isDomainBlocked(hostname)` function that checks domains against blocklists
- [ ] Integration into OpenClaw's existing SSRF/outbound HTTP infrastructure
- [ ] Clean module boundaries that support future config-driven and URL-fetched blocklists
- [ ] Unit tests for domain matching (exact, subdomain, normalization edge cases)
- [ ] Integration test proving blocked domains produce deterministic errors
- [ ] Catalog of all outbound HTTP paths in the gateway (hook one, document others)
- [ ] PR-ready code quality with proper error types extending `SsrFBlockedError`

### Out of Scope

- Full config integration (`security.dnsBlocklists*`) — future PR polish
- Fetching real DNS blocklists from URLs (Hagezi, etc.) — future PR polish
- Per-agent or per-tool blocklist policies — future work
- Standalone "agent DNS firewall" library extraction — possible future project

## Context

- OpenClaw already has robust SSRF protection at `src/infra/net/ssrf.ts` with `SsrFBlockedError`, hostname normalization, DNS pinning, and allowlist/blocklist patterns
- `src/plugin-sdk/ssrf-policy.ts` provides suffix-based hostname allowlisting for plugins
- `src/infra/net/hostname.ts` has `normalizeHostname()` used throughout the SSRF module
- The SSRF module uses a two-phase check: pre-DNS (literal hostname/IP) and post-DNS (resolved addresses) — the blocklist check fits naturally into phase 1
- Outbound HTTP surfaces include: SSRF-guarded fetch in tools, channel-specific API calls (Telegram, Discord, Slack, etc.), provider API calls, media fetching
- Existing test patterns: `src/infra/net/ssrf.test.ts`, `src/infra/net/ssrf.dispatcher.test.ts`, `src/infra/net/ssrf.pinning.test.ts`

## Constraints

- **Integration point**: Must extend existing SSRF infrastructure, not create a parallel system
- **Error types**: Must use or extend `SsrFBlockedError` for consistency
- **Code style**: TypeScript ESM, strict typing, Oxlint/Oxfmt, no `any`
- **Testing**: Vitest, colocated `*.test.ts`, V8 coverage thresholds
- **Module boundaries**: No mixing static and dynamic imports for the same module

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Extend `src/infra/net/ssrf.ts` rather than new module | Existing SSRF infra already has hostname normalization, error types, and integration points | — Pending |
| PR-ready structure from spike | Avoids throwaway code; clean interfaces accommodate config/URL lists later | — Pending |
| Hook one HTTP path, document others | Spike-appropriate scope while mapping full surface for future coverage | — Pending |

---
*Last updated: 2026-03-08 after initialization*
