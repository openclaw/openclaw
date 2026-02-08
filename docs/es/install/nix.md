---
summary: "Instale OpenClaw de forma declarativa con Nix"
read_when:
  - Quiere instalaciones reproducibles y con posibilidad de reversión
  - Ya utiliza Nix/NixOS/Home Manager
  - Quiere todo fijado y gestionado de manera declarativa
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:49Z
---

# Instalación con Nix

La forma recomendada de ejecutar OpenClaw con Nix es mediante **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — un módulo de Home Manager con todo incluido.

## Inicio rápido

Pegue esto en su agente de IA (Claude, Cursor, etc.):

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

> **📦 Guía completa: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> El repositorio nix-openclaw es la fuente de verdad para la instalación con Nix. Esta página es solo un resumen rápido.

## Lo que obtiene

- Gateway + app de macOS + herramientas (whisper, spotify, cámaras) — todo fijado
- Servicio Launchd que persiste tras reinicios
- Sistema de plugins con configuración declarativa
- Reversión instantánea: `home-manager switch --rollback`

---

## Comportamiento en tiempo de ejecución del modo Nix

Cuando se establece `OPENCLAW_NIX_MODE=1` (automático con nix-openclaw):

OpenClaw admite un **modo Nix** que hace la configuración determinista y desactiva los flujos de auto-instalación.
Actívelo exportando:

```bash
OPENCLAW_NIX_MODE=1
```

En macOS, la app GUI no hereda automáticamente las variables de entorno del shell. También puede
habilitar el modo Nix mediante defaults:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Rutas de configuración y estado

OpenClaw lee la configuración JSON5 desde `OPENCLAW_CONFIG_PATH` y almacena los datos mutables en `OPENCLAW_STATE_DIR`.

- `OPENCLAW_STATE_DIR` (predeterminado: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (predeterminado: `$OPENCLAW_STATE_DIR/openclaw.json`)

Al ejecutarse bajo Nix, configure estas rutas explícitamente a ubicaciones gestionadas por Nix para que el estado
en tiempo de ejecución y la configuración se mantengan fuera del store inmutable.

### Comportamiento en tiempo de ejecución en modo Nix

- Los flujos de auto-instalación y auto-mutación están deshabilitados
- Las dependencias faltantes muestran mensajes de remediación específicos de Nix
- La UI muestra un banner de modo Nix de solo lectura cuando está presente

## Nota de empaquetado (macOS)

El flujo de empaquetado de macOS espera una plantilla Info.plist estable en:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) copia esta plantilla dentro del bundle de la app y parchea campos dinámicos
(ID del bundle, versión/build, SHA de Git, claves de Sparkle). Esto mantiene el plist determinista para el
empaquetado con SwiftPM y las compilaciones con Nix (que no dependen de un toolchain completo de Xcode).

## Relacionado

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — guía completa de configuración
- [Wizard](/start/wizard) — configuración de la CLI sin Nix
- [Docker](/install/docker) — configuración en contenedores
