---
summary: "Menyradsikonens tillstånd och animationer för OpenClaw på macOS"
read_when:
  - Ändra beteende för menyradsikonen
title: "Menyradsikon"
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:58Z
---

# Menyradsikonens tillstånd

Författare: steipete · Uppdaterad: 2025-12-06 · Omfattning: macOS-app (`apps/macos`)

- **Viloläge:** Normal ikonanimation (blinkning, tillfällig vickning).
- **Pausad:** Statusobjektet använder `appearsDisabled`; ingen rörelse.
- **Röstutlösare (stora öron):** Röstväckningsdetektorn anropar `AppState.triggerVoiceEars(ttl: nil)` när väckningsordet hörs och behåller `earBoostActive=true` medan yttrandet fångas. Öronen skalas upp (1,9×), får cirkulära öronhål för läsbarhet och faller sedan via `stopVoiceEars()` efter 1 s tystnad. Utlöses endast från den interna röstpipen i appen.
- **Arbetar (agent körs):** `AppState.isWorking=true` driver en mikrorörelse av ”svans/ben‑sprattel”: snabbare benvickning och liten förskjutning medan arbete pågår. Växlas för närvarande runt WebChat‑agentkörningar; lägg till samma växling runt andra långvariga uppgifter när du kopplar in dem.

Kopplingspunkter

- Röstväckning: runtime/tester anropar `AppState.triggerVoiceEars(ttl: nil)` vid utlösning och `stopVoiceEars()` efter 1 s tystnad för att matcha inspelningsfönstret.
- Agentaktivitet: sätt `AppStateStore.shared.setWorking(true/false)` runt arbetsspann (redan gjort i WebChat‑agentanropet). Håll spann korta och återställ i `defer`‑block för att undvika fastnade animationer.

Former och storlekar

- Basikonen ritas i `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Öronskalning är som standard `1.0`; röstförstärkning sätter `earScale=1.9` och växlar `earHoles=true` utan att ändra den övergripande ramen (18×18 pt mallbild renderad till ett 36×36 px Retina‑baklager).
- ”Scurry” använder benvickning upp till ~1,0 med en liten horisontell jiggling; den är additiv till eventuell befintlig vilovickning.

Beteendenoteringar

- Ingen extern CLI-/broker‑växling för öron/arbete; håll det internt till appens egna signaler för att undvika oavsiktligt flaxande.
- Håll TTL:er korta (&lt;10 s) så att ikonen snabbt återgår till basläget om ett jobb hänger sig.
