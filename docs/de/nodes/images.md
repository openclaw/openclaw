---
summary: "„Regeln zur Bild- und Medienverarbeitung für Sendungen, Gateway- und Agent-Antworten“"
read_when:
  - Änderung der Medien-Pipeline oder von Anhängen
title: "„Bild- und Medienunterstützung“"
---

# Bild- & Medienunterstützung — 2025-12-05

Der WhatsApp-Kanal läuft über **Baileys Web**. Dieses Dokument beschreibt die aktuellen Regeln zur Medienverarbeitung für Sendungen, Gateway- und Agent-Antworten.

## Ziele

- Medien mit optionalen Beschriftungen über `openclaw message send --media` senden.
- Automatische Antworten aus dem Web-Posteingang sollen Medien neben Text enthalten können.
- Sinnvolle und vorhersehbare Limits pro Typ beibehalten.

## CLI-Oberfläche

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` optional; die Beschriftung kann für reine Medien-Sendungen leer sein.
  - `--dry-run` gibt die aufgelöste Payload aus; `--json` erzeugt `{ channel, to, messageId, mediaUrl, caption }`.

## Verhalten des WhatsApp-Web-Kanals

- Eingabe: lokaler Dateipfad **oder** HTTP(S)-URL.
- Ablauf: Laden in einen Buffer, Erkennen des Medientyps und Erstellen der korrekten Payload:
  - **Bilder:** Größenänderung & erneute JPEG-Komprimierung (max. Seite 2048 px) mit Zielgröße `agents.defaults.mediaMaxMb` (Standard 5 MB), begrenzt auf 6 MB.
  - **Audio/Voice/Video:** Durchreichen bis 16 MB; Audio wird als Sprachnachricht gesendet (`ptt: true`).
  - **Dokumente:** alles andere, bis 100 MB, mit beibehaltenem Dateinamen, sofern verfügbar.
- WhatsApp-GIF-ähnliche Wiedergabe: Senden eines MP4 mit `gifPlayback: true` (CLI: `--gif-playback`), sodass mobile Clients inline loopen.
- MIME-Erkennung bevorzugt Magic Bytes, dann Header, dann Dateiendung.
- Die Beschriftung stammt aus `--message` oder `reply.text`; eine leere Beschriftung ist zulässig.
- Logging: nicht-verbose zeigt `↩️`/`✅`; verbose enthält Größe und Quellpfad/URL.

## Auto-Reply-Pipeline

- `getReplyFromConfig` gibt `{ text?, mediaUrl?, mediaUrls? }` zurück.
- Wenn Medien vorhanden sind, löst der Web-Sender lokale Pfade oder URLs über dieselbe Pipeline wie `openclaw message send` auf.
- Mehrere Medieneinträge werden, falls angegeben, sequenziell gesendet.

## Eingehende Medien zu Befehlen (Pi)

- Wenn eingehende Web-Nachrichten Medien enthalten, lädt OpenClaw diese in eine temporäre Datei herunter und stellt Template-Variablen bereit:
  - `{{MediaUrl}}` Pseudo-URL für das eingehende Medium.
  - `{{MediaPath}}` lokaler temporärer Pfad, der vor dem Ausführen des Befehls geschrieben wird.
- Wenn eine Docker-Sandbox pro Sitzung aktiviert ist, werden eingehende Medien in den Workspace der Sandbox kopiert und `MediaPath`/`MediaUrl` auf einen relativen Pfad wie `media/inbound/<filename>` umgeschrieben.
- Medienverständnis (falls konfiguriert über `tools.media.*` oder gemeinsam genutztes `tools.media.models`) läuft vor dem Templating und kann `[Image]`-, `[Audio]`- und `[Video]`-Blöcke in `Body` einfügen.
  - Audio setzt `{{Transcript}}` und verwendet das Transkript für das Parsen von Befehlen, sodass Slash-Befehle weiterhin funktionieren.
  - Video- und Bildbeschreibungen behalten vorhandenen Beschriftungstext für das Parsen von Befehlen bei.
- Standardmäßig wird nur der erste passende Bild-/Audio-/Video-Anhang verarbeitet; setzen Sie `tools.media.<cap>.attachments`, um mehrere Anhänge zu verarbeiten.

## Limits & Fehler

**Outbound-Sendelimits (WhatsApp-Web-Senden)**

- Bilder: ~6 MB Limit nach erneuter Komprimierung.
- Audio/Voice/Video: 16 MB Limit; Dokumente: 100 MB Limit.
- Zu große oder nicht lesbare Medien → klarer Fehler im Log und die Antwort wird übersprungen.

**Limits für Medienverständnis (Transkription/Beschreibung)**

- Bild-Standard: 10 MB (`tools.media.image.maxBytes`).
- Audio-Standard: 20 MB (`tools.media.audio.maxBytes`).
- Video-Standard: 50 MB (`tools.media.video.maxBytes`).
- Zu große Medien überspringen das Verständnis, Antworten werden jedoch weiterhin mit dem ursprünglichen Inhalt gesendet.

## Hinweise für Tests

- Sende- und Antwortflüsse für Bild-/Audio-/Dokumentfälle abdecken.
- Erneute Komprimierung für Bilder (Größenbegrenzung) und Sprachnotiz-Flag für Audio validieren.
- Sicherstellen, dass Antworten mit mehreren Medien als sequenzielle Sendungen aufgefächert werden.
