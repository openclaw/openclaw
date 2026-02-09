---
summary: "Respaldo de Firecrawl para web_fetch (anti‑bot + extracción en caché)"
read_when:
  - Quiere extracción web con respaldo de Firecrawl
  - Necesita una clave de API de Firecrawl
  - Quiere extracción anti‑bot para web_fetch
title: "Firecrawl"
---

# Firecrawl

OpenClaw puede usar **Firecrawl** como extractor de respaldo para `web_fetch`. Es un servicio alojado de extracción de contenido que admite evasión de bots y almacenamiento en caché, lo que ayuda con sitios con mucho JS o páginas que bloquean las obtenciones HTTP simples.

## Obtener una clave de API

1. Cree una cuenta de Firecrawl y genere una clave de API.
2. Guárdela en la configuración o establezca `FIRECRAWL_API_KEY` en el entorno del Gateway.

## Configurar Firecrawl

```json5
{
  tools: {
    web: {
      fetch: {
        firecrawl: {
          apiKey: "FIRECRAWL_API_KEY_HERE",
          baseUrl: "https://api.firecrawl.dev",
          onlyMainContent: true,
          maxAgeMs: 172800000,
          timeoutSeconds: 60,
        },
      },
    },
  },
}
```

Notas:

- `firecrawl.enabled` se establece en true de forma predeterminada cuando hay una clave de API presente.
- `maxAgeMs` controla cuán antiguos pueden ser los resultados en caché (ms). El valor predeterminado es 2 días.

## Sigilo / evasión de bots

Firecrawl expone un parámetro de **modo proxy** para la evasión de bots (`basic`, `stealth` o `auto`).
OpenClaw siempre usa `proxy: "auto"` más `storeInCache: true` para las solicitudes a Firecrawl.
Si se omite el proxy, Firecrawl usa de forma predeterminada `auto`. `auto` reintenta con proxies de sigilo si un intento básico falla, lo que puede usar más créditos que el scraping solo básico.

## Cómo `web_fetch` usa Firecrawl

Orden de extracción de `web_fetch`:

1. Readability (local)
2. Firecrawl (si está configurado)
3. Limpieza básica de HTML (último respaldo)

Consulte [Web tools](/tools/web) para la configuración completa de herramientas web.
