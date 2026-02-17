---
summary: "Usa modelos de Venice AI enfocados en privacidad en OpenClaw"
read_when:
  - Quieres inferencia enfocada en privacidad en OpenClaw
  - Quieres orientación para configurar Venice AI
title: "Venice AI"
---

# Venice AI (Destacado de Venice)

**Venice** es nuestra configuración destacada de Venice para inferencia que prioriza la privacidad con acceso anónimo opcional a modelos propietarios.

Venice AI proporciona inferencia de IA enfocada en privacidad con soporte para modelos sin censura y acceso a modelos propietarios principales a través de su proxy anonimizado. Toda la inferencia es privada por defecto: sin entrenamiento con tus datos, sin registro de eventos.

## Por qué Venice en OpenClaw

- **Inferencia privada** para modelos de código abierto (sin registro de eventos).
- **Modelos sin censura** cuando los necesites.
- **Acceso anonimizado** a modelos propietarios (Opus/GPT/Gemini) cuando la calidad importa.
- Endpoints `/v1` compatibles con OpenAI.

## Modos de privacidad

Venice ofrece dos niveles de privacidad: entender esto es clave para elegir tu modelo:

| Modo           | Descripción                                                                                                          | Modelos                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Privado**    | Completamente privado. Los prompts/respuestas **nunca se almacenan ni registran**. Efímero.                          | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonimizado** | Proxy a través de Venice con metadatos eliminados. El proveedor subyacente (OpenAI, Anthropic) ve solicitudes anonimizadas. | Claude, GPT, Gemini, Grok, Kimi, MiniMax       |

## Características

- **Enfocado en privacidad**: Elige entre modos "privado" (completamente privado) y "anonimizado" (proxy)
- **Modelos sin censura**: Acceso a modelos sin restricciones de contenido
- **Acceso a modelos principales**: Usa Claude, GPT-5.2, Gemini, Grok mediante el proxy anonimizado de Venice
- **API compatible con OpenAI**: Endpoints estándar `/v1` para integración fácil
- **Streaming**: ✅ Soportado en todos los modelos
- **Llamada a funciones**: ✅ Soportado en modelos seleccionados (verifica capacidades del modelo)
- **Visión**: ✅ Soportado en modelos con capacidad de visión
- **Sin límites de tasa duros**: Puede aplicarse limitación de uso justo para uso extremo

## Configuración

### 1. Obtener clave de API

