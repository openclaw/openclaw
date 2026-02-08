---
summary: "Installér OpenClaw deklarativt med Nix"
read_when:
  - Du ønsker reproducerbare installationer med mulighed for rollback
  - Du bruger allerede Nix/NixOS/Home Manager
  - Du vil have, at alt er fastlåst og administreret deklarativt
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:22Z
---

# Nix-installation

Den anbefalede måde at køre OpenClaw med Nix er via **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — et Home Manager-modul med alt inkluderet.

## Hurtig start

Indsæt dette til din AI-agent (Claude, Cursor osv.):

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

> **📦 Fuld guide: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw-repoet er den autoritative kilde til Nix-installation. Denne side er blot et hurtigt overblik.

## Hvad du får

- Gateway + macOS-app + værktøjer (whisper, spotify, kameraer) — alt fastlåst
- Launchd-tjeneste, der overlever genstarter
- Pluginsystem med deklarativ konfiguration
- Øjeblikkelig rollback: `home-manager switch --rollback`

---

## Runtime-adfærd i Nix-tilstand

Når `OPENCLAW_NIX_MODE=1` er sat (automatisk med nix-openclaw):

Understøtter OpenClaw en **Nix-tilstand**, der gør konfiguration deterministisk og deaktiverer auto-installationsflows.
Aktivér den ved at eksportere:

```bash
OPENCLAW_NIX_MODE=1
```

På macOS arver GUI-appen ikke automatisk shell-miljøvariabler. Du kan
også aktivere Nix-tilstand via defaults:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Konfigurations- og tilstandsstier

OpenClaw læser JSON5-konfiguration fra `OPENCLAW_CONFIG_PATH` og gemmer mutable data i `OPENCLAW_STATE_DIR`.

- `OPENCLAW_STATE_DIR` (standard: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (standard: `$OPENCLAW_STATE_DIR/openclaw.json`)

Når du kører under Nix, skal disse sættes eksplicit til Nix-administrerede placeringer, så runtime-tilstand og konfiguration
holdes ude af den uforanderlige store.

### Runtime-adfærd i Nix-tilstand

- Auto-installation og selv-modificerende flows er deaktiveret
- Manglende afhængigheder viser Nix-specifikke løsningsbeskeder
- UI’et viser et skrivebeskyttet Nix-tilstandsbanner, når det er til stede

## Pakkeringsnote (macOS)

Pakkeringsflowet for macOS forventer en stabil Info.plist-skabelon på:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) kopierer denne skabelon ind i app-bundlet og patcher dynamiske felter
(bundle-ID, version/build, Git SHA, Sparkle-nøgler). Dette holder plist’en deterministisk for SwiftPM-
pakkering og Nix-builds (som ikke er afhængige af et fuldt Xcode-toolchain).

## Relateret

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — fuld opsætningsguide
- [Wizard](/start/wizard) — CLI-opsætning uden Nix
- [Docker](/install/docker) — containeriseret opsætning
