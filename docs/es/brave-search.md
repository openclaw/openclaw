---
summary: "Configuración de la API de Brave Search para web_search"
read_when:
  - Quiere usar Brave Search para web_search
  - Necesita una BRAVE_API_KEY o detalles del plan
title: "Brave Search"
---

# API de Brave Search

OpenClaw usa Brave Search como el proveedor predeterminado para `web_search`.

## Obtener una clave de API

1. Cree una cuenta de la API de Brave Search en [https://brave.com/search/api/](https://brave.com/search/api/)
2. En el panel, elija el plan **Data for Search** y genere una clave de API.
3. Guarde la clave en la configuración (recomendado) o establezca `BRAVE_API_KEY` en el entorno del Gateway.

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
- Brave ofrece un nivel gratuito además de planes de pago; consulte el portal de la API de Brave para conocer los límites actuales.

Consulte [Web tools](/tools/web) para la configuración completa de web_search.
