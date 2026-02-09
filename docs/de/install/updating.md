---
summary: "„OpenClaw sicher aktualisieren (globale Installation oder aus dem Quellcode) sowie Rollback-Strategie“"
read_when:
  - OpenClaw aktualisieren
  - Nach einem Update funktioniert etwas nicht mehr
title: "Aktualisieren"
---

# Aktualisieren

OpenClaw entwickelt sich schnell (vor „1.0“). Behandeln Sie Updates wie den Betrieb von Infrastruktur: Update → Prüfungen ausführen → neu starten (oder `openclaw update` verwenden, das neu startet) → verifizieren.

## Empfohlen: Website-Installer erneut ausführen (In‑Place‑Upgrade)

Der **bevorzugte** Aktualisierungspfad ist, den Installer von der Website erneut auszuführen. Er
erkennt bestehende Installationen, aktualisiert sie in place und führt bei Bedarf `openclaw doctor` aus.

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Hinweise:

- Fügen Sie `--no-onboard` hinzu, wenn der Onboarding‑Assistent nicht erneut ausgeführt werden soll.

- Für **Source‑Installationen** verwenden Sie:

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  Der Installer wird `git pull --rebase` **nur**, wenn das Repository sauber ist.

- Für **globale Installationen** verwendet das Skript unter der Haube `npm install -g openclaw@latest`.

- Legacy‑Hinweis: `clawdbot` bleibt als Kompatibilitäts‑Shim verfügbar.

## Vor dem Update

- Wissen, wie Sie installiert haben: **global** (npm/pnpm) vs. **aus dem Quellcode** (git clone).
- Wissen, wie Ihr Gateway läuft: **Vordergrund‑Terminal** vs. **überwachter Dienst** (launchd/systemd).
- Erstellen Sie Snapshots Ihrer Anpassungen:
  - Konfiguration: `~/.openclaw/openclaw.json`
  - Zugangsdaten: `~/.openclaw/credentials/`
  - Workspace: `~/.openclaw/workspace`

## Update (globale Installation)

Globale Installation (eine Option wählen):

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Wir empfehlen **Bun** nicht für die Gateway‑Laufzeit (WhatsApp/Telegram‑Bugs).

Zum Wechseln der Update‑Kanäle (git‑ und npm‑Installationen):

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

Verwenden Sie `--tag <dist-tag|version>` für ein einmaliges Installations‑Tag/eine Version.

Siehe [Development channels](/install/development-channels) für Kanal‑Semantik und Release‑Notes.

Hinweis: Bei npm‑Installationen protokolliert das Gateway beim Start einen Update‑Hinweis (prüft das aktuelle Kanal‑Tag). Deaktivieren Sie dies mit `update.checkOnStart: false`.

Dann:

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

Hinweise:

- Wenn Ihr Gateway als Dienst läuft, ist `openclaw gateway restart` dem Beenden von PIDs vorzuziehen.
- Wenn Sie auf eine bestimmte Version fixiert sind, siehe unten „Rollback / Pinning“.

## Update (`openclaw update`)

Für **Source‑Installationen** (git checkout) bevorzugen Sie:

```bash
openclaw update
```

Es führt einen einigermaßen sicheren Update‑Ablauf aus:

- Erfordert einen sauberen Worktree.
- Wechselt zum ausgewählten Kanal (Tag oder Branch).
- Fetch + Rebase gegen das konfigurierte Upstream (Dev‑Kanal).
- Installiert Abhängigkeiten, baut, baut die Control UI und führt `openclaw doctor` aus.
- Startet das Gateway standardmäßig neu (verwenden Sie `--no-restart`, um dies zu überspringen).

Wenn Sie über **npm/pnpm** installiert haben (keine git‑Metadaten), versucht `openclaw update`, über Ihren Paketmanager zu aktualisieren. Wenn die Installation nicht erkannt werden kann, verwenden Sie stattdessen „Update (globale Installation)“.

## Update (Control UI / RPC)

Die Control UI bietet **Update & Restart** (RPC: `update.run`). Das:

