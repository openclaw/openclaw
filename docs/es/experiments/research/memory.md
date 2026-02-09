---
summary: "Notas de investigación: sistema de memoria offline para espacios de trabajo de Clawd (Markdown como fuente de verdad + índice derivado)"
read_when:
  - Diseñar la memoria del espacio de trabajo (~/.openclaw/workspace) más allá de los registros diarios en Markdown
  - Deciding: "Decidir: CLI independiente vs integración profunda con OpenClaw"
  - Agregar recuerdo offline + reflexión (retener/recordar/reflexionar)
title: "Investigación sobre la memoria del espacio de trabajo"
---

# Memoria del espacio de trabajo v2 (offline): notas de investigación

Objetivo: espacio de trabajo estilo Clawd (`agents.defaults.workspace`, predeterminado `~/.openclaw/workspace`) donde la “memoria” se almacena como un archivo Markdown por día (`memory/YYYY-MM-DD.md`) más un pequeño conjunto de archivos estables (p. ej., `memory.md`, `SOUL.md`).

Este documento propone una arquitectura de memoria **offline-first** que mantiene Markdown como la fuente de verdad canónica y revisable, pero agrega **recuerdo estructurado** (búsqueda, resúmenes de entidades, actualizaciones de confianza) mediante un índice derivado.

## ¿Por qué cambiar?

La configuración actual (un archivo por día) es excelente para:

- registro “append-only”
- edición humana
- durabilidad y auditabilidad respaldadas por git
- captura de baja fricción (“solo escríbalo”)

Es débil para:

- recuperación de alto recuerdo (“¿qué decidimos sobre X?”, “¿la última vez que intentamos Y?”)
- respuestas centradas en entidades (“hábleme de Alice / The Castle / warelay”) sin releer muchos archivos
- estabilidad de opiniones/preferencias (y evidencia cuando cambia)
- restricciones temporales (“¿qué era cierto durante nov de 2025?”) y resolución de conflictos

## Objetivos de diseño

- **Offline**: funciona sin red; puede ejecutarse en laptop/Castle; sin dependencia de la nube.
- **Explicable**: los elementos recuperados deben ser atribuibles (archivo + ubicación) y separables de la inferencia.
- **Baja ceremonia**: el registro diario sigue siendo Markdown, sin trabajo pesado de esquemas.
- **Incremental**: v1 es útil solo con FTS; semántica/vector y grafos son mejoras opcionales.
- **Amigable para agentes**: facilita el “recuerdo dentro de presupuestos de tokens” (devuelve pequeños conjuntos de hechos).

## Modelo norte (Hindsight × Letta)

Dos piezas a combinar:

1. **Bucle de control estilo Letta/MemGPT**

- mantener un pequeño “núcleo” siempre en contexto (persona + hechos clave del usuario)
- todo lo demás queda fuera de contexto y se recupera mediante herramientas
- las escrituras de memoria son llamadas explícitas a herramientas (append/replace/insert), se persisten y luego se reinyectan en el siguiente turno

2. **Sustrato de memoria estilo Hindsight**

- separar lo observado vs lo creído vs lo resumido
- admitir retener/recordar/reflexionar
- opiniones con confianza que pueden evolucionar con evidencia
- recuperación consciente de entidades + consultas temporales (incluso sin grafos de conocimiento completos)

## Arquitectura propuesta (Markdown como fuente de verdad + índice derivado)

### Almacén canónico (amigable con git)

Mantener `~/.openclaw/workspace` como memoria canónica legible por humanos.

Diseño sugerido del espacio de trabajo:

```
~/.openclaw/workspace/
  memory.md                    # small: durable facts + preferences (core-ish)
  memory/
    YYYY-MM-DD.md              # daily log (append; narrative)
  bank/                        # “typed” memory pages (stable, reviewable)
    world.md                   # objective facts about the world
    experience.md              # what the agent did (first-person)
    opinions.md                # subjective prefs/judgments + confidence + evidence pointers
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Notas:

- **El registro diario sigue siendo registro diario**. No es necesario convertirlo a JSON.
- Los archivos `bank/` son **curados**, producidos por trabajos de reflexión, y aún pueden editarse a mano.
- `memory.md` permanece “pequeño + tipo núcleo”: las cosas que quiere que Clawd vea en cada sesión.

### Almacén derivado (recuerdo de máquina)

Agregar un índice derivado bajo el espacio de trabajo (no necesariamente con seguimiento en git):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Respaldarlo con:

- esquema SQLite para hechos + enlaces de entidades + metadatos de opiniones
- SQLite **FTS5** para recuerdo léxico (rápido, pequeño, offline)
- tabla opcional de embeddings para recuerdo semántico (aún offline)

El índice es siempre **reconstruible desde Markdown**.

## Retener / Recordar / Reflexionar (bucle operativo)

### Retener: normalizar registros diarios en “hechos”

La visión clave de Hindsight que importa aquí: almacene **hechos narrativos y autosuficientes**, no pequeños fragmentos.

Regla práctica para `memory/YYYY-MM-DD.md`:

- al final del día (o durante), agregue una sección `## Retain` con 2–5 viñetas que sean:
  - narrativas (se preserva el contexto entre turnos)
  - autocontenidas (tienen sentido por sí solas más adelante)
  - etiquetadas con tipo + menciones de entidades

Ejemplo:

