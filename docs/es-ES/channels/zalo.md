---
summary: "Estado de soporte, capacidades y configuración del bot de Zalo"
read_when:
  - Trabajando en características o webhooks de Zalo
title: "Zalo"
---

# Zalo (API de Bot)

Estado: experimental. Solo mensajes directos; los grupos llegarán pronto según la documentación de Zalo.

## Plugin requerido

Zalo se distribuye como plugin y no viene incluido con la instalación principal.

- Instalar mediante CLI: `openclaw plugins install @openclaw/zalo`
- O selecciona **Zalo** durante la incorporación y confirma la solicitud de instalación
- Detalles: [Plugins](/es-ES/tools/plugin)

## Configuración rápida (principiante)

1. Instala el plugin de Zalo:
   - Desde un checkout de fuente: `openclaw plugins install ./extensions/zalo`
   - Desde npm (si está publicado): `openclaw plugins install @openclaw/zalo`
   - O elige **Zalo** en la incorporación y confirma la solicitud de instalación
2. Establece el token:
   - Env: `ZALO_BOT_TOKEN=...`
   - O config: `channels.zalo.botToken: "..."`.
3. Reinicia el gateway (o termina la incorporación).
4. El acceso a mensajes directos es por emparejamiento por defecto; aprueba el código de emparejamiento en el primer contacto.

Configuración mínima:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Qué es

Zalo es una app de mensajería enfocada en Vietnam; su API de Bot permite que el Gateway ejecute un bot para conversaciones 1:1.
Es una buena opción para soporte o notificaciones donde deseas enrutamiento determinista de vuelta a Zalo.

- Un canal de API de Bot de Zalo gestionado por el Gateway.
- Enrutamiento determinista: las respuestas regresan a Zalo; el modelo nunca elige canales.
- Los mensajes directos comparten la sesión principal del agente.
- Los grupos aún no son compatibles (la documentación de Zalo indica "próximamente").

## Configuración (ruta rápida)

### 1) Crear un token de bot (Plataforma de Bot de Zalo)

1. Ve a [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) e inicia sesión.
2. Crea un nuevo bot y configura sus ajustes.
3. Copia el token del bot (formato: `12345689:abc-xyz`).

### 2) Configurar el token (env o config)

Ejemplo:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Opción env: `ZALO_BOT_TOKEN=...` (funciona solo para la cuenta predeterminada).

Soporte multi-cuenta: usa `channels.zalo.accounts` con tokens por cuenta y `name` opcional.

3. Reinicia el gateway. Zalo inicia cuando se resuelve un token (env o config).
4. El acceso a mensajes directos usa emparejamiento por defecto. Aprueba el código cuando el bot sea contactado por primera vez.

## Cómo funciona (comportamiento)

- Los mensajes entrantes se normalizan en el sobre de canal compartido con marcadores de posición de medios.
- Las respuestas siempre se enrutan de vuelta al mismo chat de Zalo.
- Long-polling por defecto; modo webhook disponible con `channels.zalo.webhookUrl`.

## Límites

- El texto de salida se fragmenta en 2000 caracteres (límite de la API de Zalo).
- Las descargas/cargas de medios están limitadas por `channels.zalo.mediaMaxMb` (predeterminado 5).
- El streaming está bloqueado por defecto debido a que el límite de 2000 caracteres hace que el streaming sea menos útil.

## Control de acceso (mensajes directos)

### Acceso a mensajes directos

- Predeterminado: `channels.zalo.dmPolicy = "pairing"`. Los remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta ser aprobados (los códigos expiran después de 1 hora).
- Aprobar mediante:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- El emparejamiento es el intercambio de token predeterminado. Detalles: [Emparejamiento](/es-ES/channels/pairing)
- `channels.zalo.allowFrom` acepta IDs de usuario numéricos (no hay búsqueda de nombre de usuario disponible).

## Long-polling vs webhook

