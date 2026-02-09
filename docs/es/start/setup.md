---
summary: "Flujos de configuración avanzada y desarrollo para OpenClaw"
read_when:
  - Configurar una máquina nueva
  - Quiere “lo último y lo mejor” sin romper su configuración personal
title: "Configuración"
---

# Configuración

<Note>
Si está configurando por primera vez, comience con [Getting Started](/start/getting-started).
Para detalles del asistente, consulte [Onboarding Wizard](/start/wizard).
</Note>

Última actualización: 2026-01-01

## TL;DR

- **La personalización vive fuera del repo:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config).
- **Flujo estable:** instale la app de macOS; deje que ejecute el Gateway incluido.
- **Flujo bleeding edge:** ejecute el Gateway usted mismo vía `pnpm gateway:watch`, luego deje que la app de macOS se adjunte en modo Local.

## Requisitos previos (desde el código fuente)

- Node `>=22`
- `pnpm`
- Docker (opcional; solo para configuración en contenedores/e2e — ver [Docker](/install/docker))

## Estrategia de personalización (para que las actualizaciones no duelan)

Si quiere “100% adaptado a mí” _y_ actualizaciones sencillas, mantenga su personalización en:

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memorias; conviértalo en un repo git privado)

Inicialice una vez:

```bash
openclaw setup
```

Desde dentro de este repo, use la entrada local de la CLI:

```bash
openclaw setup
```

Si aún no tiene una instalación global, ejecútela vía `pnpm openclaw setup`.

## Ejecutar el Gateway desde este repo

Después de `pnpm build`, puede ejecutar la CLI empaquetada directamente:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Flujo estable (primero la app de macOS)

1. Instale y lance **OpenClaw.app** (barra de menús).
2. Complete la lista de verificación de onboarding/permisos (prompts TCC).
3. Asegúrese de que el Gateway esté **Local** y en ejecución (la app lo gestiona).
4. Vincule superficies (ejemplo: WhatsApp):

```bash
openclaw channels login
```

5. Verificación rápida:

```bash
openclaw health
```

Si el onboarding no está disponible en su compilación:

- Ejecute `openclaw setup`, luego `openclaw channels login`, y después inicie el Gateway manualmente (`openclaw gateway`).

## Flujo bleeding edge (Gateway en una terminal)

Objetivo: trabajar en el Gateway en TypeScript, obtener hot reload y mantener la UI de la app de macOS adjunta.

### 0. (Opcional) Ejecutar también la app de macOS desde el código fuente

Si además quiere la app de macOS en bleeding edge:

```bash
./scripts/restart-mac.sh
```

### 1. Iniciar el Gateway de desarrollo

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` ejecuta el gateway en modo watch y recarga con cambios de TypeScript.

### 2. Apuntar la app de macOS a su Gateway en ejecución

En **OpenClaw.app**:

- Modo de conexión: **Local**
  La app se adjuntará al gateway en ejecución en el puerto configurado.

### 3. Verificar

- El estado del Gateway en la app debería decir **“Using existing gateway …”**
- O vía CLI:

```bash
openclaw health
```

### Pistolas comunes

- **Puerto incorrecto:** el WS del Gateway por defecto es `ws://127.0.0.1:18789`; mantenga app + CLI en el mismo puerto.
- **Dónde vive el estado:**
  - Credenciales: `~/.openclaw/credentials/`
  - Sesiones: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Mapa de almacenamiento de credenciales

Úselo al depurar autenticación o decidir qué respaldar:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Token del bot de Telegram**: config/env o `channels.telegram.tokenFile`
- **Token del bot de Discord**: config/env (el archivo de token aún no es compatible)
- **Tokens de Slack**: config/env (`channels.slack.*`)
- **Listas de permitidos de emparejamiento**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Perfiles de autenticación de modelos**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Importación OAuth heredada**: `~/.openclaw/credentials/oauth.json`
  Más detalles: [Security](/gateway/security#credential-storage-map).

## Actualización (sin destrozar su configuración)

- Mantenga `~/.openclaw/workspace` y `~/.openclaw/` como “sus cosas”; no ponga prompts/config personales en el repo `openclaw`.
- Actualizar el código fuente: `git pull` + `pnpm install` (cuando cambie el lockfile) + siga usando `pnpm gateway:watch`.

## Linux (servicio de usuario systemd)

Las instalaciones en Linux usan un servicio **de usuario** de systemd. Por defecto, systemd detiene los
servicios de usuario al cerrar sesión/inactividad, lo que mata el Gateway. El onboarding intenta habilitar
el “lingering” por usted (puede pedir sudo). Si sigue desactivado, ejecute:

```bash
sudo loginctl enable-linger $USER
```

Para servidores siempre encendidos o multiusuario, considere un servicio **de sistema** en lugar de un
servicio de usuario (no requiere lingering). Consulte [Gateway runbook](/gateway) para las notas de systemd.

## Documentos relacionados

- [Gateway runbook](/gateway) (flags, supervisión, puertos)
- [Gateway configuration](/gateway/configuration) (esquema de configuración + ejemplos)
- [Discord](/channels/discord) y [Telegram](/channels/telegram) (etiquetas de respuesta + configuraciones de replyToMode)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (ciclo de vida del gateway)
