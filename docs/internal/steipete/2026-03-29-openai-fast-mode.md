---
title: "OpenAI Fast Mode Audit"
summary: "Checked /fast across direct OpenAI websocket and Codex OAuth paths; corrected the implementation to priority-processing semantics and kept websocket payload patch coverage."
author: "Peter Steinberger <steipete@gmail.com>"
github_username: "steipete"
created: "2026-03-29"
status: "implemented"
read_when:
  - "Touching OpenAI or OpenAI Codex fast-mode shaping"
  - "Debugging websocket vs HTTP payload differences"
---

- Scope: `/fast` on direct `openai/*` Responses/WebSocket path and `openai-codex/*` OAuth path.
- Sources checked:
  - OpenAI GPT-5.4 launch post: Codex `/fast` is same model/intelligence delivered faster, with API parity via priority processing.
  - Local `~/Projects/codex` repo: `/fast` toggles `ServiceTier::Fast`, then serializes to `service_tier = "priority"` on both HTTP and websocket Responses requests.
  - Local `pi-ai` transport: Codex `onPayload` mutations are passed through for both SSE and websocket request bodies.
- Result:
  - `/fast` should inject only `service_tier = "priority"` on supported direct OpenAI and Codex Responses paths.
  - `/fast` should not reshape `reasoning` or `text.verbosity`.
- Added regression coverage so websocket `response.create` still honors `options.onPayload` patches.
