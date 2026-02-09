---
summary: "Solución rápida de problemas a nivel de canal con firmas de fallas por canal y correcciones"
read_when:
  - El transporte del canal indica conectado pero las respuestas fallan
  - Necesita verificaciones específicas del canal antes de profundizar en la documentación del proveedor
title: "Solución de problemas de canales"
---

# Solución de problemas de canales

Use esta página cuando un canal se conecta pero el comportamiento es incorrecto.

## Escalera de comandos

Ejecute estos en orden primero:

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
- El sondeo del canal muestra conectado/listo

## WhatsApp

### Firmas de fallas de WhatsApp

| Síntoma                                            | Verificación más rápida                                              | Solución                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Conectado pero sin respuestas en mensajes directos | `openclaw pairing list whatsapp`                                     | Aprobar remitente o cambiar la política de mensajes directos/lista de permitidos.     |
| Mensajes de grupo ignorados                        | Verifique `requireMention` + patrones de mención en la configuración | Mencione al bot o relaje la política de menciones para ese grupo.                     |
| Desconexiones aleatorias/bucles de reingreso       | `openclaw channels status --probe` + registros                       | Vuelva a iniciar sesión y verifique que el directorio de credenciales esté saludable. |

Solución de problemas completa: [/channels/whatsapp#troubleshooting-quick](/channels/whatsapp#troubleshooting-quick)

## Telegram

### Firmas de fallas de Telegram

| Síntoma                                          | Verificación más rápida                                               | Solución                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `/start` pero sin flujo de respuestas utilizable | `openclaw pairing list telegram`                                      | Aprobar emparejamiento o cambiar la política de mensajes directos.              |
| Bot en línea pero el grupo permanece en silencio | Verifique el requisito de mención y el modo de privacidad del bot     | Desactive el modo de privacidad para visibilidad en el grupo o mencione al bot. |
| Fallas de envío con errores de red               | Inspeccione los registros por fallas en llamadas a la API de Telegram | Corrija el enrutamiento DNS/IPv6/proxy hacia `api.telegram.org`.                |

Solución de problemas completa: [/channels/telegram#troubleshooting](/channels/telegram#troubleshooting)

## Discord

### Firmas de fallas de Discord

| Síntoma                                        | Verificación más rápida                                    | Solución                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Bot en línea pero sin respuestas en servidores | `openclaw channels status --probe`                         | Permita el servidor/canal y verifique el intent de contenido de mensajes. |
| Mensajes de grupo ignorados                    | Revise los registros por descartes de control de menciones | Mencione al bot o configure el servidor/canal `requireMention: false`.    |
| Falta respuestas DM                            | `openclaw pairing list discord`                            | Aprobar emparejamiento de DM o ajustar la política de DM.                 |

Solución de problemas completa: [/channels/discord#troubleshooting](/channels/discord#troubleshooting)

## Slack

### Firmas de fallas de Slack

| Síntoma                                   | Verificación más rápida                                    | Solución                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Modo socket conectado pero sin respuestas | `openclaw channels status --probe`                         | Verifique el token de la app + el token del bot y los alcances requeridos. |
| DMs bloqueadas                            | `openclaw pairing list slack`                              | Apruebe el emparejamiento o relaje la política de mensajes directos.       |
| Mensaje de canal ignorado                 | Verifique `groupPolicy` y la lista de permitidos del canal | Permita el canal o cambie la política a `open`.                            |

Solución de problemas completa: [/channels/slack#troubleshooting](/channels/slack#troubleshooting)

## iMessage y BlueBubbles

### Firmas de fallas de iMessage y BlueBubbles

| Síntoma                                  | Verificación más rápida                                                       | Solución                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Sin eventos entrantes                    | Verifique la accesibilidad del webhook/servidor y los permisos de la app      | Corrija la URL del webhook o el estado del servidor de BlueBubbles. |
| Puede enviar pero no recibir en macOS    | Revise los permisos de privacidad de macOS para la automatización de Mensajes | Vuelva a conceder los permisos TCC y reinicie el proceso del canal. |
| Remitente de mensajes directos bloqueado | `openclaw pairing list imessage` o `openclaw pairing list bluebubbles`        | Apruebe el emparejamiento o actualice la lista de permitidos.       |

Solución de problemas completa:

- [/channels/imessage#troubleshooting-macos-privacy-and-security-tcc](/channels/imessage#troubleshooting-macos-privacy-and-security-tcc)
- [/channels/bluebubbles#troubleshooting](/channels/bluebubbles#troubleshooting)

## Signal

### Firmas de fallas de Signal

| Síntoma                                | Verificación más rápida                                              | Solución                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Demonio accesible pero bot en silencio | `openclaw channels status --probe`                                   | Verifique la URL/cuenta del demonio `signal-cli` y el modo de recepción. |
| DM bloqueada                           | `openclaw pairing list signal`                                       | Apruebe al remitente o ajuste la política de mensajes directos.          |
| Las respuestas en grupos no se activan | Verifique la lista de permitidos de grupos y los patrones de mención | Agregue el remitente/grupo o relaje el control.                          |

Solución de problemas completa: [/channels/signal#troubleshooting](/channels/signal#troubleshooting)

## Matrix

### Firmas de fallas de Matrix

| Síntoma                                   | Verificación más rápida                                           | Solución                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Conectado pero ignora mensajes de la sala | `openclaw channels status --probe`                                | Verifique `groupPolicy` y la lista de permitidos de salas.            |
| Los DMs no procesan                       | `openclaw pairing list matrix`                                    | Apruebe al remitente o ajuste la política de mensajes directos.       |
| Fallas en salas cifradas                  | Verifique el módulo de criptografía y la configuración de cifrado | Habilite el soporte de cifrado y vuelva a unirse/sincronizar la sala. |

Solución de problemas completa: [/channels/matrix#troubleshooting](/channels/matrix#troubleshooting)
