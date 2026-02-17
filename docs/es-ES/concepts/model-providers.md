---
title: Model Providers
description: Proveedores de modelos soportados y cómo configurarlos
---

OpenClaw soporta múltiples **proveedores de modelos** para ejecutar el agente. Cada proveedor ofrece diferentes modelos con diferentes capacidades, precios y características.

## Proveedores Soportados

### Anthropic

El proveedor predeterminado para OpenClaw. Ofrece los modelos Claude:

- `claude-3-5-sonnet-20241022` (recomendado)
- `claude-3-5-haiku-20241022`
- `claude-3-opus-20240229`
- `claude-3-sonnet-20240229`
- `claude-3-haiku-20240307`

**Configuración:**

```bash
openclaw config set provider anthropic
openclaw config set anthropic.apiKey "sk-ant-..."
```

**Características:**

- Ventanas de contexto grandes (200K tokens)
- Excelente uso de herramientas
- Límites de tasa altos
- Bajo tiempo de espera

### OpenAI

Proveedor popular con modelos GPT:

- `gpt-4o` (recomendado)
- `gpt-4o-mini`
- `gpt-4-turbo`
- `gpt-4`
- `gpt-3.5-turbo`

**Configuración:**

```bash
openclaw config set provider openai
openclaw config set openai.apiKey "sk-..."
```

**Características:**

- Ampliamente disponible
- Buena calidad
- Soporte de herramientas
- Precio razonable

### Google

Proveedor de Google AI con modelos Gemini:

- `gemini-2.0-flash-exp` (recomendado)
- `gemini-1.5-pro`
- `gemini-1.5-flash`

**Configuración:**

```bash
openclaw config set provider google
openclaw config set google.apiKey "..."
```

**Características:**

- Contexto muy grande (2M tokens en Pro)
- Multimodal (imágenes, video, audio)
- Grounding web
- Precio competitivo

### AWS Bedrock

AWS managed service con múltiples modelos:

- Modelos Claude (via Bedrock)
- Modelos Llama
- Modelos Mistral
- Modelos Titan

**Configuración:**

```bash
openclaw config set provider bedrock
openclaw config set bedrock.region "us-east-1"
# Las credenciales AWS usan el perfil predeterminado o variables de entorno
```

**Características:**

- Integración AWS
- Opciones de modelos privados
- Controles de conformidad
- Facturación AWS

### Azure OpenAI

Servicio Azure managed OpenAI:

- Todos los modelos OpenAI
- Despliegues personalizados
- Controles de conformidad

**Configuración:**

```bash
openclaw config set provider azure
openclaw config set azure.apiKey "..."
openclaw config set azure.endpoint "https://your-resource.openai.azure.com"
openclaw config set azure.deployment "your-deployment-name"
```

**Características:**

- Integración empresarial
- Compliance enterprise
- Residencia de datos
- Facturación Azure

### Vertex AI

Google Cloud managed AI platform:

- Modelos Gemini
- Modelos Claude (via Model Garden)
- Modelos personalizados

**Configuración:**

```bash
openclaw config set provider vertex
openclaw config set vertex.projectId "your-project"
openclaw config set vertex.location "us-central1"
# Las credenciales GCP usan credenciales predeterminadas de aplicación
```

**Características:**

- Integración GCP
- Opciones de modelos privados
- Conformidad enterprise
- Facturación GCP

### Ollama

Modelos locales ejecutándose en tu máquina:

- Llama 3
- Mistral
- Mixtral
- CodeLlama
- Y más

**Configuración:**

```bash
openclaw config set provider ollama
openclaw config set ollama.baseUrl "http://localhost:11434"
```

**Características:**

- Gratis de usar
- Privacidad completa
- Ejecución offline
- Sin límites de tasa

### Groq

Inferencia rápida de modelos de código abierto:

- `llama-3.1-405b-reasoning`
- `llama-3.1-70b-versatile`
- `llama-3.1-8b-instant`
- `mixtral-8x7b-32768`

**Configuración:**

```bash
openclaw config set provider groq
openclaw config set groq.apiKey "gsk_..."
```

**Características:**

- Inferencia extremadamente rápida
- Modelos de código abierto
- Precio competitivo
- Límites de tasa generosos

## Selección de Modelo

Especifica qué modelo usar con:

```bash
openclaw config set agent.models '["claude-3-5-sonnet-20241022"]'
```

Para múltiples modelos (failover):

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",
  "openai/gpt-4o",
  "google/gemini-2.0-flash-exp"
]'
```

El prefijo del proveedor (`openai/`, `google/`, etc.) es opcional para el proveedor predeterminado.

## Autenticación

### Claves API

La mayoría de los proveedores usan autenticación de clave API:

```bash
# Establecer clave API directamente
openclaw config set anthropic.apiKey "sk-ant-..."

# O usar variable de entorno
export ANTHROPIC_API_KEY="sk-ant-..."
```

### Credenciales de Cloud

Proveedores de cloud (AWS, GCP, Azure) usan credenciales nativas:

```bash
# AWS: usa perfil predeterminado o variables de entorno
export AWS_PROFILE="my-profile"
export AWS_ACCESS_KEY_ID="..."
export AWS_SECRET_ACCESS_KEY="..."

# GCP: usa credenciales predeterminadas de aplicación
gcloud auth application-default login

# Azure: usa variables de entorno de Azure
export AZURE_CLIENT_ID="..."
export AZURE_TENANT_ID="..."
export AZURE_CLIENT_SECRET="..."
```

### Modelos Locales

Ollama no requiere autenticación—solo ejecuta el servidor Ollama localmente:

```bash
ollama serve
```

## Capacidades de Proveedores

### Límites de Contexto

Diferentes modelos tienen diferentes límites de contexto:

| Modelo            | Contexto |
| ----------------- | -------- |
| Claude 3.5 Sonnet | 200K     |
| GPT-4o            | 128K     |
| Gemini 1.5 Pro    | 2M       |
| Llama 3.1 405B    | 128K     |

OpenClaw maneja automáticamente compactación de contexto para todos los modelos.

### Soporte de Herramientas

Todos los proveedores principales soportan llamadas a herramientas (function calling), pero la implementación varía:

- **Anthropic**: Excelente soporte de herramientas, maneja herramientas complejas bien
- **OpenAI**: Buen soporte de herramientas, ocasionalmente se pierde parámetros
- **Google**: Buen soporte de herramientas, a veces verbose
- **Ollama**: Soporte limitado de herramientas (varía según modelo)

### Capacidades Multimodales

Algunos modelos soportan entradas multimodales:

- **Claude 3**: Imágenes
- **GPT-4o**: Imágenes, audio (próximamente)
- **Gemini**: Imágenes, video, audio
- **Llama 3.2**: Imágenes (solo 11B/90B)

OpenClaw soporta enviar imágenes a modelos que lo permiten.

### Streaming

Todos los proveedores soportan streaming, pero el comportamiento varía:

- **Anthropic**: Streaming confiable, baja latencia
- **OpenAI**: Streaming confiable, latencia moderada
- **Google**: Streaming confiable, latencia variable
- **Ollama**: Streaming confiable, velocidad depende del hardware

Consulta [Streaming](/es-ES/concepts/streaming) para más detalles.

## Límites de Tasa

Cada proveedor tiene diferentes límites de tasa:

### Anthropic

- **Claude 3.5 Sonnet**: 50 solicitudes/min (nivel 1)
- **Claude 3.5 Haiku**: 50 solicitudes/min (nivel 1)
- Los niveles superiores tienen límites más altos

### OpenAI

- **GPT-4o**: 500 solicitudes/min (nivel 1)
- **GPT-4**: 500 solicitudes/min (nivel 1)
- Los niveles superiores tienen límites más altos

### Google

- **Gemini 1.5 Pro**: 2 solicitudes/min (gratis), 1000 solicitudes/min (pagado)
- **Gemini 1.5 Flash**: 15 solicitudes/min (gratis), 2000 solicitudes/min (pagado)

### Ollama

- Sin límites de tasa (local)

OpenClaw maneja automáticamente límites de tasa con reintentos exponenciales.

## Precios

### Anthropic

| Modelo            | Entrada        | Salida       |
| ----------------- | -------------- | ------------ |
| Claude 3.5 Sonnet | $3/M tokens    | $15/M tokens |
| Claude 3.5 Haiku  | $0.80/M tokens | $4/M tokens  |
| Claude 3 Opus     | $15/M tokens   | $75/M tokens |

### OpenAI

| Modelo      | Entrada        | Salida         |
| ----------- | -------------- | -------------- |
| GPT-4o      | $2.50/M tokens | $10/M tokens   |
| GPT-4o mini | $0.15/M tokens | $0.60/M tokens |
| GPT-4 Turbo | $10/M tokens   | $30/M tokens   |

### Google

| Modelo           | Entrada                        | Salida         |
| ---------------- | ------------------------------ | -------------- |
| Gemini 1.5 Pro   | $1.25/M tokens                 | $5/M tokens    |
| Gemini 1.5 Flash | $0.075/M tokens                | $0.30/M tokens |
| Gemini 2.0 Flash | $0.00 (gratis durante preview) | $0.00          |

### Ollama

- Gratis (costos de hardware local)

Los precios están sujetos a cambios. Consulta la documentación del proveedor para precios actuales.

## Rastreo de Uso

OpenClaw rastrea uso de tokens para todos los proveedores:

```bash
# Ver estadísticas de uso
openclaw usage

