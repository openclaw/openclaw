---
summary: "Pasos de verificación de salud para conectividad de canales"
read_when:
  - Diagnosticando salud del canal de WhatsApp
title: "Verificaciones de Salud"
---

# Verificaciones de Salud (CLI)

Guía corta para verificar conectividad de canales sin adivinar.

## Verificaciones rápidas

- `openclaw status` — resumen local: accesibilidad/modo del gateway, pista de actualización, edad de auth del canal vinculado, sesiones + actividad reciente.
- `openclaw status --all` — diagnóstico local completo (solo lectura, color, seguro para pegar para depuración).
- `openclaw status --deep` — también prueba el Gateway en ejecución (pruebas por canal cuando se admiten).
- `openclaw health --json` — pide al Gateway en ejecución una instantánea de salud completa (solo WS; sin socket Baileys directo).
- Envía `/status` como mensaje independiente en WhatsApp/WebChat para obtener una respuesta de estado sin invocar el agente.
- Logs: tail `/tmp/openclaw/openclaw-*.log` y filtra por `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Diagnósticos profundos

- Creds en disco: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime debería ser reciente).
- Almacén de sesiones: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (la ruta puede anularse en la configuración). El conteo y destinatarios recientes se muestran vía `status`.
- Flujo de re-vinculación: `openclaw channels logout && openclaw channels login --verbose` cuando códigos de estado 409–515 o `loggedOut` aparecen en logs. (Nota: el flujo de login QR auto-reinicia una vez para estado 515 después del emparejamiento.)

## Cuando algo falla

- `logged out` o estado 409–515 → re-vincula con `openclaw channels logout` luego `openclaw channels login`.
- Gateway inaccesible → inícialo: `openclaw gateway --port 18789` (usa `--force` si el puerto está ocupado).
- Sin mensajes entrantes → confirma que el teléfono vinculado está en línea y el remitente está permitido (`channels.whatsapp.allowFrom`); para chats grupales, asegura que allowlist + reglas de mención coincidan (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Comando "health" dedicado

`openclaw health --json` pide al Gateway en ejecución su instantánea de salud (sin sockets de canal directos desde el CLI). Reporta creds vinculados/edad de auth cuando están disponibles, resúmenes de prueba por canal, resumen del almacén de sesiones, y una duración de prueba. Sale con código no-cero si el Gateway es inaccesible o la prueba falla/agota tiempo. Usa `--timeout <ms>` para anular el predeterminado de 10s.