1. Regístrate en [venice.ai](https://venice.ai)
2. Ve a **Settings → API Keys → Create new key**
3. Copia tu clave de API (formato: `vapi_xxxxxxxxxxxx`)

### 2. Configurar OpenClaw

**Opción A: Variable de entorno**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Opción B: Configuración interactiva (Recomendado)**

```bash
openclaw onboard --auth-choice venice-api-key
```

Esto hará:

1. Solicitar tu clave de API (o usar `VENICE_API_KEY` existente)
2. Mostrar todos los modelos de Venice disponibles
3. Permitirte elegir tu modelo por defecto
4. Configurar el proveedor automáticamente

**Opción C: No interactivo**

```bash
openclaw onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verificar configuración

```bash
openclaw chat --model venice/llama-3.3-70b "Hola, ¿estás funcionando?"
```

## Selección de modelo

Después de la configuración, OpenClaw muestra todos los modelos de Venice disponibles. Elige según tus necesidades:

- **Por defecto (nuestra elección)**: `venice/llama-3.3-70b` para rendimiento privado y equilibrado.
- **Mejor calidad general**: `venice/claude-opus-45` para trabajos difíciles (Opus sigue siendo el más potente).
- **Privacidad**: Elige modelos "privados" para inferencia completamente privada.
- **Capacidad**: Elige modelos "anonimizados" para acceder a Claude, GPT, Gemini mediante el proxy de Venice.

Cambia tu modelo por defecto en cualquier momento:

```bash
openclaw models set venice/claude-opus-45
openclaw models set venice/llama-3.3-70b
```

Lista todos los modelos disponibles:

```bash
openclaw models list | grep venice
```

## Configurar mediante `openclaw configure`

1. Ejecuta `openclaw configure`
2. Selecciona **Model/auth**
3. Elige **Venice AI**

## ¿Qué modelo debería usar?

| Caso de uso                  | Modelo recomendado               | Por qué                                       |
| ---------------------------- | -------------------------------- | --------------------------------------------- |
| **Chat general**             | `llama-3.3-70b`                  | Buen rendimiento general, completamente privado |
| **Mejor calidad general**    | `claude-opus-45`                 | Opus sigue siendo el más potente para tareas difíciles |
| **Privacidad + calidad Claude** | `claude-opus-45`              | Mejor razonamiento mediante proxy anonimizado |
| **Codificación**             | `qwen3-coder-480b-a35b-instruct` | Optimizado para código, contexto de 262k     |
| **Tareas de visión**         | `qwen3-vl-235b-a22b`             | Mejor modelo de visión privado                |
| **Sin censura**              | `venice-uncensored`              | Sin restricciones de contenido                |
| **Rápido + económico**       | `qwen3-4b`                       | Ligero, pero capaz                            |
| **Razonamiento complejo**    | `deepseek-v3.2`                  | Razonamiento fuerte, privado                  |

## Modelos disponibles (25 en total)

### Modelos privados (15) — Completamente privados, sin registro

| ID del modelo                    | Nombre                  | Contexto (tokens) | Características         |
| -------------------------------- | ----------------------- | ----------------- | ----------------------- |
| `llama-3.3-70b`                  | Llama 3.3 70B           | 131k              | General                 |
| `llama-3.2-3b`                   | Llama 3.2 3B            | 131k              | Rápido, ligero          |
| `hermes-3-llama-3.1-405b`        | Hermes 3 Llama 3.1 405B | 131k              | Tareas complejas        |
| `qwen3-235b-a22b-thinking-2507`  | Qwen3 235B Thinking     | 131k              | Razonamiento            |
| `qwen3-235b-a22b-instruct-2507`  | Qwen3 235B Instruct     | 131k              | General                 |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B        | 262k              | Código                  |
| `qwen3-next-80b`                 | Qwen3 Next 80B          | 262k              | General                 |
| `qwen3-vl-235b-a22b`             | Qwen3 VL 235B           | 262k              | Visión                  |
| `qwen3-4b`                       | Venice Small (Qwen3 4B) | 32k               | Rápido, razonamiento    |
| `deepseek-v3.2`                  | DeepSeek V3.2           | 163k              | Razonamiento            |
| `venice-uncensored`              | Venice Uncensored       | 32k               | Sin censura             |
| `mistral-31-24b`                 | Venice Medium (Mistral) | 131k              | Visión                  |
| `google-gemma-3-27b-it`          | Gemma 3 27B Instruct    | 202k              | Visión                  |
| `openai-gpt-oss-120b`            | OpenAI GPT OSS 120B     | 131k              | General                 |
| `zai-org-glm-4.7`                | GLM 4.7                 | 202k              | Razonamiento, multilingüe |

### Modelos anonimizados (10) — Mediante proxy de Venice

| ID del modelo            | Original              | Contexto (tokens) | Características       |
| ------------------------ | --------------------- | ----------------- | --------------------- |
| `claude-opus-45`         | Claude Opus 4.5       | 202k              | Razonamiento, visión  |
| `claude-sonnet-45`       | Claude Sonnet 4.5     | 202k              | Razonamiento, visión  |
| `openai-gpt-52`          | GPT-5.2               | 262k              | Razonamiento          |
| `openai-gpt-52-codex`    | GPT-5.2 Codex         | 262k              | Razonamiento, visión  |
| `gemini-3-pro-preview`   | Gemini 3 Pro          | 202k              | Razonamiento, visión  |
| `gemini-3-flash-preview` | Gemini 3 Flash        | 262k              | Razonamiento, visión  |
| `grok-41-fast`           | Grok 4.1 Fast         | 262k              | Razonamiento, visión  |
| `grok-code-fast-1`       | Grok Code Fast 1      | 262k              | Razonamiento, código  |
| `kimi-k2-thinking`       | Kimi K2 Thinking      | 262k              | Razonamiento          |
| `minimax-m21`            | MiniMax M2.1          | 202k              | Razonamiento          |

## Descubrimiento de modelos

OpenClaw descubre automáticamente modelos desde la API de Venice cuando `VENICE_API_KEY` está configurado. Si la API no es accesible, recurre a un catálogo estático.

El endpoint `/models` es público (no requiere autenticación para listar), pero la inferencia requiere una clave de API válida.

## Soporte de streaming y herramientas

| Característica       | Soporte                                                 |
| -------------------- | ------------------------------------------------------- |
| **Streaming**        | ✅ Todos los modelos                                    |
| **Llamada a funciones** | ✅ La mayoría de modelos (verifica `supportsFunctionCalling` en API) |
| **Visión/Imágenes**  | ✅ Modelos marcados con característica "Visión"         |
| **Modo JSON**        | ✅ Soportado mediante `response_format`                 |

## Precios

Venice usa un sistema basado en créditos. Consulta [venice.ai/pricing](https://venice.ai/pricing) para tarifas actuales:

- **Modelos privados**: Generalmente menor costo
- **Modelos anonimizados**: Similar a precios de API directa + pequeña tarifa de Venice

## Comparación: Venice vs API directa

| Aspecto      | Venice (Anonimizado)          | API directa         |
| ------------ | ----------------------------- | ------------------- |
| **Privacidad** | Metadatos eliminados, anonimizado | Tu cuenta vinculada |
| **Latencia** | +10-50ms (proxy)              | Directa             |
| **Características** | Mayoría de características soportadas | Características completas |
| **Facturación** | Créditos de Venice            | Facturación del proveedor |

## Ejemplos de uso

```bash
# Usar modelo privado por defecto
openclaw chat --model venice/llama-3.3-70b

# Usar Claude mediante Venice (anonimizado)
openclaw chat --model venice/claude-opus-45

# Usar modelo sin censura
openclaw chat --model venice/venice-uncensored

# Usar modelo de visión con imagen
openclaw chat --model venice/qwen3-vl-235b-a22b

# Usar modelo de codificación
openclaw chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Solución de problemas

### Clave de API no reconocida

```bash
echo $VENICE_API_KEY
openclaw models list | grep venice
```

Asegúrate de que la clave comience con `vapi_`.

### Modelo no disponible

El catálogo de modelos de Venice se actualiza dinámicamente. Ejecuta `openclaw models list` para ver modelos actualmente disponibles. Algunos modelos pueden estar temporalmente fuera de línea.

### Problemas de conexión

La API de Venice está en `https://api.venice.ai/api/v1`. Asegúrate de que tu red permita conexiones HTTPS.

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
- [Documentación de API](https://docs.venice.ai)
- [Precios](https://venice.ai/pricing)
- [Estado](https://status.venice.ai)
