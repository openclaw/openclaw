---
summary: "OpenClaw vollständig deinstallieren (CLI, Dienst, Zustand, Workspace)"
read_when:
  - Sie möchten OpenClaw von einer Maschine entfernen
  - Der Gateway-Dienst läuft nach der Deinstallation noch
title: "Deinstallation"
---

# Deinstallation

Zwei Wege:

- **Einfacher Weg**, wenn `openclaw` noch installiert ist.
- **Manuelle Dienstentfernung**, wenn die CLI fehlt, der Dienst aber noch läuft.

## Einfacher Weg (CLI noch installiert)

Empfohlen: Verwenden Sie den integrierten Deinstaller:

```bash
openclaw uninstall
```

Nicht interaktiv (Automatisierung / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Manuelle Schritte (gleiches Ergebnis):

1. Stoppen Sie den Gateway-Dienst:

```bash
openclaw gateway stop
```

2. Deinstallieren Sie den Gateway-Dienst (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Zustand + Konfiguration löschen:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

Wenn Sie `OPENCLAW_CONFIG_PATH` auf einen benutzerdefinierten Speicherort außerhalb des Zustandsverzeichnisses gesetzt haben, löschen Sie diese Datei ebenfalls.

4. Workspace löschen (optional, entfernt Agent-Dateien):

```bash
rm -rf ~/.openclaw/workspace
```

5. Entfernen Sie die CLI-Installation (wählen Sie die verwendete Methode):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. Falls Sie die macOS-App installiert haben:

```bash
rm -rf /Applications/OpenClaw.app
```

Hinweise:

- Wenn Sie Profile (`--profile` / `OPENCLAW_PROFILE`) verwendet haben, wiederholen Sie Schritt 3 für jedes Zustandsverzeichnis (Standardwerte sind `~/.openclaw-<profile>`).
- Im Remote-Modus befindet sich das Zustandsverzeichnis auf dem **Gateway-Host**; führen Sie daher die Schritte 1–4 auch dort aus.

## Manuelle Dienstentfernung (CLI nicht installiert)

Verwenden Sie dies, wenn der Gateway-Dienst weiterläuft, aber `openclaw` fehlt.

### macOS (launchd)

Das Standard-Label ist `bot.molt.gateway` (oder `bot.molt.<profile>`; das Legacy-Label `com.openclaw.*` kann noch vorhanden sein):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

Wenn Sie ein Profil verwendet haben, ersetzen Sie Label und Plist-Namen durch `bot.molt.<profile>`. Entfernen Sie vorhandene Legacy-`com.openclaw.*`-Plists.

### Linux (systemd User-Unit)

Der Standard-Unit-Name ist `openclaw-gateway.service` (oder `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (Geplante Aufgabe)

Der Standard-Taskname ist `OpenClaw Gateway` (oder `OpenClaw Gateway (<profile>)`).
Das Task-Skript befindet sich unter Ihrem Zustandsverzeichnis.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

Wenn Sie ein Profil verwendet haben, löschen Sie den entsprechenden Tasknamen und `~\.openclaw-<profile>\gateway.cmd`.

## Normale Installation vs. Source-Checkout

### Normale Installation (install.sh / npm / pnpm / bun)

Wenn Sie `https://openclaw.ai/install.sh` oder `install.ps1` verwendet haben, wurde die CLI mit `npm install -g openclaw@latest` installiert.
Entfernen Sie sie mit `npm rm -g openclaw` (oder `pnpm remove -g` / `bun remove -g`, wenn Sie auf diese Weise installiert haben).

### Source-Checkout (git clone)

Wenn Sie aus einem Repo-Checkout heraus arbeiten (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. Deinstallieren Sie den Gateway-Dienst **vor** dem Löschen des Repos (verwenden Sie den einfachen Weg oben oder die manuelle Dienstentfernung).
2. Löschen Sie das Repo-Verzeichnis.
3. Entfernen Sie Zustand + Workspace wie oben gezeigt.
