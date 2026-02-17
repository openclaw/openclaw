---
title: Modelos
description: Entendiendo modelos de lenguaje y cómo funcionan con OpenClaw
---

Los **modelos** son los modelos de lenguaje grandes (LLMs) que impulsan al agente. OpenClaw soporta múltiples modelos de diferentes proveedores, cada uno con diferentes capacidades, precios y características.

## ¿Qué es un Modelo?

Un modelo de lenguaje es un sistema de IA entrenado en texto para:

- **Entender** lenguaje natural
- **Generar** respuestas de texto
- **Usar herramientas** (llamar funciones)
- **Razonar** sobre problemas complejos

OpenClaw envía mensajes al modelo y el modelo responde con texto o llamadas a herramientas.

## Modelos Soportados

### Modelos Claude (Anthropic)

Los modelos predeterminados para OpenClaw:

- **Claude 3.5 Sonnet** (`claude-3-5-sonnet-20241022`)
  - Mejor calidad general
  - Excelente uso de herramientas
  - Contexto de 200K tokens
  - Recomendado para la mayoría de tareas

- **Claude 3.5 Haiku** (`claude-3-5-haiku-20241022`)
  - Más rápido y económico
  - Buen uso de herramientas
  - Contexto de 200K tokens
  - Bueno para tareas simples

- **Claude 3 Opus** (`claude-3-opus-20240229`)
  - Más alta calidad
  - Mejor razonamiento
  - Contexto de 200K tokens
  - Mejor para tareas complejas

### Modelos GPT (OpenAI)

- **GPT-4o** (`gpt-4o`)
  - Alta calidad
  - Buen uso de herramientas
  - Contexto de 128K tokens
  - Multimodal (texto + imágenes)

- **GPT-4o Mini** (`gpt-4o-mini`)
  - Más rápido y económico
  - Buen uso de herramientas
  - Contexto de 128K tokens
  - Bueno para tareas simples

- **GPT-4 Turbo** (`gpt-4-turbo`)
  - Alta calidad
  - Contexto de 128K tokens
  - Más lento que GPT-4o

### Modelos Gemini (Google)

- **Gemini 2.0 Flash** (`gemini-2.0-flash-exp`)
  - Rápido y gratis (durante preview)
  - Buen uso de herramientas
  - Contexto de 1M tokens
  - Multimodal (texto + imágenes + video + audio)

- **Gemini 1.5 Pro** (`gemini-1.5-pro`)
  - Alta calidad
  - Contexto de 2M tokens
  - Multimodal
  - Mejor para análisis de documentos largos

- **Gemini 1.5 Flash** (`gemini-1.5-flash`)
  - Más rápido y económico
  - Contexto de 1M tokens
  - Multimodal
  - Bueno para tareas simples

### Modelos de Código Abierto (Ollama, Groq)

- **Llama 3.1 405B** (Groq)
  - Alta calidad
  - Contexto de 128K tokens
  - Gratis en Groq
  - Puede ejecutarse localmente con Ollama

- **Llama 3.1 70B** (Groq/Ollama)
  - Buena calidad
  - Más rápido que 405B
  - Puede ejecutarse localmente

- **Mixtral 8x7B** (Groq/Ollama)
  - Buena calidad
  - Rápido
  - Puede ejecutarse localmente

## Configuración de Modelo

Establece qué modelo usar con:

```bash
openclaw config set agent.models '["claude-3-5-sonnet-20241022"]'
```

