---
summary: "Mga tala sa RPC protocol para sa onboarding wizard at config schema"
read_when: "Kapag binabago ang mga hakbang ng onboarding wizard o ang mga endpoint ng config schema"
title: "Onboarding at Config Protocol"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:21Z
---

# Onboarding + Config Protocol

Layunin: pinagsamang onboarding + config na mga surface sa buong CLI, macOS app, at Web UI.

## Mga Component

- Wizard engine (pinagsamang session + prompts + estado ng onboarding).
- Ang CLI onboarding ay gumagamit ng parehong wizard flow gaya ng mga UI client.
- Ang Gateway RPC ay naglalantad ng mga endpoint ng wizard + config schema.
- Ang macOS onboarding ay gumagamit ng wizard step model.
- Ang Web UI ay nagre-render ng mga config form mula sa JSON Schema + UI hints.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Mga response (hugis)

- Wizard: `{ sessionId, done, step?, status?, error? }`
- Config schema: `{ schema, uiHints, version, generatedAt }`

## UI Hints

- `uiHints` na naka-key ayon sa path; opsyonal na metadata (label/help/group/order/advanced/sensitive/placeholder).
- Ang mga sensitive na field ay nirere-render bilang password inputs; walang redaction layer.
- Ang mga hindi suportadong schema node ay bumabagsak pabalik sa raw JSON editor.

## Mga Tala

- Ang dokumentong ito ang iisang lugar para subaybayan ang mga protocol refactor para sa onboarding/config.
