---
title: MiniMax
description: Proveedor de Modelos de Lenguaje Grande de MiniMax
icon: maximize
---

# MiniMax

[MiniMax](https://www.minimaxi.com/) proporciona modelos de lenguaje grande y servicios de IA.

## Inicio rápido

1. Obtén tu clave API desde la [plataforma de MiniMax](https://www.minimaxi.com/user-center/basic-information/interface-key)
2. Configura OpenClaw:

```bash
openclaw config set minimax.apiKey=xxx
openclaw config set minimax.groupId=xxx
```

3. Establece MiniMax como tu proveedor predeterminado:

```bash
openclaw config set model.defaultProvider=minimax
openclaw config set model.default=abab6.5-chat
```

## Configuración

| Clave | Descripción | Valor predeterminado |
|-------|-------------|----------------------|
| `minimax.apiKey` | Clave API de MiniMax | - |
| `minimax.groupId` | ID de grupo de MiniMax | - |
| `minimax.baseURL` | URL base de la API | `https://api.minimax.chat/v1` |

## Modelos

MiniMax proporciona varios modelos con diferentes capacidades:

### Modelos de chat

- `abab6.5-chat` - Modelo de chat más reciente con capacidades mejoradas
- `abab6-chat` - Modelo de chat de propósito general
- `abab5.5-chat` - Modelo de chat anterior

### Características del modelo

Todos los modelos de MiniMax soportan:
- Conversaciones de chat
- Respuestas en streaming
- Llamadas a funciones
- Generación de embeddings

## Características avanzadas

### Llamadas a funciones

MiniMax soporta llamadas a funciones para integración con herramientas:

```bash
openclaw message send "¿Cuál es el clima en San Francisco?" \
  --provider minimax \
  --model abab6.5-chat \
  --tools '[{"type":"function","function":{"name":"get_weather","description":"Obtener el clima actual","parameters":{"type":"object","properties":{"location":{"type":"string","description":"Ciudad y estado"}}}}}]'
```

### Embeddings

Genera embeddings de texto con los modelos de MiniMax:

```bash
openclaw message send "texto para incrustar" \
  --provider minimax \
  --model embo-01 \
  --embedding
```

### Parámetros personalizados

MiniMax soporta varios parámetros para controlar la generación:

```bash
openclaw message send "Tu prompt aquí" \
  --provider minimax \
  --model abab6.5-chat \
  --temperature 0.7 \
  --top-p 0.95 \
  --max-tokens 2000
```

## Parámetros del modelo

| Parámetro | Descripción | Rango | Predeterminado |
|-----------|-------------|-------|----------------|
| `temperature` | Controla la aleatoriedad | 0.0 - 1.0 | 0.9 |
| `top_p` | Muestreo nucleus | 0.0 - 1.0 | 0.95 |
| `max_tokens` | Longitud máxima de respuesta | 1 - 8192 | 2048 |
| `presence_penalty` | Penaliza tokens repetidos | -2.0 - 2.0 | 0.0 |
| `frequency_penalty` | Penaliza frecuencia de tokens | -2.0 - 2.0 | 0.0 |

## Solución de problemas

### Error de autenticación

Si ves errores de autenticación, verifica que:
- Tu clave API sea válida
- Tu ID de grupo sea correcto
- Tu cuenta tenga suficiente crédito

### Errores de límite de tasa

MiniMax aplica límites de tasa. Si los alcanzas:
- Espera antes de reintentar
- Considera actualizar tu plan
- Implementa lógica de reintento con backoff exponencial

### Errores del modelo

Si un modelo no está disponible:
- Verifica que el nombre del modelo sea correcto
- Asegúrate de que tu cuenta tenga acceso a ese modelo
- Intenta con un modelo diferente

## Límites

- Tokens máximos por solicitud: 8192
- Límites de tasa: dependen del nivel de la cuenta
- Longitud de contexto: varía según el modelo

## Enlaces

- [Sitio web de MiniMax](https://www.minimaxi.com/)
- [Documentación de la API](https://www.minimaxi.com/document)
- [Centro de usuario](https://www.minimaxi.com/user-center)
- [Página de precios](https://www.minimaxi.com/price)
