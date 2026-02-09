---
summary: "Utforskning: modellkonfiguration, autentiseringsprofiler och fallback-beteende"
read_when:
  - Utforskar framtida idéer för modellval + autentiseringsprofiler
title: "Utforskning av modellkonfig"
---

# Modellkonfig (Utforskning)

Det här dokumentet fångar **idéer** för framtida modellkonfiguration. Det är inte en
frakt spec. För aktuellt beteende, se:

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
