---
summary: "Comprensión de imagen/audio/video entrante (opcional) con respaldos de proveedor + CLI"
read_when:
  - Diseñar o refactorizar comprensión de medios
  - Ajustar preprocesamiento de audio/video/imagen entrante
title: "Comprensión de Medios"
---

# Comprensión de Medios (Entrante) — 2026-01-17

OpenClaw puede **resumir medios entrantes** (imagen/audio/video) antes de que se ejecute el pipeline de respuesta. Detecta automáticamente cuando las herramientas locales o claves de proveedor están disponibles, y puede deshabilitarse o personalizarse. Si la comprensión está desactivada, los modelos aún reciben los archivos/URLs originales como de costumbre.

## Objetivos

- Opcional: pre-digerir medios entrantes en texto corto para enrutamiento más rápido + mejor análisis de comandos.
- Preservar la entrega de medios originales al modelo (siempre).
- Admitir **APIs de proveedor** y **respaldos CLI**.
- Permitir múltiples modelos con respaldo ordenado (error/tamaño/tiempo de espera).

## Comportamiento de alto nivel

1. Recopilar adjuntos entrantes (`MediaPaths`, `MediaUrls`, `MediaTypes`).
2. Para cada capacidad habilitada (imagen/audio/video), seleccionar adjuntos según política (predeterminado: **primero**).
3. Elegir la primera entrada de modelo elegible (tamaño + capacidad + autenticación).
4. Si un modelo falla o el medio es demasiado grande, **recurrir a la siguiente entrada**.
5. En caso de éxito:
   - `Body` se convierte en bloque `[Image]`, `[Audio]` o `[Video]`.
   - El audio establece `{{Transcript}}`; el análisis de comandos usa texto de subtítulo cuando está presente,
     de lo contrario la transcripción.
   - Los subtítulos se preservan como `Texto del usuario:` dentro del bloque.

Si la comprensión falla o está deshabilitada, **el flujo de respuesta continúa** con el cuerpo original + adjuntos.

## Resumen de configuración

`tools.media` admite **modelos compartidos** más anulaciones por capacidad:

- `tools.media.models`: lista de modelos compartida (usar `capabilities` para controlar).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - predeterminados (`prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`)
  - anulaciones de proveedor (`baseUrl`, `headers`, `providerOptions`)
  - opciones de audio Deepgram mediante `tools.media.audio.providerOptions.deepgram`
  - opcional **lista `models` por capacidad** (preferida antes de modelos compartidos)
  - política `attachments` (`mode`, `maxAttachments`, `prefer`)
  - `scope` (control opcional por canal/chatType/clave de sesión)
- `tools.media.concurrency`: máximo de ejecuciones de capacidad concurrentes (predeterminado **2**).

```json5
{
  tools: {
    media: {
      models: [
        /* lista compartida */
      ],
      image: {
        /* anulaciones opcionales */
      },
      audio: {
        /* anulaciones opcionales */
      },
      video: {
        /* anulaciones opcionales */
      },
    },
  },
}
```

### Entradas de modelo

Cada entrada `models[]` puede ser **proveedor** o **CLI**:

```json5
{
  type: "provider", // predeterminado si se omite
  provider: "openai",
  model: "gpt-5.2",
  prompt: "Describe la imagen en <= 500 caracteres.",
  maxChars: 500,
  maxBytes: 10485760,
  timeoutSeconds: 60,
  capabilities: ["image"], // opcional, usado para entradas multi-modal
  profile: "vision-profile",
  preferredProfile: "vision-fallback",
}
```

```json5
{
  type: "cli",
  command: "gemini",
  args: [
    "-m",
    "gemini-3-flash",
    "--allowed-tools",
    "read_file",
    "Lee el medio en {{MediaPath}} y descríbelo en <= {{MaxChars}} caracteres.",
  ],
  maxChars: 500,
  maxBytes: 52428800,
  timeoutSeconds: 120,
  capabilities: ["video", "image"],
}
```

Las plantillas CLI también pueden usar:

- `{{MediaDir}}` (directorio que contiene el archivo de medios)
- `{{OutputDir}}` (directorio scratch creado para esta ejecución)
- `{{OutputBase}}` (ruta base de archivo scratch, sin extensión)

## Predeterminados y límites

Predeterminados recomendados:

- `maxChars`: **500** para imagen/video (corto, amigable para comandos)
- `maxChars`: **no establecido** para audio (transcripción completa a menos que establezcas un límite)
- `maxBytes`:
  - imagen: **10MB**
  - audio: **20MB**
  - video: **50MB**

Reglas:

- Si el medio excede `maxBytes`, ese modelo se omite y **se intenta el siguiente modelo**.
- Si el modelo devuelve más de `maxChars`, la salida se recorta.
- `prompt` predeterminado es simple "Describe el {medio}." más la guía `maxChars` (solo imagen/video).
- Si `<capability>.enabled: true` pero no se configuran modelos, OpenClaw intenta el
  **modelo de respuesta activo** cuando su proveedor admite la capacidad.

### Detección automática de comprensión de medios (predeterminado)

Si `tools.media.<capability>.enabled` **no** está establecido en `false` y no has configurado modelos, OpenClaw detecta automáticamente en este orden y **se detiene en la primera opción que funciona**:

1. **CLIs locales** (solo audio; si están instalados)
   - `sherpa-onnx-offline` (requiere `SHERPA_ONNX_MODEL_DIR` con encoder/decoder/joiner/tokens)
   - `whisper-cli` (`whisper-cpp`; usa `WHISPER_CPP_MODEL` o el modelo tiny incluido)
   - `whisper` (CLI de Python; descarga modelos automáticamente)
