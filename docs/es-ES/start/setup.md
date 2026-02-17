---
summary: "Configuración avanzada y flujos de trabajo de desarrollo para OpenClaw"
read_when:
  - Configurando una nueva máquina
  - Quieres "lo último y mejor" sin romper tu configuración personal
title: "Configuración"
---

# Configuración

<Note>
Si estás configurando por primera vez, comienza con [Comenzando](/start/getting-started).
Para detalles del asistente, consulta [Asistente de Incorporación](/start/wizard).
</Note>

Última actualización: 2026-01-01

## TL;DR

- **La personalización vive fuera del repositorio:** `~/.openclaw/workspace` (espacio de trabajo) + `~/.openclaw/openclaw.json` (configuración).
- **Flujo de trabajo estable:** instala la app macOS; déjala ejecutar el Gateway incluido.
- **Flujo de trabajo de vanguardia:** ejecuta el Gateway tú mismo vía `pnpm gateway:watch`, luego deja que la app macOS se conecte en modo Local.

## Prerrequisitos (desde código fuente)

- Node `>=22`
- `pnpm`
- Docker (opcional; solo para configuración/e2e en contenedor — consulta [Docker](/install/docker))

## Estrategia de personalización (para que las actualizaciones no duelan)

Si quieres "100% personalizado para mí" _y_ actualizaciones fáciles, mantén tu personalización en:

- **Configuración:** `~/.openclaw/openclaw.json` (JSON/JSON5-ish)
- **Espacio de trabajo:** `~/.openclaw/workspace` (habilidades, prompts, memorias; hazlo un repositorio git privado)

Inicializa una vez:

```bash
openclaw setup
```

Desde dentro de este repositorio, usa el punto de entrada CLI local:

```bash
openclaw setup
```

Si aún no tienes una instalación global, ejecútalo vía `pnpm openclaw setup`.

## Ejecutar el Gateway desde este repositorio

Después de `pnpm build`, puedes ejecutar el CLI empaquetado directamente:

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Flujo de trabajo estable (app macOS primero)

1. Instala + lanza **OpenClaw.app** (barra de menú).
2. Completa la lista de verificación de incorporación/permisos (prompts TCC).
3. Asegúrate de que el Gateway esté en modo **Local** y ejecutándose (la app lo gestiona).
4. Enlaza superficies (ejemplo: WhatsApp):

```bash
openclaw channels login
```

5. Verificación de sanidad:

```bash
openclaw health
```

Si la incorporación no está disponible en tu compilación:

- Ejecuta `openclaw setup`, luego `openclaw channels login`, luego inicia el Gateway manualmente (`openclaw gateway`).

## Flujo de trabajo de vanguardia (Gateway en una terminal)

Objetivo: trabajar en el Gateway TypeScript, obtener recarga en caliente, mantener la UI de la app macOS conectada.

### 0) (Opcional) Ejecutar la app macOS también desde código fuente

Si también quieres la app macOS de vanguardia:

```bash
./scripts/restart-mac.sh
```

### 1) Iniciar el Gateway de desarrollo

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` ejecuta el gateway en modo watch y recarga con cambios de TypeScript.

### 2) Apuntar la app macOS a tu Gateway en ejecución

En **OpenClaw.app**:

- Modo de Conexión: **Local**
  La app se conectará al gateway en ejecución en el puerto configurado.

### 3) Verificar

- El estado del Gateway en la app debería leer **"Usando gateway existente …"**
- O vía CLI:

```bash
openclaw health
```

### Errores comunes

- **Puerto incorrecto:** El WS del Gateway predetermina a `ws://127.0.0.1:18789`; mantén la app + CLI en el mismo puerto.
- **Dónde vive el estado:**
  - Credenciales: `~/.openclaw/credentials/`
  - Sesiones: `~/.openclaw/agents/<agentId>/sessions/`
  - Registros: `/tmp/openclaw/`

## Mapa de almacenamiento de credenciales

Usa esto al depurar autenticación o decidir qué respaldar:

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Token de bot de Telegram**: config/env o `channels.telegram.tokenFile`
- **Token de bot de Discord**: config/env (archivo de token aún no soportado)
- **Tokens de Slack**: config/env (`channels.slack.*`)
- **Listas de permitidos de emparejamiento**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Perfiles de autenticación del modelo**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Importación OAuth heredada**: `~/.openclaw/credentials/oauth.json`
  Más detalle: [Seguridad](/gateway/security#credential-storage-map).

## Actualizar (sin arruinar tu configuración)

- Mantén `~/.openclaw/workspace` y `~/.openclaw/` como "tus cosas"; no pongas prompts/configuración personal en el repositorio `openclaw`.
- Actualizar código fuente: `git pull` + `pnpm install` (cuando cambia el lockfile) + sigue usando `pnpm gateway:watch`.

## Linux (servicio de usuario systemd)

Las instalaciones en Linux usan un servicio de **usuario** systemd. Por defecto, systemd detiene servicios
de usuario al cerrar sesión/inactividad, lo que mata el Gateway. La incorporación intenta habilitar
lingering para ti (puede pedir sudo). Si aún está desactivado, ejecuta:

```bash
sudo loginctl enable-linger $USER
```

Para servidores siempre encendidos o multiusuario, considera un servicio de **sistema** en lugar de un
servicio de usuario (no necesita lingering). Consulta [Manual del Gateway](/gateway) para las notas de systemd.

## Documentación relacionada

- [Manual del Gateway](/gateway) (indicadores, supervisión, puertos)
- [Configuración del Gateway](/gateway/configuration) (esquema de configuración + ejemplos)
- [Discord](/channels/discord) y [Telegram](/channels/telegram) (etiquetas de respuesta + ajustes replyToMode)
- [Configuración del asistente OpenClaw](/start/openclaw)
- [App macOS](/platforms/macos) (ciclo de vida del gateway)
