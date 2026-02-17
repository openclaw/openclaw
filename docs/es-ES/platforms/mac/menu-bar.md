---
summary: "Lógica de estado de la barra de menú y qué se muestra a los usuarios"
read_when:
  - Ajustando la UI del menú de Mac o lógica de estado
title: "Barra de Menú"
---

# Lógica de Estado de la Barra de Menú

## Qué se muestra

- Mostramos el estado actual del trabajo del agente en el icono de la barra de menú y en la primera fila de estado del menú.
- El estado de salud se oculta mientras el trabajo está activo; regresa cuando todas las sesiones están inactivas.
- El bloque "Nodes" en el menú lista **dispositivos** solamente (nodos emparejados vía `node.list`), no entradas de cliente/presencia.
- Una sección "Usage" aparece bajo Context cuando están disponibles instantáneas de uso del proveedor.

## Modelo de estado

- Sesiones: los eventos llegan con `runId` (por ejecución) más `sessionKey` en el payload. La sesión "main" es la clave `main`; si está ausente, recurrimos a la sesión actualizada más recientemente.
- Prioridad: main siempre gana. Si main está activa, su estado se muestra inmediatamente. Si main está inactiva, se muestra la sesión no‑main activa más recientemente. No alternamos en medio de la actividad; solo cambiamos cuando la sesión actual pasa a inactiva o main se vuelve activa.
- Tipos de actividad:
  - `job`: ejecución de comando de alto nivel (`state: started|streaming|done|error`).
  - `tool`: `phase: start|result` con `toolName` y `meta/args`.

## Enum IconState (Swift)

- `idle`
- `workingMain(ActivityKind)`
- `workingOther(ActivityKind)`
- `overridden(ActivityKind)` (override de depuración)

### ActivityKind → glyph

- `exec` → 💻
- `read` → 📄
- `write` → ✍️
- `edit` → 📝
- `attach` → 📎
- default → 🛠️

### Mapeo visual

- `idle`: critter normal.
- `workingMain`: insignia con glyph, tinte completo, animación de pata "trabajando".
- `workingOther`: insignia con glyph, tinte apagado, sin scurry.
- `overridden`: usa el glyph/tinte elegido independientemente de la actividad.

## Texto de la fila de estado (menú)

- Mientras el trabajo está activo: `<Rol de sesión> · <etiqueta de actividad>`
  - Ejemplos: `Main · exec: pnpm test`, `Other · read: apps/macos/Sources/OpenClaw/AppState.swift`.
- Cuando está inactivo: recurre al resumen de salud.

## Ingesta de eventos

- Fuente: eventos `agent` del canal de control (`ControlChannel.handleAgentEvent`).
- Campos parseados:
  - `stream: "job"` con `data.state` para inicio/parada.
  - `stream: "tool"` con `data.phase`, `name`, `meta`/`args` opcionales.
- Etiquetas:
  - `exec`: primera línea de `args.command`.
  - `read`/`write`: ruta acortada.
  - `edit`: ruta más tipo de cambio inferido de `meta`/conteos de diff.
  - fallback: nombre de la herramienta.

## Override de depuración

- Settings ▸ Debug ▸ selector "Icon override":
  - `System (auto)` (predeterminado)
  - `Working: main` (por tipo de herramienta)
  - `Working: other` (por tipo de herramienta)
  - `Idle`
- Almacenado vía `@AppStorage("iconOverride")`; mapeado a `IconState.overridden`.

## Checklist de testing

- Disparar job de sesión main: verificar que el icono cambie inmediatamente y la fila de estado muestre la etiqueta main.
- Disparar job de sesión no‑main mientras main está inactiva: icono/estado muestra no‑main; permanece estable hasta que termine.
- Iniciar main mientras otra está activa: el icono cambia a main instantáneamente.
- Ráfagas rápidas de herramientas: asegurar que la insignia no parpadee (TTL grace en resultados de herramientas).
- La fila de salud reaparece una vez que todas las sesiones están inactivas.
