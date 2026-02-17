---
summary: "Audita qué puede gastar dinero, qué claves se usan y cómo ver el uso"
read_when:
  - Quieres entender qué características pueden llamar APIs de pago
  - Necesitas auditar claves, costos y visibilidad de uso
  - Estás explicando informes de costos de /status o /usage
title: "Uso y Costos de API"
---

# Uso y costos de API

Este documento enumera **características que pueden invocar claves de API** y dónde aparecen sus costos. Se enfoca en características de OpenClaw que pueden generar uso de proveedores o llamadas a API de pago.

## Dónde aparecen los costos (chat + CLI)

**Snapshot de costo por sesión**

- `/status` muestra el modelo de sesión actual, uso de contexto y tokens de última respuesta.
- Si el modelo usa **autenticación con clave de API**, `/status` también muestra **costo estimado** para la última respuesta.

**Pie de costo por mensaje**

- `/usage full` agrega un pie de uso a cada respuesta, incluyendo **costo estimado** (solo clave de API).
- `/usage tokens` muestra solo tokens; los flujos OAuth ocultan el costo en dólares.

**Ventanas de uso CLI (cuotas de proveedor)**

- `openclaw status --usage` y `openclaw channels list` muestran **ventanas de uso** del proveedor
  (snapshots de cuota, no costos por mensaje).

Ver [Uso de tokens y costos](/es-ES/reference/token-use) para detalles y ejemplos.

## Cómo se descubren las claves

OpenClaw puede obtener credenciales de:

- **Perfiles de autenticación** (por agente, almacenados en `auth-profiles.json`).
- **Variables de entorno** (ej. `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Config** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Habilidades** (`skills.entries.<name>.apiKey`) que pueden exportar claves al entorno del proceso de habilidad.

## Características que pueden gastar claves

### 1) Respuestas principales del modelo (chat + herramientas)

Cada respuesta o llamada a herramienta usa el **proveedor de modelo actual** (OpenAI, Anthropic, etc.). Esta es la fuente principal de uso y costo.

Ver [Modelos](/es-ES/providers/models) para configuración de precios y [Uso de tokens y costos](/es-ES/reference/token-use) para visualización.

### 2) Comprensión de medios (audio/imagen/video)

Los medios entrantes pueden ser resumidos/transcritos antes de que se ejecute la respuesta. Esto usa APIs de modelo/proveedor.

- Audio: OpenAI / Groq / Deepgram (ahora **auto-habilitado** cuando existen claves).
- Imagen: OpenAI / Anthropic / Google.
- Video: Google.

Ver [Comprensión de medios](/es-ES/nodes/media-understanding).

### 3) Embeddings de memoria + búsqueda semántica

La búsqueda de memoria semántica usa **APIs de embedding** cuando se configura para proveedores remotos:

- `memorySearch.provider = "openai"` → embeddings de OpenAI
- `memorySearch.provider = "gemini"` → embeddings de Gemini
- `memorySearch.provider = "voyage"` → embeddings de Voyage
- Fallback opcional a un proveedor remoto si fallan los embeddings locales

Puedes mantenerlo local con `memorySearch.provider = "local"` (sin uso de API).

Ver [Memoria](/es-ES/concepts/memory).

### 4) Herramienta de búsqueda web (Brave / Perplexity vía OpenRouter)

`web_search` usa claves de API y puede incurrir en cargos de uso:

- **Brave Search API**: `BRAVE_API_KEY` o `tools.web.search.apiKey`
- **Perplexity** (vía OpenRouter): `PERPLEXITY_API_KEY` o `OPENROUTER_API_KEY`

**Nivel gratuito de Brave (generoso):**

- **2,000 solicitudes/mes**
- **1 solicitud/segundo**
- **Tarjeta de crédito requerida** para verificación (sin cargo a menos que actualices)

Ver [Herramientas web](/es-ES/tools/web).

### 5) Herramienta de fetch web (Firecrawl)

`web_fetch` puede llamar a **Firecrawl** cuando hay una clave de API presente:

- `FIRECRAWL_API_KEY` o `tools.web.fetch.firecrawl.apiKey`

Si Firecrawl no está configurado, la herramienta recurre a fetch directo + readability (sin API de pago).

Ver [Herramientas web](/es-ES/tools/web).

### 6) Snapshots de uso del proveedor (estado/salud)

Algunos comandos de estado llaman **endpoints de uso del proveedor** para mostrar ventanas de cuota o salud de autenticación.
Estas son típicamente llamadas de bajo volumen pero aún llegan a APIs del proveedor:

- `openclaw status --usage`
- `openclaw models status --json`

Ver [CLI de modelos](/es-ES/cli/models).

### 7) Resumen de salvaguarda de compactación

La salvaguarda de compactación puede resumir el historial de sesión usando el **modelo actual**, lo que invoca APIs del proveedor cuando se ejecuta.

Ver [Gestión de sesión + compactación](/es-ES/reference/session-management-compaction).

### 8) Escaneo / sondeo de modelo

`openclaw models scan` puede sondear modelos de OpenRouter y usa `OPENROUTER_API_KEY` cuando el sondeo está habilitado.

Ver [CLI de modelos](/es-ES/cli/models).

### 9) Talk (voz)

El modo Talk puede invocar **ElevenLabs** cuando está configurado:

- `ELEVENLABS_API_KEY` o `talk.apiKey`

Ver [Modo Talk](/es-ES/nodes/talk).

### 10) Habilidades (APIs de terceros)

Las habilidades pueden almacenar `apiKey` en `skills.entries.<name>.apiKey`. Si una habilidad usa esa clave para APIs externas, puede incurrir en costos según el proveedor de la habilidad.

Ver [Habilidades](/es-ES/tools/skills).
