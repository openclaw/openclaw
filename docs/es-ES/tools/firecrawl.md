---
title: "Firecrawl"
description: "Extracción y scraping avanzado de datos web"
---

## Descripción General

Firecrawl es una poderosa herramienta de scraping web que permite a los agentes extraer datos estructurados de sitios web. Proporciona:

- **Scraping inteligente**: Extracción automática de contenido y esquema
- **Manejo de JavaScript**: Soporte completo de renderización del lado del cliente
- **Manejo de límites de tasa**: Scraping respetuoso con reintentos automáticos
- **Limpieza de datos**: Salida estructurada y limpia

## Instalación

```bash
# Instalar Firecrawl desde ClawHub
openclaw hub install firecrawl-scraper
```

## Uso Básico

```typescript
// Extraer datos de una URL
const data = await firecrawl.scrape({
  url: "https://example.com",
  format: "markdown",
});

console.log(data.content);
```

## Parámetros

| Parámetro          | Tipo     | Requerido | Descripción                                              |
| ------------------ | -------- | --------- | -------------------------------------------------------- |
| `url`              | string   | Sí        | URL a extraer                                            |
| `format`           | string   | No        | Formato de salida: 'markdown', 'html', 'text', 'json'    |
| `waitFor`          | string   | No        | Selector CSS a esperar antes de extraer                  |
| `excludeSelectors` | string[] | No        | Selectores CSS a excluir de la extracción                |
| `includeSelectors` | string[] | No        | Solo incluir contenido que coincida con estos selectores |

## Ejemplos

### Scraping Básico

```typescript
// Extraer contenido de una página
const content = await firecrawl.scrape({
  url: "https://blog.example.com/post-1",
  format: "markdown",
});
```

### Esperar por Contenido Dinámico

```typescript
// Esperar a que se cargue contenido renderizado por JavaScript
const data = await firecrawl.scrape({
  url: "https://spa-app.com",
  waitFor: ".content-loaded",
  format: "html",
});
```

### Extracción Selectiva

```typescript
// Extraer solo contenido específico
const article = await firecrawl.scrape({
  url: "https://news.example.com/article",
  includeSelectors: [".article-content", ".article-title"],
  excludeSelectors: [".ads", ".comments"],
  format: "markdown",
});
```

## Configuración

```bash
# Configurar clave API de Firecrawl (si usas el servicio alojado)
openclaw config set firecrawl.apiKey TU_CLAVE_API

# Establecer tiempo de espera predeterminado
openclaw config set firecrawl.timeout 30000

# Habilitar caché
openclaw config set firecrawl.cache true
```

## Ver También

- [Browser](/es-ES/tools/browser) - Automatización del navegador
- [Web](/es-ES/tools/web) - Herramientas de interacción web
