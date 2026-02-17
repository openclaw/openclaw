---
title: Presencia
description: Cómo OpenClaw muestra estado de presencia en canales de mensajería
---

**Presencia** se refiere a las indicaciones de estado que OpenClaw muestra en canales de mensajería para informar a los usuarios sobre la actividad del agente. Esto incluye indicadores de escritura, estados online/offline y otra información de estado.

## Indicadores de Escritura

Cuando el agente está procesando un mensaje, OpenClaw puede mostrar **indicadores de escritura** en el canal:

- **Slack**: "OpenClaw está escribiendo..."
- **Discord**: Estado de escritura del bot
- **Telegram**: Estado de "escribiendo"
- **WhatsApp**: Indicador de escritura

Los indicadores de escritura ayudan a los usuarios a saber que el agente está trabajando activamente en una respuesta.

### Configuración de Indicadores de Escritura

Habilita o deshabilita indicadores de escritura:

```bash
# Habilitar indicadores de escritura (predeterminado)
openclaw config set agent.showTypingIndicators true

# Deshabilitar indicadores de escritura
openclaw config set agent.showTypingIndicators false
```

Consulta [Typing Indicators](/es-ES/concepts/typing-indicators) para más detalles.

## Estado Online/Offline

OpenClaw puede mostrar estado online/offline en canales:

- **Online**: El gateway está ejecutándose y el agente está activo
- **Offline**: El gateway está detenido o el agente está inactivo
- **Away**: El agente está ocupado o no disponible

### Estado de Slack

En Slack, OpenClaw muestra:

- **Punto verde**: Gateway online
- **Punto gris**: Gateway offline
- **Sin punto**: Bot no conectado

### Estado de Discord

En Discord, OpenClaw muestra:

- **Online** (verde): Gateway ejecutándose
- **Idle** (amarillo): Gateway ejecutándose pero inactivo
- **Offline** (gris): Gateway detenido

### Estado de Telegram

Telegram no muestra estado de bot explícito, pero OpenClaw indica estado a través de:

- **Respuestas rápidas**: Bot online y activo
- **Respuestas retrasadas**: Bot offline o ocupado
- **Indicadores de escritura**: Bot procesando

## Actualizaciones de Estado

OpenClaw actualiza automáticamente estado cuando:

- **Gateway inicia**: Establece estado a online
- **Gateway detiene**: Establece estado a offline
- **Agente está ocupado**: Puede establecer estado a away
- **Agente está inactivo**: Puede establecer estado a idle

### Configuración de Estado Personalizado

Establece un mensaje de estado personalizado:

```bash
# Establecer estado personalizado
openclaw config set agent.statusMessage "Trabajando en actualizaciones"

# Limpiar estado personalizado
openclaw config set agent.statusMessage ""
```

## Presencia de Canal

OpenClaw puede mostrar presencia en canales específicos:

- **Unirse/salir de canales**: El bot une/sale de canales según sea necesario
- **Listar canales**: `openclaw channels list` muestra qué canales está monitoreando el bot
- **Presencia en canal**: Algunos canales muestran "OpenClaw está en este canal"

### Gestión de Presencia en Canal

```bash
# Listar canales donde el bot está presente
openclaw channels list

# Unirse a un canal
openclaw channels join "#general"

# Salir de un canal
openclaw channels leave "#random"
```

## Indicaciones de Actividad

Además de indicadores de escritura, OpenClaw puede mostrar:

- **Reacciones**: Añadir reacciones emoji para confirmar recepción del mensaje
- **Respuestas de confirmación**: "Trabajando en eso..." o "Un momento..."
- **Actualizaciones de progreso**: "Leyendo archivo..." o "Ejecutando pruebas..."

### Configuración de Indicaciones de Actividad

```bash
# Habilitar reacciones de confirmación
openclaw config set agent.confirmWithReaction true

# Habilitar respuestas de progreso
openclaw config set agent.showProgress true
```

## Estado Multi-agente

En configuraciones multi-agente, cada agente puede tener su propia presencia:

- **Estado independiente**: Cada agente muestra su propio estado online/offline
- **Indicadores de escritura independientes**: Cada agente muestra sus propios indicadores de escritura
- **Mensajes de estado independientes**: Cada agente puede tener su propio mensaje de estado

Consulta [Multi-Agent](/es-ES/concepts/multi-agent) para más detalles.

## Presencia y Privacidad

OpenClaw respeta la privacidad cuando muestra presencia:

- **No filtra información**: Los mensajes de estado no revelan información sensible
- **Respeta permisos de canal**: Solo muestra presencia en canales donde el bot tiene acceso
- **Respeta configuración del usuario**: Respeta configuraciones de presencia del usuario cuando es posible

## Mejores Prácticas

### Cuándo Usar Indicadores de Escritura

- **Usa para respuestas largas**: Ayuda a los usuarios saber que el agente está trabajando
- **Deshabilita para operaciones rápidas**: Evita parpadeo para respuestas instantáneas
- **Considera latencia de red**: Los indicadores pueden no aparecer inmediatamente

### Cuándo Usar Mensajes de Estado

- **Usa para mantenimiento**: Informa a los usuarios sobre downtime planificado
- **Usa para contexto**: Explica por qué el agente puede estar lento
- **Mantén breve**: Los mensajes de estado deben ser concisos

### Cuándo Usar Reacciones

- **Usa para confirmación rápida**: Hazle saber al usuario que viste el mensaje
- **Usa para indicadores de progreso**: 👀 para "viendo", ✅ para "hecho"
- **Evita spam**: No reacciones a cada mensaje

## Limitaciones

### Limitaciones de Plataforma

Diferentes plataformas tienen diferentes capacidades de presencia:

- **Slack**: Soporte completo para indicadores de escritura y estado
- **Discord**: Soporte completo para indicadores de escritura y estado
- **Telegram**: Solo indicadores de escritura, sin estado online/offline
- **WhatsApp**: Soporte limitado de presencia
- **SMS**: Sin presencia

### Limitaciones de Rendimiento

Los indicadores de presencia pueden agregar overhead:

- **Llamadas API**: Los indicadores de escritura requieren llamadas API
- **Latencia de red**: Los indicadores pueden retrasarse
- **Límites de tasa**: Demasiados indicadores pueden alcanzar límites de tasa

## Solución de Problemas

### Los indicadores de escritura no aparecen

Si los indicadores de escritura no aparecen:

1. Verifica que `agent.showTypingIndicators` esté habilitado
2. Verifica que el bot tenga permisos para enviar indicadores de escritura
3. Verifica que el canal soporte indicadores de escritura
4. Revisa logs para errores API

### El estado muestra offline cuando el gateway está ejecutándose

Si el estado muestra offline pero el gateway está ejecutándose:

1. Verifica la conexión de red
2. Verifica que el bot esté autenticado
3. Reintenta el gateway
4. Verifica que el canal soporte actualizaciones de estado

### Los indicadores de escritura se atascan

Si los indicadores de escritura se quedan "atascados":

1. Esto es generalmente un problema de plataforma
2. Reiniciar el gateway generalmente los limpia
3. Considera deshabilitar indicadores de escritura si ocurre frecuentemente

## Referencias API

OpenClaw proporciona APIs programáticas para presencia:

```typescript
import { PresenceManager } from 'openclaw'

// Establecer estado
await presence.setStatus('online')

// Mostrar indicador de escritura
await presence.showTyping(channelId)

// Establecer mensaje de estado personalizado
await presence.setStatusMessage('Trabajando en actualizaciones')
```

Consulta la [Referencia API](/es-ES/api/presence) para documentación completa.
