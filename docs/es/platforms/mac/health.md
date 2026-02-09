---
summary: "Cómo la app de macOS informa los estados de salud del Gateway/Baileys"
read_when:
  - Depuración de los indicadores de salud de la app de macOS
title: "Comprobaciones de salud"
---

# Comprobaciones de salud en macOS

Cómo ver si el canal vinculado está en buen estado desde la app de la barra de menú.

## Barra de menú

- El punto de estado ahora refleja la salud de Baileys:
  - Verde: vinculado + socket abierto recientemente.
  - Naranja: conectando/reintentando.
  - Rojo: sesión cerrada o sonda fallida.
- La línea secundaria muestra "linked · auth 12m" o indica el motivo del fallo.
- El elemento de menú "Run Health Check" activa una sonda bajo demanda.

## Ajustes

- La pestaña General incorpora una tarjeta de Salud que muestra: antigüedad de autenticación vinculada, ruta/conteo del almacén de sesiones, hora de la última comprobación, último error/código de estado, y botones para Run Health Check / Reveal Logs.
- Usa una instantánea en caché para que la interfaz cargue al instante y haga una degradación elegante cuando esté sin conexión.
- La pestaña **Channels** expone el estado del canal + controles para WhatsApp/Telegram (QR de inicio de sesión, cerrar sesión, sonda, último desconecte/error).

## Cómo funciona la sonda

- La app ejecuta `openclaw health --json` mediante `ShellExecutor` cada ~60 s y bajo demanda. La sonda carga credenciales e informa el estado sin enviar mensajes.
- Almacena en caché por separado la última instantánea correcta y el último error para evitar parpadeos; muestra la marca de tiempo de cada uno.

## Cuando tenga dudas

- Aún puede usar el flujo de la CLI en [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) y seguir `/tmp/openclaw/openclaw-*.log` para `web-heartbeat` / `web-reconnect`.
