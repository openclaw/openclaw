---
summary: "Herramientas de búsqueda y obtención web (Brave Search API, Perplexity directo/OpenRouter)"
read_when:
  - Quiere habilitar web_search o web_fetch
  - Necesita configurar la clave de la API de Brave Search
  - Quiere usar Perplexity Sonar para búsqueda web
title: "Herramientas web"
---

# Herramientas web

OpenClaw incluye dos herramientas web ligeras:

- `web_search` — Busque en la web mediante Brave Search API (predeterminado) o Perplexity Sonar (directo o vía OpenRouter).
- `web_fetch` — Obtención HTTP + extracción legible (HTML → markdown/texto).

Estas **no** son automatización de navegador. Para sitios con mucho JavaScript o inicios de sesión, use la
[herramienta de navegador](/tools/browser).

## Cómo funciona

- `web_search` llama a su proveedor configurado y devuelve resultados.
  - **Brave** (predeterminado): devuelve resultados estructurados (título, URL, fragmento).
  - **Perplexity**: devuelve respuestas sintetizadas por IA con citas de búsquedas web en tiempo real.
- Los resultados se almacenan en caché por consulta durante 15 minutos (configurable).
- `web_fetch` realiza un HTTP GET simple y extrae contenido legible
  (HTML → markdown/texto). **No** ejecuta JavaScript.
- `web_fetch` está habilitado de forma predeterminada (a menos que se deshabilite explícitamente).

## Elección de un proveedor de búsqueda

| Proveedor                                     | Ventajas                                           | Desventajas                               | Clave de API                                |
| --------------------------------------------- | -------------------------------------------------- | ----------------------------------------- | ------------------------------------------- |
| **Brave** (predeterminado) | Rápido, resultados estructurados, nivel gratuito   | Resultados de búsqueda tradicionales      | `BRAVE_API_KEY`                             |
| **Perplexity**                                | Respuestas sintetizadas por IA, citas, tiempo real | Requiere acceso a Perplexity u OpenRouter | `OPENROUTER_API_KEY` o `PERPLEXITY_API_KEY` |

Consulte [Configuración de Brave Search](/brave-search) y [Perplexity Sonar](/perplexity) para detalles específicos del proveedor.

