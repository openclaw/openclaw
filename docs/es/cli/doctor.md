---
summary: "Referencia de la CLI para `openclaw doctor` (comprobaciones de estado + reparaciones guiadas)"
read_when:
  - Tiene problemas de conectividad/autenticación y quiere correcciones guiadas
  - Actualizó y quiere una verificación rápida
title: "doctor"
---

# `openclaw doctor`

Comprobaciones de estado + correcciones rápidas para el Gateway (puerta de enlace) y los canales.

Relacionado:

- Solución de problemas: [Troubleshooting](/gateway/troubleshooting)
- Auditoría de seguridad: [Security](/gateway/security)

## Ejemplos

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notas:

- Los avisos interactivos (como correcciones de llavero/OAuth) solo se ejecutan cuando stdin es un TTY y `--non-interactive` **no** está configurado. Las ejecuciones sin interfaz (cron, Telegram, sin terminal) omitirán los avisos.
- `--fix` (alias de `--repair`) escribe una copia de seguridad en `~/.openclaw/openclaw.json.bak` y elimina claves de configuración desconocidas, enumerando cada eliminación.

## macOS: anulaciones de variables de entorno de `launchctl`

Si previamente ejecutó `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (o `...PASSWORD`), ese valor anula su archivo de configuración y puede causar errores persistentes de «no autorizado».

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
