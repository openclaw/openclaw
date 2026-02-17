---
title: Grupos de Difusión de WhatsApp
description: Usa grupos de difusión de WhatsApp para escenarios multi-agente
icon: bullhorn
---

# Grupos de Difusión de WhatsApp

Los grupos de difusión de WhatsApp proporcionan una forma de enviar mensajes a múltiples destinatarios sin crear un chat grupal tradicional. OpenClaw aprovecha esta función para permitir escenarios multi-agente donde diferentes agentes pueden gestionar conversaciones con los mismos contactos.

## ¿Qué son los Grupos de Difusión?

Los grupos de difusión de WhatsApp te permiten:

- Enviar mensajes a hasta 256 contactos a la vez
- Mantener las respuestas privadas (los destinatarios no ven las respuestas de otros)
- Gestionar una lista de destinatarios sin crear un chat grupal
- Usar un solo mensaje de difusión para llegar a múltiples personas

Cuando usas grupos de difusión con OpenClaw:

- Diferentes agentes pueden gestionar el mismo grupo de difusión
- Cada agente ve los mensajes enviados al grupo de difusión
- Las respuestas van al remitente individual, no al grupo
- Útil para equipos que necesitan coordinar el soporte al cliente

## Configuración de Grupos de Difusión

### Requisitos Previos

Antes de usar grupos de difusión con OpenClaw:

1. Debes tener OpenClaw conectado a WhatsApp
2. Los contactos deben tener tu número en su libreta de direcciones
3. Necesitas crear un grupo de difusión en WhatsApp

### Crear un Grupo de Difusión

Para crear un grupo de difusión en WhatsApp:

<Tabs>
  <Tab title="Móvil (iOS/Android)">
    1. Abre WhatsApp
    2. Toca el icono de **Chat**
    3. Toca **Nueva difusión** (en Android: menú → Nueva difusión)
    4. Selecciona los contactos que quieres añadir (hasta 256)
    5. Toca la marca de verificación o **Crear**
  </Tab>
  
  <Tab title="Escritorio/Web">
    Los grupos de difusión solo pueden ser creados desde dispositivos móviles, pero puedes usarlos en WhatsApp Web/Escritorio una vez creados.
  </Tab>
</Tabs>

### Configurar OpenClaw para Grupos de Difusión

Una vez que tengas un grupo de difusión creado:

1. Obtén el ID del grupo de difusión:
   ```bash
   openclaw channels status --deep
   ```

2. Busca tu grupo de difusión en la salida (aparecerá como un chat)

3. Configura tu agente para usar el grupo de difusión:
   ```bash
   openclaw config set agents.default.channels.whatsapp.broadcastGroupId "ID_DEL_GRUPO"
   ```

## Escenarios Multi-Agente

Los grupos de difusión son especialmente útiles para escenarios multi-agente donde múltiples agentes necesitan interactuar con los mismos contactos.

### Caso de Uso: Equipo de Soporte al Cliente

Imagina un equipo de soporte con tres agentes:

- **Agente Ventas**: Maneja consultas de ventas
- **Agente Soporte**: Maneja tickets de soporte
- **Agente Facturación**: Maneja preguntas de facturación

Configuración:

```bash
# Agente Ventas
openclaw config set agents.sales.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.sales.systemPrompt "Eres un agente de ventas que ayuda con consultas de productos"

# Agente Soporte
openclaw config set agents.support.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.support.systemPrompt "Eres un agente de soporte que ayuda con problemas técnicos"

# Agente Facturación
openclaw config set agents.billing.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.billing.systemPrompt "Eres un agente de facturación que ayuda con preguntas de pago"
```

Con esta configuración:

1. Todos los agentes ven mensajes enviados al grupo de difusión
2. Cada agente puede responder según su especialidad
3. Los clientes reciben respuestas personalizadas de diferentes agentes
4. Las respuestas permanecen privadas entre el cliente y el agente

### Caso de Uso: Coordinación de Equipos

Los grupos de difusión también pueden usarse para coordinación interna del equipo:

```bash
# Agente Coordinador
openclaw config set agents.coordinator.channels.whatsapp.broadcastGroupId "equipo_interno"
openclaw config set agents.coordinator.systemPrompt "Coordinas tareas del equipo y asignaciones"

# Agente Notificaciones
openclaw config set agents.notifications.channels.whatsapp.broadcastGroupId "equipo_interno"
openclaw config set agents.notifications.systemPrompt "Envías recordatorios y actualizaciones al equipo"
```

## Enrutamiento de Mensajes

Cuando usas grupos de difusión con múltiples agentes, puedes controlar cómo se enrutan los mensajes:

### Enrutamiento Basado en Contenido

Usa habilidades o prompts del sistema para enrutar mensajes según el contenido:

```typescript
// En tu código de agente personalizado
if (message.content.includes('venta') || message.content.includes('precio')) {
  routeToAgent('sales');
} else if (message.content.includes('soporte') || message.content.includes('ayuda')) {
  routeToAgent('support');
} else if (message.content.includes('factura') || message.content.includes('pago')) {
  routeToAgent('billing');
}
```

### Enrutamiento Basado en Tiempo

Distribuye mensajes según la hora del día:

```bash
# Agente diurno (9 AM - 5 PM)
openclaw config set agents.day.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.day.schedule.start "09:00"
openclaw config set agents.day.schedule.end "17:00"

# Agente nocturno (5 PM - 9 AM)
openclaw config set agents.night.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.night.schedule.start "17:00"
openclaw config set agents.night.schedule.end "09:00"
```

### Enrutamiento Round-Robin

Distribuye mensajes equitativamente entre agentes:

```bash
# Configura múltiples agentes con el mismo grupo de difusión
openclaw config set agents.agent1.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.agent2.channels.whatsapp.broadcastGroupId "grupo_clientes"
openclaw config set agents.agent3.channels.whatsapp.broadcastGroupId "grupo_clientes"

# Usa lógica round-robin en tu código
```

## Mejores Prácticas

### 1. Gestión Clara de Responsabilidades

Asegúrate de que cada agente tenga responsabilidades claramente definidas:

```bash
openclaw config set agents.agent_name.systemPrompt "Prompt detallado con responsabilidades específicas"
```

### 2. Evitar Respuestas Duplicadas

Implementa lógica para prevenir que múltiples agentes respondan al mismo mensaje:

- Usa un sistema de bloqueo o cola
- Implementa un coordinador para asignar mensajes
- Establece reglas claras sobre qué agente maneja qué tipo de mensaje

### 3. Monitorear la Actividad del Grupo de Difusión

Revisa regularmente la actividad del grupo de difusión:

```bash
openclaw channels status --deep
```

### 4. Mantener Actualizada la Lista de Contactos

Mantén tu grupo de difusión actualizado:

- Remueve contactos inactivos
- Añade nuevos contactos cuando sea necesario
- Verifica que los contactos tengan tu número guardado

### 5. Usa Nombres Descriptivos

Da a tus grupos de difusión nombres significativos para fácil identificación:

- ❌ Mal: "Grupo 1", "Lista 2"
- ✅ Bueno: "Clientes Premium", "Equipo de Soporte", "Alertas de Ventas"

## Limitaciones

Ten en cuenta estas limitaciones al usar grupos de difusión:

### Límites de WhatsApp

- **Máximo 256 contactos** por grupo de difusión
- Los contactos deben tener tu número guardado
- Los mensajes solo se entregan si el contacto te tiene guardado
- Los grupos de difusión no pueden convertirse en grupos regulares

### Consideraciones de OpenClaw

- Los grupos de difusión comparten el mismo límite de tasa que los chats normales
- Todos los agentes ven todos los mensajes al grupo de difusión
- Las respuestas son 1:1, no difundidas al grupo
- El historial de grupo de difusión se comparte entre agentes

## Solución de Problemas

### Los Mensajes No se Entregan

Si los mensajes al grupo de difusión no se entregan:

