---
title: "Memoria"
summary: "Cómo funciona la memoria de OpenClaw (archivos del espacio de trabajo + volcado automático de memoria)"
read_when:
  - Quieres el diseño de archivos de memoria y el flujo de trabajo
  - Quieres ajustar el volcado automático de memoria pre-compactación
---

# Memoria

La memoria de OpenClaw es **Markdown plano en el espacio de trabajo del agente**. Los archivos son la
fuente de verdad; el modelo solo "recuerda" lo que se escribe en disco.

Las herramientas de búsqueda de memoria son proporcionadas por el plugin de memoria activo (predeterminado:
`memory-core`). Deshabilita los plugins de memoria con `plugins.slots.memory = "none"`.

## Archivos de memoria (Markdown)

El diseño predeterminado del espacio de trabajo utiliza dos capas de memoria:

- `memory/YYYY-MM-DD.md`
  - Registro diario (solo añadir).
  - Lee hoy + ayer al inicio de sesión.
- `MEMORY.md` (opcional)
  - Memoria curada a largo plazo.
  - **Solo carga en la sesión principal y privada** (nunca en contextos grupales).

Estos archivos viven bajo el espacio de trabajo (`agents.defaults.workspace`, predeterminado
`~/.openclaw/workspace`). Consulta [Espacio de trabajo del agente](/es-ES/concepts/agent-workspace) para el diseño completo.

## Cuándo escribir memoria

- Decisiones, preferencias y hechos duraderos van a `MEMORY.md`.
- Notas del día a día y contexto en ejecución van a `memory/YYYY-MM-DD.md`.
- Si alguien dice "recuerda esto", escríbelo (no lo mantengas en RAM).
- Esta área aún está evolucionando. Ayuda recordarle al modelo que almacene memorias; sabrá qué hacer.
- Si quieres que algo persista, **pide al bot que lo escriba** en memoria.

## Volcado automático de memoria (ping pre-compactación)

Cuando una sesión está **cerca de la auto-compactación**, OpenClaw activa un **turno
agéntico silencioso** que recuerda al modelo escribir memoria duradera **antes** de que
el contexto sea compactado. Los prompts predeterminados dicen explícitamente que el modelo _puede responder_,
pero usualmente `NO_REPLY` es la respuesta correcta para que el usuario nunca vea este turno.

Esto se controla mediante `agents.defaults.compaction.memoryFlush`:

```json5
{
  agents: {
    defaults: {
      compaction: {
        reserveTokensFloor: 20000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 4000,
          systemPrompt: "Sesión cercana a compactación. Almacena memorias duraderas ahora.",
          prompt: "Escribe cualquier nota duradera en memory/YYYY-MM-DD.md; responde con NO_REPLY si no hay nada que almacenar.",
        },
      },
    },
  },
}
```

Detalles:

- **Umbral suave**: el volcado se activa cuando la estimación de tokens de sesión cruza
  `contextWindow - reserveTokensFloor - softThresholdTokens`.
- **Silencioso** por defecto: los prompts incluyen `NO_REPLY` para que no se entregue nada.
- **Dos prompts**: un prompt de usuario más un prompt de sistema añaden el recordatorio.
- **Un volcado por ciclo de compactación** (rastreado en `sessions.json`).
- **El espacio de trabajo debe ser escribible**: si la sesión se ejecuta en sandbox con
  `workspaceAccess: "ro"` o `"none"`, el volcado se omite.

Para el ciclo completo de compactación, consulta
[Gestión de sesiones + compactación](/es-ES/reference/session-management-compaction).

## Búsqueda de memoria vectorial

OpenClaw puede construir un pequeño índice vectorial sobre `MEMORY.md` y `memory/*.md` para que
las consultas semánticas puedan encontrar notas relacionadas incluso cuando la redacción difiere.

Valores predeterminados:

- Habilitado por defecto.
- Vigila archivos de memoria para cambios (debounced).
- Configura la búsqueda de memoria bajo `agents.defaults.memorySearch` (no a nivel superior
  `memorySearch`).
