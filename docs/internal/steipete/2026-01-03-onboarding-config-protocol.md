---
title: "Onboarding and Config Protocol"
summary: "RPC protocol notes for setup wizard and config schema"
author: "Peter Steinberger <steipete@gmail.com>"
github_username: "steipete"
created: "2026-01-03"
read_when: "Changing setup wizard steps or config schema endpoints"
---

# Onboarding + Config Protocol

Purpose: shared onboarding + config surfaces across CLI, macOS app, and Web UI.

## Components

- Wizard engine (shared session + prompts + onboarding state).
- CLI onboarding uses the same wizard flow as the UI clients.
- Gateway RPC exposes wizard + config schema endpoints.
- macOS onboarding uses the wizard step model.
- Web UI renders config forms from JSON Schema + UI hints.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`
- `config.schema.lookup` params: `{ path }`
  - `path` accepts standard config segments plus slash-delimited plugin ids, for example `plugins.entries.pack/one.config`.

Responses (shape)

- Wizard: `{ sessionId, done, step?, status?, error? }`
- Config schema: `{ schema, uiHints, version, generatedAt }`
- Config schema lookup: `{ path, schema, hint?, hintPath?, children[] }`

## UI Hints

- `uiHints` keyed by path; optional metadata (label/help/group/order/advanced/sensitive/placeholder).
- Sensitive fields render as password inputs; no redaction layer.
- Unsupported schema nodes fall back to the raw JSON editor.

## Notes

- This doc is the single place to track protocol refactors for onboarding/config.
