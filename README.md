# radar-claw-defender

Defensive security assistant for Radar Meseriași, built on top of the OpenClaw runtime.

## What this fork is

`radar-claw-defender` narrows the original OpenClaw platform into a product-context-aware defensive analyst for the Radar Meseriași marketplace.

Its job is to help review:

- code and route handlers
- SQL / RLS policies
- auth and OTP flows
- admin boundaries
- webhook verification logic
- threat models and remediation plans

It is intentionally scoped for **defensive analysis only**.

## What this fork is not

This fork is **not** an offensive toolkit and must not be used for:

- unauthorized targeting
- exploit execution
- credential theft
- phishing or impersonation playbooks
- malware, persistence, or stealth workflows
- exploit chaining guidance

If you need a live scanner or offensive automation platform, this fork is the wrong tool.

## Why this exists

Radar Meseriași is a marketplace for homeowners and craftsmen. Its highest-risk paths are not generic “cyber” problems; they are product-specific trust failures:

- auth bypass
- authorization / IDOR
- RLS gaps
- admin escalation
- OTP abuse
- webhook verification mistakes
- XSS and unsafe rendering
- sensitive data exposure
- rate-limiting gaps
- input validation failures

This fork packages those concerns into a deterministic review surface that can be used by founders, engineers, and future AI clients without drifting into unsafe behavior.

## Current deliverables in this fork

### Defensive role and guardrails

- `config/system-role.md`
- `config/radar-context.md`
- `config/security-guardrails.md`
- `config/review-checklist.md`
- `config/output-format.md`

### Future API contracts

- `docs/api-design.md`
- `openapi/radar-claw-openapi.yaml`
- `docs/chatgpt-integration-plan.md`

### Local implementation stubs

- `src/defender/types.ts`
- `src/defender/defaults.ts`
- `src/defender/render.ts`
- `src/defender/stubs.ts`
- `src/defender/index.ts`

The stubs are local, deterministic, and artifact-based. They do not perform remote execution, crawling, or offensive actions.

## Skill Security Pipeline

This fork now includes a Radar-first defensive skill security pipeline designed around:

- deterministic ZIP packaging
- SHA-256 fingerprinting
- scanner abstraction (`mock`, future `virustotal`, future local providers)
- verdict-based policy gating
- versioned scan metadata
- daily re-scan scaffolding

The goal is simple: a skill should be packaged, fingerprinted, scanned, classified, and policy-gated before it is trusted.

This pipeline is defensive-only. It is meant for packaging, metadata, classification, auditability, and re-evaluation, not for offensive tooling or exploit execution.

## Design principles

- scope lock over breadth
- deterministic output over smart-sounding output
- defensive analysis over exploit creativity
- product-context-aware findings over generic findings
- future API cleanliness over ad-hoc local coupling

## Planned API surface

The future public API is intentionally small:

- `POST /analyze/code-snippet`
- `POST /analyze/file`
- `POST /analyze/route`
- `POST /analyze/sql-policy`
- `POST /threat-model/flow`
- `POST /summarize/finding`

Each endpoint is designed to accept only supplied review artifacts and return structured JSON suitable for later ChatGPT Actions integration.

## Configurability

The defensive layer is designed around explicit configuration:

- severity thresholds
- enabled analyzers
- output mode (`markdown` / `json`)
- product context overrides

See `config/radar-defender.example.json`.

## UI identity

The control UI now defaults to a Radar-specific defensive identity instead of the generic assistant naming from upstream.

## Base platform note

This fork still inherits the underlying OpenClaw runtime and much of its internal structure. To keep scope safe and reversible, this pass does **not** rename:

- the CLI binary
- package manager commands
- legacy upstream config paths
- mobile / desktop bundle identifiers

Those can be addressed later if you decide to turn the fork into a separately distributed product.

## Future ChatGPT integration

The long-term plan is a thin, authenticated API layer in front of the defensive analyzers, using the OpenAPI contract in `openapi/radar-claw-openapi.yaml`.

That future integration should remain:

- defensive-only
- stateless
- artifact-driven
- easy to audit

## Development note

This repository is now opinionated toward Radar Meseriași defensive review, but it still uses the upstream technical base. Expect future work to focus on:

1. safe analyzer coverage
2. structured JSON responses
3. product-context-aware rules
4. clean API exposure for ChatGPT and internal tooling
