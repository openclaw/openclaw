---
summary: "Verschieben (Migrieren) einer OpenClaw-Installation von einer Maschine auf eine andere"
read_when:
  - Sie ziehen OpenClaw auf einen neuen Laptop/Server um
  - Sie möchten Sitzungen, Authentifizierung und Kanal-Logins (WhatsApp usw.) beibehalten
title: "Migrationsleitfaden"
---

# Migration von OpenClaw auf eine neue Maschine

Dieser Leitfaden migriert ein OpenClaw Gateway von einer Maschine auf eine andere **ohne erneutes Onboarding**.

Die Migration ist konzeptionell einfach:

- Kopieren Sie das **State-Verzeichnis** (`$OPENCLAW_STATE_DIR`, Standard: `~/.openclaw/`) — dieses enthält Konfiguration, Authentifizierung, Sitzungen und Kanalzustand.
- Kopieren Sie Ihren **Workspace** (standardmäßig `~/.openclaw/workspace/`) — dieser enthält Ihre Agent-Dateien (Memory, Prompts usw.).

Es gibt jedoch häufige Stolperfallen rund um **Profile**, **Berechtigungen** und **unvollständige Kopien**.

## Bevor Sie beginnen (was Sie migrieren)

### 1. Identifizieren Sie Ihr State-Verzeichnis

Die meisten Installationen verwenden den Standard:

- **State-Verzeichnis:** `~/.openclaw/`

Es kann jedoch abweichen, wenn Sie Folgendes verwenden:

- `--profile <name>` (wird oft zu `~/.openclaw-<profile>/`)
- `OPENCLAW_STATE_DIR=/some/path`

Wenn Sie unsicher sind, führen Sie auf der **alten** Maschine aus:

```bash
openclaw status
```

Achten Sie in der Ausgabe auf Hinweise zu `OPENCLAW_STATE_DIR` / Profil. Wenn Sie mehrere Gateways betreiben, wiederholen Sie dies für jedes Profil.

### 2. Identifizieren Sie Ihren Workspace

Gängige Standards:

- `~/.openclaw/workspace/` (empfohlener Workspace)
- ein benutzerdefinierter Ordner, den Sie erstellt haben

Ihr Workspace ist der Ort, an dem Dateien wie `MEMORY.md`, `USER.md` und `memory/*.md` liegen.

### 3. Verstehen, was Sie beibehalten

Wenn Sie **sowohl** das State-Verzeichnis als auch den Workspace kopieren, behalten Sie:

- Gateway-Konfiguration (`openclaw.json`)
- Auth-Profile / API-Schlüssel / OAuth-Tokens
- Sitzungsverlauf + Agent-Zustand
- Kanalzustand (z. B. WhatsApp-Login/-Sitzung)
- Ihre Workspace-Dateien (Memory, Skills-Notizen usw.)

Wenn Sie **nur** den Workspace kopieren (z. B. per Git), behalten Sie **nicht**:

- Sitzungen
- anmeldedaten
- Kanal-Logins

Diese befinden sich unter `$OPENCLAW_STATE_DIR`.

## Migrationsschritte (empfohlen)

### Schritt 0 — Backup erstellen (alte Maschine)

Stoppen Sie auf der **alten** Maschine zuerst das Gateway, damit sich Dateien während des Kopierens nicht ändern:

```bash
openclaw gateway stop
```

(Optional, aber empfohlen) Archivieren Sie das State-Verzeichnis und den Workspace:

```bash
# Adjust paths if you use a profile or custom locations
cd ~
tar -czf openclaw-state.tgz .openclaw

tar -czf openclaw-workspace.tgz .openclaw/workspace
```

Wenn Sie mehrere Profile/State-Verzeichnisse haben (z. B. `~/.openclaw-main`, `~/.openclaw-work`), archivieren Sie jedes.

### Schritt 1 — OpenClaw auf der neuen Maschine installieren

Installieren Sie auf der **neuen** Maschine die CLI (und ggf. Node):

- Siehe: [Install](/install)

In diesem Stadium ist es in Ordnung, wenn das Onboarding ein frisches `~/.openclaw/` erstellt — Sie überschreiben es im nächsten Schritt.