- Predeterminado: long-polling (no se requiere URL pública).
- Modo webhook: establece `channels.zalo.webhookUrl` y `channels.zalo.webhookSecret`.
  - El secreto del webhook debe tener entre 8-256 caracteres.
  - La URL del webhook debe usar HTTPS.
  - Zalo envía eventos con el encabezado `X-Bot-Api-Secret-Token` para verificación.
  - El HTTP del gateway maneja las solicitudes del webhook en `channels.zalo.webhookPath` (predeterminado a la ruta de la URL del webhook).

**Nota:** getUpdates (polling) y webhook son mutuamente excluyentes según la documentación de la API de Zalo.

## Tipos de mensajes compatibles

- **Mensajes de texto**: Soporte completo con fragmentación de 2000 caracteres.
- **Mensajes de imagen**: Descarga y procesa imágenes entrantes; envía imágenes mediante `sendPhoto`.
- **Stickers**: Registrados pero no completamente procesados (sin respuesta del agente).
- **Tipos no compatibles**: Registrados (por ejemplo, mensajes de usuarios protegidos).

## Capacidades

| Característica   | Estado                            |
| ---------------- | --------------------------------- |
| Mensajes directos| ✅ Compatible                     |
| Grupos           | ❌ Próximamente (según docs Zalo) |
| Medios (imágenes)| ✅ Compatible                     |
| Reacciones       | ❌ No compatible                  |
| Hilos            | ❌ No compatible                  |
| Encuestas        | ❌ No compatible                  |
| Comandos nativos | ❌ No compatible                  |
| Streaming        | ⚠️ Bloqueado (límite 2000 chars)  |

## Objetivos de entrega (CLI/cron)

- Usa un chat id como objetivo.
- Ejemplo: `openclaw message send --channel zalo --target 123456789 --message "hola"`.

## Solución de problemas

**El bot no responde:**

- Verifica que el token sea válido: `openclaw channels status --probe`
- Verifica que el remitente esté aprobado (emparejamiento o allowFrom)
- Verifica los logs del gateway: `openclaw logs --follow`

**El webhook no recibe eventos:**

- Asegúrate de que la URL del webhook use HTTPS
- Verifica que el token secreto tenga entre 8-256 caracteres
- Confirma que el endpoint HTTP del gateway sea accesible en la ruta configurada
- Verifica que el polling de getUpdates no esté en ejecución (son mutuamente excluyentes)

## Referencia de configuración (Zalo)

Configuración completa: [Configuración](/es-ES/gateway/configuration)

Opciones del provider:

- `channels.zalo.enabled`: habilitar/deshabilitar inicio del canal.
- `channels.zalo.botToken`: token del bot desde la Plataforma de Bot de Zalo.
- `channels.zalo.tokenFile`: leer token desde ruta de archivo.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: pairing).
- `channels.zalo.allowFrom`: lista de permitidos de mensajes directos (IDs de usuario). `open` requiere `"*"`. El asistente pedirá IDs numéricos.
- `channels.zalo.mediaMaxMb`: límite de medios entrantes/salientes (MB, predeterminado 5).
- `channels.zalo.webhookUrl`: habilitar modo webhook (HTTPS requerido).
- `channels.zalo.webhookSecret`: secreto del webhook (8-256 caracteres).
- `channels.zalo.webhookPath`: ruta del webhook en el servidor HTTP del gateway.
- `channels.zalo.proxy`: URL de proxy para solicitudes de API.

Opciones multi-cuenta:

- `channels.zalo.accounts.<id>.botToken`: token por cuenta.
- `channels.zalo.accounts.<id>.tokenFile`: archivo de token por cuenta.
- `channels.zalo.accounts.<id>.name`: nombre para mostrar.
- `channels.zalo.accounts.<id>.enabled`: habilitar/deshabilitar cuenta.
- `channels.zalo.accounts.<id>.dmPolicy`: política de mensajes directos por cuenta.
- `channels.zalo.accounts.<id>.allowFrom`: lista de permitidos por cuenta.
- `channels.zalo.accounts.<id>.webhookUrl`: URL de webhook por cuenta.
- `channels.zalo.accounts.<id>.webhookSecret`: secreto de webhook por cuenta.
- `channels.zalo.accounts.<id>.webhookPath`: ruta de webhook por cuenta.
- `channels.zalo.accounts.<id>.proxy`: URL de proxy por cuenta.
