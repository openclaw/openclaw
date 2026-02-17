---
summary: "Notas de investigación: sistema de memoria offline para espacios de trabajo de Clawd (fuente de verdad en Markdown + índice derivado)"
read_when:
  - Diseñando memoria de espacio de trabajo (~/.openclaw/workspace) más allá de registros diarios en Markdown
  - Decidiendo: CLI independiente vs integración profunda con OpenClaw
  - Agregando recall y reflexión offline (retain/recall/reflect)
title: "Investigación de Memoria de Espacio de Trabajo"
---

# Memoria de Espacio de Trabajo v2 (offline): notas de investigación

Objetivo: espacio de trabajo estilo Clawd (`agents.defaults.workspace`, predeterminado `~/.openclaw/workspace`) donde la "memoria" se almacena como un archivo Markdown por día (`memory/YYYY-MM-DD.md`) más un pequeño conjunto de archivos estables (por ejemplo, `memory.md`, `SOUL.md`).

Este documento propone una arquitectura de memoria **offline-first** que mantiene Markdown como la fuente canónica y revisable de verdad, pero agrega **recall estructurado** (búsqueda, resúmenes de entidades, actualizaciones de confianza) a través de un índice derivado.

## ¿Por qué cambiar?

La configuración actual (un archivo por día) es excelente para:

- journaling de solo agregar
- edición humana
- durabilidad + auditabilidad respaldada por git
- captura de baja fricción ("solo escríbelo")

Es débil para:

- recuperación de alto recall ("¿qué decidimos sobre X?", "¿la última vez que intentamos Y?")
- respuestas centradas en entidades ("cuéntame sobre Alice / The Castle / warelay") sin releer muchos archivos
- estabilidad de opinión/preferencia (y evidencia cuando cambia)
- restricciones de tiempo ("¿qué era cierto durante noviembre de 2025?") y resolución de conflictos

## Objetivos de diseño

- **Offline**: funciona sin red; puede ejecutarse en laptop/Castle; sin dependencia en la nube.
- **Explicable**: los ítems recuperados deben ser atribuibles (archivo + ubicación) y separables de la inferencia.
- **Baja ceremonia**: el registro diario permanece en Markdown, sin trabajo pesado de esquema.
- **Incremental**: v1 es útil solo con FTS; semántico/vector y grafos son actualizaciones opcionales.
- **Amigable para agentes**: hace que "recall dentro de presupuestos de tokens" sea fácil (devolver pequeños paquetes de hechos).

## Modelo estrella del norte (Hindsight × Letta)

Dos piezas para mezclar:

1. **Bucle de control estilo Letta/MemGPT**

- mantener un pequeño "núcleo" siempre en contexto (persona + hechos clave del usuario)
- todo lo demás está fuera de contexto y se recupera a través de herramientas
- las escrituras de memoria son llamadas de herramientas explícitas (append/replace/insert), persistidas, luego reinyectadas en el siguiente turno

2. **Sustrato de memoria estilo Hindsight**

- separar lo observado vs lo creído vs lo resumido
- soportar retain/recall/reflect
- opiniones con confianza que pueden evolucionar con evidencia
- recuperación consciente de entidades + consultas temporales (incluso sin grafos de conocimiento completos)

## Arquitectura propuesta (fuente de verdad en Markdown + índice derivado)

### Almacenamiento canónico (amigable con git)

Mantener `~/.openclaw/workspace` como memoria canónica legible por humanos.

Disposición de espacio de trabajo sugerida:

```
~/.openclaw/workspace/
  memory.md                    # pequeño: hechos durables + preferencias (tipo núcleo)
  memory/
    YYYY-MM-DD.md              # registro diario (agregar; narrativo)
  bank/                        # páginas de memoria "tipadas" (estables, revisables)
    world.md                   # hechos objetivos sobre el mundo
    experience.md              # lo que hizo el agente (primera persona)
    opinions.md                # prefs/juicios subjetivos + confianza + punteros de evidencia
    entities/
      Peter.md
      The-Castle.md
      warelay.md
      ...
```

Notas:

- **El registro diario permanece como registro diario**. No hay necesidad de convertirlo en JSON.
- Los archivos de `bank/` están **curados**, producidos por trabajos de reflexión, y todavía pueden editarse a mano.
- `memory.md` permanece "pequeño + tipo núcleo": las cosas que quieres que Clawd vea en cada sesión.

### Almacenamiento derivado (recall de máquina)

Agregar un índice derivado bajo el espacio de trabajo (no necesariamente rastreado por git):

```
~/.openclaw/workspace/.memory/index.sqlite
```

Respaldarlo con:

- Esquema SQLite para hechos + enlaces de entidades + metadatos de opinión
- **FTS5** de SQLite para recall léxico (rápido, pequeño, offline)
- tabla de embeddings opcional para recall semántico (todavía offline)

El índice es siempre **reconstruible desde Markdown**.

## Retain / Recall / Reflect (bucle operacional)

### Retain: normalizar registros diarios en "hechos"

La idea clave de Hindsight que importa aquí: almacenar **hechos narrativos y autocontenidos**, no fragmentos pequeños.

Regla práctica para `memory/YYYY-MM-DD.md`:

- al final del día (o durante), agregar una sección `## Retain` con 2–5 viñetas que sean:
  - narrativas (contexto entre turnos preservado)
  - autocontenidas (tiene sentido por sí solo más tarde)
  - etiquetadas con tipo + menciones de entidades

Ejemplo:

