---
summary: "Configuración del bot de Mattermost y config de OpenClaw"
read_when:
  - Configurando Mattermost
  - Depurando enrutamiento de Mattermost
title: "Mattermost"
---

# Mattermost (plugin)

Estado: soportado mediante plugin (token de bot + eventos WebSocket). Se soportan canales, grupos y mensajes directos.
Mattermost es una plataforma de mensajería de equipos auto-hospedable; consulta el sitio oficial en
[mattermost.com](https://mattermost.com) para detalles del producto y descargas.

## Plugin requerido

Mattermost se distribuye como plugin y no está incluido en la instalación principal.

Instalar mediante CLI (registro npm):

```bash
openclaw plugins install @openclaw/mattermost
```

Repositorio local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/mattermost
```

Si eliges Mattermost durante configure/onboarding y se detecta un repositorio git,
OpenClaw ofrecerá automáticamente la ruta de instalación local.

Detalles: [Plugins](/es-ES/tools/plugin)

## Configuración rápida

1. Instalar el plugin de Mattermost.
2. Crear una cuenta de bot de Mattermost y copiar el **token de bot**.
3. Copiar la **URL base** de Mattermost (ej., `https://chat.example.com`).
4. Configurar OpenClaw e iniciar el gateway.

Configuración mínima:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Variables de entorno (cuenta por defecto)

Configura estas variables en el host del gateway si prefieres usar variables de entorno:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Las variables de entorno aplican solo a la cuenta **por defecto** (`default`). Otras cuentas deben usar valores de configuración.

## Modos de chat

Mattermost responde a mensajes directos automáticamente. El comportamiento en canales se controla mediante `chatmode`:

- `oncall` (por defecto): responder solo cuando se menciona con @ en canales.
- `onmessage`: responder a cada mensaje de canal.
- `always`: responder a cada mensaje en canales (mismo comportamiento de canal que `onmessage`).
- `onchar`: responder cuando un mensaje comienza con un prefijo de activación.

Ejemplo de configuración:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Notas:

- `onchar` aún responde a menciones @ explícitas.
- `channels.mattermost.requireMention` se respeta para configs heredados pero se prefiere `chatmode`.
- Limitación actual: debido al comportamiento de eventos del plugin de Mattermost (`#11797`), `chatmode: "onmessage"` y
  `chatmode: "always"` pueden requerir sobrescritura explícita de mención de grupo para responder sin @menciones.
  Usa:

```json5
{
  channels: {
    mattermost: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

Referencia: [Bug: Mattermost plugin does not receive channel message events via WebSocket #11797](https://github.com/open-webui/open-webui/issues/11797).
Alcance de corrección relacionada: [fix(mattermost): honor chatmode mention fallback in group mention gating #14995](https://github.com/open-webui/open-webui/pull/14995).

## Control de acceso (DMs)

- Por defecto: `channels.mattermost.dmPolicy = "pairing"` (remitentes desconocidos reciben un código de emparejamiento).
- Aprobar mediante:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CÓDIGO>`
- Mensajes directos públicos: `channels.mattermost.dmPolicy="open"` más `channels.mattermost.allowFrom=["*"]`.

## Canales (grupos)

- Por defecto: `channels.mattermost.groupPolicy = "allowlist"` (controlado por menciones).
- Lista de permitidos de remitentes con `channels.mattermost.groupAllowFrom` (IDs de usuario o `@username`).
- Canales abiertos: `channels.mattermost.groupPolicy="open"` (controlado por menciones).

## Destinos para entrega saliente

Usa estos formatos de destino con `openclaw message send` o cron/webhooks:

- `channel:<id>` para un canal
- `user:<id>` para un mensaje directo
- `@username` para un mensaje directo (resuelto mediante la API de Mattermost)

Los IDs simples se tratan como canales.

## Multi-cuenta

Mattermost soporta múltiples cuentas bajo `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Solución de problemas

- Sin respuestas en canales: asegúrate de que el bot esté en el canal y use el comportamiento del modo correctamente: menciónalo (`oncall`), usa un prefijo de activación (`onchar`), o usa `onmessage`/`always` con:
  `channels.mattermost.groups["*"].requireMention = false` (y típicamente `groupPolicy: "open"`).
- Errores de autenticación: verifica el token de bot, URL base y si la cuenta está habilitada.
- Problemas multi-cuenta: las variables de entorno solo aplican a la cuenta `default`.
