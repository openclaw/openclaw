---
summary: "Instalar OpenClaw declarativamente con Nix"
read_when:
  - Quieres instalaciones reproducibles y reversibles
  - Ya estás usando Nix/NixOS/Home Manager
  - Quieres todo fijado y gestionado declarativamente
title: "Nix"
---

# Instalación con Nix

La forma recomendada de ejecutar OpenClaw con Nix es vía **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — un módulo de Home Manager con baterías incluidas.

## Inicio Rápido

Pega esto a tu agente AI (Claude, Cursor, etc.):

```text
Quiero configurar nix-openclaw en mi Mac.
Repositorio: github:openclaw/nix-openclaw

Lo que necesito que hagas:
1. Verificar si Determinate Nix está instalado (si no, instalarlo)
2. Crear un flake local en ~/code/openclaw-local usando templates/agent-first/flake.nix
3. Ayudarme a crear un bot de Telegram (@BotFather) y obtener mi ID de chat (@userinfobot)
4. Configurar secretos (token del bot, clave Anthropic) - archivos planos en ~/.secrets/ está bien
5. Llenar los placeholders de la plantilla y ejecutar home-manager switch
6. Verificar: launchd ejecutándose, bot responde a mensajes

Consulta el README de nix-openclaw para opciones del módulo.
```

> **📦 Guía completa: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> El repositorio nix-openclaw es la fuente de verdad para la instalación con Nix. Esta página es solo una vista general rápida.

## Lo que obtienes

- Gateway + app macOS + herramientas (whisper, spotify, cámaras) — todo fijado
- Servicio launchd que sobrevive reinicios
- Sistema de plugins con configuración declarativa
- Reversión instantánea: `home-manager switch --rollback`

---

## Comportamiento en Tiempo de Ejecución del Modo Nix

Cuando `OPENCLAW_NIX_MODE=1` está establecido (automático con nix-openclaw):

OpenClaw soporta un **modo Nix** que hace la configuración determinística y deshabilita flujos de auto-instalación.
Habilítalo exportando:

```bash
OPENCLAW_NIX_MODE=1
```

En macOS, la app GUI no hereda automáticamente variables de entorno del shell. También
puedes habilitar el modo Nix vía defaults:

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Rutas de configuración + estado

OpenClaw lee configuración JSON5 desde `OPENCLAW_CONFIG_PATH` y almacena datos mutables en `OPENCLAW_STATE_DIR`.
Cuando sea necesario, también puedes establecer `OPENCLAW_HOME` para controlar el directorio home base usado para resolución de rutas internas.

- `OPENCLAW_HOME` (precedencia predeterminada: `HOME` / `USERPROFILE` / `os.homedir()`)
- `OPENCLAW_STATE_DIR` (predeterminado: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (predeterminado: `$OPENCLAW_STATE_DIR/openclaw.json`)

Cuando se ejecuta bajo Nix, establece estos explícitamente a ubicaciones gestionadas por Nix para que el estado en tiempo de ejecución y configuración
permanezcan fuera del almacén inmutable.

### Comportamiento en tiempo de ejecución en modo Nix

- Los flujos de auto-instalación y auto-mutación están deshabilitados
- Las dependencias faltantes muestran mensajes de remediación específicos de Nix
- La UI muestra un banner de modo Nix de solo lectura cuando está presente

## Nota de empaquetado (macOS)

El flujo de empaquetado de macOS espera una plantilla Info.plist estable en:

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) copia esta plantilla en el bundle de la app y parchea campos dinámicos
(ID de bundle, versión/build, SHA de Git, claves de Sparkle). Esto mantiene el plist determinístico para empaquetado
de SwiftPM y builds de Nix (que no dependen de una cadena de herramientas completa de Xcode).

## Relacionado

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — guía completa de configuración
- [Wizard](/es-ES/start/wizard) — configuración CLI sin Nix
- [Docker](/es-ES/install/docker) — configuración containerizada
