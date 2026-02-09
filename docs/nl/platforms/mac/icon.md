---
summary: "Menubalkpictogramtoestanden en animaties voor OpenClaw op macOS"
read_when:
  - Wijzigen van het gedrag van het menubalkpictogram
title: "Menubalkpictogram"
---

# Menubalkpictogramtoestanden

Auteur: steipete · Bijgewerkt: 2025-12-06 · Reikwijdte: macOS-app (`apps/macos`)

- **Inactief:** Normale pictogramanimatie (knipperen, af en toe wiebelen).
- **Gepauzeerd:** Statusitem gebruikt `appearsDisabled`; geen beweging.
- **Spraaktrigger (grote oren):** De spraak-wekdetector roept `AppState.triggerVoiceEars(ttl: nil)` aan wanneer het wekwoord wordt gehoord, en behoudt `earBoostActive=true` terwijl de uiting wordt vastgelegd. Oren schalen omhoog (1,9×), krijgen ronde oorgaten voor leesbaarheid en zakken vervolgens via `stopVoiceEars()` na 1 s stilte. Alleen geactiveerd vanuit de in-app spraakpipeline.
- **Werkend (agent actief):** `AppState.isWorking=true` stuurt een microbeweging “staart/pootjes-scharrelen”: snellere pootjeswiebels en een lichte offset terwijl werk bezig is. Momenteel geschakeld rond WebChat-agentuitvoeringen; voeg dezelfde schakel toe rond andere langdurige taken wanneer je die aansluit.

Aansluitpunten

- Spraakwekker: runtime/tester roept `AppState.triggerVoiceEars(ttl: nil)` aan bij trigger en `stopVoiceEars()` na 1 s stilte om overeen te komen met het vastlegvenster.
- Agentactiviteit: zet `AppStateStore.shared.setWorking(true/false)` rond werkspannes (al gedaan in de WebChat-agentaanroep). Houd spannes kort en reset in `defer`-blokken om vastlopende animaties te voorkomen.

Vormen & afmetingen

- Basispictogram getekend in `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Oorschaal staat standaard op `1.0`; spraakboost zet `earScale=1.9` en schakelt `earHoles=true` zonder het totale frame te wijzigen (18×18 pt sjabloonafbeelding gerenderd in een 36×36 px Retina-achterliggende buffer).
- Scurry gebruikt beenwiggle tot ~1.0 met een kleine horizontale leg; het is additief aan een bestaande inactieve muziek.

Gedragsnotities

- Geen externe CLI-/broker-schakelaar voor oren/werken; houd dit intern aan de eigen signalen van de app om onbedoeld flapperen te voorkomen.
- Houd TTL’s kort (&lt;10 s) zodat het pictogram snel terugkeert naar de basislijn als een taak vastloopt.