- Usa embeddings remotos por defecto. Si `memorySearch.provider` no está configurado, OpenClaw auto-selecciona:
  1. `local` si un `memorySearch.local.modelPath` está configurado y el archivo existe.
  2. `openai` si una clave de OpenAI puede resolverse.
  3. `gemini` si una clave de Gemini puede resolverse.
  4. `voyage` si una clave de Voyage puede resolverse.
  5. De lo contrario, la búsqueda de memoria permanece deshabilitada hasta que se configure.
- El modo local usa node-llama-cpp y puede requerir `pnpm approve-builds`.
- Usa sqlite-vec (cuando está disponible) para acelerar la búsqueda vectorial dentro de SQLite.

Los embeddings remotos **requieren** una clave de API para el proveedor de embeddings. OpenClaw
resuelve claves desde perfiles de autenticación, `models.providers.*.apiKey`, o variables de
entorno. OAuth de Codex solo cubre chat/completions y **no** satisface
embeddings para búsqueda de memoria. Para Gemini, usa `GEMINI_API_KEY` o
`models.providers.google.apiKey`. Para Voyage, usa `VOYAGE_API_KEY` o
`models.providers.voyage.apiKey`. Al usar un endpoint personalizado compatible con OpenAI,
establece `memorySearch.remote.apiKey` (y opcional `memorySearch.remote.headers`).

### Backend QMD (experimental)

