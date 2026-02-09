---
summary: "Estado de compatibilidad del bot de Zalo, capacidades y configuración"
read_when:
  - Trabajando en funciones o webhooks de Zalo
title: "Zalo"
---

# Zalo (Bot API)

Estado: experimental. Solo mensajes directos; los grupos llegarán pronto según la documentación de Zalo.

## Plugin requerido

Zalo se distribuye como un plugin y no está incluido en la instalación principal.

- Instale mediante la CLI: `openclaw plugins install @openclaw/zalo`
- O seleccione **Zalo** durante el onboarding y confirme el aviso de instalación
- Detalles: [Plugins](/tools/plugin)

## Configuración rápida (principiante)

1. Instale el plugin de Zalo:
   - Desde un checkout del código fuente: `openclaw plugins install ./extensions/zalo`
   - Desde npm (si está publicado): `openclaw plugins install @openclaw/zalo`
   - O elija **Zalo** en el onboarding y confirme el aviso de instalación
2. Configure el token:
   - Env: `ZALO_BOT_TOKEN=...`
   - O configuración: `channels.zalo.botToken: "..."`.
3. Reinicie el Gateway (o finalice el onboarding).
4. El acceso a mensajes directos se empareja de forma predeterminada; apruebe el código de emparejamiento en el primer contacto.

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

Zalo es una aplicación de mensajería centrada en Vietnam; su Bot API permite que el Gateway ejecute un bot para conversaciones 1:1.
Es una buena opción para soporte o notificaciones cuando se desea un enrutamiento determinista de regreso a Zalo.

- Un canal de Zalo Bot API propiedad del Gateway.
- Enrutamiento determinista: las respuestas vuelven a Zalo; el modelo nunca elige canales.
- Los mensajes directos comparten la sesión principal del agente.
- Los grupos aún no son compatibles (la documentación de Zalo indica “próximamente”).

## Configuración (ruta rápida)

### 1. Crear un token de bot (Zalo Bot Platform)

1. Vaya a [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) e inicie sesión.
2. Cree un nuevo bot y configure sus ajustes.
3. Copie el token del bot (formato: `12345689:abc-xyz`).

### 2) Configurar el token (entorno o configuración)

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

Opción por variable de entorno: `ZALO_BOT_TOKEN=...` (funciona solo para la cuenta predeterminada).

Soporte multi-cuenta: use `channels.zalo.accounts` con tokens por cuenta y `name` opcional.

3. Reinicie el Gateway. Zalo se inicia cuando se resuelve un token (variable de entorno o configuración).
4. El acceso a mensajes directos usa emparejamiento de forma predeterminada. Apruebe el código cuando el bot sea contactado por primera vez.

## Cómo funciona (comportamiento)

- Los mensajes entrantes se normalizan en el sobre compartido del canal con marcadores de posición de medios.
- Las respuestas siempre se enrutan de vuelta al mismo chat de Zalo.
- Long-polling de forma predeterminada; modo webhook disponible con `channels.zalo.webhookUrl`.

## Límites

- El texto saliente se fragmenta en bloques de 2000 caracteres (límite de la API de Zalo).
- Las descargas/cargas de medios están limitadas por `channels.zalo.mediaMaxMb` (predeterminado 5).
- El streaming está bloqueado de forma predeterminada debido a que el límite de 2000 caracteres hace que el streaming sea menos útil.

## Control de acceso (mensajes directos)

### Acceso DM

