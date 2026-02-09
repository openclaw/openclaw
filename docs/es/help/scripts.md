---
summary: "Scripts del repositorio: propósito, alcance y notas de seguridad"
read_when:
  - Al ejecutar scripts del repositorio
  - Al agregar o cambiar scripts bajo ./scripts
title: "Scripts"
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