Establece `memory.backend = "qmd"` para intercambiar el indexador SQLite integrado por
[QMD](https://github.com/tobi/qmd): un sidecar de búsqueda local que combina
BM25 + vectores + reranking. Markdown permanece como la fuente de verdad; OpenClaw ejecuta
comandos shell a QMD para recuperación. Puntos clave:

**Prerrequisitos**

- Deshabilitado por defecto. Opta por configuración (`memory.backend = "qmd"`).
- Instala el CLI de QMD por separado (`bun install -g https://github.com/tobi/qmd` o toma
  una versión) y asegúrate de que el binario `qmd` esté en el `PATH` del gateway.
- QMD necesita una compilación de SQLite que permita extensiones (`brew install sqlite` en
  macOS).
- QMD se ejecuta completamente local vía Bun + `node-llama-cpp` y auto-descarga modelos GGUF
  desde HuggingFace en el primer uso (no se requiere daemon Ollama separado).
- El gateway ejecuta QMD en un hogar XDG autocontenido bajo
  `~/.openclaw/agents/<agentId>/qmd/` estableciendo `XDG_CONFIG_HOME` y
  `XDG_CACHE_HOME`.
- Soporte de SO: macOS y Linux funcionan inmediatamente una vez que Bun + SQLite están
  instalados. Windows es mejor soportado vía WSL2.

**Cómo se ejecuta el sidecar**

- El gateway escribe un hogar QMD autocontenido bajo
  `~/.openclaw/agents/<agentId>/qmd/` (config + cache + DB sqlite).
- Las colecciones se crean vía `qmd collection add` desde `memory.qmd.paths`
  (más archivos de memoria de espacio de trabajo predeterminados), luego `qmd update` + `qmd embed` se ejecutan
  al arrancar y en un intervalo configurable (`memory.qmd.update.interval`,
  predeterminado 5 m).
- El gateway ahora inicializa el gestor QMD al arrancar, por lo que los temporizadores de actualización periódica
  se arman incluso antes de la primera llamada `memory_search`.
- La actualización de arranque ahora se ejecuta en segundo plano por defecto para que el inicio del chat no se
  bloquee; establece `memory.qmd.update.waitForBootSync = true` para mantener el
  comportamiento de bloqueo anterior.
- Las búsquedas se ejecutan vía `memory.qmd.searchMode` (predeterminado `qmd search --json`; también
  soporta `vsearch` y `query`). Si el modo seleccionado rechaza flags en tu
  compilación de QMD, OpenClaw reintenta con `qmd query`. Si QMD falla o el binario está
  ausente, OpenClaw automáticamente vuelve al gestor SQLite integrado para que
  las herramientas de memoria sigan funcionando.
- OpenClaw no expone el ajuste de tamaño de lote de embed de QMD hoy; el comportamiento de lote es
  controlado por QMD mismo.
- **La primera búsqueda puede ser lenta**: QMD puede descargar modelos GGUF locales (reranker/expansión de
  consulta) en la primera ejecución de `qmd query`.
  - OpenClaw establece `XDG_CONFIG_HOME`/`XDG_CACHE_HOME` automáticamente cuando ejecuta QMD.
  - Si quieres pre-descargar modelos manualmente (y calentar el mismo índice que OpenClaw
    usa), ejecuta una consulta única con los dirs XDG del agente.

    El estado QMD de OpenClaw vive bajo tu **directorio de estado** (predeterminado `~/.openclaw`).
    Puedes apuntar `qmd` al exacto mismo índice exportando las mismas variables XDG
    que OpenClaw usa:

    ```bash
    # Elige el mismo directorio de estado que OpenClaw usa
    STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"

    export XDG_CONFIG_HOME="$STATE_DIR/agents/main/qmd/xdg-config"
    export XDG_CACHE_HOME="$STATE_DIR/agents/main/qmd/xdg-cache"

    # (Opcional) forzar una actualización de índice + embeddings
    qmd update
    qmd embed

    # Calentar / activar descargas de modelos por primera vez
    qmd query "test" -c memory-root --json >/dev/null 2>&1
    ```

**Superficie de configuración (`memory.qmd.*`)**

- `command` (predeterminado `qmd`): sobrescribe la ruta del ejecutable.
- `searchMode` (predeterminado `search`): elige qué comando QMD respalda
  `memory_search` (`search`, `vsearch`, `query`).
- `includeDefaultMemory` (predeterminado `true`): auto-indexa `MEMORY.md` + `memory/**/*.md`.
- `paths[]`: agrega directorios/archivos extra (`path`, `pattern` opcional,
  `name` estable opcional).
- `sessions`: opta por indexación de JSONL de sesión (`enabled`, `retentionDays`,
  `exportDir`).
- `update`: controla la cadencia de actualización y ejecución de mantenimiento:
  (`interval`, `debounceMs`, `onBoot`, `waitForBootSync`, `embedInterval`,
  `commandTimeoutMs`, `updateTimeoutMs`, `embedTimeoutMs`).
- `limits`: limita el payload de recall (`maxResults`, `maxSnippetChars`,
  `maxInjectedChars`, `timeoutMs`).
- `scope`: mismo esquema que [`session.sendPolicy`](/es-ES/gateway/configuration#session).
  Predeterminado es solo DM (`deny` todo, `allow` chats directos); aflójalo para mostrar resultados QMD
  en grupos/canales.
  - `match.keyPrefix` coincide con la clave de sesión **normalizada** (minúsculas, con cualquier
    `agent:<id>:` inicial eliminado). Ejemplo: `discord:channel:`.
  - `match.rawKeyPrefix` coincide con la clave de sesión **cruda** (minúsculas), incluyendo
    `agent:<id>:`. Ejemplo: `agent:main:discord:`.
  - Legado: `match.keyPrefix: "agent:..."` aún se trata como un prefijo de clave cruda,
    pero prefiere `rawKeyPrefix` para claridad.
- Cuando `scope` deniega una búsqueda, OpenClaw registra una advertencia con el
  `channel`/`chatType` derivado para que los resultados vacíos sean más fáciles de depurar.
- Los snippets originados fuera del espacio de trabajo aparecen como
  `qmd/<collection>/<relative-path>` en resultados de `memory_search`; `memory_get`
  entiende ese prefijo y lee desde la raíz de colección QMD configurada.
- Cuando `memory.qmd.sessions.enabled = true`, OpenClaw exporta transcripciones de sesión sanitizadas
  (turnos Usuario/Asistente) en una colección QMD dedicada bajo
  `~/.openclaw/agents/<id>/qmd/sessions/`, para que `memory_search` pueda recordar
  conversaciones recientes sin tocar el índice SQLite integrado.
- Los snippets de `memory_search` ahora incluyen un pie de página `Source: <path#line>` cuando
  `memory.citations` es `auto`/`on`; establece `memory.citations = "off"` para mantener
  los metadatos de ruta internos (el agente aún recibe la ruta para
  `memory_get`, pero el texto del snippet omite el pie de página y el prompt del sistema
  advierte al agente que no lo cite).

**Ejemplo**

```json5
memory: {
  backend: "qmd",
  citations: "auto",
  qmd: {
    includeDefaultMemory: true,
    update: { interval: "5m", debounceMs: 15000 },
    limits: { maxResults: 6, timeoutMs: 4000 },
    scope: {
      default: "deny",
      rules: [
        { action: "allow", match: { chatType: "direct" } },
        // Prefijo de clave de sesión normalizado (elimina `agent:<id>:`).
        { action: "deny", match: { keyPrefix: "discord:channel:" } },
        // Prefijo de clave de sesión crudo (incluye `agent:<id>:`).
        { action: "deny", match: { rawKeyPrefix: "agent:main:discord:" } },
      ]
    },
    paths: [
      { name: "docs", path: "~/notes", pattern: "**/*.md" }
    ]
  }
}
```

**Citas y fallback**

- `memory.citations` se aplica independientemente del backend (`auto`/`on`/`off`).
- Cuando `qmd` se ejecuta, etiquetamos `status().backend = "qmd"` para que los diagnósticos muestren qué
  motor sirvió los resultados. Si el subproceso QMD sale o la salida JSON no puede
  parsearse, el gestor de búsqueda registra una advertencia y devuelve el proveedor integrado
  (embeddings de Markdown existentes) hasta que QMD se recupere.

### Rutas de memoria adicionales

Si quieres indexar archivos Markdown fuera del diseño de espacio de trabajo predeterminado, agrega
rutas explícitas:

```json5
agents: {
  defaults: {
    memorySearch: {
      extraPaths: ["../team-docs", "/srv/shared-notes/overview.md"]
    }
  }
}
```

Notas:

- Las rutas pueden ser absolutas o relativas al espacio de trabajo.
- Los directorios se escanean recursivamente para archivos `.md`.
- Solo se indexan archivos Markdown.
- Los enlaces simbólicos se ignoran (archivos o directorios).

### Embeddings de Gemini (nativo)

Establece el proveedor a `gemini` para usar la API de embeddings de Gemini directamente:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "gemini",
      model: "gemini-embedding-001",
      remote: {
        apiKey: "YOUR_GEMINI_API_KEY"
      }
    }
  }
}
```

Notas:

- `remote.baseUrl` es opcional (predeterminado a la URL base de la API de Gemini).
- `remote.headers` te permite agregar encabezados extra si es necesario.
- Modelo predeterminado: `gemini-embedding-001`.

Si quieres usar un **endpoint personalizado compatible con OpenAI** (OpenRouter, vLLM, o un proxy),
puedes usar la configuración `remote` con el proveedor OpenAI:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_OPENAI_COMPAT_API_KEY",
        headers: { "X-Custom-Header": "value" }
      }
    }
  }
}
```