Configure el proveedor en la configuración:

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave", // or "perplexity"
      },
    },
  },
}
```

Ejemplo: cambiar a Perplexity Sonar (API directa):

```json5
{
  tools: {
    web: {
      search: {
        provider: "perplexity",
        perplexity: {
          apiKey: "pplx-...",
          baseUrl: "https://api.perplexity.ai",
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

## Obtención de una clave de API de Brave

1. Cree una cuenta de Brave Search API en [https://brave.com/search/api/](https://brave.com/search/api/)
2. En el panel, elija el plan **Data for Search** (no “Data for AI”) y genere una clave de API.
3. Ejecute `openclaw configure --section web` para almacenar la clave en la configuración (recomendado), o configure `BRAVE_API_KEY` en su entorno.

Brave ofrece un nivel gratuito además de planes de pago; consulte el portal de la API de Brave para conocer los
límites y precios actuales.

### Dónde configurar la clave (recomendado)

**Recomendado:** ejecute `openclaw configure --section web`. Almacena la clave en
`~/.openclaw/openclaw.json` bajo `tools.web.search.apiKey`.

**Alternativa por entorno:** configure `BRAVE_API_KEY` en el entorno del proceso del Gateway. Para una instalación del gateway, colóquelo en `~/.openclaw/.env` (o en el
entorno de su servicio). Consulte [Variables de entorno](/help/faq#how-does-openclaw-load-environment-variables).

## Uso de Perplexity (directo o vía OpenRouter)

Los modelos Perplexity Sonar tienen capacidades integradas de búsqueda web y devuelven
respuestas sintetizadas por IA con citas. Puede usarlos vía OpenRouter (no se requiere tarjeta de crédito; admite
cripto/prepago).

### Obtención de una clave de API de OpenRouter

1. Cree una cuenta en [https://openrouter.ai/](https://openrouter.ai/)
2. Agregue créditos (admite cripto, prepago o tarjeta de crédito)
3. Genere una clave de API en la configuración de su cuenta

### Configuración de la búsqueda con Perplexity

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        provider: "perplexity",
        perplexity: {
          // API key (optional if OPENROUTER_API_KEY or PERPLEXITY_API_KEY is set)
          apiKey: "sk-or-v1-...",
          // Base URL (key-aware default if omitted)
          baseUrl: "https://openrouter.ai/api/v1",
          // Model (defaults to perplexity/sonar-pro)
          model: "perplexity/sonar-pro",
        },
      },
    },
  },
}
```

**Alternativa por entorno:** configure `OPENROUTER_API_KEY` o `PERPLEXITY_API_KEY` en el entorno del Gateway. Para una instalación del gateway, colóquelo en `~/.openclaw/.env`.

Si no se establece una URL base, OpenClaw elige un valor predeterminado según la fuente de la clave de API:

- `PERPLEXITY_API_KEY` o `pplx-...` → `https://api.perplexity.ai`
- `OPENROUTER_API_KEY` o `sk-or-...` → `https://openrouter.ai/api/v1`
- Formatos de clave desconocidos → OpenRouter (alternativa segura)

### Modelos de Perplexity disponibles

| Modelo                                                     | Descripción                                     | Ideal para             |
| ---------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| `perplexity/sonar`                                         | Preguntas y respuestas rápidas con búsqueda web | Consultas rápidas      |
| `perplexity/sonar-pro` (predeterminado) | Razonamiento de varios pasos con búsqueda web   | Preguntas complejas    |
| `perplexity/sonar-reasoning-pro`                           | Análisis de cadena de pensamiento               | Investigación profunda |

## web_search

Busque en la web usando su proveedor configurado.

### Requisitos

- `tools.web.search.enabled` no debe ser `false` (predeterminado: habilitado)
- Clave de API para su proveedor elegido:
  - **Brave**: `BRAVE_API_KEY` o `tools.web.search.apiKey`
  - **Perplexity**: `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, o `tools.web.search.perplexity.apiKey`

### Configuración

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "BRAVE_API_KEY_HERE", // optional if BRAVE_API_KEY is set
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
    },
  },
}
```

### Parámetros de la herramienta

- `query` (obligatorio)
- `count` (1–10; valor predeterminado desde la configuración)
- `country` (opcional): código de país de 2 letras para resultados específicos por región (p. ej., "DE", "US", "ALL"). Si se omite, Brave elige su región predeterminada.
- `search_lang` (opcional): código de idioma ISO para los resultados de búsqueda (p. ej., "de", "en", "fr")
- `ui_lang` (opcional): código de idioma ISO para elementos de la interfaz
- `freshness` (opcional, solo Brave): filtrar por tiempo de descubrimiento (`pd`, `pw`, `pm`, `py`, o `YYYY-MM-DDtoYYYY-MM-DD`)

**Ejemplos:**

```javascript
// German-specific search
await web_search({
  query: "TV online schauen",
  count: 10,
  country: "DE",
  search_lang: "de",
});

// French search with French UI
await web_search({
  query: "actualités",
  country: "FR",
  search_lang: "fr",
  ui_lang: "fr",
});

// Recent results (past week)
await web_search({
  query: "TMBG interview",
  freshness: "pw",
});
```

## web_fetch

Obtenga una URL y extraiga contenido legible.

### Requisitos de web_fetch

- `tools.web.fetch.enabled` no debe ser `false` (predeterminado: habilitado)
- Alternativa opcional con Firecrawl: configure `tools.web.fetch.firecrawl.apiKey` o `FIRECRAWL_API_KEY`.

### Configuración de web_fetch

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true,
        maxChars: 50000,
        maxCharsCap: 50000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        readability: true,
        firecrawl: {
          enabled: true,
          apiKey: "FIRECRAWL_API_KEY_HERE", // optional if FIRECRAWL_API_KEY is set
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 86400000, // ms (1 day)
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

### Parámetros de la herramienta web_fetch

- `url` (obligatorio, solo http/https)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncar páginas largas)

Notas:

- `web_fetch` usa Readability (extracción del contenido principal) primero, luego Firecrawl (si está configurado). Si ambos fallan, la herramienta devuelve un error.
- Las solicitudes de Firecrawl usan el modo de evasión de bots y almacenan en caché los resultados de forma predeterminada.
- `web_fetch` envía un User-Agent similar a Chrome y `Accept-Language` de forma predeterminada; anule `userAgent` si es necesario.
- `web_fetch` bloquea nombres de host privados/internos y vuelve a verificar redirecciones (limite con `maxRedirects`).
- `maxChars` se limita a `tools.web.fetch.maxCharsCap`.
- `web_fetch` es una extracción de mejor esfuerzo; algunos sitios necesitarán la herramienta de navegador.
- Consulte [Firecrawl](/tools/firecrawl) para la configuración de claves y detalles del servicio.
- Las respuestas se almacenan en caché (predeterminado: 15 minutos) para reducir obtenciones repetidas.
- Si usa perfiles/listas de permitidos de herramientas, agregue `web_search`/`web_fetch` o `group:web`.
- Si falta la clave de Brave, `web_search` devuelve una breve sugerencia de configuración con un enlace a la documentación.
