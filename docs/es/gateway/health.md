---
summary: "Pasos de verificación de salud para la conectividad del canal"
read_when:
  - Diagnóstico de la salud del canal de WhatsApp
title: "Comprobaciones de salud"
---

# Comprobaciones de salud (CLI)

Guía breve para verificar la conectividad del canal sin suposiciones.

## Comprobaciones rápidas

- `openclaw status` — resumen local: alcanzabilidad/modo del Gateway, sugerencia de actualización, antigüedad de autenticación del canal vinculado, sesiones + actividad reciente.
- `openclaw status --all` — diagnóstico local completo (solo lectura, con color, seguro para pegar al depurar).
- `openclaw status --deep` — también sondea el Gateway en ejecución (sondeos por canal cuando están disponibles).
- `openclaw health --json` — solicita al Gateway en ejecución una instantánea completa de salud (solo WS; sin socket directo de Baileys).
- Envíe `/status` como un mensaje independiente en WhatsApp/WebChat para obtener una respuesta de estado sin invocar al agente.
- Registros: haga tail de `/tmp/openclaw/openclaw-*.log` y filtre por `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Diagnósticos profundos

- Credenciales en disco: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (la mtime debería ser reciente).
- Almacén de sesiones: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (la ruta se puede sobrescribir en la configuración). El recuento y los destinatarios recientes se muestran mediante `status`.
- Flujo de revinculación: `openclaw channels logout && openclaw channels login --verbose` cuando aparezcan códigos de estado 409–515 o `loggedOut` en los registros. (Nota: el flujo de inicio de sesión por QR se reinicia automáticamente una vez para el estado 515 después del emparejamiento).

## Cuando algo falla

- `logged out` o estado 409–515 → revincule con `openclaw channels logout` y luego `openclaw channels login`.
- Gateway inalcanzable → inícielo: `openclaw gateway --port 18789` (use `--force` si el puerto está ocupado).
- Sin mensajes entrantes → confirme que el teléfono vinculado esté en línea y que el remitente esté permitido (`channels.whatsapp.allowFrom`); para chats grupales, asegúrese de que la lista de permitidos + las reglas de mención coincidan (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Comando dedicado de "health"

`openclaw health --json` solicita al Gateway en ejecución su instantánea de salud (sin sockets directos del canal desde la CLI). Informa, cuando está disponible, las credenciales vinculadas/antigüedad de autenticación, resúmenes de sondeos por canal, resumen del almacén de sesiones y la duración del sondeo. Sale con un código distinto de cero si el Gateway es inalcanzable o si el sondeo falla o excede el tiempo. Use `--timeout <ms>` para sobrescribir el valor predeterminado de 10 s.