Si no quieres establecer una clave de API, usa `memorySearch.provider = "local"` o establece
`memorySearch.fallback = "none"`.

Fallbacks:

- `memorySearch.fallback` puede ser `openai`, `gemini`, `local`, o `none`.
- El proveedor de fallback solo se usa cuando el proveedor de embeddings primario falla.

Indexación por lotes (OpenAI + Gemini + Voyage):

- Deshabilitado por defecto. Establece `agents.defaults.memorySearch.remote.batch.enabled = true` para habilitar para indexación de corpus grande (OpenAI, Gemini y Voyage).
- El comportamiento predeterminado espera la finalización del lote; ajusta `remote.batch.wait`, `remote.batch.pollIntervalMs`, y `remote.batch.timeoutMinutes` si es necesario.
- Establece `remote.batch.concurrency` para controlar cuántos trabajos de lote enviamos en paralelo (predeterminado: 2).
- El modo lote se aplica cuando `memorySearch.provider = "openai"` o `"gemini"` y usa la clave de API correspondiente.
- Los trabajos de lote de Gemini usan el endpoint de lote de embeddings asíncrono y requieren disponibilidad de la API de Lote de Gemini.

Por qué el lote de OpenAI es rápido + barato:

- Para rellenos grandes, OpenAI es típicamente la opción más rápida que soportamos porque podemos enviar muchas solicitudes de embedding en un solo trabajo de lote y dejar que OpenAI las procese de forma asíncrona.
- OpenAI ofrece precios con descuento para cargas de trabajo de la API de Lote, por lo que las ejecuciones de indexación grandes son usualmente más baratas que enviar las mismas solicitudes síncronamente.
- Consulta los documentos de la API de Lote de OpenAI y los precios para detalles:
  - [https://platform.openai.com/docs/api-reference/batch](https://platform.openai.com/docs/api-reference/batch)
  - [https://platform.openai.com/pricing](https://platform.openai.com/pricing)

Ejemplo de configuración:

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "openai",
      remote: {
        batch: { enabled: true, concurrency: 2 }
      },
      sync: { watch: true }
    }
  }
}
```

Herramientas:

- `memory_search` — devuelve snippets con archivo + rangos de línea.
- `memory_get` — lee el contenido del archivo de memoria por ruta.

Modo local:

- Establece `agents.defaults.memorySearch.provider = "local"`.
- Proporciona `agents.defaults.memorySearch.local.modelPath` (GGUF o URI `hf:`).
- Opcional: establece `agents.defaults.memorySearch.fallback = "none"` para evitar fallback remoto.

### Cómo funcionan las herramientas de memoria

- `memory_search` busca semánticamente fragmentos de Markdown (objetivo ~400 tokens, solapamiento de 80 tokens) desde `MEMORY.md` + `memory/**/*.md`. Devuelve texto de snippet (limitado ~700 caracteres), ruta de archivo, rango de línea, puntuación, proveedor/modelo, y si volvimos de local → embeddings remotos. No se devuelve payload completo de archivo.
- `memory_get` lee un archivo Markdown de memoria específico (relativo al espacio de trabajo), opcionalmente desde una línea inicial y por N líneas. Las rutas fuera de `MEMORY.md` / `memory/` son rechazadas.
- Ambas herramientas están habilitadas solo cuando `memorySearch.enabled` se resuelve a verdadero para el agente.

### Qué se indexa (y cuándo)

- Tipo de archivo: solo Markdown (`MEMORY.md`, `memory/**/*.md`).
- Almacenamiento de índice: SQLite por agente en `~/.openclaw/memory/<agentId>.sqlite` (configurable vía `agents.defaults.memorySearch.store.path`, soporta token `{agentId}`).
- Frescura: vigilante en `MEMORY.md` + `memory/` marca el índice como sucio (debounce 1.5s). La sincronización se programa al inicio de sesión, en búsqueda, o en un intervalo y se ejecuta de forma asíncrona. Las transcripciones de sesión usan umbrales delta para activar sincronización en segundo plano.
- Disparadores de reindexación: el índice almacena el **proveedor/modelo de embedding + huella de endpoint + params de fragmentación**. Si alguno de esos cambia, OpenClaw automáticamente resetea y reindexa todo el almacén.

### Búsqueda híbrida (BM25 + vector)

Cuando está habilitada, OpenClaw combina:

- **Similitud vectorial** (coincidencia semántica, la redacción puede diferir)
- **Relevancia de palabras clave BM25** (tokens exactos como IDs, variables de entorno, símbolos de código)

Si la búsqueda de texto completo no está disponible en tu plataforma, OpenClaw vuelve a búsqueda solo vectorial.

#### ¿Por qué híbrida?

La búsqueda vectorial es excelente en "esto significa lo mismo":

- "host gateway Mac Studio" vs "la máquina ejecutando el gateway"
- "debounce de actualizaciones de archivo" vs "evitar indexar en cada escritura"

Pero puede ser débil en tokens exactos de alta señal:

- IDs (`a828e60`, `b3b9895a…`)
- símbolos de código (`memorySearch.query.hybrid`)
- cadenas de error ("sqlite-vec unavailable")

BM25 (texto completo) es lo opuesto: fuerte en tokens exactos, más débil en paráfrasis.
La búsqueda híbrida es el punto medio pragmático: **usar ambas señales de recuperación** para que obtengas
buenos resultados tanto para consultas de "lenguaje natural" como de "aguja en el pajar".

#### Cómo fusionamos resultados (el diseño actual)

Esquema de implementación:

1. Recuperar un pool de candidatos de ambos lados:

- **Vector**: top `maxResults * candidateMultiplier` por similitud de coseno.
- **BM25**: top `maxResults * candidateMultiplier` por rango BM25 de FTS5 (menor es mejor).

2. Convertir rango BM25 en una puntuación 0..1-ish:

- `textScore = 1 / (1 + max(0, bm25Rank))`

3. Unir candidatos por id de fragmento y calcular una puntuación ponderada:

- `finalScore = vectorWeight * vectorScore + textWeight * textScore`

Notas:

- `vectorWeight` + `textWeight` se normalizan a 1.0 en la resolución de configuración, por lo que los pesos se comportan como porcentajes.
- Si los embeddings no están disponibles (o el proveedor devuelve un vector-cero), aún ejecutamos BM25 y devolvemos coincidencias de palabras clave.
- Si FTS5 no puede crearse, mantenemos búsqueda solo vectorial (sin fallo duro).

Esto no es "perfecto de teoría IR", pero es simple, rápido, y tiende a mejorar recall/precision en notas reales.
Si queremos ser más sofisticados más adelante, los siguientes pasos comunes son Reciprocal Rank Fusion (RRF) o normalización de puntuación
(min/max o z-score) antes de mezclar.

#### Pipeline de post-procesamiento

Después de fusionar puntuaciones vectoriales y de palabras clave, dos etapas de post-procesamiento opcionales
refinan la lista de resultados antes de que llegue al agente:

```
Vector + Keyword → Weighted Merge → Temporal Decay → Sort → MMR → Top-K Results
```

Ambas etapas están **desactivadas por defecto** y pueden habilitarse independientemente.

#### Re-ranking MMR (diversidad)

Cuando la búsqueda híbrida devuelve resultados, múltiples fragmentos pueden contener contenido similar o superpuesto.
Por ejemplo, buscar "configuración de red doméstica" podría devolver cinco snippets casi idénticos
de diferentes notas diarias que todas mencionan la misma configuración de router.

**MMR (Maximal Marginal Relevance)** reordena los resultados para equilibrar relevancia con diversidad,
asegurando que los resultados superiores cubran diferentes aspectos de la consulta en lugar de repetir la misma información.

Cómo funciona:

1. Los resultados se puntúan por su relevancia original (puntuación ponderada vector + BM25).
2. MMR selecciona iterativamente resultados que maximizan: `λ × relevance − (1−λ) × max_similarity_to_selected`.
3. La similitud entre resultados se mide usando similitud de texto Jaccard en contenido tokenizado.

El parámetro `lambda` controla el trade-off:

- `lambda = 1.0` → relevancia pura (sin penalización por diversidad)
- `lambda = 0.0` → máxima diversidad (ignora relevancia)
- Predeterminado: `0.7` (equilibrado, ligero sesgo de relevancia)

**Ejemplo — consulta: "configuración de red doméstica"**

Dados estos archivos de memoria:

```
memory/2026-02-10.md  → "Configuré router Omada, establecí VLAN 10 para dispositivos IoT"
memory/2026-02-08.md  → "Configuré router Omada, moví IoT a VLAN 10"
memory/2026-02-05.md  → "Configuré DNS AdGuard en 192.168.10.2"
memory/network.md     → "Router: Omada ER605, AdGuard: 192.168.10.2, VLAN 10: IoT"
```

Sin MMR — top 3 resultados:

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/2026-02-08.md  (score: 0.89)  ← router + VLAN (¡casi duplicado!)
3. memory/network.md     (score: 0.85)  ← doc de referencia
```

