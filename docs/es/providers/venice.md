---
summary: "Use modelos de Venice AI enfocados en la privacidad en OpenClaw"
read_when:
  - Quiere inferencia enfocada en la privacidad en OpenClaw
  - Quiere guía de configuración de Venice AI
title: "Venice AI"
---

# Venice AI (destacado de Venice)

**Venice** es nuestro destacado de configuración de Venice para inferencia con prioridad en la privacidad, con acceso anonimizado opcional a modelos propietarios.

Venice AI ofrece inferencia de IA enfocada en la privacidad con soporte para modelos sin censura y acceso a los principales modelos propietarios a través de su proxy anonimizado. Toda la inferencia es privada por defecto: sin entrenamiento con sus datos, sin registros.

## Por qué Venice en OpenClaw

- **Inferencia privada** para modelos de código abierto (sin registros).
- **Modelos sin censura** cuando los necesita.
- **Acceso anonimizado** a modelos propietarios (Opus/GPT/Gemini) cuando la calidad importa.
- Endpoints compatibles con OpenAI `/v1`.

## Modos de privacidad

Venice ofrece dos niveles de privacidad; comprenderlos es clave para elegir su modelo:

| Modo            | Descripción                                                                                                                                                                       | Modelos                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Privado**     | Totalmente privado. Los prompts/respuestas **nunca se almacenan ni se registran**. Efímero.                                       | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonimizado** | Enrutado a través de Venice con metadatos eliminados. El proveedor subyacente (OpenAI, Anthropic) ve solicitudes anonimizadas. | Claude, GPT, Gemini, Grok, Kimi, MiniMax                       |

## Funcionalidades

- **Enfoque en la privacidad**: Elija entre modos "privado" (totalmente privado) y "anonimizado" (enrutado)
- **Modelos sin censura**: Acceso a modelos sin restricciones de contenido
- **Acceso a modelos principales**: Use Claude, GPT-5.2, Gemini, Grok mediante el proxy anonimizado de Venice
- **API compatible con OpenAI**: Endpoints estándar `/v1` para integración sencilla
- **Streaming**: ✅ Compatible con todos los modelos
- **Llamadas a funciones**: ✅ Compatible en modelos seleccionados (ver capacidades del modelo)
- **Visión**: ✅ Compatible en modelos con capacidad de visión
- **Sin límites estrictos de tasa**: Puede aplicar limitación por uso justo para usos extremos

## Configuración

### 1. Obtener la clave de API

