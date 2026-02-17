---
title: Mensajes
description: Cómo OpenClaw estructura y gestiona mensajes en sesiones de agentes
---

Los **mensajes** son los bloques de construcción de las conversaciones del agente. Cada sesión contiene una secuencia de mensajes que representan la interacción entre el usuario, el agente y las herramientas.

## Estructura de Mensajes

OpenClaw utiliza el formato de mensaje estándar de Anthropic API:

```typescript
interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; tool_use_id: string; content: string };
```

## Roles de Mensajes

### Mensajes del Usuario

Los mensajes con `role: 'user'` representan entrada del usuario. Pueden contener:

- **Bloques de texto** con la pregunta o solicitud del usuario
- **Bloques de resultados de herramientas** con salidas de ejecuciones de herramientas previas

Ejemplo:

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "¿Cuál es el clima?" },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_123",
      "content": "{\"temp\": 72, \"condition\": \"sunny\"}"
    }
  ]
}
```

### Mensajes del Asistente

Los mensajes con `role: 'assistant'` representan respuestas del agente. Pueden contener:

- **Bloques de texto** con la respuesta del agente
- **Bloques de uso de herramientas** con llamadas a herramientas que el agente quiere ejecutar

Ejemplo:

```json
{
  "role": "assistant",
  "content": [
    { "type": "text", "text": "Déjame verificar el clima para ti." },
    {
      "type": "tool_use",
      "id": "toolu_123",
      "name": "get_weather",
      "input": { "location": "San Francisco" }
    }
  ]
}
```

## Flujo de Mensajes

Una conversación típica sigue este flujo:

1. **Usuario envía un mensaje** → OpenClaw crea un mensaje de usuario
2. **Agente responde** → OpenClaw añade un mensaje de asistente
3. **Agente llama a herramientas** → OpenClaw ejecuta herramientas y añade resultados
4. **Agente proporciona respuesta final** → OpenClaw añade mensaje de asistente final

Ejemplo de secuencia:

```
User: "¿Cuál es el clima en SF?"
Assistant: [text] "Déjame verificar" + [tool_use] get_weather(location="SF")
User: [tool_result] {"temp": 72, "condition": "sunny"}
Assistant: [text] "El clima en SF es soleado y 72°F"
```

## Bloques de Contenido

### Bloques de Texto

Los bloques de texto contienen texto en lenguaje natural:

```typescript
{
  type: 'text',
  text: 'Este es un mensaje de texto'
}
```

### Bloques de Uso de Herramientas

Los bloques de uso de herramientas representan solicitudes de llamadas a herramientas del agente:

```typescript
{
  type: 'tool_use',
  id: 'toolu_123',           // ID único generado por el modelo
  name: 'read_file',         // Nombre de la herramienta a llamar
  input: {                   // Parámetros para la herramienta
    path: '/path/to/file'
  }
}
```

### Bloques de Resultados de Herramientas

Los bloques de resultados de herramientas contienen salidas de ejecuciones de herramientas:

```typescript
{
  type: 'tool_result',
  tool_use_id: 'toolu_123',  // Coincide con el ID del bloque tool_use
  content: 'contenido del archivo...'  // Salida de la herramienta (string o JSON)
}
```

## Historial de Mensajes

OpenClaw mantiene todo el historial de mensajes en memoria durante la sesión. El historial se almacena en:

```
~/.openclaw/sessions/<agent-id>/<session-id>.jsonl
```

Cada línea en el archivo es un evento JSON que contiene:

- **Mensajes** enviados al/desde el modelo
- **Ejecuciones de herramientas** con entradas y salidas
- **Metadatos** como marcas de tiempo y uso de tokens

## Compactación de Mensajes

Cuando una sesión se vuelve larga, OpenClaw compacta automáticamente el historial de mensajes para ajustarse dentro del límite de contexto del modelo. Esto implica:

- **Eliminar** resultados de herramientas antiguas
- **Preservar** mensajes importantes del usuario y del asistente
- **Mantener** mensajes recientes intactos

Consulta [Compaction](/es-ES/concepts/compaction) para más detalles.

## System Prompt

Además de los mensajes del usuario y del asistente, cada solicitud incluye un **system prompt** que proporciona al agente:

- Instrucciones generales
- Información del entorno
- Instrucciones personalizadas desde `AGENTS.md`
- Definiciones de herramientas

El system prompt no se almacena en el historial de mensajes pero se incluye en cada solicitud al modelo.

Consulta [System Prompt](/es-ES/concepts/system-prompt) para más detalles.

## Formato de Mensajes

### Display de Mensajes

Al mostrar mensajes al usuario, OpenClaw:

- **Renderiza** texto Markdown en los bloques de texto
- **Muestra** llamadas a herramientas como notificaciones de progreso
- **Formatea** resultados de herramientas para legibilidad
- **Agrupa** múltiples bloques de contenido en un solo mensaje

### Serialización de Mensajes

Al guardar mensajes en disco, OpenClaw:

- **Serializa** cada mensaje como una línea JSON
- **Incluye** metadatos como marcas de tiempo y uso de tokens
- **Preserva** toda la información de bloques de contenido
- **Comprime** archivos de sesión antiguos para ahorrar espacio

## API de Mensajes

Puedes enviar mensajes programáticamente usando la CLI:

```bash
# Enviar mensaje a una sesión
openclaw message send "Hola, agente"

# Enviar a una sesión específica
openclaw message send "Hola" --session abc123

# Enviar a un agente específico
openclaw message send "Hola" --agent my-agent

# Enviar con contexto
openclaw message send "Revisa este archivo" --context src/app.ts
```

Consulta la [Referencia CLI](/es-ES/cli/message) para más opciones.

## Límites de Mensajes

### Límites de Contexto

Cada modelo tiene un límite máximo de contexto que restringe cuántos mensajes pueden ajustarse en una solicitud. OpenClaw maneja esto automáticamente a través de la compactación.

### Límites de Salida

Los modelos también tienen límites de salida máximos que restringen cuánto puede generar el agente en una sola respuesta. Si una respuesta se trunca, OpenClaw permite al modelo continuar en una solicitud de seguimiento.

## Mensajes en Multi-agente

En configuraciones multi-agente, cada agente mantiene su propio historial de mensajes independiente. Los agentes pueden comunicarse entre sí a través de:

- **Paso de mensajes explícito** donde un agente envía mensajes al canal de otro
- **Estado compartido** donde los agentes leen/escriben archivos comunes
- **Coordinación de herramientas** donde las herramientas actúan como puntos de sincronización

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.