Con MMR (λ=0.7) — top 3 resultados:

```
1. memory/2026-02-10.md  (score: 0.92)  ← router + VLAN
2. memory/network.md     (score: 0.85)  ← doc de referencia (¡diverso!)
3. memory/2026-02-05.md  (score: 0.78)  ← DNS AdGuard (¡diverso!)
```

El casi-duplicado del 8 de Feb desaparece, y el agente obtiene tres piezas de información distintas.

**Cuándo habilitar:** Si notas que `memory_search` devuelve snippets redundantes o casi duplicados,
especialmente con notas diarias que a menudo repiten información similar a través de días.

#### Decaimiento temporal (boost de recencia)

Los agentes con notas diarias acumulan cientos de archivos fechados con el tiempo. Sin decaimiento,
una nota bien redactada de hace seis meses puede superar en ranking la actualización de ayer sobre el mismo tema.

**El decaimiento temporal** aplica un multiplicador exponencial a las puntuaciones basado en la edad de cada resultado,
para que las memorias recientes naturalmente tengan mayor ranking mientras las viejas se desvanecen:

```
decayedScore = score × e^(-λ × ageInDays)
```

donde `λ = ln(2) / halfLifeDays`.

Con la vida media predeterminada de 30 días:

- Notas de hoy: **100%** de puntuación original
- Hace 7 días: **~84%**
- Hace 30 días: **50%**
- Hace 90 días: **12.5%**
- Hace 180 días: **~1.6%**

