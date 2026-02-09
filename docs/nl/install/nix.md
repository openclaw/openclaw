---
summary: "Installeer OpenClaw declaratief met Nix"
read_when:
  - Je wilt reproduceerbare installaties met rollback
  - Je gebruikt al Nix/NixOS/Home Manager
  - Je wilt dat alles vastgepind en declaratief beheerd wordt
title: "Nix"
---

# Nix-installatie

De aanbevolen manier om OpenClaw met Nix te draaien is via **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — een Home Manager-module met alles inbegrepen.

## Snelle start

Plak dit in je AI-agent (Claude, Cursor, enz.):

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

> **📦 Volledige gids: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> De nix-openclaw-repo is de bron van waarheid voor Nix-installatie. Deze pagina is slechts een snel overzicht.

## Wat je krijgt

- Gateway + macOS-app + tools (whisper, spotify, camera’s) — allemaal vastgepind
- Launchd-service die herstarts overleeft
- Pluginsysteem met declaratieve config
- Directe rollback: `home-manager switch --rollback`

---

## Runtime-gedrag in Nix-modus

Wanneer `OPENCLAW_NIX_MODE=1` is ingesteld (automatisch met nix-openclaw):

Ondersteunt OpenClaw een **Nix-modus** die configuratie deterministisch maakt en auto-installatiestromen uitschakelt.
Schakel deze in door te exporteren:

```bash
OPENCLAW_NIX_MODE=1
```

Op macOS neemt de GUI-app shell-omgevingsvariabelen niet automatisch over. Je kunt
Nix-modus ook inschakelen via defaults:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Config- en staatspaden

OpenClaw leest JSON5-configuratie uit `OPENCLAW_CONFIG_PATH` en slaat muteerbare data op in `OPENCLAW_STATE_DIR`.

- `OPENCLAW_STATE_DIR` (standaard: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (standaard: `$OPENCLAW_STATE_DIR/openclaw.json`)

Wanneer je onder Nix draait, stel deze expliciet in op door Nix beheerde locaties, zodat runtime-staat en configuratie
buiten de onveranderlijke store blijven.

### Runtime-gedrag in Nix-modus

- Auto-installatie en zelf-mutatiestromen zijn uitgeschakeld
- Ontbrekende afhankelijkheden tonen Nix-specifieke herstelmeldingen
- De UI toont een alleen-lezen Nix-modusbanner wanneer aanwezig

## Packaging-opmerking (macOS)

De macOS-packagingflow verwacht een stabiel Info.plist-sjabloon op:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) kopieert dit sjabloon naar de app-bundel en past dynamische velden aan
(bundle-ID, versie/build, Git SHA, Sparkle-sleutels). Dit houdt de plist deterministisch voor SwiftPM-
packaging en Nix-builds (die niet afhankelijk zijn van een volledige Xcode-toolchain).

## Gerelateerd

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — volledige installatiegids
- [Wizard](/start/wizard) — niet-Nix CLI-installatie
- [Docker](/install/docker) — containerized installatie
