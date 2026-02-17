---
summary: "Referencia CLI para `openclaw doctor` (comprobaciones de salud + reparaciones guiadas)"
read_when:
  - Tienes problemas de conectividad/autenticación y quieres correcciones guiadas
  - Actualizaste y quieres una comprobación de cordura
title: "doctor"
---

# `openclaw doctor`

Comprobaciones de salud + correcciones rápidas para el gateway y canales.

Relacionado:

- Solución de problemas: [Solución de problemas](/es-ES/gateway/troubleshooting)
- Auditoría de seguridad: [Seguridad](/es-ES/gateway/security)

## Ejemplos

```bash
openclaw doctor
openclaw doctor --repair
openclaw doctor --deep
```

Notas:

- Los prompts interactivos (como correcciones de keychain/OAuth) solo se ejecutan cuando stdin es un TTY y `--non-interactive` **no** está establecido. Las ejecuciones sin interfaz (cron, Telegram, sin terminal) omitirán los prompts.
- `--fix` (alias para `--repair`) escribe una copia de seguridad en `~/.openclaw/openclaw.json.bak` y elimina claves de configuración desconocidas, listando cada eliminación.

## macOS: sobrescrituras de env de `launchctl`

Si previamente ejecutaste `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (o `...PASSWORD`), ese valor sobrescribe tu archivo de configuración y puede causar errores persistentes de "no autorizado".

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```