```
## Retain
- W @Peter: Currently in Marrakech (Nov 27–Dec 1, 2025) for Andy’s birthday.
- B @warelay: I fixed the Baileys WS crash by wrapping connection.update handlers in try/catch (see memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefers concise replies (&lt;1500 chars) on WhatsApp; long content goes into files.
```

Análisis mínimo:

- Prefijo de tipo: `W` (mundo), `B` (experiencia/biográfico), `O` (opinión), `S` (observación/resumen; normalmente generado)
- Entidades: `@Peter`, `@warelay`, etc. (los slugs mapean a `bank/entities/*.md`)
- Confianza de opinión: `O(c=0.0..1.0)` opcional

Si no quiere que los autores piensen en esto: el trabajo de reflexión puede inferir estas viñetas a partir del resto del registro, pero tener una sección explícita `## Retain` es la palanca de calidad más sencilla.

### Recordar: consultas sobre el índice derivado

El recuerdo debe admitir:

- **léxico**: “encontrar términos/nombres/comandos exactos” (FTS5)
- **entidades**: “hábleme de X” (páginas de entidades + hechos vinculados a entidades)
- **temporal**: “qué pasó alrededor del 27 de nov” / “desde la semana pasada”
- **opinión**: “¿qué prefiere Peter?” (con confianza + evidencia)

El formato de retorno debe ser amigable para agentes y citar fuentes:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (día fuente, o rango temporal extraído si existe)
- `entities` (`["Peter","warelay"]`)
- `content` (el hecho narrativo)
- `source` (`memory/2025-11-27.md#L12` etc.)

### Reflexionar: producir páginas estables + actualizar creencias

La reflexión es un trabajo programado (diario o latido `ultrathink`) que:

- actualiza `bank/entities/*.md` a partir de hechos recientes (resúmenes de entidades)
- actualiza la confianza de `bank/opinions.md` según refuerzo/contradicción
- opcionalmente propone ediciones a `memory.md` (hechos duraderos “tipo núcleo”)

Evolución de opiniones (simple, explicable):

- cada opinión tiene:
  - enunciado
  - confianza `c ∈ [0,1]`
  - last_updated
  - enlaces de evidencia (IDs de hechos que apoyan + contradicen)
- cuando llegan nuevos hechos:
  - encontrar opiniones candidatas por solapamiento de entidades + similitud (primero FTS, luego embeddings)
  - actualizar la confianza con pequeños deltas; los saltos grandes requieren contradicción fuerte + evidencia repetida

## Integración de la CLI: independiente vs integración profunda

Recomendación: **integración profunda en OpenClaw**, pero mantener una biblioteca central separable.

### ¿Por qué integrar en OpenClaw?

- OpenClaw ya conoce:
  - la ruta del espacio de trabajo (`agents.defaults.workspace`)
  - el modelo de sesión + latidos
  - patrones de registro + solución de problemas
- Quiere que el propio agente llame a las herramientas:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### ¿Por qué aun así separar una biblioteca?

- mantener la lógica de memoria testeable sin gateway/runtime
- reutilizarla desde otros contextos (scripts locales, futura app de escritorio, etc.)

Forma:
Las herramientas de memoria están pensadas como una pequeña CLI + capa de biblioteca, pero esto es solo exploratorio.

## “S-Collide” / SuCo: cuándo usarlo (investigación)

Si “S-Collide” se refiere a **SuCo (Subspace Collision)**: es un enfoque de recuperación ANN que apunta a buenos compromisos de recuerdo/latencia usando colisiones aprendidas/estructuradas en subespacios (paper: arXiv 2411.14754, 2024).

Postura pragmática para `~/.openclaw/workspace`:

- **no empiece** con SuCo.
- comience con SQLite FTS + (opcional) embeddings simples; obtendrá la mayoría de las mejoras de UX de inmediato.
- considere soluciones de la clase SuCo/HNSW/ScaNN solo cuando:
  - el corpus sea grande (decenas/cientos de miles de fragmentos)
  - la búsqueda de embeddings por fuerza bruta sea demasiado lenta
  - la calidad de recuerdo esté significativamente limitada por la búsqueda léxica

Alternativas amigables con offline (en complejidad creciente):

- SQLite FTS5 + filtros de metadatos (cero ML)
- Embeddings + fuerza bruta (funciona sorprendentemente lejos si el número de fragmentos es bajo)
- Índice HNSW (común, robusto; requiere un binding de biblioteca)
- SuCo (nivel investigación; atractivo si hay una implementación sólida que pueda incrustar)

Pregunta abierta:

- ¿cuál es el **mejor** modelo de embeddings offline para “memoria de asistente personal” en sus máquinas (laptop + escritorio)?
  - si ya tiene Ollama: incruste con un modelo local; de lo contrario, incluya un modelo pequeño de embeddings en la cadena de herramientas.

## Piloto útil más pequeño

Si quiere una versión mínima, pero aún útil:

- Agregue páginas de entidades `bank/` y una sección `## Retain` en los registros diarios.
- Use SQLite FTS para el recuerdo con citas (ruta + números de línea).
- Agregue embeddings solo si la calidad de recuerdo o la escala lo exigen.

## Referencias

- Conceptos de Letta / MemGPT: “bloques de memoria núcleo” + “memoria de archivo” + memoria autoeditable impulsada por herramientas.
- Informe técnico de Hindsight: “retener / recordar / reflexionar”, memoria de cuatro redes, extracción de hechos narrativos, evolución de la confianza en opiniones.
- SuCo: arXiv 2411.14754 (2024): “Subspace Collision”, recuperación de vecinos más cercanos aproximada.
