---
summary: "„Lebenszyklus des Voice-Overlays, wenn Wake-Word und Push-to-Talk überlappen“"
read_when:
  - Anpassen des Voice-Overlay-Verhaltens
title: "„Voice Overlay“"
---

# Voice-Overlay-Lebenszyklus (macOS)

Zielgruppe: Mitwirkende an der macOS-App. Ziel: Das Voice-Overlay vorhersehbar halten, wenn Wake-Word und Push-to-Talk überlappen.

## Aktuelle Intention

- Wenn das Overlay bereits durch das Wake-Word sichtbar ist und der Benutzer die Hotkey-Taste drückt, _übernimmt_ die Hotkey-Sitzung den vorhandenen Text, anstatt ihn zurückzusetzen. Das Overlay bleibt sichtbar, solange der Hotkey gehalten wird. Beim Loslassen: Senden, wenn es getrimmten Text gibt, andernfalls verwerfen.
- Wake-Word allein sendet weiterhin automatisch bei Stille; Push-to-Talk sendet sofort beim Loslassen.

## Implementiert (9. Dez. 2025)

- Overlay-Sitzungen tragen nun pro Aufnahme (Wake-Word oder Push-to-Talk) ein Token. Partial-/Final-/Send-/Dismiss-/Level-Updates werden verworfen, wenn das Token nicht übereinstimmt, wodurch veraltete Callbacks vermieden werden.
- Push-to-Talk übernimmt jeden sichtbaren Overlay-Text als Präfix (sodass das Drücken des Hotkeys, während das Wake-Overlay aktiv ist, den Text beibehält und neue Sprache anhängt). Es wartet bis zu 1,5 s auf ein finales Transkript, bevor auf den aktuellen Text zurückgegriffen wird.
- Chime-/Overlay-Logging wird bei `info` in den Kategorien `voicewake.overlay`, `voicewake.ptt` und `voicewake.chime` ausgegeben (Sitzungsstart, Partial, Final, Senden, Verwerfen, Chime-Grund).

## Nächste Schritte

1. **VoiceSessionCoordinator (Actor)**
   - Besitzt zu jedem Zeitpunkt genau eine `VoiceSession`.
   - API (tokenbasiert): `beginWakeCapture`, `beginPushToTalk`, `updatePartial`, `endCapture`, `cancel`, `applyCooldown`.
   - Verwirft Callbacks mit veralteten Tokens (verhindert, dass alte Recognizer das Overlay erneut öffnen).
2. **VoiceSession (Modell)**
   - Felder: `token`, `source` (wakeWord|pushToTalk), committeter/volatiler Text, Chime-Flags, Timer (Auto-Senden, Idle), `overlayMode` (display|editing|sending), Cooldown-Deadline.
3. **Overlay-Bindung**
   - `VoiceSessionPublisher` (`ObservableObject`) spiegelt die aktive Sitzung in SwiftUI.
   - `VoiceWakeOverlayView` rendert ausschließlich über den Publisher; es mutiert niemals direkt globale Singletons.
   - Overlay-Benutzeraktionen (`sendNow`, `dismiss`, `edit`) rufen den Coordinator mit dem Sitzungs-Token zurück.
4. **Vereinheitlichter Sendepfad**
   - Bei `endCapture`: Wenn getrimmter Text leer ist → verwerfen; andernfalls `performSend(session:)` (spielt den Sende-Chime einmal ab, leitet weiter, verwirft).
   - Push-to-Talk: keine Verzögerung; Wake-Word: optionale Verzögerung für Auto-Senden.
   - Wenden Sie nach Abschluss von Push-to-Talk einen kurzen Cooldown auf die Wake-Laufzeit an, damit das Wake-Word nicht sofort erneut auslöst.
5. **Logging**
   - Der Coordinator gibt `.info`-Logs im Subsystem `bot.molt` in den Kategorien `voicewake.overlay` und `voicewake.chime` aus.
   - Schlüsselereignisse: `session_started`, `adopted_by_push_to_talk`, `partial`, `finalized`, `send`, `dismiss`, `cancel`, `cooldown`.

## Debugging-Checkliste

- Streamen Sie Logs, während Sie ein „klebendes“ Overlay reproduzieren:

  ```bash
  sudo log stream --predicate 'subsystem == "bot.molt" AND category CONTAINS "voicewake"' --level info --style compact
  ```

- Verifizieren Sie, dass nur ein aktives Sitzungs-Token existiert; veraltete Callbacks sollten vom Coordinator verworfen werden.

- Stellen Sie sicher, dass das Loslassen von Push-to-Talk immer `endCapture` mit dem aktiven Token aufruft; wenn der Text leer ist, erwarten Sie `dismiss` ohne Chime oder Senden.

## Migrationsschritte (empfohlen)

1. Fügen Sie `VoiceSessionCoordinator`, `VoiceSession` und `VoiceSessionPublisher` hinzu.
2. Refaktorieren Sie `VoiceWakeRuntime`, um Sitzungen zu erstellen/aktualisieren/beenden, anstatt `VoiceWakeOverlayController` direkt zu verändern.
3. Refaktorieren Sie `VoicePushToTalk`, um bestehende Sitzungen zu übernehmen und beim Loslassen `endCapture` aufzurufen; wenden Sie einen Laufzeit-Cooldown an.
4. Verdrahten Sie `VoiceWakeOverlayController` mit dem Publisher; entfernen Sie direkte Aufrufe aus Runtime/PTT.
5. Fügen Sie Integrationstests für Sitzungsübernahme, Cooldown und Verwerfen bei leerem Text hinzu.
