---
summary: "Monitorear la caducidad de OAuth para proveedores de modelos"
read_when:
  - Configurar el monitoreo o alertas de caducidad de autenticación
  - Automatizar verificaciones de actualización de OAuth de Claude Code / Codex
title: "Monitoreo de autenticación"
---

# Monitoreo de autenticación

OpenClaw expone el estado de caducidad de OAuth a través de `openclaw models status`. Use eso para
automatización y alertas; los scripts son extras opcionales para flujos de trabajo en el teléfono.

## Preferido: verificación por CLI (portable)

```bash
openclaw models status --check
```

Códigos de salida:

- `0`: OK
- `1`: credenciales caducadas o faltantes
- `2`: a punto de caducar (dentro de 24 h)

Esto funciona en cron/systemd y no requiere scripts adicionales.

## Scripts opcionales (operaciones / flujos de trabajo en el teléfono)

Estos viven bajo `scripts/` y son **opcionales**. Asumen acceso SSH al
host del Gateway y están ajustados para systemd + Termux.

- `scripts/claude-auth-status.sh` ahora usa `openclaw models status --json` como la
  fuente de verdad (recurriendo a lecturas directas de archivos si la CLI no está disponible),
  así que mantenga `openclaw` en `PATH` para los temporizadores.
- `scripts/auth-monitor.sh`: objetivo de cron/systemd; envía alertas (ntfy o teléfono).
- `scripts/systemd/openclaw-auth-monitor.{service,timer}`: temporizador de usuario de systemd.
- `scripts/claude-auth-status.sh`: verificador de autenticación de Claude Code + OpenClaw (completo/json/simple).
- `scripts/mobile-reauth.sh`: flujo guiado de reautenticación por SSH.
- `scripts/termux-quick-auth.sh`: estado del widget de un toque + abrir URL de autenticación.
- `scripts/termux-auth-widget.sh`: flujo completo guiado del widget.
- `scripts/termux-sync-widget.sh`: sincronizar credenciales de Claude Code → OpenClaw.

Si no necesita automatización en el teléfono ni temporizadores de systemd, omita estos scripts.
