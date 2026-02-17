---
title: Streaming
description: Cómo OpenClaw usa streaming para respuestas en tiempo real
---

**Streaming** es la capacidad de OpenClaw de mostrar respuestas del agente incrementalmente a medida que se generan, en lugar de esperar a que se complete toda la respuesta. Esto proporciona una mejor experiencia de usuario, especialmente para respuestas largas.

## Cómo Funciona

Con streaming:

1. **OpenClaw envía solicitud** al modelo con `stream: true`
2. **El modelo genera tokens** uno a la vez
3. **Los tokens se envían de vuelta** a medida que se generan
4. **OpenClaw muestra tokens** incrementalmente al usuario
5. **La respuesta se construye** a lo largo del tiempo

Sin streaming:

1. **OpenClaw envía solicitud** al modelo
2. **El modelo genera toda la respuesta** antes de responder
3. **OpenClaw recibe respuesta completa** de una vez
4. **OpenClaw muestra toda la respuesta** al usuario

El streaming proporciona retroalimentación más rápida pero requiere manejar respuestas parciales.

## Configuración de Streaming

Habilita o deshabilita streaming:

```bash
# Habilitar streaming (predeterminado)
openclaw config set agent.streaming true

# Deshabilitar streaming
openclaw config set agent.streaming false
```

## Soporte de Streaming

### Proveedores de Modelos

Todos los proveedores principales soportan streaming:

- **Anthropic**: Excelente soporte de streaming, baja latencia
- **OpenAI**: Buen soporte de streaming, latencia moderada
- **Google**: Buen soporte de streaming, latencia variable
- **Ollama**: Soporte de streaming (velocidad depende del hardware)
- **AWS Bedrock**: Soporte de streaming
- **Azure OpenAI**: Soporte de streaming
- **Groq**: Soporte de streaming, muy rápido

### Canales

Diferentes canales manejan streaming de manera diferente:

- **CLI**: Muestra texto a medida que llega (como typing)
- **Slack**: Actualiza mensaje a medida que se generan nuevos chunks
- **Discord**: Actualiza mensaje en intervalos (límites de tasa)
- **Telegram**: Actualiza mensaje en intervalos
- **WhatsApp**: Sin streaming (solo mensaje completo)
- **SMS**: Sin streaming (solo mensaje completo)

## Streaming de Texto

Para bloques de texto, el streaming es sencillo:

```
Usuario: "Explica cómo funciona el hashing"
Agente: "El hashing es..."  [se muestra inmediatamente]
        "un proceso que..."  [se añade a medida que se genera]
        "convierte datos..." [continúa creciendo]
        ...
```

El texto aparece palabra por palabra (o chunk por chunk) a medida que el modelo lo genera.

## Streaming de Llamadas a Herramientas

Las llamadas a herramientas también se streamean:

```
Usuario: "Lee el archivo config.json"
Agente: [text] "Déjame leer ese archivo"
        [tool_use] {
          "name": "read_file",      [se muestra el nombre de la herramienta]
          "input": {
            "path": "config.json"   [parámetros streameados]
          }
        }
```

OpenClaw espera a que se complete la llamada a herramienta antes de ejecutarla (no puedes ejecutar una herramienta parcial).

## Fragmentación de Respuestas

Al hacer streaming, las respuestas llegan en **chunks** (fragmentos). OpenClaw las maneja:

### Chunks de Texto

```json
{ "type": "content_block_start", "content_block": { "type": "text" } }
{ "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Hola" } }
{ "type": "content_block_delta", "delta": { "type": "text_delta", "text": " mundo" } }
{ "type": "content_block_stop" }
```

OpenClaw concatena el texto de los deltas para construir la respuesta completa.

### Chunks de Uso de Herramientas

```json
{ "type": "content_block_start", "content_block": { "type": "tool_use", "id": "toolu_123", "name": "read_file" } }
{ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "{\"path\":" } }
{ "type": "content_block_delta", "delta": { "type": "input_json_delta", "partial_json": "\"config.json\"}" } }
{ "type": "content_block_stop" }
```

OpenClaw acumula el JSON parcial hasta que el bloque está completo, luego ejecuta la herramienta.

## Actualizaciones de Mensajes

Cuando se hace streaming a canales de mensajería, OpenClaw actualiza el mensaje a medida que llegan nuevos chunks:

- **Primera actualización**: Tan pronto como llega el primer chunk
- **Actualizaciones subsecuentes**: A intervalos regulares (por ejemplo, cada 500ms)
- **Actualización final**: Cuando la respuesta está completa

Esto evita alcanzar límites de tasa mientras proporciona retroalimentación en tiempo real.

### Frecuencia de Actualización

Controla con qué frecuencia se actualizan los mensajes:

```bash
# Actualizar cada 500ms (predeterminado)
openclaw config set agent.streamUpdateInterval 500

# Actualizar con más frecuencia (más responsive, más llamadas API)
openclaw config set agent.streamUpdateInterval 250

# Actualizar con menos frecuencia (menos responsive, menos llamadas API)
openclaw config set agent.streamUpdateInterval 1000
```

## Manejo de Errores de Streaming

Si el streaming falla a medio camino:

- **OpenClaw detecta el error**
- **Guarda la respuesta parcial**
- **Reintenta si es un error transitorio**
- **Muestra mensaje de error si no puede recuperarse**

