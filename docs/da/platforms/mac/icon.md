---
summary: "Tilstande og animationer for menulinjeikonet for OpenClaw på macOS"
read_when:
  - Ændring af adfærd for menulinjeikonet
title: "Menulinjeikon"
x-i18n:
  source_path: platforms/mac/icon.md
  source_hash: a67a6e6bbdc2b611
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:26Z
---

# Menulinjeikonets tilstande

Forfatter: steipete · Opdateret: 2025-12-06 · Omfang: macOS-app (`apps/macos`)

- **Idle:** Normal ikonanimation (blink, lejlighedsvis vrik).
- **Paused:** Status-elementet bruger `appearsDisabled`; ingen bevægelse.
- **Voice trigger (big ears):** Voice wake-detektoren kalder `AppState.triggerVoiceEars(ttl: nil)`, når vækkeordet høres, og holder `earBoostActive=true`, mens ytringen optages. Ørerne skaleres op (1,9x), får cirkulære ørehuller for bedre læsbarhed og falder derefter via `stopVoiceEars()` efter 1 s stilhed. Udløses kun fra appens interne voice-pipeline.
- **Working (agent running):** `AppState.isWorking=true` styrer en mikrobevægelse af “hale/ben-løb”: hurtigere benvrik og let forskydning, mens arbejdet er i gang. I øjeblikket slået til omkring WebChat-agentkørsler; tilføj den samme toggle omkring andre langvarige opgaver, når du forbinder dem.

Tilslutningspunkter

- Voice wake: runtime/tester kalder `AppState.triggerVoiceEars(ttl: nil)` ved trigger og `stopVoiceEars()` efter 1 s stilhed for at matche optagevinduet.
- Agentaktivitet: sæt `AppStateStore.shared.setWorking(true/false)` omkring arbejdsintervaller (allerede gjort i WebChat-agentkaldet). Hold intervallerne korte, og nulstil i `defer`-blokke for at undgå fastlåste animationer.

Former & størrelser

- Basisikonet er tegnet i `CritterIconRenderer.makeIcon(blink:legWiggle:earWiggle:earScale:earHoles:)`.
- Øreskalaen er som standard `1.0`; voice-boost sætter `earScale=1.9` og toggler `earHoles=true` uden at ændre den samlede ramme (18×18 pt skabelonbillede renderet til et 36×36 px Retina backing store).
- Løb bruger benvrik op til ~1,0 med en lille horisontal jiggle; den er additiv til enhver eksisterende idle-vrik.

Adfærdsmæssige noter

- Ingen ekstern CLI/broker-toggle for ører/arbejde; hold det internt til appens egne signaler for at undgå utilsigtet flagren.
- Hold TTL’er korte (&lt;10 s), så ikonet hurtigt vender tilbage til baseline, hvis et job hænger.