**Los archivos perennes nunca decaen:**

- `MEMORY.md` (archivo de memoria raíz)
- Archivos sin fecha en `memory/` (ej., `memory/projects.md`, `memory/network.md`)
- Estos contienen información de referencia duradera que siempre debe rankear normalmente.

**Los archivos diarios fechados** (`memory/YYYY-MM-DD.md`) usan la fecha extraída del nombre de archivo.
Otras fuentes (ej., transcripciones de sesión) vuelven al tiempo de modificación de archivo (`mtime`).

**Ejemplo — consulta: "¿cuál es el horario de trabajo de Rod?"**

Dados estos archivos de memoria (hoy es 10 de Feb):

```
memory/2025-09-15.md  → "Rod trabaja Lun-Vie, standup a las 10am, pairing a las 2pm"  (148 días)
memory/2026-02-10.md  → "Rod tiene standup a las 14:15, 1:1 con Zeb a las 14:45"    (hoy)
memory/2026-02-03.md  → "Rod comenzó nuevo equipo, standup movido a 14:15"        (7 días)
```

Sin decaimiento:

```
1. memory/2025-09-15.md  (score: 0.91)  ← mejor coincidencia semántica, ¡pero obsoleta!
2. memory/2026-02-10.md  (score: 0.82)
3. memory/2026-02-03.md  (score: 0.80)
```

