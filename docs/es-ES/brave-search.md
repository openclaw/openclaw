---
summary: "Configuración de la API de Brave Search para web_search"
read_when:
  - Deseas usar Brave Search para web_search
  - Necesitas un BRAVE_API_KEY o detalles del plan
title: "Brave Search"
---

# API de Brave Search

OpenClaw utiliza Brave Search como proveedor predeterminado para `web_search`.

## Obtener una clave de API

1. Crea una cuenta de API de Brave Search en [https://brave.com/search/api/](https://brave.com/search/api/)
2. En el panel de control, elige el plan **Data for Search** y genera una clave de API.
3. Almacena la clave en la configuración (recomendado) o establece `BRAVE_API_KEY` en el entorno del Gateway.

## Ejemplo de configuración

```json5
{
  tools: {
    web: {
      search: {
        provider: "brave",
        apiKey: "BRAVE_API_KEY_HERE",
        maxResults: 5,
        timeoutSeconds: 30,
      },
    },
  },
}
```

## Notas

- El plan Data for AI **no** es compatible con `web_search`.
- Brave ofrece un nivel gratuito más planes de pago; consulta el portal de la API de Brave para conocer los límites actuales.

Consulta [Herramientas web](/es-ES/tools/web) para ver la configuración completa de web_search.
