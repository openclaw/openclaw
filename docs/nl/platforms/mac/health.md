---
summary: "Hoe de macOS-app de Gateway/Baileys-gezondheidsstatussen rapporteert"
read_when:
  - Debuggen van gezondheidsindicatoren van de macOS-app
title: "Gezondheidscontroles"
---

# Gezondheidscontroles op macOS

Hoe je vanuit de menubalk-app kunt zien of het gekoppelde kanaal gezond is.

## Menu balk

- De statusstip weerspiegelt nu de Baileys-gezondheid:
  - Groen: gekoppeld + socket recent geopend.
  - Oranje: verbinden/opnieuw proberen.
  - Rood: uitgelogd of probe mislukt.
- De secundaire regel toont "gekoppeld · auth 12m" of geeft de reden van de fout weer.
- Het menu-item "Gezondheidscontrole uitvoeren" start een probe op aanvraag.

## Instellingen

- Het tabblad Algemeen krijgt een Gezondheid-kaart met: leeftijd van gekoppelde auth, pad/aantal van de sessie-opslag, tijdstip van de laatste controle, laatste fout/statuscode en knoppen voor Gezondheidscontrole uitvoeren / Logs tonen.
- Gebruikt een gecachte momentopname zodat de UI direct laadt en bij offline status soepel terugvalt.
- **Tabblad Kanalen** toont kanaalstatus + bediening voor WhatsApp/Telegram (inlog-QR, uitloggen, probe, laatste verbreking/fout).

## Hoe de probe werkt

- De app voert `openclaw health --json` uit via `ShellExecutor` elke ~60s en op aanvraag. De probe laadt referenties en rapporteert de status zonder berichten te verzenden.
- Cache de laatste goede momentopname en de laatste fout afzonderlijk om flikkeren te voorkomen; toon de tijdstempel van elk.

## Bij twijfel

- Je kunt nog steeds de CLI-stroom gebruiken in [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) en `/tmp/openclaw/openclaw-*.log` volgen voor `web-heartbeat` / `web-reconnect`.