```
## Retain
- W @Peter: Actualmente en Marrakech (27 nov – 1 dic 2025) para el cumpleaños de Andy.
- B @warelay: Arreglé el crash de Baileys WS envolviendo manejadores de connection.update en try/catch (ver memory/2025-11-27.md).
- O(c=0.95) @Peter: Prefiere respuestas concisas (<1500 caracteres) en WhatsApp; el contenido largo va en archivos.
```

Análisis mínimo:

- Prefijo de tipo: `W` (world), `B` (experience/biográfico), `O` (opinión), `S` (observación/resumen; generalmente generado)
- Entidades: `@Peter`, `@warelay`, etc (slugs mapean a `bank/entities/*.md`)
- Confianza de opinión: `O(c=0.0..1.0)` opcional

Si no quieres que los autores piensen en ello: el trabajo de reflexión puede inferir estas viñetas del resto del registro, pero tener una sección `## Retain` explícita es la "palanca de calidad" más fácil.

### Recall: consultas sobre el índice derivado

Recall debería soportar:

- **léxico**: "encontrar términos / nombres / comandos exactos" (FTS5)
- **entidad**: "cuéntame sobre X" (páginas de entidad + hechos vinculados a entidad)
- **temporal**: "qué pasó alrededor del 27 de noviembre" / "desde la semana pasada"
- **opinión**: "¿qué prefiere Peter?" (con confianza + evidencia)

El formato de retorno debe ser amigable para agentes y citar fuentes:

- `kind` (`world|experience|opinion|observation`)
- `timestamp` (día de origen, o rango de tiempo extraído si está presente)
- `entities` (`["Peter","warelay"]`)
- `content` (el hecho narrativo)
- `source` (`memory/2025-11-27.md#L12` etc)

### Reflect: producir páginas estables + actualizar creencias

La reflexión es un trabajo programado (diario o heartbeat `ultrathink`) que:

- actualiza `bank/entities/*.md` de hechos recientes (resúmenes de entidades)
- actualiza confianza de `bank/opinions.md` basado en refuerzo/contradicción
- opcionalmente propone ediciones a `memory.md` (hechos durables "tipo núcleo")

Evolución de opinión (simple, explicable):

- cada opinión tiene:
  - declaración
  - confianza `c ∈ [0,1]`
  - last_updated
  - enlaces de evidencia (IDs de hechos de apoyo + contradictorios)
- cuando llegan hechos nuevos:
  - encontrar opiniones candidatas por superposición de entidad + similitud (FTS primero, embeddings después)
  - actualizar confianza por pequeños deltas; grandes saltos requieren contradicción fuerte + evidencia repetida

## Integración de CLI: independiente vs integración profunda

Recomendación: **integración profunda en OpenClaw**, pero mantener una biblioteca central separable.

### ¿Por qué integrar en OpenClaw?

- OpenClaw ya conoce:
  - la ruta del espacio de trabajo (`agents.defaults.workspace`)
  - el modelo de sesión + heartbeats
  - patrones de registro + solución de problemas
- Quieres que el agente mismo llame a las herramientas:
  - `openclaw memory recall "…" --k 25 --since 30d`
  - `openclaw memory reflect --since 7d`

### ¿Por qué todavía dividir una biblioteca?

- mantener la lógica de memoria testeable sin gateway/runtime
- reutilizar desde otros contextos (scripts locales, futura aplicación de escritorio, etc.)

Forma:
Las herramientas de memoria están destinadas a ser una pequeña capa de CLI + biblioteca, pero esto es solo exploratorio.

## "S-Collide" / SuCo: cuándo usarlo (investigación)

Si "S-Collide" se refiere a **SuCo (Subspace Collision)**: es un enfoque de recuperación ANN que apunta a tradeoffs fuertes de recall/latencia usando colisiones aprendidas/estructuradas en subespacios (paper: arXiv 2411.14754, 2024).

Enfoque pragmático para `~/.openclaw/workspace`:

- **no comiences** con SuCo.
- comienza con FTS de SQLite + embeddings simples (opcionales); obtendrás la mayoría de las ganancias de UX inmediatamente.
- considera soluciones clase SuCo/HNSW/ScaNN solo una vez:
  - el corpus es grande (decenas/cientos de miles de fragmentos)
  - la búsqueda de embeddings de fuerza bruta se vuelve demasiado lenta
  - la calidad de recall está significativamente limitada por la búsqueda léxica

Alternativas amigables con offline (en complejidad creciente):

- FTS5 de SQLite + filtros de metadatos (cero ML)
- Embeddings + fuerza bruta (funciona sorprendentemente lejos si el conteo de fragmentos es bajo)
- Índice HNSW (común, robusto; necesita un binding de biblioteca)
- SuCo (grado de investigación; atractivo si hay una implementación sólida que puedas embeber)

Pregunta abierta:

- ¿cuál es el **mejor** modelo de embedding offline para "memoria de asistente personal" en tus máquinas (laptop + escritorio)?
  - si ya tienes Ollama: embebe con un modelo local; de lo contrario, envía un modelo de embedding pequeño en el toolchain.

## Piloto útil más pequeño

Si quieres una versión mínima pero útil:

- Agregar páginas de entidades de `bank/` y una sección `## Retain` en registros diarios.
- Usar FTS de SQLite para recall con citas (ruta + números de línea).
- Agregar embeddings solo si la calidad de recall o la escala lo demandan.

## Referencias

- Conceptos de Letta / MemGPT: "bloques de memoria núcleo" + "memoria archival" + autoedición de memoria dirigida por herramientas.
- Reporte técnico de Hindsight: "retain / recall / reflect", memoria de cuatro redes, extracción de hechos narrativos, evolución de confianza de opinión.
- SuCo: arXiv 2411.14754 (2024): recuperación de vecino más cercano aproximado "Subspace Collision".