2. **CLI Gemini** (`gemini`) usando `read_many_files`
3. **Claves de proveedor**
   - Audio: OpenAI → Groq → Deepgram → Google
   - Imagen: OpenAI → Anthropic → Google → MiniMax
   - Video: Google

Para deshabilitar la detección automática, establece:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: false,
      },
    },
  },
}
```

Nota: La detección binaria es de mejor esfuerzo en macOS/Linux/Windows; asegúrate de que el CLI esté en `PATH` (expandimos `~`), o establece un modelo CLI explícito con una ruta de comando completa.

## Capacidades (opcional)

Si estableces `capabilities`, la entrada solo se ejecuta para esos tipos de medios. Para listas compartidas, OpenClaw puede inferir predeterminados:

- `openai`, `anthropic`, `minimax`: **imagen**
- `google` (API Gemini): **imagen + audio + video**
- `groq`: **audio**
- `deepgram`: **audio**

Para entradas CLI, **establece `capabilities` explícitamente** para evitar coincidencias sorpresivas.
Si omites `capabilities`, la entrada es elegible para la lista en la que aparece.

## Matriz de soporte de proveedor (integraciones OpenClaw)

| Capacidad | Integración de proveedor                             | Notas                                                             |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Imagen    | OpenAI / Anthropic / Google / otros mediante `pi-ai` | Cualquier modelo con capacidad de imagen en el registro funciona. |
| Audio     | OpenAI, Groq, Deepgram, Google                       | Transcripción de proveedor (Whisper/Deepgram/Gemini).             |
| Video     | Google (API Gemini)                                  | Comprensión de video del proveedor.                               |

## Proveedores recomendados

**Imagen**

- Prefiere tu modelo activo si admite imágenes.
- Buenos predeterminados: `openai/gpt-5.2`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`.

**Audio**

- `openai/gpt-4o-mini-transcribe`, `groq/whisper-large-v3-turbo`, o `deepgram/nova-3`.
- Respaldo CLI: `whisper-cli` (whisper-cpp) o `whisper`.
- Configuración Deepgram: [Deepgram (transcripción de audio)](/es-ES/providers/deepgram).

**Video**

- `google/gemini-3-flash-preview` (rápido), `google/gemini-3-pro-preview` (más rico).
- Respaldo CLI: CLI `gemini` (admite `read_file` en video/audio).

## Política de adjuntos

`attachments` por capacidad controla qué adjuntos se procesan:

- `mode`: `first` (predeterminado) o `all`
- `maxAttachments`: limita el número procesado (predeterminado **1**)
- `prefer`: `first`, `last`, `path`, `url`

Cuando `mode: "all"`, las salidas se etiquetan `[Image 1/2]`, `[Audio 2/2]`, etc.

## Ejemplos de configuración

### 1) Lista de modelos compartidos + anulaciones

```json5
{
  tools: {
    media: {
      models: [
        { provider: "openai", model: "gpt-5.2", capabilities: ["image"] },
        {
          provider: "google",
          model: "gemini-3-flash-preview",
          capabilities: ["image", "audio", "video"],
        },
        {
          type: "cli",
          command: "gemini",
          args: [
            "-m",
            "gemini-3-flash",
            "--allowed-tools",
            "read_file",
            "Lee el medio en {{MediaPath}} y descríbelo en <= {{MaxChars}} caracteres.",
          ],
          capabilities: ["image", "video"],
        },
      ],
      audio: {
        attachments: { mode: "all", maxAttachments: 2 },
      },
      video: {
        maxChars: 500,
      },
    },
  },
}
```

### 2) Solo audio + video (imagen desactivada)

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          {
            type: "cli",
            command: "whisper",
            args: ["--model", "base", "{{MediaPath}}"],
          },
        ],
      },
      video: {
        enabled: true,
        maxChars: 500,
        models: [
          { provider: "google", model: "gemini-3-flash-preview" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Lee el medio en {{MediaPath}} y descríbelo en <= {{MaxChars}} caracteres.",
            ],
          },
        ],
      },
    },
  },
}
```

### 3) Comprensión de imagen opcional

```json5
{
  tools: {
    media: {
      image: {
        enabled: true,
        maxBytes: 10485760,
        maxChars: 500,
        models: [
          { provider: "openai", model: "gpt-5.2" },
          { provider: "anthropic", model: "claude-opus-4-6" },
          {
            type: "cli",
            command: "gemini",
            args: [
              "-m",
              "gemini-3-flash",
              "--allowed-tools",
              "read_file",
              "Lee el medio en {{MediaPath}} y descríbelo en <= {{MaxChars}} caracteres.",
            ],
          },
        ],
      },
    },
  },
}
```

### 4) Entrada única multi-modal (capacidades explícitas)

```json5
{
  tools: {
    media: {
      image: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      audio: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
      video: {
        models: [
          {
            provider: "google",
            model: "gemini-3-pro-preview",
            capabilities: ["image", "video", "audio"],
          },
        ],
      },
    },
  },
}
```

## Salida de estado

Cuando se ejecuta la comprensión de medios, `/status` incluye una línea de resumen corta:

```
📎 Medios: imagen ok (openai/gpt-5.2) · audio omitido (maxBytes)
```

Esto muestra resultados por capacidad y el proveedor/modelo elegido cuando es aplicable.

## Notas

- La comprensión es **de mejor esfuerzo**. Los errores no bloquean respuestas.
- Los adjuntos aún se pasan a los modelos incluso cuando la comprensión está deshabilitada.
- Usa `scope` para limitar dónde se ejecuta la comprensión (ej. solo mensajes directos).

## Documentación relacionada

- [Configuración](/es-ES/gateway/configuration)
- [Soporte de Imágenes y Medios](/es-ES/nodes/images)
