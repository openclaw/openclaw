---
summary: "Endurecer el manejo de entradas de cron.add, alinear esquemas y mejorar las herramientas de UI/agente de cron"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Endurecimiento de Cron Add"
---

# Endurecimiento de Cron Add y Alineación de Esquemas

## Contexto

Los registros recientes del Gateway muestran fallos repetidos de `cron.add` con parámetros inválidos (falta `sessionTarget`, `wakeMode`, `payload`, y `schedule` malformado). Esto indica que al menos un cliente (probablemente la ruta de llamada de herramienta del agente) está enviando payloads de trabajo envueltos o parcialmente especificados. Por separado, hay desviación entre los enums de proveedor de cron en TypeScript, el esquema del Gateway, las flags de CLI y los tipos de formulario de UI, además de una discrepancia en la UI para `cron.status` (espera `jobCount` mientras que el Gateway devuelve `jobs`).

## Objetivos

- Detener el spam de INVALID_REQUEST de `cron.add` normalizando payloads de envoltura comunes e infiriendo campos `kind` faltantes.
- Alinear las listas de proveedores de cron en el esquema del Gateway, los tipos de cron, la documentación de CLI y los formularios de UI.
- Hacer explícito el esquema de herramienta de cron del agente para que el LLM produzca payloads de trabajo correctos.
- Corregir la visualización del conteo de trabajos del estado de cron en la Interfaz de Control.
- Agregar pruebas para cubrir la normalización y el comportamiento de las herramientas.

## No objetivos

- Cambiar la semántica de programación de cron o el comportamiento de ejecución de trabajos.
- Agregar nuevos tipos de programación o análisis de expresiones cron.
- Revisar completamente la UI/UX de cron más allá de las correcciones de campos necesarias.

## Hallazgos (brechas actuales)

- `CronPayloadSchema` en el Gateway excluye `signal` + `imessage`, mientras que los tipos de TS los incluyen.
- La UI de Control CronStatus espera `jobCount`, pero el Gateway devuelve `jobs`.
- El esquema de herramienta de cron del agente permite objetos `job` arbitrarios, habilitando entradas malformadas.
- El Gateway valida estrictamente `cron.add` sin normalización, por lo que los payloads envueltos fallan.

## Qué cambió

- `cron.add` y `cron.update` ahora normalizan formas de envoltura comunes e infieren campos `kind` faltantes.
- El esquema de herramienta de cron del agente coincide con el esquema del Gateway, lo que reduce los payloads inválidos.
- Los enums de proveedores están alineados en Gateway, CLI, UI y el selector de macOS.
- La Interfaz de Control usa el campo de conteo `jobs` del Gateway para el estado.

## Comportamiento actual

- **Normalización:** los payloads envueltos de `data`/`job` se desenvuelven; `schedule.kind` y `payload.kind` se infieren cuando es seguro.
- **Valores predeterminados:** se aplican valores predeterminados seguros para `wakeMode` y `sessionTarget` cuando faltan.
- **Proveedores:** Discord/Slack/Signal/iMessage ahora se muestran consistentemente en CLI/UI.

Consulta [Tareas programadas](/es-ES/automation/cron-jobs) para la forma normalizada y ejemplos.

## Verificación

- Observa los registros del Gateway para ver la reducción de errores INVALID_REQUEST de `cron.add`.
- Confirma que el estado de cron en la Interfaz de Control muestra el conteo de trabajos después de actualizar.

## Seguimientos opcionales

- Prueba manual de la Interfaz de Control: agregar un trabajo de cron por proveedor + verificar el conteo de trabajos en el estado.

## Preguntas abiertas

- ¿Debería `cron.add` aceptar `state` explícito de los clientes (actualmente no permitido por el esquema)?
- ¿Deberíamos permitir `webchat` como proveedor de entrega explícito (actualmente filtrado en la resolución de entrega)?
