---
title: "Envío de Agente"
description: "Envía mensajes a otros agentes en ejecución"
---

## Descripción General

La herramienta `agent-send` permite a los agentes enviar mensajes a otros agentes en ejecución dentro del mismo Gateway. Esto habilita:

- **Coordinación multi-agente**: Los agentes pueden comunicarse entre sí
- **Delegación de tareas**: Envía trabajo a agentes especializados
- **Notificaciones**: Alerta a otros agentes sobre eventos o cambios de estado
- **Colaboración**: Comparte información entre sesiones de agentes

## Uso Básico

```typescript
// Enviar un mensaje a otro agente
await agentSend({
  agentId: "agent-123",
  message: "Por favor procesa este archivo de datos",
  metadata: {
    priority: "high",
    taskType: "data-processing",
  },
});
```

## Parámetros

| Parámetro  | Tipo   | Requerido | Descripción                                    |
| ---------- | ------ | --------- | ---------------------------------------------- |
| `agentId`  | string | Sí        | El ID del agente objetivo                      |
| `message`  | string | Sí        | El contenido del mensaje a enviar              |
| `metadata` | object | No        | Metadatos adicionales para adjuntar al mensaje |

## Casos de Uso Comunes

### Delegación de Tareas

```typescript
// Delegar trabajo de procesamiento de datos a un agente especializado
await agentSend({
  agentId: "data-processor-agent",
  message: "Analiza el dataset adjunto y genera un informe",
  metadata: {
    datasetPath: "/data/sales-q4.csv",
    reportFormat: "pdf",
  },
});
```

### Notificaciones de Estado

```typescript
// Notificar al coordinador sobre la finalización de la tarea
await agentSend({
  agentId: "coordinator-agent",
  message: "Tarea completada exitosamente",
  metadata: {
    taskId: "task-456",
    status: "completed",
    duration: "2m 15s",
  },
});
```
