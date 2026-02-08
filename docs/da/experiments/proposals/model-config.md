---
summary: "Udforskning: modelkonfiguration, godkendelsesprofiler og fallback-adfærd"
read_when:
  - Udforsker fremtidige idéer til modelvalg + godkendelsesprofiler
title: "Udforskning af modelkonfiguration"
x-i18n:
  source_path: experiments/proposals/model-config.md
  source_hash: 48623233d80f874c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:09Z
---

# Modelkonfiguration (Udforskning)

Dette dokument samler **idéer** til fremtidig modelkonfiguration. Det er ikke en
leveringsklar specifikation. For nuværende adfærd, se:

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
