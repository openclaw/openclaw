---
summary: "Utforskning: modellkonfiguration, autentiseringsprofiler och fallback-beteende"
read_when:
  - "Utforskar framtida idéer för modellval + autentiseringsprofiler"
title: "Utforskning av modellkonfig"
x-i18n:
  source_path: experiments/proposals/model-config.md
  source_hash: 48623233d80f874c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:16Z
---

# Modellkonfig (Utforskning)

Det här dokumentet samlar **idéer** för framtida modellkonfiguration. Det är inte en
levererad specifikation. För nuvarande beteende, se:

- [Models](/concepts/models)
- [Model failover](/concepts/model-failover)
- [OAuth + profiles](/concepts/oauth)

## Motivation

Operatörer vill ha:

- Flera autentiseringsprofiler per leverantör (privat vs arbete).
- Enkelt val av `/model` med förutsägbara fallbacks.
- Tydlig åtskillnad mellan textmodeller och bildkapabla modeller.

## Möjlig inriktning (på hög nivå)

- Håll modellvalet enkelt: `provider/model` med valfria alias.
- Låt leverantörer ha flera autentiseringsprofiler, med en explicit ordning.
- Använd en global fallback-lista så att alla sessioner faller tillbaka konsekvent.
- Åsidosätt bildroutning endast när det är explicit konfigurerat.

## Öppna frågor

- Ska profilrotation vara per leverantör eller per modell?
- Hur bör UI:t exponera profilval för en session?
- Vilken är den säkraste migreringsvägen från äldre konfig-nycklar?
