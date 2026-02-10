---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "RPC protocol notes for onboarding wizard and config schema"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when: "Changing onboarding wizard steps or config schema endpoints"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Onboarding and Config Protocol"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Onboarding + Config Protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Purpose: shared onboarding + config surfaces across CLI, macOS app, and Web UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Components（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wizard engine (shared session + prompts + onboarding state).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- CLI onboarding uses the same wizard flow as the UI clients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway RPC exposes wizard + config schema endpoints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS onboarding uses the wizard step model.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Web UI renders config forms from JSON Schema + UI hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway RPC（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.cancel` params: `{ sessionId }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `wizard.status` params: `{ sessionId }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.schema` params: `{}`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Responses (shape)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wizard: `{ sessionId, done, step?, status?, error? }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config schema: `{ schema, uiHints, version, generatedAt }`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## UI Hints（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `uiHints` keyed by path; optional metadata (label/help/group/order/advanced/sensitive/placeholder).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sensitive fields render as password inputs; no redaction layer.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Unsupported schema nodes fall back to the raw JSON editor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- This doc is the single place to track protocol refactors for onboarding/config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
