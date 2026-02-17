---
summary: "Transcripción de Deepgram para notas de voz entrantes"
read_when:
  - Quieres Deepgram speech-to-text para archivos de audio adjuntos
  - Necesitas un ejemplo rápido de configuración de Deepgram
title: "Deepgram"
---

# Deepgram (Transcripción de audio)

Deepgram es una API de speech-to-text. En OpenClaw se usa para **transcripción de audio/notas de voz
entrantes** mediante `tools.media.audio`.

Cuando está habilitado, OpenClaw sube el archivo de audio a Deepgram e inyecta la transcripción
en el pipeline de respuesta (`{{Transcript}}` + bloque `[Audio]`). Esto **no es streaming**;
usa el endpoint de transcripción pregrabada.

Sitio web: [https://deepgram.com](https://deepgram.com)  
Documentación: [https://developers.deepgram.com](https://developers.deepgram.com)

## Inicio rápido

1. Establece tu clave de API:

```
DEEPGRAM_API_KEY=dg_...
```

2. Habilita el proveedor:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Opciones

- `model`: ID de modelo de Deepgram (por defecto: `nova-3`)
- `language`: sugerencia de idioma (opcional)
- `tools.media.audio.providerOptions.deepgram.detect_language`: habilitar detección de idioma (opcional)
- `tools.media.audio.providerOptions.deepgram.punctuate`: habilitar puntuación (opcional)
- `tools.media.audio.providerOptions.deepgram.smart_format`: habilitar formato inteligente (opcional)

Ejemplo con idioma:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "deepgram", model: "nova-3", language: "en" }],
      },
    },
  },
}
```

Ejemplo con opciones de Deepgram:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        providerOptions: {
          deepgram: {
            detect_language: true,
            punctuate: true,
            smart_format: true,
          },
        },
        models: [{ provider: "deepgram", model: "nova-3" }],
      },
    },
  },
}
```

## Notas

- La autenticación sigue el orden estándar de autenticación del proveedor; `DEEPGRAM_API_KEY` es la ruta más simple.
- Anula endpoints o encabezados con `tools.media.audio.baseUrl` y `tools.media.audio.headers` al usar un proxy.
- La salida sigue las mismas reglas de audio que otros proveedores (límites de tamaño, tiempos de espera, inyección de transcripción).
