---
summary: "„Doctor-Befehl: Zustandsprüfungen, Konfigurationsmigrationen und Reparaturschritte“"
read_when:
  - Hinzufügen oder Ändern von Doctor-Migrationen
  - Einführung inkompatibler Konfigurationsänderungen
title: "Doctor"
---

# Doctor

`openclaw doctor` ist das Reparatur- und Migrationstool für OpenClaw. Es behebt
veraltete Konfigurationen/Zustände, prüft die Gesundheit des Systems und stellt
konkrete Reparaturschritte bereit.

## Schnellstart

```bash
openclaw doctor
```

### Headless / Automatisierung

```bash
openclaw doctor --yes
```

Standardwerte ohne Rückfragen akzeptieren (einschließlich Neustart-/Service-/Sandbox-Reparaturschritten, sofern zutreffend).

```bash
openclaw doctor --repair
```

Empfohlene Reparaturen ohne Rückfragen anwenden (Reparaturen + Neustarts, wo sicher).

```bash
openclaw doctor --repair --force
```

Auch aggressive Reparaturen anwenden (überschreibt benutzerdefinierte Supervisor-Konfigurationen).

```bash
openclaw doctor --non-interactive
```

Ohne Rückfragen ausführen und nur sichere Migrationen anwenden (Konfigurationsnormalisierung + Verschieben des On-Disk-Zustands). Überspringt Neustart-/Service-/Sandbox-Aktionen, die eine menschliche Bestätigung erfordern.
Legacy-Zustandsmigrationen werden bei Erkennung automatisch ausgeführt.

```bash
openclaw doctor --deep
```

Systemdienste nach zusätzlichen Gateway-Installationen scannen (launchd/systemd/schtasks).

Wenn Sie Änderungen vor dem Schreiben überprüfen möchten, öffnen Sie zuerst die Konfigurationsdatei:

```bash
cat ~/.openclaw/openclaw.json
```

## Was es tut (Zusammenfassung)

- Optionale Pre-Flight-Aktualisierung für Git-Installationen (nur interaktiv).
- UI-Protokoll-Frischeprüfung (erstellt die Control UI neu, wenn das Protokollschema neuer ist).
- Zustandsprüfung + Neustartaufforderung.
- Skills-Statusübersicht (geeignet/fehlend/blockiert).
- Konfigurationsnormalisierung für Legacy-Werte.
- Warnungen zu OpenCode-Zen-Anbieter-Überschreibungen (`models.providers.opencode`).
- Migration von Legacy-On-Disk-Zuständen (Sitzungen/Agent-Verzeichnis/WhatsApp-Auth).
- Prüfungen der Zustandsintegrität und Berechtigungen (Sitzungen, Transkripte, Zustandsverzeichnis).
- Prüfung der Dateiberechtigungen der Konfiguration (chmod 600) bei lokaler Ausführung.
- Modell-Auth-Zustand: prüft OAuth-Ablauf, kann ablaufende Tokens erneuern und meldet Cooldown-/Deaktivierungszustände von Auth-Profilen.
- Erkennung zusätzlicher Workspace-Verzeichnisse (`~/openclaw`).
- Reparatur von Sandbox-Images, wenn sandboxing aktiviert ist.
- Migration von Legacy-Services und Erkennung zusätzlicher Gateways.
- Gateway-Laufzeitprüfungen (Service installiert, aber nicht laufend; gecachter launchd-Label).
- Kanal-Statuswarnungen (vom laufenden Gateway sondiert).
- Supervisor-Konfigurationsaudit (launchd/systemd/schtasks) mit optionaler Reparatur.
- Best-Practice-Prüfungen für die Gateway-Laufzeit (Node vs. Bun, Pfade von Versionsmanagern).
- Diagnose von Gateway-Portkollisionen (Standard `18789`).
- Sicherheitswarnungen bei offenen DM-Richtlinien.
- Gateway-Auth-Warnungen, wenn kein `gateway.auth.token` gesetzt ist (lokaler Modus; bietet Token-Generierung an).
- systemd-linger-Prüfung unter Linux.
- Prüfungen von Source-Installationen (pnpm-Workspace-Mismatch, fehlende UI-Assets, fehlendes tsx-Binary).
- Schreibt aktualisierte Konfiguration + Assistenten-Metadaten.

## Detailliertes Verhalten und Begründung

### 0. Optionale Aktualisierung (Git-Installationen)

Wenn es sich um ein Git-Checkout handelt und Doctor interaktiv läuft, wird
angeboten, vor dem Ausführen von Doctor zu aktualisieren (fetch/rebase/build).

### 1. Konfigurationsnormalisierung

Wenn die Konfiguration Legacy-Wertformen enthält (z. B. `messages.ackReaction`
ohne kanalspezifische Überschreibung), normalisiert Doctor diese in das aktuelle
Schema.

### 2. Migration von Legacy-Konfigurationsschlüsseln

Wenn die Konfiguration veraltete Schlüssel enthält, verweigern andere Befehle
die Ausführung und fordern Sie auf, `openclaw doctor` auszuführen.

Doctor wird:

