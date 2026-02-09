---
summary: "Agent-Workspace: Speicherort, Layout und Backup-Strategie"
read_when:
  - Sie müssen den Agent-Workspace oder dessen Dateistruktur erklären
  - Sie möchten einen Agent-Workspace sichern oder migrieren
title: "Agent-Workspace"
---

# Agent-Workspace

Der Workspace ist das Zuhause des Agenten. Er ist das einzige Arbeitsverzeichnis, das für
Dateiwerkzeuge und für den Workspace-Kontext verwendet wird. Halten Sie ihn privat und
behandeln Sie ihn wie Gedächtnis.

Dies ist getrennt von `~/.openclaw/`, das Konfiguration, Anmeldedaten und
Sitzungen speichert.

**Wichtig:** Der Workspace ist das **Standard-cwd**, keine harte Sandbox. Werkzeuge
lösen relative Pfade gegen den Workspace auf, aber absolute Pfade können weiterhin
andere Bereiche auf dem Host erreichen, sofern Sandboxing nicht aktiviert ist. Wenn Sie Isolation benötigen, verwenden Sie
[`agents.defaults.sandbox`](/gateway/sandboxing) (und/oder eine agentenspezifische
Sandbox-Konfiguration).
Wenn Sandboxing aktiviert ist und `workspaceAccess` nicht `"rw"` ist,
arbeiten Werkzeuge innerhalb eines Sandbox-Workspace unter `~/.openclaw/sandboxes` und
nicht in Ihrem Host-Workspace.

## Standardspeicherort

- Standard: `~/.openclaw/workspace`
- Wenn `OPENCLAW_PROFILE` gesetzt ist und nicht `"default"`, wird der Standard zu
  `~/.openclaw/workspace-<profile>`.
- Überschreiben in `~/.openclaw/openclaw.json`:

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

`openclaw onboard`, `openclaw configure` oder `openclaw setup` erstellen den Workspace
und legen die Bootstrap-Dateien an, falls sie fehlen.

Wenn Sie die Workspace-Dateien bereits selbst verwalten, können Sie die Erstellung
von Bootstrap-Dateien deaktivieren:

```json5
{ agent: { skipBootstrap: true } }
```

## Zusätzliche Workspace-Ordner

Ältere Installationen haben möglicherweise `~/openclaw` erstellt. Mehrere
Workspace-Verzeichnisse parallel zu behalten, kann zu verwirrender Authentifizierung
oder Zustandsabweichungen führen, da immer nur ein Workspace gleichzeitig aktiv ist.

**Empfehlung:** Halten Sie einen einzigen aktiven Workspace. Wenn Sie die zusätzlichen
Ordner nicht mehr verwenden, archivieren Sie sie oder verschieben Sie sie in den
Papierkorb (zum Beispiel `trash ~/openclaw`).
Wenn Sie bewusst mehrere Workspaces behalten, stellen Sie sicher, dass
`agents.defaults.workspace` auf den aktiven verweist.

`openclaw doctor` warnt, wenn zusätzliche Workspace-Verzeichnisse erkannt werden.

## Workspace-Dateiübersicht (Bedeutung der einzelnen Dateien)

Dies sind die Standarddateien, die OpenClaw innerhalb des Workspace erwartet:

- `AGENTS.md`
  - Betriebsanweisungen für den Agenten und wie er Gedächtnis verwenden soll.
  - Wird zu Beginn jeder Sitzung geladen.
  - Guter Ort für Regeln, Prioritäten und Details zum „Verhalten“.

- `SOUL.md`
  - Persona, Tonfall und Grenzen.
  - Wird in jeder Sitzung geladen.

- `USER.md`
  - Wer der Benutzer ist und wie er angesprochen werden soll.
  - Wird in jeder Sitzung geladen.

- `IDENTITY.md`
  - Name, Vibe und Emoji des Agenten.
  - Wird während des Bootstrap-Rituals erstellt/aktualisiert.

- `TOOLS.md`
  - Hinweise zu Ihren lokalen Werkzeugen und Konventionen.
  - Steuert nicht die Werkzeugverfügbarkeit; dient nur als Orientierung.

- `HEARTBEAT.md`
  - Optionale kleine Checkliste für Heartbeat-Läufe.
  - Halten Sie sie kurz, um Tokenverbrauch zu vermeiden.

- `BOOT.md`
  - Optionale Start-Checkliste, die beim Neustart des Gateway ausgeführt wird,
    wenn interne Hooks aktiviert sind.
  - Halten Sie sie kurz; verwenden Sie das Message-Werkzeug für ausgehende Sends.

- `BOOTSTRAP.md`
  - Einmaliges Ritual beim ersten Start.
  - Wird nur für einen brandneuen Workspace erstellt.
  - Löschen Sie die Datei, nachdem das Ritual abgeschlossen ist.

- `memory/YYYY-MM-DD.md`
  - Tägliches Gedächtnisprotokoll (eine Datei pro Tag).
  - Empfohlen, beim Sitzungsstart heute + gestern zu lesen.