### Schritt 2 — State-Verzeichnis + Workspace auf die neue Maschine kopieren

Kopieren Sie **beides**:

- `$OPENCLAW_STATE_DIR` (Standard `~/.openclaw/`)
- Ihren Workspace (Standard `~/.openclaw/workspace/`)

Gängige Vorgehensweisen:

- `scp` der Tarballs und entpacken
- `rsync -a` über SSH
- externes Laufwerk

Stellen Sie nach dem Kopieren sicher:

- Versteckte Verzeichnisse wurden einbezogen (z. B. `.openclaw/`)
- Dateibesitz ist korrekt für den Benutzer, der das Gateway ausführt

### Schritt 3 — Doctor ausführen (Migrationen + Service-Reparatur)

Auf der **neuen** Maschine:

```bash
openclaw doctor
```

Doctor ist der „sicher-langweilige“ Befehl. Er repariert Services, wendet Konfigurationsmigrationen an und warnt vor Abweichungen.

Dann:

```bash
openclaw gateway restart
openclaw status
```

## Gemeinsame Fußwaffen (und wie man sie vermeidet)

### Stolperfalle: Profil-/State-Verzeichnis-Mismatch

Wenn Sie das alte Gateway mit einem Profil (oder `OPENCLAW_STATE_DIR`) ausgeführt haben und das neue Gateway ein anderes verwendet, sehen Sie Symptome wie:

- Konfigurationsänderungen greifen nicht
- Kanäle fehlen / sind abgemeldet
- leerer Sitzungsverlauf

Behebung: Führen Sie das Gateway/den Service mit **demselben** migrierten Profil/State-Verzeichnis aus und führen Sie dann erneut aus:

```bash
openclaw doctor
```

### Stolperfalle: Nur `openclaw.json` kopieren

`openclaw.json` reicht nicht aus. Viele Anbieter speichern Zustand unter:

- `$OPENCLAW_STATE_DIR/credentials/`
- `$OPENCLAW_STATE_DIR/agents/<agentId>/...`

Migrieren Sie immer den gesamten Ordner `$OPENCLAW_STATE_DIR`.

### Stolperfalle: Berechtigungen / Eigentümerschaft

Wenn Sie als root kopiert oder Benutzer gewechselt haben, kann das Gateway Anmeldedaten/Sitzungen möglicherweise nicht lesen.

Behebung: Stellen Sie sicher, dass State-Verzeichnis und Workspace dem Benutzer gehören, der das Gateway ausführt.

### Stolperfalle: Migration zwischen Remote-/Local-Modi

- Wenn Ihre UI (WebUI/TUI) auf ein **Remote**-Gateway zeigt, besitzt der Remote-Host den Sitzungspeicher + Workspace.
- Die Migration Ihres Laptops verschiebt nicht den Zustand des Remote-Gateways.

Wenn Sie im Remote-Modus sind, migrieren Sie den **Gateway-Host**.

### Stolperfalle: Geheimnisse in Backups

`$OPENCLAW_STATE_DIR` enthält Geheimnisse (API-Schlüssel, OAuth-Tokens, WhatsApp-Zugangsdaten). Behandeln Sie Backups wie Produktionsgeheimnisse:

- verschlüsselt speichern
- Weitergabe über unsichere Kanäle vermeiden
- Schlüssel rotieren, wenn Sie eine Offenlegung vermuten

## Checkliste zur Verifikation

Bestätigen Sie auf der neuen Maschine:

- `openclaw status` zeigt, dass das Gateway läuft
- Ihre Kanäle sind weiterhin verbunden (z. B. erfordert WhatsApp kein erneutes Pairing)
- Das Dashboard öffnet sich und zeigt bestehende Sitzungen
- Ihre Workspace-Dateien (Memory, Konfigurationen) sind vorhanden

## Verwandt

- [Doctor](/gateway/doctor)
- [Gateway-Fehlerbehebung](/gateway/troubleshooting)
- [Wo speichert OpenClaw seine Daten?](/help/faq#where-does-openclaw-store-its-data)