1. Führt denselben Source‑Update‑Ablauf aus wie `openclaw update` (nur git checkout).
2. Schreibt einen Neustart‑Sentinel mit einem strukturierten Bericht (stdout/stderr‑Tail).
3. Startet das Gateway neu und pingt die zuletzt aktive Sitzung mit dem Bericht an.

Wenn der Rebase fehlschlägt, bricht das Gateway ab und startet neu, ohne das Update anzuwenden.

## Update (aus dem Quellcode)

Aus dem Repo‑Checkout:

Bevorzugt:

```bash
openclaw update
```

Manuell (ungefähr gleichwertig):

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

Hinweise:

- `pnpm build` ist relevant, wenn Sie das paketierte `openclaw`‑Binary ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) ausführen oder Node verwenden, um `dist/` auszuführen.
- Wenn Sie aus einem Repo‑Checkout ohne globale Installation laufen, verwenden Sie `pnpm openclaw ...` für CLI‑Befehle.
- Wenn Sie direkt aus TypeScript (`pnpm openclaw ...`) ausführen, ist ein Rebuild in der Regel nicht notwendig, aber **Konfigurationsmigrationen gelten weiterhin** → Doctor ausführen.
- Der Wechsel zwischen globalen und git‑Installationen ist einfach: Installieren Sie die andere Variante und führen Sie dann `openclaw doctor` aus, damit der Gateway‑Dienst‑Entrypoint auf die aktuelle Installation umgeschrieben wird.

## Immer ausführen: `openclaw doctor`

Doctor ist der „sichere Update“-Befehl. Er ist bewusst langweilig: reparieren + migrieren + warnen.

Hinweis: Wenn Sie eine **Source‑Installation** (git checkout) verwenden, bietet `openclaw doctor` an, zuerst `openclaw update` auszuführen.

Typische Aufgaben:

- Migration veralteter Konfigurationsschlüssel / legacy Konfigurationsdatei‑Pfade.
- Prüfung von DM‑Richtlinien und Warnungen bei riskanten „offenen“ Einstellungen.
- Überprüfung der Gateway‑Gesundheit und optionaler Neustart.
- Erkennung und Migration älterer Gateway‑Dienste (launchd/systemd; legacy schtasks) zu aktuellen OpenClaw‑Diensten.
- Unter Linux: Sicherstellen von systemd‑User‑Lingering (damit das Gateway das Logout überlebt).

Details: [Doctor](/gateway/doctor)

## Gateway starten / stoppen / neu starten

CLI (funktioniert unabhängig vom Betriebssystem):

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

Wenn Sie überwacht ausführen:

- macOS launchd (app‑gebündelter LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (verwenden Sie `bot.molt.<profile>`; legacy `com.openclaw.*` funktioniert weiterhin)
- Linux systemd User‑Service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` funktionieren nur, wenn der Dienst installiert ist; andernfalls führen Sie `openclaw gateway install` aus.

Runbook + exakte Service‑Labels: [Gateway runbook](/gateway)

## Rollback / Pinning (wenn etwas kaputtgeht)

### Pinnen (globale Installation)

Installieren Sie eine bekannte, funktionierende Version (ersetzen Sie `<version>` durch die zuletzt funktionierende):

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

Tipp: Um die aktuell veröffentlichte Version zu sehen, führen Sie `npm view openclaw version` aus.

Dann neu starten + Doctor erneut ausführen:

```bash
openclaw doctor
openclaw gateway restart
```

### Pinnen (Source) nach Datum

Wählen Sie einen Commit zu einem Datum (Beispiel: „Stand von main zum 2026‑01‑01“):

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

Dann Abhängigkeiten neu installieren + neu starten:

```bash
pnpm install
pnpm build
openclaw gateway restart
```

Wenn Sie später wieder auf „latest“ gehen möchten:

```bash
git checkout main
git pull
```

## Wenn Sie feststecken

- Führen Sie `openclaw doctor` erneut aus und lesen Sie die Ausgabe sorgfältig (sie nennt oft die Lösung).
- Prüfen Sie: [Fehlerbehebung](/gateway/troubleshooting)
- Fragen Sie in Discord: [https://discord.gg/clawd](https://discord.gg/clawd)
