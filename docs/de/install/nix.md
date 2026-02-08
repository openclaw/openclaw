---
summary: "OpenClaw deklarativ mit Nix installieren"
read_when:
  - Sie möchten reproduzierbare, rollback-fähige Installationen
  - Sie verwenden bereits Nix/NixOS/Home Manager
  - Sie möchten alles fest gepinnt und deklarativ verwalten
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:35Z
---

# Nix-Installation

Die empfohlene Methode, OpenClaw mit Nix auszuführen, ist **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — ein Home-Manager-Modul mit Batterien inklusive.

## Schnellstart

Fügen Sie dies in Ihren KI-Agenten (Claude, Cursor usw.) ein:

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 Vollständige Anleitung: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> Das Repository nix-openclaw ist die maßgebliche Quelle für die Nix-Installation. Diese Seite bietet lediglich einen kurzen Überblick.

## Was Sie erhalten

- Gateway + macOS-App + Werkzeuge (whisper, spotify, cameras) — alles fest gepinnt
- Launchd-Dienst, der Neustarts übersteht
- Plugin-System mit deklarativer Konfiguration
- Sofortiger Rollback: `home-manager switch --rollback`

---

## Laufzeitverhalten im Nix-Modus

Wenn `OPENCLAW_NIX_MODE=1` gesetzt ist (automatisch mit nix-openclaw):

OpenClaw unterstützt einen **Nix-Modus**, der die Konfiguration deterministisch macht und Auto-Installationsabläufe deaktiviert.
Aktivieren Sie ihn durch Exportieren von:

```bash
OPENCLAW_NIX_MODE=1
```

Unter macOS übernimmt die GUI-App Shell-Umgebungsvariablen nicht automatisch. Sie können
den Nix-Modus auch über defaults aktivieren:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Konfigurations- und Statuspfade

OpenClaw liest JSON5-Konfiguration aus `OPENCLAW_CONFIG_PATH` und speichert veränderliche Daten in `OPENCLAW_STATE_DIR`.

- `OPENCLAW_STATE_DIR` (Standard: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (Standard: `$OPENCLAW_STATE_DIR/openclaw.json`)

Beim Betrieb unter Nix setzen Sie diese explizit auf von Nix verwaltete Speicherorte, damit Laufzeitzustand und Konfiguration
außerhalb des unveränderlichen Stores bleiben.

### Laufzeitverhalten im Nix-Modus

- Auto-Installation und Selbstmutationsabläufe sind deaktiviert
- Fehlende Abhängigkeiten zeigen Nix-spezifische Hinweise zur Behebung an
- Die UI zeigt bei Vorhandensein ein schreibgeschütztes Nix-Modus-Banner an

## Packaging-Hinweis (macOS)

Der macOS-Packaging-Ablauf erwartet eine stabile Info.plist-Vorlage unter:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) kopiert diese Vorlage in das App-Bundle und patcht dynamische Felder
(Bundle-ID, Version/Build, Git-SHA, Sparkle-Schlüssel). Dadurch bleibt die plist für SwiftPM-Packaging
und Nix-Builds (die nicht auf eine vollständige Xcode-Toolchain angewiesen sind) deterministisch.

## Verwandt

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — vollständige Einrichtungsanleitung
- [Wizard](/start/wizard) — CLI-Einrichtung ohne Nix
- [Docker](/install/docker) — containerisierte Einrichtung
