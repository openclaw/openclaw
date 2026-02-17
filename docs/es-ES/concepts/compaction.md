---
title: "Compactación"
description: "Cómo OpenClaw gestiona sesiones largas a través de la compactación"
---

# Compactación

La **compactación** es el proceso de resumir y reducir sesiones largas de agentes para mantenerlas manejables, rápidas y rentables. Cuando una sesión crece más allá de un cierto umbral, OpenClaw automáticamente compacta mensajes antiguos en resúmenes concisos mientras preserva el contexto importante.

## ¿Por qué es necesaria la compactación?

A medida que los agentes tienen conversaciones más largas:

1. **Ventanas de contexto**: Los modelos tienen límites de contexto (por ejemplo, 8k, 32k, 128k tokens)
2. **Costo**: Más tokens = mayores costos de API
3. **Rendimiento**: Las sesiones grandes son más lentas de procesar
4. **Enfoque**: Los mensajes antiguos pueden distraer de la tarea actual

La compactación resuelve estos problemas resumiendo selectivamente partes de la sesión mientras mantiene la información crítica.

## Cómo funciona

### 1. Detección de umbral

OpenClaw monitorea el tamaño de la sesión. Cuando se alcanza un umbral:

```typescript
const threshold = config.session.compactionThreshold // Por defecto: 32000 tokens
if (session.totalTokens > threshold) {
  await compact(session)
}
```

### 2. Selección de segmentos

El sistema identifica qué mensajes compactar:

- **Mantener**: Prompt del sistema, mensajes recientes
- **Compactar**: Mensajes más antiguos en el medio
- **Preservar**: Contexto crítico, definiciones de herramientas

### 3. Resumen

Los mensajes seleccionados se resumen usando el modelo del agente:

```
Original (500 tokens):
Usuario: ¿Puedes ayudarme a construir una API REST en Python?
Agente: ¡Claro! Construyamos una API REST usando FastAPI...
[conversación larga sobre configuración, endpoints, etc.]

Compactado (50 tokens):
Resumen: El usuario solicitó ayuda para construir una API REST de Python.
Discutimos la configuración de FastAPI, creando endpoints CRUD y middleware.
```

### 4. Reemplazo

Los mensajes originales se reemplazan con el resumen compactado:

```
Before compaction:
[system] | [msg1] | [msg2] | ... | [msg50] | [msg51] | [msg52]
                    ^^^^^^^^^^^^^^^^^^^^^^
                    50 mensajes antiguos

After compaction:
[system] | [summary] | [msg51] | [msg52]
           ^^^^^^^^^^
           Resumen compactado
```

## Configuración

### Configurar umbral de compactación

```bash
# Compactar cuando la sesión exceda 20k tokens
openclaw config set session.compactionThreshold 20000
```

### Configurar tamaño objetivo

```bash
# Apuntar a 10k tokens después de la compactación
openclaw config set session.compactionTarget 10000
```

### Deshabilitar compactación automática

```bash
openclaw config set session.autoCompact false
```

### Compactación manual

Compacta una sesión manualmente:

```bash
openclaw session compact <session-id>
```

## Estrategias de compactación

OpenClaw admite múltiples estrategias de compactación:

### 1. Resumen (predeterminado)

Resume mensajes antiguos en texto conciso:

```bash
openclaw config set session.compactionStrategy summary
```

**Ventajas**:
- Preserva la esencia de las conversaciones
- Bueno para contexto a largo plazo
- Flexible y adaptable

**Desventajas**:
- Puede perder detalles específicos
- Requiere una llamada de modelo adicional

### 2. Truncamiento

Simplemente elimina mensajes antiguos:

```bash
openclaw config set session.compactionStrategy truncate
```

**Ventajas**:
- Rápido y simple
- Sin costo adicional

**Desventajas**:
- Pérdida completa de contexto antiguo
- Puede confundir al agente

### 3. Priorización

Mantiene los mensajes más importantes, descarta otros:

```bash
openclaw config set session.compactionStrategy prioritize
```

**Ventajas**:
- Preserva mensajes críticos
- Balance entre resumen y truncamiento

**Desventajas**:
- Requiere lógica para determinar importancia
- Puede aún perder contexto útil

## Preservación de contexto

Ciertos elementos **nunca** se compactan:

- **Prompt del sistema**: Siempre se mantiene intacto
- **Mensajes recientes**: Los últimos N mensajes se preservan
- **Mensajes fijados**: Los mensajes marcados como importantes
- **Definiciones de herramientas**: Las definiciones de herramientas permanecen disponibles

### Fijar mensajes

Evita que mensajes específicos sean compactados:

```bash
openclaw session pin <session-id> <message-id>
```

O programáticamente:

```typescript
await session.pinMessage(messageId)
```

## Monitoreo de compactación

### Ver historial de compactación

```bash
openclaw session show <session-id> --compactions
```

Salida:
```
Compaction History:
- 2024-02-15 10:30: Compacted 50 messages → 1 summary (45,000 → 12,000 tokens)
- 2024-02-16 14:20: Compacted 40 messages → 1 summary (38,000 → 11,500 tokens)
```

### Estadísticas de compactación

```bash
openclaw usage --compactions
```

## Mejores prácticas

### 1. Ajusta umbrales según el modelo

Diferentes modelos tienen diferentes ventanas de contexto:

```bash
# Para GPT-4 Turbo (128k)
openclaw config set session.compactionThreshold 100000

# Para Claude 3 Opus (200k)
openclaw config set session.compactionThreshold 150000
```

### 2. Usa fijado para contexto crítico

Fija información importante que el agente necesita recordar:

```bash
openclaw session pin <session-id> <message-id>
```

### 3. Compacta proactivamente

Para sesiones largas, compacta antes de alcanzar el umbral:

```bash
openclaw session compact <session-id> --force
```

### 4. Revisa los resúmenes

Después de la compactación, revisa el resumen para asegurar que se preservó el contexto clave:

```bash
openclaw session show <session-id> --messages
```

### 5. Considera iniciar nuevas sesiones

Para tareas completamente nuevas, inicia una nueva sesión en lugar de depender de sesiones compactadas largas:

```bash
openclaw chat --new
```

## Ver también

- [Sesiones](/es-ES/concepts/sessions) - Descripción general de las sesiones de agentes
- [Memoria](/es-ES/concepts/memory) - Cómo los agentes recuerdan contexto
- [Poda de sesiones](/es-ES/concepts/session-pruning) - Limpiando sesiones antiguas
