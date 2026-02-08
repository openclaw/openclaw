---
summary: "RPC-protokolnoter for introduktionsguide og konfigurationsskema"
read_when: "Ændring af trin i introduktionsguiden eller endpoints for konfigurationsskema"
title: "Introduktion og konfigurationsprotokol"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:06Z
---

# Introduktion + konfigurationsprotokol

Formål: delte introduktions- og konfigurationsflader på tværs af CLI, macOS-app og Web UI.

## Komponenter

- Opsætningsguide-motor (delt session + prompts + introduktionstilstand).
- CLI-introduktion bruger det samme opsætningsguide-flow som UI-klienterne.
- Gateway RPC eksponerer endpoints for opsætningsguide + konfigurationsskema.
- macOS-introduktion bruger opsætningsguidens trinmodel.
- Web UI renderer konfigurationsformularer fra JSON Schema + UI-hints.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Svar (form)

- Opsætningsguide: `{ sessionId, done, step?, status?, error? }`
- Konfigurationsskema: `{ schema, uiHints, version, generatedAt }`

## UI-hints

- `uiHints` nøgleinddelt efter sti; valgfri metadata (label/help/group/order/advanced/sensitive/placeholder).
- Følsomme felter renderes som password-inputs; ingen redaktionslag.
- Skemanoder, der ikke understøttes, falder tilbage til den rå JSON-editor.

## Noter

- Dette dokument er det eneste sted at følge protokolrefaktoreringer for introduktion/konfiguration.
