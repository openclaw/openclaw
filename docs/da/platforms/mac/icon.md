---
summary: "Tilstande og animationer for menulinjeikonet for OpenClaw på macOS"
read_when:
  - Ændring af adfærd for menulinjeikonet
title: "Menulinjeikon"
---

# Menulinjeikonets tilstande

Forfatter: steipete · Opdateret: 2025-12-06 · Omfang: macOS-app (`apps/macos`)

- **Idle:** Normal ikonanimation (blink, lejlighedsvis vrik).
- **Paused:** Status-elementet bruger `appearsDisabled`; ingen bevægelse.
- **Stemmeudløser (store ører):** Stemmeopvågningsdetektor kalder `AppState.triggerVoiceEars(ttl: nil)` når det vågne ord høres, så 'earBoostActive=true', mens påstanden fanges. Ører skalere op (1,9x), få cirkulære ørehuller for læsbarhed, derefter falde via `stopVoiceEars()` efter 1s stilhed. Kun affyret fra stemmepipelinen i appen.
- **Arbejde (agent, der kører):** `AppState.isWorking=true` driver en mikrobevægelse med ”hale/ben-scurry” : hurtigere benswiggle og let forskudt, mens arbejdet er under flyvning. I øjeblikket skiftet rundt WebChat agent kører; tilføje det samme skifte rundt andre lange opgaver, når du wire dem.

Tilslutningspunkter

- Voice wake: runtime/tester kalder `AppState.triggerVoiceEars(ttl: nil)` ved trigger og `stopVoiceEars()` efter 1 s stilhed for at matche optagevinduet.
- Agent aktivitet: sæt `AppStateStore.shared.setWorking(true/false)` omkring arbejde spænder (allerede gjort i WebChat agent opkald). Hold spænder korte og nulstille i `defer`-blokke for at undgå hængende animationer.

Former & størrelser

- Basisikonet er tegnet i `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Øreskalaen er som standard `1.0`; voice-boost sætter `earScale=1.9` og toggler `earHoles=true` uden at ændre den samlede ramme (18×18 pt skabelonbillede renderet til et 36×36 px Retina backing store).
- Løb bruger benvrik op til ~1,0 med en lille horisontal jiggle; den er additiv til enhver eksisterende idle-vrik.

Adfærdsmæssige noter

- Ingen ekstern CLI/broker-toggle for ører/arbejde; hold det internt til appens egne signaler for at undgå utilsigtet flagren.
- Hold TTL’er korte (&lt;10 s), så ikonet hurtigt vender tilbage til baseline, hvis et job hænger.
