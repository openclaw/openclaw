---
summary: "Ejecute OpenClaw con Ollama (runtime local de LLM)"
read_when:
  - Quiere ejecutar OpenClaw con modelos locales mediante Ollama
  - Necesita orientación de configuración e instalación de Ollama
title: "Ollama"
---

# Ollama

Ollama es un runtime local de LLM que facilita ejecutar modelos de código abierto en su máquina. OpenClaw se integra con la API compatible con OpenAI de Ollama y puede **descubrir automáticamente modelos con capacidad de herramientas** cuando usted opta por ello con `OLLAMA_API_KEY` (o un perfil de autenticación) y no define una entrada explícita `models.providers.ollama`.

## Inicio rápido

1. Instale Ollama: [https://ollama.ai](https://ollama.ai)

2. Descargue un modelo:

```bash
ollama pull gpt-oss:20b
# or
ollama pull llama3.3
# or
ollama pull qwen2.5-coder:32b
# or
ollama pull deepseek-r1:32b
```

3. Habilite Ollama para OpenClaw (cualquier valor funciona; Ollama no requiere una clave real):

```bash
# Set environment variable
export OLLAMA_API_KEY="ollama-local"

# Or configure in your config file
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Use modelos de Ollama:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/gpt-oss:20b" },
    },
  },
}
```

## Descubrimiento de modelos (proveedor implícito)

Cuando establece `OLLAMA_API_KEY` (o un perfil de autenticación) y **no** define `models.providers.ollama`, OpenClaw descubre modelos desde la instancia local de Ollama en `http://127.0.0.1:11434`:

- Consulta `/api/tags` y `/api/show`
- Conserva solo los modelos que reportan la capacidad `tools`
- Marca `reasoning` cuando el modelo reporta `thinking`
- Lee `contextWindow` desde `model_info["<arch>.context_length"]` cuando está disponible
- Establece `maxTokens` en 10× la ventana de contexto
- Establece todos los costos en `0`

Esto evita entradas manuales de modelos mientras mantiene el catálogo alineado con las capacidades de Ollama.

Para ver qué modelos están disponibles:

```bash
ollama list
openclaw models list
```

Para agregar un nuevo modelo, simplemente descárguelo con Ollama:

```bash
ollama pull mistral
```

El nuevo modelo se descubrirá automáticamente y estará disponible para usar.

Si establece `models.providers.ollama` explícitamente, se omite el descubrimiento automático y debe definir los modelos manualmente (ver abajo).

## Configuración

### Configuración básica (descubrimiento implícito)

La forma más sencilla de habilitar Ollama es mediante una variable de entorno:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Configuración explícita (modelos manuales)

Use configuración explícita cuando:

- Ollama se ejecuta en otro host/puerto.
- Quiere forzar ventanas de contexto específicas o listas de modelos.
- Quiere incluir modelos que no reportan soporte de herramientas.

```json5
{
  models: {
    providers: {
      ollama: {
        // Use a host that includes /v1 for OpenAI-compatible APIs
        baseUrl: "http://ollama-host:11434/v1",
        apiKey: "ollama-local",
        api: "openai-completions",
        models: [
          {
            id: "gpt-oss:20b",
            name: "GPT-OSS 20B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 8192 * 10
          }
        ]
      }
    }
  }
}
```

Si se establece `OLLAMA_API_KEY`, puede omitir `apiKey` en la entrada del proveedor y OpenClaw lo completará para las comprobaciones de disponibilidad.

### URL base personalizada (configuración explícita)

Si Ollama se está ejecutando en un host o puerto diferente (la configuración explícita deshabilita el descubrimiento automático, por lo que debe definir los modelos manualmente):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434/v1",
      },
    },
  },
}
```

### Selección de modelos

Una vez configurado, todos sus modelos de Ollama están disponibles:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

## Avanzado

### Modelos de razonamiento

OpenClaw marca los modelos como capaces de razonamiento cuando Ollama reporta `thinking` en `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Costos de modelos

Ollama es gratuito y se ejecuta localmente, por lo que todos los costos de los modelos se establecen en $0.

### Configuración de streaming

Debido a un [problema conocido](https://github.com/badlogic/pi-mono/issues/1205) en el SDK subyacente con el formato de respuesta de Ollama, **el streaming está deshabilitado de forma predeterminada** para los modelos de Ollama. Esto evita respuestas corruptas al usar modelos con capacidad de herramientas.

Cuando el streaming está deshabilitado, las respuestas se entregan de una sola vez (modo no streaming), lo que evita el problema en el que deltas de contenido/razonamiento intercalados causan una salida confusa.

#### Volver a habilitar streaming (avanzado)

Si desea volver a habilitar el streaming para Ollama (puede causar problemas con modelos con capacidad de herramientas):

```json5
{
  agents: {
    defaults: {
      models: {
        "ollama/gpt-oss:20b": {
          streaming: true,
        },
      },
    },
  },
}
```

#### Deshabilitar streaming para otros proveedores

También puede deshabilitar el streaming para cualquier proveedor si es necesario:

```json5
{
  agents: {
    defaults: {
      models: {
        "openai/gpt-4": {
          streaming: false,
        },
      },
    },
  },
}
```

### Ventanas de contexto

Para los modelos descubiertos automáticamente, OpenClaw utiliza la ventana de contexto reportada por Ollama cuando está disponible; de lo contrario, usa de forma predeterminada `8192`. Puede sobrescribir `contextWindow` y `maxTokens` en la configuración explícita del proveedor.

## Solución de problemas

### Ollama no detectado

Asegúrese de que Ollama esté en ejecución y de haber establecido `OLLAMA_API_KEY` (o un perfil de autenticación), y de que **no** haya definido una entrada explícita `models.providers.ollama`:

```bash
ollama serve
```

Y de que la API sea accesible:

```bash
curl http://localhost:11434/api/tags
```

### No hay modelos disponibles

OpenClaw solo descubre automáticamente modelos que reportan soporte de herramientas. Si su modelo no aparece en la lista, haga una de las siguientes opciones:

- Descargue un modelo con capacidad de herramientas, o
- Defina el modelo explícitamente en `models.providers.ollama`.

Para agregar modelos:

```bash
ollama list  # See what's installed
ollama pull gpt-oss:20b  # Pull a tool-capable model
ollama pull llama3.3     # Or another model
```

### Conexión rechazada

Verifique que Ollama esté ejecutándose en el puerto correcto:

```bash
# Check if Ollama is running
ps aux | grep ollama

# Or restart Ollama
ollama serve
```

### Respuestas corruptas o nombres de herramientas en la salida

Si ve respuestas confusas que contienen nombres de herramientas (como `sessions_send`, `memory_get`) o texto fragmentado al usar modelos de Ollama, esto se debe a un problema del SDK aguas arriba con las respuestas en streaming. **Esto se corrige de forma predeterminada** en la versión más reciente de OpenClaw al deshabilitar el streaming para los modelos de Ollama.

Si habilitó manualmente el streaming y experimenta este problema:

1. Elimine la configuración `streaming: true` de las entradas de sus modelos de Ollama, o
2. Establezca explícitamente `streaming: false` para los modelos de Ollama (consulte [Configuración de streaming](#configuración-de-streaming))

## Ver también

- [Proveedores de modelos](/concepts/model-providers) - Descripción general de todos los proveedores
- [Selección de modelos](/concepts/models) - Cómo elegir modelos
- [Configuración](/gateway/configuration) - Referencia completa de configuración