- Erklären, welche Legacy-Schlüssel gefunden wurden.
- Die angewendete Migration anzeigen.
- `~/.openclaw/openclaw.json` mit dem aktualisierten Schema neu schreiben.

Das Gateway führt Doctor-Migrationen beim Start auch automatisch aus, wenn es
ein Legacy-Konfigurationsformat erkennt, sodass veraltete Konfigurationen ohne
manuelles Eingreifen repariert werden.

Aktuelle Migrationen:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → Top-Level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`

### 2b) OpenCode-Zen-Anbieter-Überschreibungen

Wenn Sie `models.providers.opencode` (oder `opencode-zen`) manuell hinzugefügt haben,
überschreibt dies den integrierten OpenCode-Zen-Katalog aus `@mariozechner/pi-ai`. Das kann alle Modelle auf eine einzige API zwingen oder Kosten auf null setzen. Doctor warnt Sie, damit Sie die Überschreibung entfernen und die modellweise
API-Routing- und Kostenlogik wiederherstellen können.

### 3. Legacy-Zustandsmigrationen (Datenträgerlayout)

Doctor kann ältere On-Disk-Layouts in die aktuelle Struktur migrieren:

- Sitzungsstore + Transkripte:
  - von `~/.openclaw/sessions/` nach `~/.openclaw/agents/<agentId>/sessions/`
- Agent-Verzeichnis:
  - von `~/.openclaw/agent/` nach `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp-Auth-Zustand (Baileys):
  - aus Legacy-`~/.openclaw/credentials/*.json` (außer `oauth.json`)
  - nach `~/.openclaw/credentials/whatsapp/<accountId>/...` (Standardkonto-ID: `default`)

Diese Migrationen erfolgen nach bestem Aufwand und sind idempotent; Doctor gibt
Warnungen aus, wenn Legacy-Ordner als Backups zurückgelassen werden. Das
Gateway/CLI migriert die Legacy-Sitzungen und das Agent-Verzeichnis beim Start
ebenfalls automatisch, sodass Verlauf/Auth/Modelle im Agent-spezifischen Pfad
landen, ohne einen manuellen Doctor-Lauf. Die WhatsApp-Auth wird bewusst nur
über `openclaw doctor` migriert.

### 4. Prüfungen der Zustandsintegrität (Sitzungspersistenz, Routing und Sicherheit)

Das Zustandsverzeichnis ist das operative Rückgrat. Wenn es verschwindet,
verlieren Sie Sitzungen, Anmeldedaten, Logs und Konfiguration (sofern keine
Backups vorhanden sind).

Doctor prüft:

- **Zustandsverzeichnis fehlt**: warnt vor katastrophalem Zustandsverlust,
  fordert zur Neuerstellung des Verzeichnisses auf und erinnert daran, dass
  fehlende Daten nicht wiederhergestellt werden können.
- **Berechtigungen des Zustandsverzeichnisses**: prüft Schreibbarkeit; bietet
  eine Reparatur der Berechtigungen an (und gibt einen `chown`-Hinweis
  aus, wenn ein Eigentümer-/Gruppen-Mismatch erkannt wird).
- **Fehlende Sitzungsverzeichnisse**: `sessions/` und das
  Sitzungsstore-Verzeichnis sind erforderlich, um Verlauf zu persistieren und
  `ENOENT`-Abstürze zu vermeiden.
- **Transkript-Mismatch**: warnt, wenn zu aktuellen Sitzungseinträgen
  Transkriptdateien fehlen.
- **Hauptsitzung „1-Zeilen-JSONL“**: kennzeichnet, wenn das Haupttranskript nur
  eine Zeile hat (der Verlauf akkumuliert nicht).
- **Mehrere Zustandsverzeichnisse**: warnt, wenn mehrere `~/.openclaw`-Ordner
  über Home-Verzeichnisse hinweg existieren oder wenn `OPENCLAW_STATE_DIR` woanders
  hinzeigt (der Verlauf kann sich zwischen Installationen aufteilen).
- **Remote-Modus-Erinnerung**: wenn `gateway.mode=remote`, erinnert Doctor daran, es
  auf dem Remote-Host auszuführen (der Zustand lebt dort).
- **Dateiberechtigungen der Konfiguration**: warnt, wenn `~/.openclaw/openclaw.json`
  gruppen-/weltlesbar ist, und bietet an, auf `600` zu verschärfen.

### 5. Modell-Auth-Zustand (OAuth-Ablauf)

Doctor prüft OAuth-Profile im Auth-Store, warnt bei ablaufenden/abgelaufenen
Tokens und kann sie erneuern, wenn dies sicher ist. Wenn das Anthropic-Claude-
Code-Profil veraltet ist, schlägt es vor, `claude setup-token` auszuführen (oder ein
Setup-Token einzufügen).
Erneuerungsabfragen erscheinen nur bei interaktiver
Ausführung (TTY); `--non-interactive` überspringt Erneuerungsversuche.

Doctor meldet außerdem Auth-Profile, die vorübergehend unbrauchbar sind aufgrund von:

- kurzen Cooldowns (Rate-Limits/Timeouts/Auth-Fehler)
- längeren Deaktivierungen (Abrechnung-/Kreditprobleme)

