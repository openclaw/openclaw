---
summary: "Scripts del repositorio: propósito, alcance y notas de seguridad"
read_when:
  - Al ejecutar scripts del repositorio
  - Al agregar o cambiar scripts bajo ./scripts
title: "Scripts"
x-i18n:
  source_path: help/scripts.md
  source_hash: efd220df28f20b33
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:36Z
---

# Scripts

El directorio `scripts/` contiene scripts de ayuda para flujos de trabajo locales y tareas operativas.
Úselos cuando una tarea esté claramente vinculada a un script; de lo contrario, prefiera la CLI.

## Convenciones

- Los scripts son **opcionales** a menos que se mencionen en la documentación o en listas de verificación de versiones.
- Prefiera las superficies de la CLI cuando existan (ejemplo: el monitoreo de autenticación usa `openclaw models status --check`).
- Asuma que los scripts son específicos del host; léalos antes de ejecutarlos en una máquina nueva.

## Scripts de monitoreo de autenticación

Los scripts de monitoreo de autenticación están documentados aquí:
[/automation/auth-monitoring](/automation/auth-monitoring)

## Al agregar scripts

- Mantenga los scripts enfocados y documentados.
- Agregue una entrada breve en el documento relevante (o cree uno si falta).