Con decaimiento (halfLife=30):

```
1. memory/2026-02-10.md  (score: 0.82 × 1.00 = 0.82)  ← hoy, sin decaimiento
2. memory/2026-02-03.md  (score: 0.80 × 0.85 = 0.68)  ← 7 días, decaimiento leve
3. memory/2025-09-15.md  (score: 0.91 × 0.03 = 0.03)  ← 148 días, casi desaparecida
```

La nota obsoleta de septiembre baja al fondo a pesar de tener la mejor coincidencia semántica cruda.

**Cuándo habilitar:** Si tu agente tiene meses de notas diarias y encuentras que información vieja y
obsoleta supera en ranking al contexto reciente. Una vida media de 30 días funciona bien para
flujos de trabajo pesados en notas diarias; auméntala (ej., 90 días) si referencias notas más viejas frecuentemente.

#### Configuración

Ambas características se configuran bajo `memorySearch.query.hybrid`:

```json5
agents: {
  defaults: {
    memorySearch: {
      query: {
        hybrid: {
          enabled: true,
          vectorWeight: 0.7,
          textWeight: 0.3,
          candidateMultiplier: 4,
          // Diversidad: reduce resultados redundantes
          mmr: {
            enabled: true,    // predeterminado: false
            lambda: 0.7       // 0 = max diversidad, 1 = max relevancia
          },
          // Recencia: boost memorias más nuevas
          temporalDecay: {
            enabled: true,    // predeterminado: false
            halfLifeDays: 30  // puntuación se reduce a la mitad cada 30 días
          }
        }
      }
    }
  }
}
```

Puedes habilitar cualquiera de las características independientemente:

- **Solo MMR** — útil cuando tienes muchas notas similares pero la edad no importa.
- **Solo decaimiento temporal** — útil cuando la recencia importa pero tus resultados ya son diversos.
- **Ambos** — recomendado para agentes con historiales largos y en ejecución de notas diarias grandes.

### Caché de embeddings

