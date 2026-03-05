---
summary: "Remove insecure BlueBubbles webhook authentication via query parameters"
title: "Task 02: BlueBubbles Webhook Query Auth Removal"
---

## Objective

Eliminate query-string authentication for BlueBubbles webhooks and move to header-based auth.

## Scope

- BlueBubbles inbound webhook endpoint and auth middleware.
- Any docs, examples, and tests that currently use query tokens.
- Logging and telemetry that might expose query secrets.

## Task Checklist

- [ ] Remove acceptance of auth tokens passed in URL query parameters.
- [ ] Require header-based authentication (for example, `Authorization` bearer or signed header).
- [ ] Add constant-time secret comparison for shared-secret validation.
- [ ] Redact auth credentials from logs, traces, and error payloads.
- [ ] Provide a short deprecation/migration note for existing setups.
- [ ] Update docs and examples to header-only authentication.

## Acceptance Criteria

- Requests that only include query auth are rejected.
- Header-authenticated requests succeed.
- Secrets never appear in logs or error responses.

## Verification

- Integration tests for accepted header auth and rejected query auth.
- Log redaction test to verify tokens are not emitted.
- Docs check confirming no query-auth examples remain.