1. Verifica que los contactos tengan tu número guardado
2. Confirma que el grupo de difusión existe y está activo
3. Revisa el estado de conexión de WhatsApp:
   ```bash
   openclaw channels status
   ```

### Los Agentes No Ven los Mensajes

Si los agentes no reciben mensajes del grupo de difusión:

1. Verifica la configuración del broadcastGroupId:
   ```bash
   openclaw config get agents.agent_name.channels.whatsapp.broadcastGroupId
   ```

2. Asegúrate de que el agente esté ejecutándose:
   ```bash
   openclaw agent status agent_name
   ```

3. Revisa los logs del agente:
   ```bash
   openclaw agent logs agent_name
   ```

### Múltiples Agentes Responden al Mismo Mensaje

Si múltiples agentes están respondiendo al mismo mensaje:

1. Implementa lógica de deduplicación en tu código
2. Usa un agente coordinador para asignar mensajes
3. Configura reglas de enrutamiento más específicas

## Ejemplos Avanzados

### Ejemplo 1: Sistema de Tickets con Grupos de Difusión

```typescript
import { OpenClawAgent } from 'openclaw';

const coordinatorAgent = new OpenClawAgent({
  name: 'coordinator',
  channels: {
    whatsapp: {
      broadcastGroupId: 'customer_support'
    }
  },
  systemPrompt: `Eres un coordinador que:
  1. Recibe nuevos tickets de clientes
  2. Analiza el tipo de solicitud
  3. Asigna al agente apropiado
  4. Rastrea el estado del ticket`
});

coordinatorAgent.on('message', async (message) => {
  // Analiza el mensaje y asigna al agente apropiado
  const ticketType = analyzeMessage(message.content);
  const assignedAgent = assignToAgent(ticketType);
  
  // Crea ticket y notifica al agente asignado
  await createTicket(message, assignedAgent);
  await notifyAgent(assignedAgent, message);
});
```

### Ejemplo 2: Respuestas Automáticas de Grupo de Difusión

```typescript
import { OpenClawAgent } from 'openclaw';

const autoResponderAgent = new OpenClawAgent({
  name: 'autoresponder',
  channels: {
    whatsapp: {
      broadcastGroupId: 'product_updates'
    }
  },
  systemPrompt: 'Respondes automáticamente a preguntas comunes sobre actualizaciones de producto'
});

autoResponderAgent.on('message', async (message) => {
  // Verifica si hay respuesta automática disponible
  const autoResponse = await findAutoResponse(message.content);
  
  if (autoResponse) {
    await message.reply(autoResponse);
  } else {
    // Escala a agente humano
    await notifyHumanAgent(message);
  }
});
```

### Ejemplo 3: Alertas Multi-Canal con Difusión

```typescript
import { OpenClawAgent } from 'openclaw';

const alertAgent = new OpenClawAgent({
  name: 'alerts',
  channels: {
    whatsapp: {
      broadcastGroupId: 'team_alerts'
    }
  },
  systemPrompt: 'Monitoreas sistemas y envías alertas al equipo'
});

// Envía alertas al grupo de difusión
async function sendAlert(alertType: string, message: string) {
  await alertAgent.sendToBroadcastGroup('team_alerts', {
    type: alertType,
    message: message,
    timestamp: new Date().toISOString()
  });
}

// Ejemplo de uso
await sendAlert('critical', 'El servidor está caído - se requiere atención inmediata');
await sendAlert('warning', 'Alto uso de CPU detectado en producción');
await sendAlert('info', 'Despliegue completado exitosamente');
```

## Recursos Adicionales

- [Documentación de Grupos de WhatsApp](/es-ES/channels/groups)
- [Documentación de Canales de WhatsApp](/es-ES/channels/whatsapp)
- [Guía de Configuración Multi-Agente](/es-ES/configuration/multi-agent)
- [Documentación de la API de WhatsApp Business](https://developers.facebook.com/docs/whatsapp)

## Soporte

Si encuentras problemas con grupos de difusión:

1. Revisa esta documentación y las guías de solución de problemas
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
4. Contacta al soporte en [support@openclaw.ai](mailto:support@openclaw.ai)
