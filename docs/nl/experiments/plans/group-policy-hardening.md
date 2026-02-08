---
summary: "Versteviging van de Telegram-toegestane lijst: prefix- en witruimtenormalisatie"
read_when:
  - Beoordelen van historische wijzigingen in de Telegram-toegestane lijst
title: "Versteviging van de Telegram-toegestane lijst"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:19Z
---

# Versteviging van de Telegram-toegestane lijst

**Datum**: 2026-01-05  
**Status**: Voltooid  
**PR**: #216

## Samenvatting

Telegram-toegestane lijsten accepteren nu de prefixes `telegram:` en `tg:` hoofdletterongevoelig en tolereren
onbedoelde witruimte. Dit brengt inkomende controles van de toegestane lijst in lijn met de normalisatie bij uitgaand verzenden.

## Wat is er veranderd

- De prefixes `telegram:` en `tg:` worden hetzelfde behandeld (hoofdletterongevoelig).
- Items in de toegestane lijst worden getrimd; lege items worden genegeerd.

## Voorbeelden

Al deze worden geaccepteerd voor dezelfde ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Waarom dit belangrijk is

Kopiëren/plakken uit logs of chat-ID's bevat vaak prefixes en witruimte. Normalisatie voorkomt
valse negatieven bij het bepalen of er in DM's of groepen moet worden gereageerd.

## Gerelateerde documentatie

- [Groepschats](/channels/groups)
- [Telegram Provider](/channels/telegram)
