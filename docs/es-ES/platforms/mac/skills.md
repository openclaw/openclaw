---
summary: "UI de configuración de Habilidades de macOS y estado respaldado por el gateway"
read_when:
  - Actualizando la UI de configuración de Habilidades de macOS
  - Cambiando el gating o comportamiento de instalación de habilidades
title: "Habilidades"
---

# Habilidades (macOS)

La app de macOS muestra las habilidades de OpenClaw vía el gateway; no parsea habilidades localmente.

## Fuente de datos

- `skills.status` (gateway) devuelve todas las habilidades más elegibilidad y requisitos faltantes
  (incluyendo bloqueos de allowlist para habilidades incluidas).
- Los requisitos se derivan de `metadata.openclaw.requires` en cada `SKILL.md`.

## Acciones de instalación

- `metadata.openclaw.install` define opciones de instalación (brew/node/go/uv).
- La app llama a `skills.install` para ejecutar instaladores en el host del gateway.
- El gateway muestra solo un instalador preferido cuando se proporcionan múltiples
  (brew cuando está disponible, de lo contrario gestor de node desde `skills.install`, npm por defecto).

## Env/claves API

- La app almacena claves en `~/.openclaw/openclaw.json` bajo `skills.entries.<skillKey>`.
- `skills.update` parchea `enabled`, `apiKey`, y `env`.

## Modo remoto

- Las actualizaciones de instalación + configuración ocurren en el host del gateway (no en el Mac local).
