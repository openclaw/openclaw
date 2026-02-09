---
summary: "Menyradsikonens tillstånd och animationer för OpenClaw på macOS"
read_when:
  - Ändra beteende för menyradsikonen
title: "Menyradsikon"
---

# Menyradsikonens tillstånd

Författare: steipete · Uppdaterad: 2025-12-06 · Omfattning: macOS-app (`apps/macos`)

- **Viloläge:** Normal ikonanimation (blinkning, tillfällig vickning).
- **Pausad:** Statusobjektet använder `appearsDisabled`; ingen rörelse.
- **Röstutlösare (stora öron):** Röstvaktsdetektor anropar `AppState.triggerVoiceEars(ttl: nil)` när väckningsordet hörs, behåller `earBoostActive=true` medan uttalandet fångas. Öron skala upp (1,9x), få cirkulära örat hål för läsbarhet, släpp sedan via `stopVoiceEars()` efter 1s tystnad. Endast avfyras från in-app röströrledningen.
- **Arbetar (agent som kört):** `AppState.isWorking=true` kör en ”svans/benskör” mikro-rörelse: snabbare benviggle och liten förskjutning medan arbetet är under flygning. För närvarande växlas runt WebChat agent körs, lägg till samma växla runt andra långa uppgifter när du kopplar dem.

Kopplingspunkter

- Röstväckning: runtime/tester anropar `AppState.triggerVoiceEars(ttl: nil)` vid utlösning och `stopVoiceEars()` efter 1 s tystnad för att matcha inspelningsfönstret.
- Agent aktivitet: sätt `AppStateStore.shared.setWorking(true/false)` runt arbetsspannet (redan gjort i WebChat agentsamtal). Behåll spännvidden kort och återställ i blocken `defer` för att undvika fastnade animationer.

Former och storlekar

- Basikonen ritas i `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Öronskalning är som standard `1.0`; röstförstärkning sätter `earScale=1.9` och växlar `earHoles=true` utan att ändra den övergripande ramen (18×18 pt mallbild renderad till ett 36×36 px Retina‑baklager).
- ”Scurry” använder benvickning upp till ~1,0 med en liten horisontell jiggling; den är additiv till eventuell befintlig vilovickning.

Beteendenoteringar

- Ingen extern CLI-/broker‑växling för öron/arbete; håll det internt till appens egna signaler för att undvika oavsiktligt flaxande.
- Håll TTL:er korta (&lt;10 s) så att ikonen snabbt återgår till basläget om ett jobb hänger sig.
