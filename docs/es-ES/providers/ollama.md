---
summary: "Ejecuta OpenClaw con Ollama (runtime local de LLM)"
read_when:
  - Quieres ejecutar OpenClaw con modelos locales mediante Ollama
  - Necesitas orientación para configurar Ollama
title: "Ollama"
---

# Ollama

Ollama es un runtime local de LLM que facilita ejecutar modelos de código abierto en tu máquina. OpenClaw se integra con la API nativa de Ollama (`/api/chat`), soportando streaming y llamada a herramientas, y puede **descubrir automáticamente modelos con capacidad de herramientas** cuando optas por usar `OLLAMA_API_KEY` (o un perfil de autenticación) y no defines una entrada explícita de `models.providers.ollama`.

## Inicio rápido

1. Instala Ollama: [https://ollama.ai](https://ollama.ai)

2. Descarga un modelo:

```bash
ollama pull gpt-oss:20b
# o
ollama pull llama3.3
# o
ollama pull qwen2.5-coder:32b
# o
ollama pull deepseek-r1:32b
```

3. Habilita Ollama para OpenClaw (cualquier valor funciona; Ollama no requiere una clave real):

```bash
# Establecer variable de entorno
export OLLAMA_API_KEY="ollama-local"

# O configurar en tu archivo de configuración
openclaw config set models.providers.ollama.apiKey "ollama-local"
```

4. Usa modelos de Ollama:

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

Cuando estableces `OLLAMA_API_KEY` (o un perfil de autenticación) y **no** defines `models.providers.ollama`, OpenClaw descubre modelos desde la instancia local de Ollama en `http://127.0.0.1:11434`:

- Consulta `/api/tags` y `/api/show`
- Mantiene solo modelos que reporten capacidad de `tools`
- Marca `reasoning` cuando el modelo reporta `thinking`
- Lee `contextWindow` desde `model_info["<arch>.context_length"]` cuando está disponible
- Establece `maxTokens` a 10× la ventana de contexto
- Establece todos los costos a `0`

Esto evita entradas de modelo manuales mientras mantiene el catálogo alineado con las capacidades de Ollama.

Para ver qué modelos están disponibles:

```bash
ollama list
openclaw models list
```

Para agregar un nuevo modelo, simplemente descárgalo con Ollama:

```bash
ollama pull mistral
```

El nuevo modelo será descubierto automáticamente y estará disponible para usar.

Si estableces `models.providers.ollama` explícitamente, el descubrimiento automático se omite y debes definir modelos manualmente (ver abajo).

## Configuración

### Configuración básica (descubrimiento implícito)

La forma más simple de habilitar Ollama es mediante variable de entorno:

```bash
export OLLAMA_API_KEY="ollama-local"
```

### Configuración explícita (modelos manuales)

Usa configuración explícita cuando:

- Ollama se ejecuta en otro host/puerto.
- Quieres forzar ventanas de contexto específicas o listas de modelos.
- Quieres incluir modelos que no reporten soporte de herramientas.

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434",
        apiKey: "ollama-local",
        api: "ollama",
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

Si `OLLAMA_API_KEY` está establecido, puedes omitir `apiKey` en la entrada del proveedor y OpenClaw lo completará para verificaciones de disponibilidad.

### URL base personalizada (configuración explícita)

Si Ollama se ejecuta en un host o puerto diferente (la configuración explícita deshabilita el descubrimiento automático, así que define modelos manualmente):

```json5
{
  models: {
    providers: {
      ollama: {
        apiKey: "ollama-local",
        baseUrl: "http://ollama-host:11434",
      },
    },
  },
}
```

### Selección de modelo

Una vez configurado, todos tus modelos de Ollama están disponibles:

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

OpenClaw marca modelos como capaces de razonamiento cuando Ollama reporta `thinking` en `/api/show`:

```bash
ollama pull deepseek-r1:32b
```

### Costos de modelo

Ollama es gratuito y se ejecuta localmente, por lo que todos los costos de modelo se establecen en $0.

### Configuración de streaming

La integración de Ollama con OpenClaw usa la **API nativa de Ollama** (`/api/chat`) por defecto, que soporta completamente streaming y llamada a herramientas simultáneamente. No se necesita configuración especial.

#### Modo legacy compatible con OpenAI

Si necesitas usar el endpoint compatible con OpenAI en su lugar (por ejemplo, detrás de un proxy que solo soporta formato OpenAI), establece `api: "openai-completions"` explícitamente:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://ollama-host:11434/v1",
        api: "openai-completions",
        apiKey: "ollama-local",
        models: [...]
      }
    }
  }
}
```

Nota: El endpoint compatible con OpenAI puede no soportar streaming + llamada a herramientas simultáneamente. Puede que necesites deshabilitar el streaming con `params: { streaming: false }` en la configuración del modelo.

### Ventanas de contexto

Para modelos descubiertos automáticamente, OpenClaw usa la ventana de contexto reportada por Ollama cuando está disponible, de lo contrario usa por defecto `8192`. Puedes anular `contextWindow` y `maxTokens` en la configuración explícita del proveedor.

## Solución de problemas

### Ollama no detectado

Asegúrate de que Ollama esté en ejecución y de que hayas establecido `OLLAMA_API_KEY` (o un perfil de autenticación), y que **no** hayas definido una entrada explícita de `models.providers.ollama`:

```bash
ollama serve
```

Y que la API sea accesible:

```bash
curl http://localhost:11434/api/tags
```

### No hay modelos disponibles

OpenClaw solo descubre automáticamente modelos que reporten soporte de herramientas. Si tu modelo no está listado, puedes:

- Descargar un modelo con capacidad de herramientas, o
- Definir el modelo explícitamente en `models.providers.ollama`.

Para agregar modelos:

```bash
ollama list  # Ver qué está instalado
ollama pull gpt-oss:20b  # Descargar un modelo con capacidad de herramientas
ollama pull llama3.3     # O otro modelo
```

### Conexión rechazada

Verifica que Ollama esté ejecutándose en el puerto correcto:

```bash
# Verificar si Ollama está en ejecución
ps aux | grep ollama

# O reiniciar Ollama
ollama serve
```

## Ver también

- [Proveedores de modelos](/es-ES/concepts/model-providers) - Vista general de todos los proveedores
- [Selección de modelo](/es-ES/concepts/models) - Cómo elegir modelos
- [Configuración](/es-ES/gateway/configuration) - Referencia completa de configuración
