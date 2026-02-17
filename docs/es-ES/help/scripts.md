---
summary: "Scripts del repositorio: propósito, alcance y notas de seguridad"
read_when:
  - Ejecutando scripts del repositorio
  - Agregando o cambiando scripts bajo ./scripts
title: "Scripts"
---

# Scripts

El directorio `scripts/` contiene scripts auxiliares para flujos de trabajo locales y tareas de operaciones.
Usa estos cuando una tarea está claramente vinculada a un script; de lo contrario prefiere el CLI.

## Convenciones

- Los scripts son **opcionales** a menos que se referencien en documentos o listas de verificación de versiones.
- Prefiere superficies CLI cuando existan (ejemplo: el monitoreo de autenticación usa `openclaw models status --check`).
- Asume que los scripts son específicos del host; léelos antes de ejecutarlos en una máquina nueva.

## Scripts de monitoreo de autenticación

Los scripts de monitoreo de autenticación están documentados aquí:
[/es-ES/automation/auth-monitoring](/es-ES/automation/auth-monitoring)

## Al agregar scripts

- Mantén los scripts enfocados y documentados.
- Agrega una entrada breve en el documento relevante (o crea uno si falta).