- Predeterminado: `channels.zalo.dmPolicy = "pairing"`. Los remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta que se aprueban (los códigos expiran después de 1 hora).
- Aprobar mediante:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- El emparejamiento es el intercambio de tokens predeterminado. Detalles: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` acepta IDs numéricos de usuario (no hay búsqueda por nombre de usuario).

## Long-polling vs webhook

- Predeterminado: long-polling (no se requiere una URL pública).
- Modo webhook: configure `channels.zalo.webhookUrl` y `channels.zalo.webhookSecret`.
  - El secreto del webhook debe tener entre 8 y 256 caracteres.
  - La URL del webhook debe usar HTTPS.
  - Zalo envía eventos con el encabezado `X-Bot-Api-Secret-Token` para verificación.
  - El HTTP del Gateway maneja las solicitudes del webhook en `channels.zalo.webhookPath` (por defecto, la ruta de la URL del webhook).

**Nota:** getUpdates (polling) y webhook son mutuamente excluyentes según la documentación de la API de Zalo.

## Tipos de mensajes compatibles

- **Mensajes de texto**: compatibilidad completa con fragmentación de 2000 caracteres.
- **Mensajes de imagen**: descargar y procesar imágenes entrantes; enviar imágenes mediante `sendPhoto`.
- **Stickers**: se registran pero no se procesan completamente (sin respuesta del agente).
- **Tipos no compatibles**: se registran (p. ej., mensajes de usuarios protegidos).

## Capacidades

| Función                              | Estado                                         |
| ------------------------------------ | ---------------------------------------------- |
| Mensajes directos                    | ✅ Compatible                                   |
| Grupos                               | ❌ Próximamente (según Zalo) |
| Medios (imágenes) | ✅ Compatible                                   |
| Reacciones                           | ❌ No compatible                                |
| Hilos                                | ❌ No compatible                                |
| Encuestas                            | ❌ No compatible                                |
| Comandos nativos                     | ❌ No compatible                                |
| Streaming                            | ⚠️ Bloqueado (límite 2000)  |

## Destinos de entrega (CLI/cron)

- Use un id de chat como destino.
- Ejemplo: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Solución de problemas

**El bot no responde:**

- Verifique que el token sea válido: `openclaw channels status --probe`
- Verifique que el remitente esté aprobado (emparejamiento o allowFrom)
- Revise los registros del Gateway: `openclaw logs --follow`

**El webhook no recibe eventos:**

- Asegúrese de que la URL del webhook use HTTPS
- Verifique que el token secreto tenga entre 8 y 256 caracteres
- Confirme que el endpoint HTTP del Gateway sea accesible en la ruta configurada
- Compruebe que el polling de getUpdates no esté en ejecución (son mutuamente excluyentes)

## Referencia de configuración (Zalo)

Configuración completa: [Configuration](/gateway/configuration)

Opciones del proveedor:

- `channels.zalo.enabled`: habilitar/deshabilitar el inicio del canal.
- `channels.zalo.botToken`: token del bot de Zalo Bot Platform.
- `channels.zalo.tokenFile`: leer el token desde una ruta de archivo.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: emparejamiento).
- `channels.zalo.allowFrom`: lista de permitidos de mensajes directos (IDs de usuario). `open` requiere `"*"`. El asistente solicitará IDs numéricos.
- `channels.zalo.mediaMaxMb`: límite de medios entrantes/salientes (MB, predeterminado 5).
- `channels.zalo.webhookUrl`: habilitar modo webhook (se requiere HTTPS).
- `channels.zalo.webhookSecret`: secreto del webhook (8–256 caracteres).
- `channels.zalo.webhookPath`: ruta del webhook en el servidor HTTP del Gateway.
- `channels.zalo.proxy`: URL de proxy para solicitudes a la API.

Opciones multi-cuenta:

- `channels.zalo.accounts.<id>.botToken`: token por cuenta.
- `channels.zalo.accounts.<id>.tokenFile`: archivo de token por cuenta.
- `channels.zalo.accounts.<id>.name`: nombre para mostrar.
- `channels.zalo.accounts.<id>.enabled`: habilitar/deshabilitar la cuenta.
- `channels.zalo.accounts.<id>.dmPolicy`: política de mensajes directos por cuenta.
- `channels.zalo.accounts.<id>.allowFrom`: lista de permitidos por cuenta.
- `channels.zalo.accounts.<id>.webhookUrl`: URL de webhook por cuenta.
- `channels.zalo.accounts.<id>.webhookSecret`: secreto de webhook por cuenta.
- `channels.zalo.accounts.<id>.webhookPath`: ruta de webhook por cuenta.
- `channels.zalo.accounts.<id>.proxy`: URL de proxy por cuenta.
