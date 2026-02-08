---
summary: "Livscykel för röstöverlägg när väckningsord och push-to-talk överlappar"
read_when:
  - Justerar beteendet för röstöverlägg
title: "Röstöverlägg"
x-i18n:
  source_path: platforms/mac/voice-overlay.md
  source_hash: 5d32704c412295c2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:07Z
---

# Livscykel för röstöverlägg (macOS)

Målgrupp: macOS-appbidragsgivare. Mål: hålla röstöverlägget förutsägbart när väckningsord och push-to-talk överlappar.

## Nuvarande avsikt

- Om överlägget redan är synligt från väckningsord och användaren trycker på snabbtangenten, _tar_ snabbtangent-sessionen över den befintliga texten i stället för att nollställa den. Överlägget förblir synligt medan snabbtangenten hålls nere. När användaren släpper: skicka om det finns trimmad text, annars stäng.
- Enbart väckningsord skickar fortfarande automatiskt vid tystnad; push-to-talk skickar omedelbart vid släpp.

## Implementerat (9 dec 2025)

- Överläggssessioner bär nu en token per inspelning (väckningsord eller push-to-talk). Uppdateringar för partial/final/send/dismiss/level släpps när token inte matchar, vilket undviker inaktuella callbacks.
- Push-to-talk tar över all synlig överläggstext som prefix (så att trycka på snabbtangenten medan väckningsöverlägget är uppe behåller texten och lägger till nytt tal). Den väntar upp till 1,5 s på ett slutligt transkript innan den faller tillbaka till aktuell text.
- Loggning för chime/överlägg emitteras vid `info` i kategorierna `voicewake.overlay`, `voicewake.ptt` och `voicewake.chime` (sessionsstart, partial, final, send, dismiss, chime-anledning).

## Nästa steg

1. **VoiceSessionCoordinator (actor)**
   - Äger exakt en `VoiceSession` åt gången.
   - API (tokenbaserat): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Släpper callbacks som bär inaktuella token (förhindrar att gamla igenkännare öppnar överlägget igen).
2. **VoiceSession (modell)**
   - Fält: `token`, `source` (wakeWord|pushToTalk), committed/volatile text, chime-flaggor, timers (autosändning, inaktiv), `overlayMode` (display|editing|sending), cooldown-deadline.
3. **Överläggsbindning**
   - `VoiceSessionPublisher` (`ObservableObject`) speglar den aktiva sessionen till SwiftUI.
   - `VoiceWakeOverlayView` renderar endast via publiceraren; den muterar aldrig globala singletoner direkt.
   - Användaråtgärder i överlägget (`sendNow`, `dismiss`, `edit`) anropar koordinatorn med sessionstoken.
4. **Enhetlig sändningsväg**
   - Vid `endCapture`: om trimmad text är tom → stäng; annars `performSend(session:)` (spelar sändningschime en gång, vidarebefordrar, stänger).
   - Push-to-talk: ingen fördröjning; väckningsord: valfri fördröjning för autosändning.
   - Tillämpa en kort cooldown på wake-körningen efter att push-to-talk avslutas så att väckningsord inte omedelbart triggar igen.
5. **Loggning**
   - Koordinatorn emitterar `.info`-loggar i subsystem `bot.molt`, kategorierna `voicewake.overlay` och `voicewake.chime`.
   - Nyckelhändelser: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Felsökningschecklista

- Strömma loggar medan du återskapar ett klibbigt överlägg:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verifiera att endast en aktiv sessionstoken finns; inaktuella callbacks ska släppas av koordinatorn.
- Säkerställ att släpp av push-to-talk alltid anropar `endCapture` med den aktiva token; om texten är tom, förvänta `dismiss` utan chime eller sändning.

## Migreringssteg (föreslaget)

1. Lägg till `VoiceSessionCoordinator`, `VoiceSession` och `VoiceSessionPublisher`.
2. Refaktorera `VoiceWakeRuntime` så att sessioner skapas/uppdateras/avslutas i stället för att röra `VoiceWakeOverlayController` direkt.
3. Refaktorera `VoicePushToTalk` för att ta över befintliga sessioner och anropa `endCapture` vid släpp; tillämpa runtime-cooldown.
4. Koppla `VoiceWakeOverlayController` till publiceraren; ta bort direkta anrop från runtime/PTT.
5. Lägg till integrationstester för session-övertagande, cooldown och avstängning vid tom text.
