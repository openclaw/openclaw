---
summary: "Anteckningar om RPC-protokoll för introduktionsguide och konfigschema"
read_when: "När stegen i introduktionsguiden eller konfigschemaendpoints ändras"
title: "Introduktion och konfigprotokoll"
x-i18n:
  source_path: experiments/onboarding-config-protocol.md
  source_hash: 55163b3ee029c024
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:05Z
---

# Introduktion + konfigprotokoll

Syfte: delade ytor för introduktion och konfiguration över CLI, macOS-app och webbgränssnitt.

## Komponenter

- Guide-motor (delad session + uppmaningar + introduktionstillstånd).
- CLI-introduktion använder samma guideflöde som UI-klienterna.
- Gateway-RPC exponerar endpoints för guide och konfigschema.
- macOS-introduktion använder modellen för guidesteg.
- Webbgränssnittet renderar konfigformulär från JSON Schema + UI-ledtrådar.

## Gateway RPC

- `wizard.start` params: `{ mode?: "local"|"remote", workspace?: string }`
- `wizard.next` params: `{ sessionId, answer?: { stepId, value? } }`
- `wizard.cancel` params: `{ sessionId }`
- `wizard.status` params: `{ sessionId }`
- `config.schema` params: `{}`

Svar (form)

- Guide: `{ sessionId, done, step?, status?, error? }`
- Konfigschema: `{ schema, uiHints, version, generatedAt }`

## UI-ledtrådar

- `uiHints` nycklade efter sökväg; valfri metadata (label/help/group/order/advanced/sensitive/placeholder).
- Känsliga fält renderas som lösenordsinmatningar; inget maskeringslager.
- Schema-noder som inte stöds faller tillbaka till rå JSON-redigerare.

## Noteringar

- Detta dokument är den enda platsen för att följa protokollrefaktoreringar för introduktion/konfiguration.
