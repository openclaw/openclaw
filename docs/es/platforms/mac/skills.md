---
summary: "Interfaz de configuración de Skills en macOS y estado respaldado por el Gateway"
read_when:
  - Actualizar la interfaz de configuración de Skills en macOS
  - Cambiar el control de acceso o el comportamiento de instalación de Skills
title: "Skills"
---

# Skills (macOS)

La app de macOS expone las Skills de OpenClaw a través del Gateway; no analiza las Skills localmente.

## Fuente de datos

- `skills.status` (Gateway) devuelve todas las Skills más la elegibilidad y los requisitos faltantes
  (incluidos los bloqueos de lista de permitidos para Skills incluidas).
- Los requisitos se derivan de `metadata.openclaw.requires` en cada `SKILL.md`.

## Acciones de instalación

- `metadata.openclaw.install` define las opciones de instalación (brew/node/go/uv).
- La app llama a `skills.install` para ejecutar los instaladores en el host del Gateway.
- El Gateway expone solo un instalador preferido cuando se proporcionan varios
  (brew cuando está disponible; de lo contrario, el gestor de node de `skills.install`, npm predeterminado).

## Claves de entorno/API

- La app almacena las claves en `~/.openclaw/openclaw.json` bajo `skills.entries.<skillKey>`.
- `skills.update` aplica parches a `enabled`, `apiKey` y `env`.

## Modo remoto

- La instalación y las actualizaciones de configuración ocurren en el host del Gateway (no en el Mac local).
