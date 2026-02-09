---
summary: "Hoe de mac-app de Gateway WebChat insluit en hoe je deze kunt debuggen"
read_when:
  - Debuggen van de mac WebChat-weergave of local loopback-poort
title: "WebChat"
---

# WebChat (macOS-app)

De macOS-menubalkapp sluit de WebChat‑UI in als een native SwiftUI‑weergave. Deze
maakt verbinding met de Gateway en gebruikt standaard de **hoofd­sessie** voor de
geselecteerde agent (met een sessiewisselaar voor andere sessies).

- **Lokale modus**: maakt rechtstreeks verbinding met de lokale Gateway WebSocket.
- **Modus op afstand**: stuurt de Gateway‑controlepoort door via SSH en gebruikt
  die tunnel als dataplane.

## Starten & debuggen

- Handmatig: Lobster‑menu → “Open Chat”.

- Automatisch openen voor testen:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- Logs: `./scripts/clawlog.sh` (subsystem `bot.molt`, categorie `WebChatSwiftUI`).

## Hoe het is bekabeld

- Dataplane: Gateway WS‑methoden `chat.history`, `chat.send`, `chat.abort`,
  `chat.inject` en events `chat`, `agent`, `presence`, `tick`, `health`.
- Sessie: standaard de primaire sessie (`main`, of `global` wanneer de scope
  globaal is). De UI kan tussen sessies wisselen.
- Onboarding gebruikt een speciale sessie om de eerste‑keer‑installatie gescheiden te houden.

## Beveiligingsoppervlak

- De modus op afstand stuurt uitsluitend de Gateway WebSocket‑controlepoort door via SSH.

## Bekende beperkingen

- De UI is geoptimaliseerd voor chatsessies (geen volledige browser‑sandbox).