Para múltiples modelos (failover):

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022"
]'
```

## Capacidades de Modelos

### Límites de Contexto

El **límite de contexto** (también llamado "ventana de contexto") es el número máximo de tokens que un modelo puede procesar en una sola solicitud.

| Modelo            | Límite de Contexto |
| ----------------- | ------------------ |
| Claude 3.5 Sonnet | 200K tokens        |
| Claude 3.5 Haiku  | 200K tokens        |
| GPT-4o            | 128K tokens        |
| Gemini 1.5 Pro    | 2M tokens          |
| Gemini 1.5 Flash  | 1M tokens          |
| Llama 3.1 405B    | 128K tokens        |

OpenClaw compacta automáticamente sesiones largas para ajustarse dentro del límite de contexto del modelo.

### Límites de Salida

El **límite de salida** es el número máximo de tokens que un modelo puede generar en una sola respuesta.

| Modelo            | Límite de Salida |
| ----------------- | ---------------- |
| Claude 3.5 Sonnet | 8K tokens        |
| Claude 3.5 Haiku  | 8K tokens        |
| GPT-4o            | 16K tokens       |
| Gemini 1.5 Pro    | 8K tokens        |
| Gemini 1.5 Flash  | 8K tokens        |
| Llama 3.1 405B    | 4K tokens        |

OpenClaw permite al modelo continuar si una respuesta se trunca.

### Uso de Herramientas

Todos los modelos principales soportan **uso de herramientas** (también llamado "function calling"), pero la calidad varía:

- **Anthropic Claude**: Excelente uso de herramientas, maneja herramientas complejas bien
- **OpenAI GPT**: Buen uso de herramientas, ocasionalmente se pierde parámetros
- **Google Gemini**: Buen uso de herramientas, a veces verbose
- **Llama/Mixtral**: Soporte limitado de herramientas (varía según modelo)

### Capacidades Multimodales

Algunos modelos soportan entradas **multimodales** (no solo texto):

- **GPT-4o**: Texto + imágenes
- **Gemini**: Texto + imágenes + video + audio
- **Llama 3.2**: Texto + imágenes (solo modelos 11B/90B)
- **Claude 3**: Texto + imágenes

OpenClaw soporta enviar imágenes a modelos que lo permiten.

### Velocidad

La velocidad del modelo varía según el tamaño y el proveedor:

- **Más rápido**: Claude 3.5 Haiku, GPT-4o Mini, Gemini Flash, Llama en Groq
- **Medio**: Claude 3.5 Sonnet, GPT-4o, Gemini Pro
- **Más lento**: Claude 3 Opus, GPT-4 Turbo, Llama local

Los modelos más rápidos son buenos para tareas interactivas; los modelos más lentos son mejores para razonamiento profundo.

## Precios del Modelo

Los precios varían ampliamente entre modelos:

### Más Económicos

- **Gemini 2.0 Flash**: Gratis durante preview
- **Claude 3.5 Haiku**: $0.80-4/M tokens
- **GPT-4o Mini**: $0.15-0.60/M tokens
- **Ollama (local)**: Gratis (costos de hardware)

### Rango Medio

- **GPT-4o**: $2.50-10/M tokens
- **Gemini 1.5 Flash**: $0.075-0.30/M tokens
- **Claude 3.5 Sonnet**: $3-15/M tokens
- **Llama (Groq)**: Gratis

### Premium

- **Claude 3 Opus**: $15-75/M tokens
- **GPT-4 Turbo**: $10-30/M tokens
- **Gemini 1.5 Pro**: $1.25-5/M tokens

Consulta [Model Providers](/es-ES/concepts/model-providers) para detalles de precios actualizados.

## Elección de Modelo

### Para Tareas Generales

Usa **Claude 3.5 Sonnet** o **GPT-4o**:

- Mejor equilibrio de calidad/precio
- Excelente uso de herramientas
- Buen contexto (128K-200K)
- Confiable para la mayoría de tareas

### Para Tareas Simples

Usa **Claude 3.5 Haiku** o **GPT-4o Mini**:

- Más rápido y económico
- Suficientemente bueno para tareas simples
- Buen uso de herramientas
- Mejor para sesiones interactivas

### Para Tareas Complejas

Usa **Claude 3 Opus** o **GPT-4 Turbo**:

- Más alta calidad
- Mejor razonamiento
- Vale la pena para problemas difíciles
- Más lento y costoso

### Para Documentos Largos

Usa **Gemini 1.5 Pro**:

- Contexto de 2M tokens
- Puede analizar documentos completos
- Buen resumen
- Precio razonable

### Para Presupuesto Limitado

Usa **Gemini Flash** o **Ollama**:

- Gemini Flash: Gratis/muy económico
- Ollama: Gratis (local)
- Suficientemente bueno para muchas tareas
- Sin límites de tasa (Ollama)

### Para Privacidad

Usa **Ollama**:

- Completamente local
- Sin datos enviados a la nube
- Sin límites de tasa
- Gratis de usar

## Cambio de Modelos

Puedes cambiar de modelo en cualquier momento:

```bash
# Cambiar a un modelo diferente
openclaw config set agent.models '["gpt-4o"]'
```

Las sesiones existentes continuarán usando su modelo original hasta que se reinicien.

Para reiniciar una sesión con un nuevo modelo:

```bash
openclaw session reset
```

## Configuración de Múltiples Modelos

Usa múltiples modelos para failover:

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",
  "gpt-4o",
  "gemini-2.0-flash-exp"
]'
```

OpenClaw intentará los modelos en orden. Si el primer modelo falla, recurrirá al segundo, luego al tercero, etc.

Consulta [Model Failover](/es-ES/concepts/model-failover) para más detalles.

## Uso de Tokens

Los modelos cobran por **tokens**, que son aproximadamente palabras/fragmentos de palabras:

- **~4 caracteres** = 1 token (inglés)
- **~1 palabra** = 1-2 tokens
- **1K tokens** = ~750 palabras

OpenClaw rastrea uso de tokens para todas las solicitudes:

```bash
# Ver estadísticas de uso
openclaw usage

# Ver uso por modelo
openclaw usage --by-model
```

Consulta [Usage Tracking](/es-ES/concepts/usage-tracking) para más detalles.

## Límites de Tasa

Los proveedores imponen **límites de tasa** para prevenir abuso:

| Proveedor | Límites Típicos        |
| --------- | ---------------------- |
| Anthropic | 50 solicitudes/min     |
| OpenAI    | 500 solicitudes/min    |
| Google    | 2-1000 solicitudes/min |
| Ollama    | Sin límites (local)    |
| Groq      | 30 solicitudes/min     |

OpenClaw maneja automáticamente límites de tasa con reintentos exponenciales.

## Mejores Prácticas

### Selección de Modelo

- **Comienza con Claude Sonnet** o GPT-4o para calidad confiable
- **Cambia a Haiku/Mini** si necesitas velocidad o bajo costo
- **Prueba Gemini** para documentos largos o presupuesto limitado
- **Considera Ollama** para privacidad o uso offline

### Optimización de Costos

- **Usa modelos más económicos** para tareas simples
- **Usa modelos premium** solo para trabajo complejo
- **Establece múltiples modelos** para failover a opciones más económicas
- **Monitorea uso** con `openclaw usage`

### Optimización de Rendimiento

- **Usa modelos más rápidos** para sesiones interactivas
- **Usa modelos más lentos** para trabajo batch
- **Compacta sesiones** regularmente para reducir uso de contexto
- **Limita límites de salida** si no necesitas respuestas largas

### Confiabilidad

- **Configura failover** con múltiples modelos
- **Usa diferentes proveedores** para máxima resiliencia
- **Monitorea logs** para problemas de modelos
- **Ten respaldos** para proveedores críticos

Consulta [Model Providers](/es-ES/concepts/model-providers) para más detalles sobre proveedores y configuración.
