---
summary: "Audite qué puede gastar dinero, qué claves se usan y cómo ver el uso"
read_when:
  - Quiere entender qué funciones pueden llamar a APIs de pago
  - Necesita auditar claves, costos y visibilidad de uso
  - Está explicando el reporte de costos de /status o /usage
title: "Uso y costos de la API"
---

# Uso y costos de la API

Este documento enumera **las funciones que pueden invocar claves de API** y dónde aparecen sus costos. Se centra en
las funciones de OpenClaw que pueden generar uso del proveedor o llamadas a APIs de pago.

## Dónde aparecen los costos (chat + CLI)

**Instantánea de costos por sesión**

- `/status` muestra el modelo de la sesión actual, el uso de contexto y los tokens de la última respuesta.
- Si el modelo usa **autenticación por clave de API**, `/status` también muestra el **costo estimado** de la última respuesta.

**Pie de costos por mensaje**

- `/usage full` agrega un pie de uso a cada respuesta, incluido el **costo estimado** (solo clave de API).
- `/usage tokens` muestra solo tokens; los flujos OAuth ocultan el costo en dólares.

**Ventanas de uso de la CLI (cuotas del proveedor)**

- `openclaw status --usage` y `openclaw channels list` muestran **ventanas de uso** del proveedor
  (instantáneas de cuota, no costos por mensaje).

Vea [Uso de tokens y costos](/reference/token-use) para detalles y ejemplos.

## Cómo se descubren las claves

OpenClaw puede recoger credenciales desde:

- **Perfiles de autenticación** (por agente, almacenados en `auth-profiles.json`).
- **Variables de entorno** (p. ej., `OPENAI_API_KEY`, `BRAVE_API_KEY`, `FIRECRAWL_API_KEY`).
- **Configuración** (`models.providers.*.apiKey`, `tools.web.search.*`, `tools.web.fetch.firecrawl.*`,
  `memorySearch.*`, `talk.apiKey`).
- **Skills** (`skills.entries.<name>.apiKey`) que pueden exportar claves al entorno del proceso del skill.

## Funciones que pueden gastar claves

### 1. Respuestas del modelo principal (chat + herramientas)

Cada respuesta o llamada a herramienta usa el **proveedor del modelo actual** (OpenAI, Anthropic, etc.). Esta es la
principal fuente de uso y costo.

Vea [Modelos](/providers/models) para la configuración de precios y [Uso de tokens y costos](/reference/token-use) para la visualización.

### 2. Comprensión de medios (audio/imagen/video)

Los medios entrantes pueden resumirse/transcribirse antes de que se ejecute la respuesta. Esto usa APIs de modelos/proveedores.

- Audio: OpenAI / Groq / Deepgram (ahora **habilitado automáticamente** cuando existen claves).
- Imagen: OpenAI / Anthropic / Google.
- Video: Google.

Vea [Comprensión de medios](/nodes/media-understanding).

### 3. Embeddings de memoria + búsqueda semántica

La búsqueda semántica de memoria usa **APIs de embeddings** cuando se configura para proveedores remotos:

- `memorySearch.provider = "openai"` → embeddings de OpenAI
- `memorySearch.provider = "gemini"` → embeddings de Gemini
- `memorySearch.provider = "voyage"` → embeddings de Voyage
- Respaldo opcional a un proveedor remoto si fallan los embeddings locales

Puede mantenerlo local con `memorySearch.provider = "local"` (sin uso de API).

Vea [Memoria](/concepts/memory).

### 4. Herramienta de búsqueda web (Brave / Perplexity vía OpenRouter)

`web_search` usa claves de API y puede incurrir en cargos de uso:

- **Brave Search API**: `BRAVE_API_KEY` o `tools.web.search.apiKey`
- **Perplexity** (vía OpenRouter): `PERPLEXITY_API_KEY` o `OPENROUTER_API_KEY`

**Nivel gratuito de Brave (generoso):**

- **2,000 solicitudes/mes**
- **1 solicitud/segundo**
- **Tarjeta de crédito requerida** para verificación (sin cargo a menos que actualice)

Vea [Herramientas web](/tools/web).

### 5. Herramienta de obtención web (Firecrawl)

`web_fetch` puede llamar a **Firecrawl** cuando hay una clave de API presente:

- `FIRECRAWL_API_KEY` o `tools.web.fetch.firecrawl.apiKey`

Si Firecrawl no está configurado, la herramienta vuelve a obtención directa + legibilidad (sin API de pago).

Vea [Herramientas web](/tools/web).

### 6. Instantáneas de uso del proveedor (estado/salud)

Algunos comandos de estado llaman a **endpoints de uso del proveedor** para mostrar ventanas de cuota o salud de autenticación.
Suelen ser llamadas de bajo volumen, pero aun así alcanzan las APIs del proveedor:

- `openclaw status --usage`
- `openclaw models status --json`

Vea [CLI de Modelos](/cli/models).

### 7. Resumen de salvaguarda de compactación

La salvaguarda de compactación puede resumir el historial de la sesión usando el **modelo actual**, lo que
invoca APIs del proveedor cuando se ejecuta.

Vea [Gestión de sesiones + compactación](/reference/session-management-compaction).

### 8. Escaneo/sondeo de modelos

`openclaw models scan` puede sondear modelos de OpenRouter y usa `OPENROUTER_API_KEY` cuando
el sondeo está habilitado.

Vea [CLI de Modelos](/cli/models).

### 9. Talk (voz)

El modo Talk puede invocar **ElevenLabs** cuando está configurado:

- `ELEVENLABS_API_KEY` o `talk.apiKey`

Vea [Modo Talk](/nodes/talk).

### 10. Skills (APIs de terceros)

Los Skills pueden almacenar `apiKey` en `skills.entries.<name>.apiKey`. Si un skill usa esa clave para
APIs externas, puede incurrir en costos según el proveedor del skill.

Vea [Skills](/tools/skills).
