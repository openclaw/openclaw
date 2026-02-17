---
summary: "Solución rápida de problemas a nivel de canal con firmas de fallas y correcciones por canal"
read_when:
  - El transporte del canal dice conectado pero las respuestas fallan
  - Necesitas verificaciones específicas del canal antes de docs profundos del proveedor
title: "Solución de Problemas de Canales"
---

# Solución de problemas de canales

Usa esta página cuando un canal se conecta pero el comportamiento es incorrecto.

## Escalera de comandos

Ejecuta estos en orden primero:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Línea base saludable:

- `Runtime: running`
- `RPC probe: ok`
- El sondeo del canal muestra connected/ready

## WhatsApp

### Firmas de falla de WhatsApp

| Síntoma                                    | Verificación más rápida                                      | Corrección                                                                      |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Conectado pero sin respuestas a DMs        | `openclaw pairing list whatsapp`                             | Aprobar remitente o cambiar política de DM/lista de permitidos.                 |
| Mensajes de grupo ignorados                | Verificar `requireMention` + patrones de menciones en config | Mencionar el bot o relajar política de menciones para ese grupo.                |
| Desconexiones aleatorias/bucles de relogin | `openclaw channels status --probe` + logs                    | Re-iniciar sesión y verificar que el directorio de credenciales esté saludable. |

Solución completa: [/es-ES/channels/whatsapp#troubleshooting-quick](/es-ES/channels/whatsapp#troubleshooting-quick)

## Telegram

### Firmas de falla de Telegram

| Síntoma                                      | Verificación más rápida                                     | Corrección                                                                                |
| -------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/start` pero sin flujo de respuesta usable  | `openclaw pairing list telegram`                            | Aprobar emparejamiento o cambiar política de DM.                                          |
| Bot en línea pero grupo permanece silencioso | Verificar requisito de mención y modo de privacidad del bot | Deshabilitar modo de privacidad para visibilidad de grupo o mencionar bot.                |
| Fallas de envío con errores de red           | Inspeccionar logs para fallas de llamadas a API de Telegram | Corregir enrutamiento DNS/IPv6/proxy hacia `api.telegram.org`.                            |
| Actualizado y lista de permitidos te bloquea | `openclaw security audit` y listas de permitidos de config  | Ejecutar `openclaw doctor --fix` o reemplazar `@username` con IDs numéricos de remitente. |

Solución completa: [/es-ES/channels/telegram#troubleshooting](/es-ES/channels/telegram#troubleshooting)

## Discord

### Firmas de falla de Discord

| Síntoma                                   | Verificación más rápida                            | Corrección                                                           |
| ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| Bot en línea pero sin respuestas en guild | `openclaw channels status --probe`                 | Permitir guild/canal y verificar intención de contenido del mensaje. |
| Mensajes de grupo ignorados               | Verificar logs para caídas de control de menciones | Mencionar bot o configurar `requireMention: false` para guild/canal. |
| Respuestas de DM faltantes                | `openclaw pairing list discord`                    | Aprobar emparejamiento de DM o ajustar política de DM.               |

Solución completa: [/es-ES/channels/discord#troubleshooting](/es-ES/channels/discord#troubleshooting)

## Slack

### Firmas de falla de Slack

| Síntoma                                   | Verificación más rápida                                | Corrección                                                 |
| ----------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Modo socket conectado pero sin respuestas | `openclaw channels status --probe`                     | Verificar token de app + token de bot y scopes requeridos. |
| DMs bloqueados                            | `openclaw pairing list slack`                          | Aprobar emparejamiento o relajar política de DM.           |
| Mensaje de canal ignorado                 | Verificar `groupPolicy` y lista de permitidos de canal | Permitir el canal o cambiar política a `open`.             |

Solución completa: [/es-ES/channels/slack#troubleshooting](/es-ES/channels/slack#troubleshooting)

## iMessage y BlueBubbles

### Firmas de falla de iMessage y BlueBubbles

| Síntoma                               | Verificación más rápida                                                   | Corrección                                                 |
| ------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Sin eventos entrantes                 | Verificar alcanzabilidad de webhook/servidor y permisos de app            | Corregir URL de webhook o estado del servidor BlueBubbles. |
| Puede enviar pero no recibir en macOS | Verificar permisos de privacidad de macOS para automatización de Messages | Re-otorgar permisos TCC y reiniciar proceso del canal.     |
| Remitente de DM bloqueado             | `openclaw pairing list imessage` o `openclaw pairing list bluebubbles`    | Aprobar emparejamiento o actualizar lista de permitidos.   |

Solución completa:

- [/es-ES/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/es-ES/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/es-ES/channels/bluebubbles#troubleshooting](/es-ES/channels/bluebubbles#troubleshooting)

## Signal

### Firmas de falla de Signal

| Síntoma                               | Verificación más rápida                                        | Corrección                                                       |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Daemon alcanzable pero bot silencioso | `openclaw channels status --probe`                             | Verificar URL/cuenta de daemon `signal-cli` y modo de recepción. |
| DM bloqueado                          | `openclaw pairing list signal`                                 | Aprobar remitente o ajustar política de DM.                      |
| Respuestas de grupo no se activan     | Verificar lista de permitidos de grupo y patrones de menciones | Agregar remitente/grupo o aflojar control.                       |

Solución completa: [/es-ES/channels/signal#troubleshooting](/es-ES/channels/signal#troubleshooting)

## Matrix

### Firmas de falla de Matrix

| Síntoma                                      | Verificación más rápida                                   | Corrección                                                            |
| -------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------- |
| Sesión iniciada pero ignora mensajes de sala | `openclaw channels status --probe`                        | Verificar `groupPolicy` y lista de permitidos de sala.                |
| DMs no se procesan                           | `openclaw pairing list matrix`                            | Aprobar remitente o ajustar política de DM.                           |
| Salas encriptadas fallan                     | Verificar módulo crypto y configuraciones de encriptación | Habilitar soporte de encriptación y volver a unirse/sincronizar sala. |

Solución completa: [/es-ES/channels/matrix#troubleshooting](/es-ES/channels/matrix#troubleshooting)
