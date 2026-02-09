---
summary: "Sprachaktivierung und Push-to-Talk-Modi sowie Routing-Details in der mac-App"
read_when:
  - Arbeit an Sprachaktivierungs- oder PTT-Pfaden
title: "Sprachaktivierung"
---

# Sprachaktivierung & Push-to-Talk

## Modi

- **Wake-Word-Modus** (Standard): Ein ständig aktiver Spracherkenner wartet auf Trigger-Tokens (`swabbleTriggerWords`). Bei Erkennung startet er die Aufnahme, zeigt das Overlay mit Teiltranskripten an und sendet nach Stille automatisch.
- **Push-to-Talk (rechte Option gedrückt halten)**: Halten Sie die rechte Option-Taste gedrückt, um sofort aufzunehmen – kein Trigger erforderlich. Das Overlay erscheint während des Haltens; beim Loslassen wird finalisiert und nach einer kurzen Verzögerung weitergeleitet, sodass Sie den Text noch anpassen können.

## Laufzeitverhalten (Wake-Word)

- Der Spracherkenner lebt in `VoiceWakeRuntime`.
- Der Trigger feuert nur, wenn zwischen dem Wake-Word und dem nächsten Wort eine **bedeutende Pause** liegt (~0,55 s Abstand). Overlay/Signalton können bereits bei der Pause starten, noch bevor der Befehl beginnt.
- Stillefenster: 2,0 s bei fließender Sprache, 5,0 s, wenn nur der Trigger gehört wurde.
- Harte Begrenzung: 120 s, um ausufernde Sitzungen zu verhindern.
- Entprellung zwischen Sitzungen: 350 ms.
- Das Overlay wird über `VoiceWakeOverlayController` mit Farbgebung für bestätigte/volatile Inhalte gesteuert.
- Nach dem Senden startet der Erkenner sauber neu, um auf den nächsten Trigger zu lauschen.

## Lebenszyklus-Invarianten

- Wenn Sprachaktivierung aktiviert ist und Berechtigungen erteilt sind, sollte der Wake-Word-Erkenner lauschen (außer während einer expliziten Push-to-Talk-Aufnahme).
- Die Sichtbarkeit des Overlays (einschließlich manuellem Schließen über die X-Schaltfläche) darf niemals verhindern, dass der Erkenner wieder startet.

## Sticky-Overlay-Fehlermodus (früher)

Zuvor konnte es passieren, dass bei sichtbar hängen gebliebenem Overlay und manuellem Schließen die Sprachaktivierung „tot“ wirkte, weil der Neustartversuch der Laufzeit durch die Overlay-Sichtbarkeit blockiert wurde und kein weiterer Neustart geplant war.

Härtung:

- Der Neustart der Wake-Laufzeit wird nicht mehr durch die Overlay-Sichtbarkeit blockiert.
- Der Abschluss des Overlay-Schließens triggert ein `VoiceWakeRuntime.refresh(...)` über `VoiceSessionCoordinator`, sodass ein manuelles X-Schließen das Lauschen immer wieder aufnimmt.

## Push-to-Talk-Details

- Die Hotkey-Erkennung verwendet einen globalen `.flagsChanged`-Monitor für **rechte Option** (`keyCode 61` + `.option`). Es werden nur Ereignisse beobachtet (kein Abfangen).
- Die Aufnahme-Pipeline lebt in `VoicePushToTalk`: startet Speech sofort, streamt Teiltranskripte ins Overlay und ruft bei Loslassen `VoiceWakeForwarder` auf.
- Beim Start von Push-to-Talk pausieren wir die Wake-Word-Laufzeit, um konkurrierende Audio-Taps zu vermeiden; sie startet nach dem Loslassen automatisch neu.
- Berechtigungen: Erfordert Mikrofon + Speech; zum Sehen von Ereignissen ist die Freigabe für Bedienungshilfen/Eingabemonitoring nötig.
- Externe Tastaturen: Manche stellen die rechte Option nicht wie erwartet bereit – bieten Sie eine alternative Tastenkombination an, wenn Nutzer Aussetzer melden.

## Nutzerseitige Einstellungen

- **Sprachaktivierung**-Schalter: aktiviert die Wake-Word-Laufzeit.
- **Cmd+Fn gedrückt halten zum Sprechen**: aktiviert den Push-to-Talk-Monitor. Deaktiviert auf macOS < 26.
- Sprach- & Mikrofon-Auswahl, Live-Pegelanzeige, Triggerwort-Tabelle, Tester (nur lokal; leitet nicht weiter).
- Die Mikrofon-Auswahl behält die letzte Auswahl bei, wenn ein Gerät getrennt wird, zeigt einen Hinweis auf die Trennung an und fällt vorübergehend auf den Systemstandard zurück, bis das Gerät wieder verfügbar ist.
- **Sounds**: Signaltöne bei Trigger-Erkennung und beim Senden; Standard ist der macOS-Systemton „Glass“. Sie können für jedes Ereignis eine beliebige `NSSound`-ladbare Datei (z. B. MP3/WAV/AIFF) auswählen oder **Kein Sound** wählen.

## Weiterleitungsverhalten

- Wenn Sprachaktivierung aktiviert ist, werden Transkripte an den aktiven Gateway/Agent weitergeleitet (derselbe lokale vs. Remote-Modus wie im restlichen mac-App).
- Antworten werden an den **zuletzt verwendeten Hauptanbieter** (WhatsApp/Telegram/Discord/WebChat) zugestellt. Schlägt die Zustellung fehl, wird der Fehler protokolliert und der Lauf ist weiterhin über WebChat/Sitzungsprotokolle sichtbar.

## Weiterleitungs-Payload

- `VoiceWakeForwarder.prefixedTranscript(_:)` stellt vor dem Senden den Maschinenhinweis voran. Wird von Wake-Word- und Push-to-Talk-Pfaden gemeinsam genutzt.

## Schnelle Überprüfung

- Push-to-Talk aktivieren, Cmd+Fn gedrückt halten, sprechen, loslassen: Das Overlay sollte Teiltranskripte anzeigen und dann senden.
- Während des Haltens sollten die Menüleisten-Ohren vergrößert bleiben (verwendet `triggerVoiceEars(ttl:nil)`); nach dem Loslassen werden sie wieder kleiner.