# Ver uso por modelo
openclaw usage --by-model

# Ver uso por fecha
openclaw usage --since 2024-01-01
```

Consulta [Usage Tracking](/es-ES/concepts/usage-tracking) para más detalles.

## Cambio de Proveedores

Para cambiar de proveedor:

1. **Configura las credenciales del nuevo proveedor**
2. **Establece el proveedor predeterminado**
3. **Actualiza la lista de modelos**

Ejemplo de cambio de Anthropic a OpenAI:

```bash
openclaw config set openai.apiKey "sk-..."
openclaw config set provider openai
openclaw config set agent.models '["gpt-4o"]'
```

Las sesiones existentes continuarán usando su proveedor original hasta que se reinicien.

## Mejores Prácticas

### Elección de Proveedor

- **Usa Anthropic** para la mejor calidad y uso de herramientas
- **Usa OpenAI** para amplia disponibilidad y ecosistema
- **Usa Google** para contexto muy grande o necesidades multimodales
- **Usa Ollama** para privacidad o uso offline
- **Usa proveedores de cloud** para integración empresarial

### Múltiples Proveedores

Configura múltiples proveedores para failover:

```bash
openclaw config set agent.models '[
  "claude-3-5-sonnet-20241022",
  "openai/gpt-4o",
  "google/gemini-2.0-flash-exp"
]'
```

Esto asegura que el agente pueda continuar trabajando incluso si un proveedor está caído.

Consulta [Model Failover](/es-ES/concepts/model-failover) para más detalles.

### Optimización de Costos

- **Usa Haiku/Mini** para tareas simples
- **Usa Sonnet/GPT-4o** para tareas complejas
- **Usa Gemini Flash** para presupuesto limitado
- **Usa Ollama** cuando el costo sea una preocupación

### Consideraciones de Privacidad

- **Usa Ollama** para máxima privacidad (completamente local)
- **Usa proveedores de cloud** con controles conformidad (Bedrock, Azure, Vertex)
- **Revisa términos del proveedor** para políticas de retención de datos