1. Regístrese en [venice.ai](https://venice.ai)
2. Vaya a **Settings → API Keys → Create new key**
3. Copie su clave de API (formato: `vapi_xxxxxxxxxxxx`)

### 2) Configurar OpenClaw

**Opción A: Variable de entorno**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Opción B: Configuración interactiva (recomendada)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Esto hará lo siguiente:

1. Solicitar su clave de API (o usar la existente `VENICE_API_KEY`)
2. Mostrar todos los modelos de Venice disponibles
3. Permitirle elegir su modelo predeterminado
4. Configurar el proveedor automáticamente

**Opción C: No interactiva**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verificar la configuración

```bash
openclaw chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Selección de modelo

Después de la configuración, OpenClaw muestra todos los modelos de Venice disponibles. Elija según sus necesidades:

- **Predeterminado (nuestra elección)**: `venice/llama-3.3-70b` para privacidad y rendimiento equilibrado.
- **Mejor calidad general**: `venice/claude-opus-45` para trabajos difíciles (Opus sigue siendo el más fuerte).
- **Privacidad**: Elija modelos "privados" para inferencia totalmente privada.
- **Capacidad**: Elija modelos "anonimizados" para acceder a Claude, GPT, Gemini mediante el proxy de Venice.

Cambie su modelo predeterminado en cualquier momento:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Liste todos los modelos disponibles:

```bash
openclaw models list | grep venice
```

## Configurar vía `openclaw configure`

1. Ejecute `openclaw configure`
2. Seleccione **Model/auth**
3. Elija **Venice AI**

## ¿Qué modelo debería usar?

| Caso de uso                     | Modelo recomendado               | Por qué                                               |
| ------------------------------- | -------------------------------- | ----------------------------------------------------- |
| **Chat general**                | `llama-3.3-70b`                  | Buen equilibrio, totalmente privado                   |
| **Mejor calidad general**       | `claude-opus-45`                 | Opus sigue siendo el más fuerte para tareas difíciles |
| **Privacidad + calidad Claude** | `claude-opus-45`                 | Mejor razonamiento vía proxy anonimizado              |
| **Programación**                | `qwen3-coder-480b-a35b-instruct` | Optimizado para código, contexto de 262k              |
| **Tareas de visión**            | `qwen3-vl-235b-a22b`             | Mejor modelo privado de visión                        |
| **Sin censura**                 | `venice-uncensored`              | Sin restricciones de contenido                        |
| **Rápido y económico**          | `qwen3-4b`                       | Ligero, aún capaz                                     |
| **Razonamiento complejo**       | `deepseek-v3.2`                  | Razonamiento sólido, privado                          |

## Modelos disponibles (25 en total)

### Modelos privados (15) — Totalmente privados, sin registros

| ID del modelo                    | Nombre                                     | Contexto (tokens) | Funcionalidades           |
| -------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B              | 131k                                 | General                   |
| `llama-3.2-3b`                   | Llama 3.2 3B               | 131k                                 | Rápido, ligero            |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B    | 131k                                 | Tareas complejas          |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking                        | 131k                                 | Razonamiento              |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct                        | 131k                                 | General                   |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B                           | 262k                                 | Código                    |
| `qwen3-next-80b`                 | Qwen3 Next 80B                             | 262k                                 | General                   |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B                              | 262k                                 | Visión                    |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k                                  | Rápido, razonamiento      |
| `deepseek-v3.2`                  | DeepSeek V3.2              | 163k                                 | Razonamiento              |
| `venice-uncensored`              | Venice Uncensored                          | 32k                                  | Sin censura               |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k                                 | Visión                    |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct                       | 202k                                 | Visión                    |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B                        | 131k                                 | General                   |
| `zai-org-glm-4.7`                | GLM 4.7                    | 202k                                 | Razonamiento, multilingüe |

### Modelos anonimizados (10) — Vía proxy de Venice

| ID del modelo            | Original                          | Contexto (tokens) | Funcionalidades      |
| ------------------------ | --------------------------------- | ------------------------------------ | -------------------- |
| `claude-opus-45`         | Claude Opus 4.5   | 202k                                 | Razonamiento, visión |
| `claude-sonnet-45`       | Claude Sonnet 4.5 | 202k                                 | Razonamiento, visión |
| `openai-gpt-52`          | GPT-5.2           | 262k                                 | Razonamiento         |
| `openai-gpt-52-codex`    | GPT-5.2 Codex     | 262k                                 | Razonamiento, visión |
| `gemini-3-pro-preview`   | Gemini 3 Pro                      | 202k                                 | Razonamiento, visión |
| `gemini-3-flash-preview` | Gemini 3 Flash                    | 262k                                 | Razonamiento, visión |
| `grok-41-fast`           | Grok 4.1 Fast     | 262k                                 | Razonamiento, visión |
| `grok-code-fast-1`       | Grok Code Fast 1                  | 262k                                 | Razonamiento, código |
| `kimi-k2-thinking`       | Kimi K2 Thinking                  | 262k                                 | Razonamiento         |
| `minimax-m21`            | MiniMax M2.1      | 202k                                 | Razonamiento         |

## Descubrimiento de modelos

OpenClaw descubre automáticamente los modelos desde la API de Venice cuando `VENICE_API_KEY` está configurado. Si la API no es accesible, recurre a un catálogo estático.

El endpoint `/models` es público (no requiere autenticación para listar), pero la inferencia requiere una clave de API válida.

## Streaming y soporte de herramientas

| Funcionalidad            | Soporte                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| **Streaming**            | ✅ Todos los modelos                                                                      |
| **Llamadas a funciones** | ✅ La mayoría de los modelos (ver `supportsFunctionCalling` en la API) |
| **Visión/Imágenes**      | ✅ Modelos marcados con la funcionalidad "Vision"                                         |
| **Modo JSON**            | ✅ Compatible mediante `response_format`                                                  |

## Precios

Venice utiliza un sistema basado en créditos. Consulte [venice.ai/pricing](https://venice.ai/pricing) para las tarifas actuales:

- **Modelos privados**: Generalmente de menor costo
- **Modelos anonimizados**: Similares al precio de la API directa + una pequeña tarifa de Venice

## Comparación: Venice vs API directa

| Aspecto         | Venice (anonimizado) | API directa               |
| --------------- | --------------------------------------- | ------------------------- |
| **Privacidad**  | Metadatos eliminados, anonimizado       | Su cuenta vinculada       |
| **Latencia**    | +10-50 ms (proxy)    | Directa                   |
| **Funciones**   | La mayoría de las funciones compatibles | Funciones completas       |
| **Facturación** | Créditos de Venice                      | Facturación del proveedor |

## Ejemplos de uso

```bash
# Use default private model
openclaw chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
openclaw chat --model venice/claude-opus-45

# Use uncensored model
openclaw chat --model venice/venice-uncensored

# Use vision model with image
openclaw chat --model venice/qwen3-vl-235b-a22b

# Use coding model
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Solución de problemas

### La clave de API no es reconocida

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Asegúrese de que la clave comience con `vapi_`.

### Modelo no disponible

El catálogo de modelos de Venice se actualiza dinámicamente. Ejecute `openclaw models list` para ver los modelos disponibles actualmente. Algunos modelos pueden estar temporalmente fuera de línea.

### Problemas de conexión

La API de Venice está en `https://api.venice.ai/api/v1`. Asegúrese de que su red permita conexiones HTTPS.

## Ejemplo de archivo de configuración

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

## Enlaces

- [Venice AI](https://venice.ai)
- [Documentación de la API](https://docs.venice.ai)
- [Precios](https://venice.ai/pricing)
- [Estado](https://status.venice.ai)