Los usuarios ven la respuesta parcial más un mensaje de error.

## Buffering de Streaming

Para mejor rendimiento, OpenClaw bufferiza chunks antes de mostrarlos:

- **Buffer pequeño** (predeterminado): Actualizaciones más frecuentes, más llamadas API
- **Buffer grande**: Menos actualizaciones, menos llamadas API, ligeramente más lenta percepción

Ajusta el buffering:

```bash
# Tamaño de buffer en bytes (predeterminado: 1024)
openclaw config set agent.streamBufferSize 2048
```

## Deshabilitar Streaming

Hay razones para deshabilitar streaming:

- **Los límites de tasa del canal son restrictivos** (por ejemplo, Discord)
- **La red es inestable** (el streaming puede interrumpirse)
- **Debugging** (más fácil ver respuestas completas)
- **Simplicidad** (sin actualizaciones parciales)

Para deshabilitar:

```bash
openclaw config set agent.streaming false
```

Con streaming deshabilitado:

- **OpenClaw espera la respuesta completa**
- **Muestra todo de una vez**
- **Sin actualizaciones parciales**
- **Latencia más alta pero más simple**

## Streaming y Límites de Tasa

El streaming puede aumentar el uso de API:

- **Sin streaming**: 1 llamada API por respuesta
- **Con streaming**: 1 llamada inicial + N actualizaciones

Para evitar límites de tasa:

- **Aumenta `streamUpdateInterval`** para menos actualizaciones
- **Usa buffering más grande** para agrupar actualizaciones
- **Deshabilita streaming** en canales con límites de tasa restrictivos

## Streaming Multi-agente

En configuraciones multi-agente, cada agente puede tener su propia configuración de streaming:

```bash
# Habilitar streaming para agente1
openclaw config set agents.agent1.streaming true

# Deshabilitar streaming para agente2
openclaw config set agents.agent2.streaming false
```

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Comportamiento Específico del Canal

### Slack

- Streaming habilitado por defecto
- Actualiza mensaje cada 500ms
- Muestra indicador "editado" cuando se actualiza el mensaje

### Discord

- Streaming habilitado pero con actualizaciones menos frecuentes (1s)
- Los límites de tasa de Discord son más restrictivos
- Considera deshabilitar para bots de alto volumen

### Telegram

- Streaming habilitado con actualizaciones moderadas (750ms)
- Limites de tasa de Telegram son razonables
- Funciona bien para la mayoría de casos de uso

### WhatsApp

- Sin streaming (limitación de plataforma)
- Solo muestra mensaje completo
- No puede actualizar mensajes después de enviar

### CLI

- Streaming habilitado por defecto
- Muestra texto a medida que llega
- Sin límites de tasa
- Mejor experiencia de usuario

## Mejores Prácticas

### Cuándo Usar Streaming

- **Usa streaming** para experiencia interactiva (CLI, Slack)
- **Usa streaming** para respuestas largas (más de unas pocas líneas)
- **Deshabilita streaming** si los límites de tasa son un problema
- **Deshabilita streaming** para mensajes cortos (menos overhead)

### Configuración de Actualización

- **Use intervalos de actualización más cortos** (250-500ms) para mejor respuesta
- **Usa intervalos de actualización más largos** (1000-2000ms) si los límites de tasa son restrictivos
- **Ajusta según el canal** (diferentes canales tienen diferentes límites)

### Buffering

- **Usa buffer pequeño** (1024 bytes) para mejor respuesta
- **Usa buffer grande** (4096+ bytes) para reducir llamadas API
- **Ajusta según la latencia de red** (más latencia = buffer más grande)

## Solución de Problemas

### El streaming se interrumpe

Si el streaming se interrumpe a medio camino:

1. **Verifica la conexión de red**: ¿Es estable?
2. **Verifica los logs**: `openclaw logs --filter streaming`
3. **Verifica límites de tasa**: ¿Alcanzando límites?
4. **Aumenta el timeout**: `agent.requestTimeout`

### Actualizaciones demasiado frecuentes

Si los mensajes se actualizan demasiado frecuentemente:

1. **Aumenta `streamUpdateInterval`**: Menos actualizaciones
2. **Aumenta `streamBufferSize`**: Agrupa más datos
3. **Considera deshabilitar streaming**: Si los límites de tasa son un problema

### El streaming es lento

Si el streaming se siente lento:

1. **Reduce `streamUpdateInterval`**: Actualizaciones más frecuentes
2. **Reduce `streamBufferSize`**: Menos buffering
3. **Verifica latencia de red**: ¿La red es lenta?
4. **Verifica velocidad del modelo**: ¿El modelo es lento?

## Referencias API

OpenClaw proporciona APIs programáticas para streaming:

```typescript
import { Agent } from 'openclaw'

// Enviar mensaje con streaming
const stream = await agent.sendMessage('Hola', { stream: true })

// Manejar chunks del stream
for await (const chunk of stream) {
  if (chunk.type === 'text_delta') {
    process.stdout.write(chunk.text)
  } else if (chunk.type === 'tool_use') {
    console.log(`Calling tool: ${chunk.name}`)
  }
}
```

Consulta la [Referencia API](/es-ES/api/streaming) para documentación completa.
