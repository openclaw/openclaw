---
summary: "Udforskning: modelkonfiguration, godkendelsesprofiler og fallback-adfærd"
read_when:
  - Udforsker fremtidige idéer til modelvalg + godkendelsesprofiler
title: "Udforskning af modelkonfiguration"
---

# Modelkonfiguration (Udforskning)

Dette dokument indfanger **ideer** til fremtidig modelkonfiguration. Det er ikke et
shipping spec. For aktuel opførsel, se:

- [Modeller](/concepts/models)
- [Model-failover](/concepts/model-failover)
- [OAuth + profiler](/concepts/oauth)

## Motivation

Operatører ønsker:

- Flere godkendelsesprofiler pr. udbyder (personlig vs. arbejde).
- Simpelt valg med `/model` og forudsigelige fallbacks.
- Klar adskillelse mellem tekstmodeller og billedkapable modeller.

## Mulig retning (overordnet)

- Hold modelvalg enkelt: `provider/model` med valgfri aliaser.
- Lad udbydere have flere godkendelsesprofiler med en eksplicit rækkefølge.
- Brug en global fallback-liste, så alle sessioner failover ensartet.
- Overstyr kun billedrouting, når det er eksplicit konfigureret.

## Åbne spørgsmål

- Skal profilerotation være pr. udbyder eller pr. model?
- Hvordan bør UI’en vise profilvalg for en session?
- Hvad er den sikreste migrationssti fra ældre konfigurationsnøgler?