### 6. Validierung des Hooks-Modells

Wenn `hooks.gmail.model` gesetzt ist, validiert Doctor die Modellreferenz gegen den
Katalog und die Allowlist und warnt, wenn sie nicht auflösbar oder unzulässig ist.

### 7. Reparatur von Sandbox-Images

Wenn sandboxing aktiviert ist, prüft Doctor Docker-Images und bietet an, sie zu
bauen oder auf Legacy-Namen zu wechseln, falls das aktuelle Image fehlt.

### 8. Migrationen von Gateway-Services und Cleanup-Hinweise

Doctor erkennt Legacy-Gateway-Services (launchd/systemd/schtasks) und bietet an,
sie zu entfernen und den OpenClaw-Service mit dem aktuellen Gateway-Port zu
installieren. Außerdem kann es nach zusätzlichen gateway-ähnlichen Services
scannen und Cleanup-Hinweise ausgeben.
Profilbenannte OpenClaw-Gateway-Services
gelten als erstklassig und werden nicht als „extra“ markiert.

### 9. Sicherheitswarnungen

Doctor gibt Warnungen aus, wenn ein Anbieter für DMs ohne Allowlist offen ist
oder wenn eine Richtlinie auf gefährliche Weise konfiguriert ist.

### 10. systemd linger (Linux)

Bei Ausführung als systemd-User-Service stellt Doctor sicher, dass Linger
aktiviert ist, damit das Gateway nach dem Abmelden weiterläuft.

### 11. Skills-Status

Doctor gibt eine kurze Übersicht über geeignete/fehlende/blockierte Skills für
den aktuellen Workspace aus.

### 12. Gateway-Auth-Prüfungen (lokales Token)

Doctor warnt, wenn `gateway.auth` auf einem lokalen Gateway fehlt, und bietet
an, ein Token zu generieren. Verwenden Sie `openclaw doctor --generate-gateway-token`, um die Token-
Erstellung in der Automatisierung zu erzwingen.

### 13. Gateway-Zustandsprüfung + Neustart

Doctor führt eine Zustandsprüfung durch und bietet einen Neustart des Gateways
an, wenn es ungesund erscheint.

### 14. Kanal-Statuswarnungen

Wenn das Gateway gesund ist, führt Doctor eine Kanalstatus-Sondierung durch und
meldet Warnungen mit vorgeschlagenen Behebungen.

### 15. Supervisor-Konfigurationsaudit + Reparatur

Doctor prüft die installierte Supervisor-Konfiguration (launchd/systemd/schtasks)
auf fehlende oder veraltete Standardwerte (z. B. systemd-Abhängigkeiten für
network-online und Neustartverzögerung). Wenn eine Abweichung gefunden wird, empfiehlt es ein Update und kann die Service-Datei/den Task auf die aktuellen Standardwerte umschreiben.

Hinweise:

- `openclaw doctor` fragt vor dem Umschreiben der Supervisor-Konfiguration nach.
- `openclaw doctor --yes` akzeptiert die Standard-Reparaturaufforderungen.
- `openclaw doctor --repair` wendet empfohlene Fixes ohne Rückfragen an.
- `openclaw doctor --repair --force` überschreibt benutzerdefinierte Supervisor-Konfigurationen.
- Eine vollständige Neuerstellung können Sie jederzeit über `openclaw gateway install --force`
  erzwingen.

### 16. Gateway-Laufzeit- und Port-Diagnose

Doctor untersucht die Service-Laufzeit (PID, letzter Exit-Status) und warnt,
wenn der Service installiert, aber nicht tatsächlich laufend ist. Außerdem
prüft es auf Portkollisionen am Gateway-Port (Standard `18789`) und
meldet wahrscheinliche Ursachen (Gateway läuft bereits, SSH-Tunnel).

### 17. Best Practices für die Gateway-Laufzeit

Doctor warnt, wenn der Gateway-Service auf Bun oder auf einem durch einen
Versionsmanager verwalteten Node-Pfad läuft (`nvm`, `fnm`,
`volta`, `asdf`, usw.). WhatsApp- und Telegram-Kanäle
erfordern Node, und Versionsmanager-Pfade können nach Upgrades brechen, da der
Service Ihre Shell-Initialisierung nicht lädt. Doctor bietet an, auf eine
systemweite Node-Installation zu migrieren, wenn verfügbar
(Homebrew/apt/choco).

### 18. Schreiben der Konfiguration + Assistenten-Metadaten

Doctor persistiert alle Konfigurationsänderungen und versieht sie mit
Assistenten-Metadaten zur Dokumentation des Doctor-Laufs.

### 19. Workspace-Tipps (Backup + Memory-System)

Doctor schlägt ein Workspace-Memory-System vor, wenn es fehlt, und gibt einen
Backup-Tipp aus, wenn der Workspace noch nicht unter Git steht.

Siehe [/concepts/agent-workspace](/concepts/agent-workspace) für eine vollständige
Anleitung zur Workspace-Struktur und zum Git-Backup (empfohlen: privates GitHub
oder GitLab).