OpenClaw puede cachear **embeddings de fragmentos** en SQLite para que la reindexación y actualizaciones frecuentes (especialmente transcripciones de sesión) no re-embeben texto sin cambios.

Configuración:

```json5
agents: {
  defaults: {
    memorySearch: {
      cache: {
        enabled: true,
        maxEntries: 50000
      }
    }
  }
}
```

### Búsqueda de memoria de sesión (experimental)

Opcionalmente puedes indexar **transcripciones de sesión** y mostrarlas vía `memory_search`.
Esto está protegido detrás de una bandera experimental.

```json5
agents: {
  defaults: {
    memorySearch: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"]
    }
  }
}
```

Notas:

- La indexación de sesión es **opt-in** (desactivada por defecto).
- Las actualizaciones de sesión están debounced e **indexadas asincrónicamente** una vez que cruzan umbrales delta (mejor esfuerzo).
- `memory_search` nunca bloquea en indexación; los resultados pueden estar ligeramente obsoletos hasta que termine la sincronización en segundo plano.
- Los resultados aún incluyen solo snippets; `memory_get` permanece limitado a archivos de memoria.
- La indexación de sesión está aislada por agente (solo los registros de sesión de ese agente se indexan).
- Los registros de sesión viven en disco (`~/.openclaw/agents/<agentId>/sessions/*.jsonl`). Cualquier proceso/usuario con acceso al sistema de archivos puede leerlos, por lo que trata el acceso a disco como el límite de confianza. Para aislamiento más estricto, ejecuta agentes bajo usuarios de SO separados u hosts.

Umbrales delta (predeterminados mostrados):

```json5
agents: {
  defaults: {
    memorySearch: {
      sync: {
        sessions: {
          deltaBytes: 100000,   // ~100 KB
          deltaMessages: 50     // líneas JSONL
        }
      }
    }
  }
}
```

### Aceleración de vectores SQLite (sqlite-vec)

Cuando la extensión sqlite-vec está disponible, OpenClaw almacena embeddings en una
tabla virtual de SQLite (`vec0`) y realiza consultas de distancia vectorial en la
base de datos. Esto mantiene la búsqueda rápida sin cargar cada embedding en JS.

Configuración (opcional):

```json5
agents: {
  defaults: {
    memorySearch: {
      store: {
        vector: {
          enabled: true,
          extensionPath: "/path/to/sqlite-vec"
        }
      }
    }
  }
}
```

Notas:

- `enabled` por defecto es true; cuando está deshabilitado, la búsqueda vuelve a
  similitud de coseno en proceso sobre embeddings almacenados.
- Si la extensión sqlite-vec falta o falla al cargar, OpenClaw registra el
  error y continúa con el fallback de JS (sin tabla vectorial).
- `extensionPath` sobrescribe la ruta de sqlite-vec incluida (útil para builds personalizadas
  o ubicaciones de instalación no estándar).

### Auto-descarga de embedding local

- Modelo de embedding local predeterminado: `hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB).
- Cuando `memorySearch.provider = "local"`, `node-llama-cpp` resuelve `modelPath`; si el GGUF falta **auto-descarga** al caché (o `local.modelCacheDir` si está configurado), luego lo carga. Las descargas se reanudan al reintentar.
- Requisito de build nativo: ejecuta `pnpm approve-builds`, elige `node-llama-cpp`, luego `pnpm rebuild node-llama-cpp`.
- Fallback: si la configuración local falla y `memorySearch.fallback = "openai"`, cambiamos automáticamente a embeddings remotos (`openai/text-embedding-3-small` a menos que se sobrescriba) y registramos la razón.

### Ejemplo de endpoint personalizado compatible con OpenAI

```json5
agents: {
  defaults: {
    memorySearch: {
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_REMOTE_API_KEY",
        headers: {
          "X-Organization": "org-id",
          "X-Project": "project-id"
        }
      }
    }
  }
}
```

Notas:

- `remote.*` tiene precedencia sobre `models.providers.openai.*`.
- `remote.headers` se fusionan con encabezados de OpenAI; remoto gana en conflictos de clave. Omite `remote.headers` para usar los valores predeterminados de OpenAI.
