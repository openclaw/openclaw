---
title: Herramienta Web
description: Buscar y obtener contenido web en conversaciones de agentes
---

La **herramienta Web** permite que los agentes OpenClaw:

- **Busquen** en la web con múltiples motores
- **Obtengan** contenido de página en Markdown, texto o HTML
- Accedan a **conocimiento actualizado** más allá de su fecha límite de entrenamiento

## Búsqueda Web

Los agentes pueden buscar en la web usando motores configurados.

### Motores Soportados

1. **Perplexity** (predeterminado) – búsqueda con IA con resúmenes
2. **Tavily** – búsqueda optimizada para IA
3. **Brave** – búsqueda centrada en privacidad

### Configuración de Clave API

Cada motor requiere una clave API:

```bash
# Perplexity (predeterminado)
openclaw config set web.perplexity.apiKey pplx-...

# Tavily
openclaw config set web.tavily.apiKey tvly-...

# Brave
openclaw config set web.brave.apiKey BSA...
```

### Cambiar el Motor de Búsqueda

```bash
openclaw config set web.search.engine tavily
```

### Ejemplo de Búsqueda

```
Usuario: Busca las últimas noticias de IA
Agente: [invoca la herramienta de búsqueda]
Resultado: [lista de enlaces relevantes + resúmenes]
```

## Obtención Web

Los agentes pueden obtener contenido de cualquier URL.

### Formato de Contenido

| Formato    | Descripción                                                       |
| ---------- | ----------------------------------------------------------------- |
| `markdown` | Contenido limpio de página convertido a Markdown (predeterminado) |
| `text`     | Texto sin formato sin formato                                     |
| `html`     | HTML en bruto                                                     |

### Ejemplo de Obtención

```
Usuario: ¿Qué hay en https://example.com?
Agente: [obtiene URL]
Resultado: [Markdown de la página]
```

## Redirección Automática

Si una URL redirige a un host diferente, el agente recibe un aviso:

```
La URL redirigió a https://otro-host.com. Obtén esa URL para continuar.
```

El agente debería hacer una nueva solicitud de obtención al host redirigido.

## Tiempo de Espera

Las obtenciones web tienen un tiempo de espera predeterminado de 30 segundos. Para páginas lentas, ajusta:

```bash
openclaw config set web.fetch.timeout 60000  # ms
```

## Seguridad y Privacidad

- Las URL se validan antes de la obtención
- Las URL HTTP se actualizan automáticamente a HTTPS
- Sin obtención de recursos locales (`file://`, `localhost`, etc.)
- Las claves API se almacenan de forma segura en `~/.openclaw/credentials/`

## Integración con Firecrawl

Para rastreo web avanzado (mapas del sitio, extracción de datos estructurados), usa la [herramienta Firecrawl](/es-ES/tools/firecrawl) en su lugar.

## Aprobaciones de Búsqueda/Obtención

Por defecto, la obtención web no requiere aprobación. Para habilitar aprobaciones:

```bash
openclaw config set agent.approvals.web true
```

Ahora cada solicitud de búsqueda/obtención solicitará confirmación.

## Ejemplo de Comando Slash

Define un comando slash para búsquedas rápidas:

```json
{
  "name": "search",
  "description": "Buscar en la web",
  "prompt": "Busca: {{query}}"
}
```

Uso:

```
/search últimas tendencias de TypeScript
```

## Límites

- **Tamaño de página**: Páginas muy grandes (>1MB) pueden truncarse.
- **JavaScript**: La obtención básica no ejecuta JavaScript; usa [Browser](/es-ES/tools/browser) para sitios renderizados por JS.
- **Rastreo**: La obtención básica es de una sola página; usa [Firecrawl](/es-ES/tools/firecrawl) para rastreo multi-página.

## Alternativas

### Para Sitios Pesados en JavaScript

Usa la [herramienta Browser](/es-ES/tools/browser) con Playwright para renderizado completo de navegador:

```bash
openclaw agent send "Carga https://app.example.com y toma una captura de pantalla"
```

### Para Rastreo Profundo

Usa la [herramienta Firecrawl](/es-ES/tools/firecrawl) para mapas del sitio y rastreo estructurado.

## Depuración

Para ver solicitudes web en logs:

```bash
DEBUG=openclaw:web openclaw agent send "Busca TypeScript"
```

## Problemas Comunes

**Problema**: Búsqueda devuelve resultados vacíos.
**Solución**: Verifica que tu clave API esté configurada y sea válida.

**Problema**: La obtención falla con tiempo de espera.
**Solución**: Aumenta `web.fetch.timeout` o usa la herramienta Browser para sitios lentos.

**Problema**: Obtención devuelve HTML desordenado.
**Solución**: Intenta `format=markdown` (predeterminado) para contenido limpio.

**Problema**: Redirección a un host diferente.
**Solución**: El agente debería obtener automáticamente la URL redirigida; si no, menciónala explícitamente.

## Configuración Avanzada

### Deshabilitar Actualizaciones de HTTP a HTTPS

```bash
openclaw config set web.fetch.upgradeHttp false
```

### Cabeceras Personalizadas

Para agregar cabeceras HTTP personalizadas a las obtenciones, usa la herramienta Browser en su lugar (la obtención básica no soporta cabeceras personalizadas).

## Integración de API

Los proveedores de búsqueda exponen sus propias API:

- [Perplexity API](https://docs.perplexity.ai)
- [Tavily API](https://tavily.com)
- [Brave Search API](https://brave.com/search/api/)

OpenClaw usa estas API bajo el capó, por lo que te beneficias de sus características y límites de tasa.

## Límites de Tasa

Cada proveedor de búsqueda tiene sus propios límites de tasa:

- **Perplexity**: varía por plan
- **Tavily**: varía por plan
- **Brave**: 1 solicitud/segundo (nivel gratuito)

Si alcanzas límites de tasa, espera o actualiza tu plan.

## Ejemplos

### Ejemplo 1: Búsqueda + Obtención

```
Usuario: Encuentra la documentación oficial de React y resume la página de hooks.
Agente:
1. [Busca "documentación oficial de React"]
2. [Obtiene https://react.dev/reference/react/hooks]
3. [Devuelve resumen]
```

### Ejemplo 2: Verificación de Hechos

```
Usuario: ¿Es cierto que TypeScript 5.0 fue lanzado en marzo de 2023?
Agente: [Busca "lanzamiento de TypeScript 5.0"]
Resultado: Sí, TypeScript 5.0 fue lanzado el 16 de marzo de 2023.
```

### Ejemplo 3: Monitoreo de Noticias

```
Usuario: Resume las principales noticias tecnológicas de hoy.
Agente: [Busca "noticias tecnológicas hoy"]
Resultado: [Lista de titulares recientes + resúmenes]
```

## Referencias

- [Browser](/es-ES/tools/browser) – automatización de navegador completa
- [Firecrawl](/es-ES/tools/firecrawl) – rastreo web avanzado
- [Aprobaciones de Exec](/es-ES/tools/exec-approvals) – controlar cuándo los agentes pueden buscar/obtener
- [Comandos Slash](/es-ES/tools/slash-commands) – automatizar flujos de trabajo de búsqueda
