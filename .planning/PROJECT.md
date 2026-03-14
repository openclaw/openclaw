# OpenClaw DNS Blocklist Filter

## What This Is

A DNS blocklist filter for OpenClaw's outbound HTTP path that blocks requests to known-malicious domains before any network call is made. It extends the existing SSRF protection infrastructure with a standalone domain-filter module, SSRF pipeline integration, and a documented catalog of all outbound HTTP surfaces.

## Core Value

Outbound HTTP requests from the gateway must be checked against DNS blocklists before any network call, preventing AI agents from contacting known-malicious domains.

## Requirements

### Validated

- ✓ `isDomainBlocked(hostname)` function with suffix-based matching — v1.0
- ✓ Integration into SSRF pipeline (pre-DNS security floor) — v1.0
- ✓ Clean module boundaries (`domain-filter.ts` sibling to `ssrf.ts`) — v1.0
- ✓ Unit tests for domain matching (30 tests, exact/subdomain/normalization) — v1.0
- ✓ Integration test proving blocked domains produce deterministic errors — v1.0
- ✓ Catalog of all outbound HTTP paths (30+ surfaces, 6 categories) — v1.0
- ✓ PR-ready code quality with `DnsBlocklistError` extending `SsrFBlockedError` — v1.0

### Active

(None — next milestone will define)

### Out of Scope

- Full config integration (`security.dnsBlocklists*`) — future PR polish
- Fetching real DNS blocklists from URLs (Hagezi, etc.) — future PR polish
- Per-agent or per-tool blocklist policies — future work
- Standalone "agent DNS firewall" library extraction — possible future project
- IDN/punycode normalization — documented as known gap

## Context

Shipped v1.0 with 2,358 lines added across 24 files.
Tech stack: TypeScript ESM, Vitest, existing SSRF infrastructure.
Key files: `src/infra/net/domain-filter.ts`, `src/infra/net/ssrf-error.ts`, `docs/reference/outbound-surfaces.md`.

## Constraints

- **Integration point**: Extends existing SSRF infrastructure, not a parallel system
- **Error types**: `DnsBlocklistError` extends `SsrFBlockedError` via extracted `ssrf-error.ts`
- **Code style**: TypeScript ESM, strict typing, Oxlint/Oxfmt, no `any`
- **Testing**: Vitest, colocated `*.test.ts`, V8 coverage thresholds
- **Module boundaries**: No mixing static and dynamic imports for the same module

## Key Decisions

| Decision                                       | Rationale                                                       | Outcome |
| ---------------------------------------------- | --------------------------------------------------------------- | ------- |
| New `domain-filter.ts` sibling to `ssrf.ts`    | Clean module boundary; avoids bloating ssrf.ts                  | ✓ Good  |
| PR-ready structure from spike                  | Clean interfaces accommodate config/URL lists later             | ✓ Good  |
| Hook one HTTP path, document others            | Spike-appropriate scope while mapping full surface              | ✓ Good  |
| Suffix-walk via indexOf('.') loop              | Simple, no regex, handles all standard blocklist cases          | ✓ Good  |
| Extract SsrFBlockedError to ssrf-error.ts      | Breaks circular dependency between ssrf.ts and domain-filter.ts | ✓ Good  |
| Binary Yes/No catalog with guard type in Notes | Clear audit artifact without editorial judgment                 | ✓ Good  |

---

_Last updated: 2026-03-08 after v1.0 milestone_
