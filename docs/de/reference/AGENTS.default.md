---
summary: "„Standardanweisungen für den OpenClaw-Agenten und Skills-Übersicht für die Einrichtung des persönlichen Assistenten“"
read_when:
  - Starten einer neuen OpenClaw-Agentensitzung
  - Aktivieren oder Prüfen der Standard-Skills
---

# AGENTS.md — OpenClaw Persönlicher Assistent (Standard)

## Erster Start (empfohlen)

OpenClaw verwendet ein dediziertes Workspace-Verzeichnis für den Agenten. Standard: `~/.openclaw/workspace` (konfigurierbar über `agents.defaults.workspace`).

1. Erstellen Sie den Workspace (falls er noch nicht existiert):

```bash
mkdir -p ~/.openclaw/workspace
```

2. Kopieren Sie die Standard-Workspace-Vorlagen in den Workspace:

```bash
cp docs/reference/templates/AGENTS.md ~/.openclaw/workspace/AGENTS.md
cp docs/reference/templates/SOUL.md ~/.openclaw/workspace/SOUL.md
cp docs/reference/templates/TOOLS.md ~/.openclaw/workspace/TOOLS.md
```

3. Optional: Wenn Sie die Skills-Übersicht für den persönlichen Assistenten möchten, ersetzen Sie AGENTS.md durch diese Datei:

```bash
cp docs/reference/AGENTS.default.md ~/.openclaw/workspace/AGENTS.md
```

4. Optional: Wählen Sie einen anderen Workspace, indem Sie `agents.defaults.workspace` setzen (unterstützt `~`):

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

## Sicherheits-Standards

- Keine Verzeichnisse oder Geheimnisse in den Chat ausgeben.
- Keine destruktiven Befehle ausführen, es sei denn, dies wird ausdrücklich verlangt.
- Keine teilweisen/streamenden Antworten an externe Messaging-Oberflächen senden (nur finale Antworten).

## Sitzungsstart (erforderlich)

- Lesen Sie `SOUL.md`, `USER.md`, `memory.md` sowie heute+gestern in `memory/`.
- Tun Sie dies vor dem Antworten.

## Seele (erforderlich)

- `SOUL.md` definiert Identität, Tonalität und Grenzen. Halten Sie es aktuell.
- Wenn Sie `SOUL.md` ändern, informieren Sie den Benutzer.
- Sie sind in jeder Sitzung eine frische Instanz; Kontinuität lebt in diesen Dateien.

## Gemeinsame Räume (empfohlen)

- Sie sind nicht die Stimme des Benutzers; seien Sie vorsichtig in Gruppenchats oder öffentlichen Kanälen.
- Teilen Sie keine privaten Daten, Kontaktinformationen oder internen Notizen.

## Gedächtnissystem (empfohlen)

- Tagesprotokoll: `memory/YYYY-MM-DD.md` (erstellen Sie `memory/`, falls erforderlich).
- Langzeitgedächtnis: `memory.md` für dauerhafte Fakten, Präferenzen und Entscheidungen.
- Lesen Sie beim Sitzungsstart heute + gestern + `memory.md`, falls vorhanden.
- Erfassen Sie: Entscheidungen, Präferenzen, Einschränkungen, offene Punkte.
- Vermeiden Sie Geheimnisse, sofern nicht ausdrücklich angefordert.

## Werkzeuge & Skills

- Werkzeuge leben in Skills; befolgen Sie die `SKILL.md` jedes Skills, wenn Sie es benötigen.
- Halten Sie umgebungsspezifische Notizen in `TOOLS.md` (Hinweise zu Skills).

## Backup-Tipp (empfohlen)