- `MEMORY.md` (optional)
  - Kuratiertes Langzeitgedächtnis.
  - Nur in der Haupt‑, privaten Sitzung laden (nicht in geteilten/Gruppenkontexten).

Siehe [Memory](/concepts/memory) für den Workflow und das automatische Flushen des
Gedächtnisses.

- `skills/` (optional)
  - Workspace-spezifische Skills.
  - Überschreibt verwaltete/gebündelte Skills bei Namenskonflikten.

- `canvas/` (optional)
  - Canvas-UI-Dateien für Node-Anzeigen (zum Beispiel `canvas/index.html`).

Fehlt eine Bootstrap-Datei, fügt OpenClaw einen „missing file“-Marker in die Sitzung
ein und fährt fort. Große Bootstrap-Dateien werden beim Einfügen gekürzt; passen Sie
das Limit mit `agents.defaults.bootstrapMaxChars` an (Standard: 20000).
`openclaw setup` kann fehlende Standarddateien neu erstellen, ohne vorhandene
Dateien zu überschreiben.

## Was NICHT im Workspace ist

Diese liegen unter `~/.openclaw/` und sollten NICHT in das Workspace-Repo
committed werden:

- `~/.openclaw/openclaw.json` (Konfiguration)
- `~/.openclaw/credentials/` (OAuth-Tokens, API-Schlüssel)
- `~/.openclaw/agents/<agentId>/sessions/` (Sitzungsprotokolle + Metadaten)
- `~/.openclaw/skills/` (verwaltete Skills)

Wenn Sie Sitzungen oder Konfiguration migrieren müssen, kopieren Sie diese
separat und halten Sie sie aus der Versionskontrolle heraus.

## Git-Backup (empfohlen, privat)

Behandeln Sie den Workspace als privates Gedächtnis. Legen Sie ihn in einem
**privaten** Git-Repository ab, damit er gesichert und wiederherstellbar ist.

Führen Sie diese Schritte auf der Maschine aus, auf der das Gateway läuft
(dort befindet sich der Workspace).

### 1. Repository initialisieren

Wenn Git installiert ist, werden brandneue Workspaces automatisch initialisiert. Wenn dieser Workspace noch kein Repository ist, führen Sie aus:

```bash
cd ~/.openclaw/workspace
git init
git add AGENTS.md SOUL.md TOOLS.md IDENTITY.md USER.md HEARTBEAT.md memory/
git commit -m "Add agent workspace"
```

### 2. Privates Remote hinzufügen (einsteigerfreundliche Optionen)

Option A: GitHub-Web-UI

1. Erstellen Sie ein neues **privates** Repository auf GitHub.
2. Initialisieren Sie es nicht mit einer README (vermeidet Merge-Konflikte).
3. Kopieren Sie die HTTPS-Remote-URL.
4. Fügen Sie das Remote hinzu und pushen Sie:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

Option B: GitHub CLI (`gh`)

```bash
gh auth login
gh repo create openclaw-workspace --private --source . --remote origin --push
```

Option C: GitLab-Web-UI

1. Erstellen Sie ein neues **privates** Repository auf GitLab.
2. Initialisieren Sie es nicht mit einer README (vermeidet Merge-Konflikte).
3. Kopieren Sie die HTTPS-Remote-URL.
4. Fügen Sie das Remote hinzu und pushen Sie:

```bash
git branch -M main
git remote add origin <https-url>
git push -u origin main
```

### 3. Laufende Updates

```bash
git status
git add .
git commit -m "Update memory"
git push
```

## Keine Secrets committen

Auch in einem privaten Repo sollten Sie vermeiden, Secrets im Workspace zu speichern:

- API-Schlüssel, OAuth-Tokens, Passwörter oder private Anmeldedaten.
- Alles unter `~/.openclaw/`.
- Roh-Dumps von Chats oder sensiblen Anhängen.

Wenn Sie sensible Referenzen speichern müssen, verwenden Sie Platzhalter und
bewahren Sie das echte Secret an anderer Stelle auf (Password-Manager,
Umgebungsvariablen oder `~/.openclaw/`).

Vorgeschlagener `.gitignore`-Starter:

```gitignore
.DS_Store
.env
**/*.key
**/*.pem
**/secrets*
```

## Workspace auf einen neuen Rechner verschieben

1. Klonen Sie das Repo in den gewünschten Pfad (Standard `~/.openclaw/workspace`).
2. Setzen Sie `agents.defaults.workspace` auf diesen Pfad in `~/.openclaw/openclaw.json`.
3. Führen Sie `openclaw setup --workspace <path>` aus, um fehlende Dateien anzulegen.
4. Wenn Sie Sitzungen benötigen, kopieren Sie `~/.openclaw/agents/<agentId>/sessions/` vom alten
   Rechner separat.

## Erweiterte Hinweise

- Multi-Agent-Routing kann unterschiedliche Workspaces pro Agent verwenden. Siehe [Channel routing](/channels/channel-routing) für die Routing-Konfiguration.
- Wenn `agents.defaults.sandbox` aktiviert ist, können Nicht-Hauptsitzungen
  sitzungsbezogene Sandbox-Workspaces unter `agents.defaults.sandbox.workspaceRoot` verwenden.
