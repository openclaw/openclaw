---
summary: "Kameraaufnahme (iOS-Node + macOS-App) für die Agentennutzung: Fotos (jpg) und kurze Videoclips (mp4)"
read_when:
  - Hinzufügen oder Ändern der Kameraaufnahme auf iOS-Nodes oder macOS
  - Erweitern agentenzugänglicher MEDIA-Temporärdatei-Workflows
title: "Kameraaufnahme"
---

# Kameraaufnahme (Agent)

OpenClaw unterstützt **Kameraaufnahmen** für Agenten-Workflows:

- **iOS-Node** (über Gateway gekoppelt): Aufnahme eines **Fotos** (`jpg`) oder eines **kurzen Videoclips** (`mp4`, optional mit Audio) über `node.invoke`.
- **Android-Node** (über Gateway gekoppelt): Aufnahme eines **Fotos** (`jpg`) oder eines **kurzen Videoclips** (`mp4`, optional mit Audio) über `node.invoke`.
- **macOS-App** (Node über Gateway): Aufnahme eines **Fotos** (`jpg`) oder eines **kurzen Videoclips** (`mp4`, optional mit Audio) über `node.invoke`.

Der gesamte Kamerazugriff ist durch **benutzerkontrollierte Einstellungen** abgesichert.

## iOS-Node

### Benutzereinstellung (standardmäßig an)

- iOS-Einstellungs-Tab → **Kamera** → **Kamera erlauben** (`camera.enabled`)
  - Standard: **an** (fehlender Schlüssel gilt als aktiviert).
  - Wenn aus: `camera.*`-Befehle geben `CAMERA_DISABLED` zurück.

### Befehle (über Gateway `node.invoke`)

- `camera.list`
  - Antwort-Payload:
    - `devices`: Array von `{ id, name, position, deviceType }`

- `camera.snap`
  - Parameter:
    - `facing`: `front|back` (Standard: `front`)
    - `maxWidth`: number (optional; Standard `1600` auf dem iOS-Node)
    - `quality`: `0..1` (optional; Standard `0.9`)
    - `format`: derzeit `jpg`
    - `delayMs`: number (optional; Standard `0`)
    - `deviceId`: string (optional; aus `camera.list`)
  - Antwort-Payload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Payload-Schutz: Fotos werden neu komprimiert, um das Base64-Payload unter 5 MB zu halten.

- `camera.clip`
  - Parameter:
    - `facing`: `front|back` (Standard: `front`)
    - `durationMs`: number (Standard `3000`, begrenzt auf maximal `60000`)
    - `includeAudio`: boolean (Standard `true`)
    - `format`: derzeit `mp4`
    - `deviceId`: string (optional; aus `camera.list`)
  - Antwort-Payload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Vordergrundanforderung

Wie `canvas.*` erlaubt der iOS-Node `camera.*`-Befehle nur im **Vordergrund**. Aufrufe im Hintergrund geben `NODE_BACKGROUND_UNAVAILABLE` zurück.

### CLI-Helfer (Temporärdateien + MEDIA)

Der einfachste Weg, Anhänge zu erhalten, ist über den CLI-Helfer, der dekodierte Medien in eine Temporärdatei schreibt und `MEDIA:<path>` ausgibt.

Beispiele:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

Hinweise:

- `nodes camera snap` ist standardmäßig **beide** Ausrichtungen, um dem Agenten beide Ansichten zu geben.
- Ausgabedateien sind temporär (im OS-Temp-Verzeichnis), sofern Sie keinen eigenen Wrapper erstellen.

## Android-Node

### Android-Benutzereinstellung (standardmäßig an)

- Android-Einstellungsblatt → **Kamera** → **Kamera erlauben** (`camera.enabled`)
  - Standard: **an** (fehlender Schlüssel gilt als aktiviert).
  - Wenn aus: `camera.*`-Befehle geben `CAMERA_DISABLED` zurück.

### Berechtigungen

- Android erfordert Laufzeitberechtigungen:
  - `CAMERA` für sowohl `camera.snap` als auch `camera.clip`.
  - `RECORD_AUDIO` für `camera.clip`, wenn `includeAudio=true`.

Wenn Berechtigungen fehlen, fordert die App diese nach Möglichkeit an; bei Ablehnung schlagen `camera.*`-Anfragen mit einem
`*_PERMISSION_REQUIRED`-Fehler fehl.

### Android-Vordergrundanforderung

Wie `canvas.*` erlaubt der Android-Node `camera.*`-Befehle nur im **Vordergrund**. Aufrufe im Hintergrund geben `NODE_BACKGROUND_UNAVAILABLE` zurück.

### Payload-Schutz

Fotos werden neu komprimiert, um das Base64-Payload unter 5 MB zu halten.

## macOS-App

### Benutzereinstellung (standardmäßig aus)

Die macOS-Companion-App stellt ein Kontrollkästchen bereit:

- **Einstellungen → Allgemein → Kamera erlauben** (`openclaw.cameraEnabled`)
  - Standard: **aus**
  - Wenn aus: Kameraanfragen geben „Camera disabled by user“ zurück.

### CLI-Helfer (Node-Aufruf)

Verwenden Sie die Haupt-CLI `openclaw`, um Kamerabefehle auf dem macOS-Node aufzurufen.

Beispiele:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

Hinweise:

- `openclaw nodes camera snap` ist standardmäßig `maxWidth=1600`, sofern nicht überschrieben.
- Unter macOS wartet `camera.snap` nach dem Warm-up/Abklingen der Belichtung `delayMs` (Standard 2000 ms), bevor aufgenommen wird.
- Foto-Payloads werden neu komprimiert, um Base64 unter 5 MB zu halten.

## Sicherheit + praktische Grenzen

- Kamera- und Mikrofonzugriff lösen die üblichen Betriebssystem-Berechtigungsabfragen aus (und erfordern Usage-Strings in der Info.plist).
- Videoclips sind begrenzt (derzeit `<= 60s`), um übergroße Node-Payloads zu vermeiden (Base64-Overhead + Nachrichtenlimits).

## macOS-Bildschirmvideo (auf Betriebssystemebene)

Für _Bildschirm_-Video (nicht Kamera) verwenden Sie die macOS-Companion-App:

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

Hinweise:

- Erfordert die macOS-Berechtigung **Screen Recording** (TCC).