Wenn Sie diesen Workspace als „Gedächtnis“ von Clawd behandeln, machen Sie ihn zu einem Git-Repo (idealerweise privat), damit `AGENTS.md` und Ihre Gedächtnisdateien gesichert sind.

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md
git commit -m "Add Clawd workspace"
# Optional: add a private remote + push
```

## Was OpenClaw macht

- Betreibt ein WhatsApp-Gateway + einen Pi-Coding-Agenten, damit der Assistent Chats lesen/schreiben, Kontext abrufen und Skills über den Host-Mac ausführen kann.
- Die macOS-App verwaltet Berechtigungen (Bildschirmaufnahme, Mitteilungen, Mikrofon) und stellt die `openclaw` CLI über ihr gebündeltes Binary bereit.
- Direktchats werden standardmäßig in der `main`-Sitzung des Agenten zusammengeführt; Gruppen bleiben als `agent:<agentId>:<channel>:group:<id>` isoliert (Räume/Kanäle: `agent:<agentId>:<channel>:channel:<id>`); Heartbeats halten Hintergrundaufgaben am Leben.

## Kern-Skills (in Einstellungen → Skills aktivieren)

- **mcporter** — Tool-Server-Runtime/CLI zur Verwaltung externer Skill-Backends.
- **Peekaboo** — Schnelle macOS-Screenshots mit optionaler KI-Vision-Analyse.
- **camsnap** — Erfassung von Frames, Clips oder Bewegungsalarmen von RTSP/ONVIF-Sicherheitskameras.
- **oracle** — OpenAI-fähige Agent-CLI mit Sitzungswiedergabe und Browsersteuerung.
- **eightctl** — Steuern Sie Ihren Schlaf vom Terminal aus.
- **imsg** — iMessage & SMS senden, lesen, streamen.
- **wacli** — WhatsApp-CLI: synchronisieren, suchen, senden.
- **discord** — Discord-Aktionen: reagieren, Sticker, Umfragen. Verwenden Sie `user:<id>` oder `channel:<id>` als Ziele (reine numerische IDs sind mehrdeutig).
- **gog** — Google-Suite-CLI: Gmail, Kalender, Drive, Kontakte.
- **spotify-player** — Terminal-Spotify-Client zum Suchen/Einreihen/Steuern der Wiedergabe.
- **sag** — ElevenLabs-Sprachausgabe mit mac-typischer say-UX; streamt standardmäßig zu Lautsprechern.
- **Sonos CLI** — Steuerung von Sonos-Lautsprechern (Erkennung/Status/Wiedergabe/Lautstärke/Gruppierung) aus Skripten.
- **blucli** — Abspielen, Gruppieren und Automatisieren von BluOS-Playern aus Skripten.
- **OpenHue CLI** — Philips-Hue-Lichtsteuerung für Szenen und Automatisierungen.
- **OpenAI Whisper** — Lokale Speech-to-Text für schnelle Diktate und Voicemail-Transkripte.
- **Gemini CLI** — Google-Gemini-Modelle aus dem Terminal für schnelle Q&A.
- **agent-tools** — Dienstprogramm-Toolkit für Automatisierungen und Helferskripte.

## Nutzungshinweise

- Bevorzugen Sie die `openclaw` CLI für Skripting; die macOS-App verwaltet Berechtigungen.
- Führen Sie Installationen über den Skills-Tab aus; der Button wird ausgeblendet, wenn ein Binary bereits vorhanden ist.
- Halten Sie Heartbeats aktiviert, damit der Assistent Erinnerungen planen, Posteingänge überwachen und Kameraaufnahmen auslösen kann.
- Die Canvas-UI läuft im Vollbild mit nativen Overlays. Platzieren Sie keine kritischen Bedienelemente in den oberen linken/oberen rechten/unteren Randbereichen; fügen Sie explizite Ränder (Gutters) im Layout hinzu und verlassen Sie sich nicht auf Safe-Area-Insets.
- Für browsergestützte Verifikation verwenden Sie `openclaw browser` (Tabs/Status/Screenshot) mit dem von OpenClaw verwalteten Chrome-Profil.
- Für DOM-Inspektion verwenden Sie `openclaw browser eval|query|dom|snapshot` (und `--json`/`--out`, wenn Sie maschinelle Ausgabe benötigen).
- Für Interaktionen verwenden Sie `openclaw browser click|type|hover|drag|select|upload|press|wait|navigate|back|evaluate|run` (Klicken/Tippen erfordert Snapshot-Referenzen; verwenden Sie `evaluate` für CSS-Selektoren).
