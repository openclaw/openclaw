---
title: Mensajes Grupales de WhatsApp
description: Manejo de mensajes grupales de WhatsApp
icon: whatsapp
---

# Mensajes Grupales de WhatsApp

Esta guía cubre el manejo de mensajes grupales de WhatsApp en OpenClaw, incluyendo características específicas de WhatsApp y mejores prácticas.

## Descripción General

Los chats grupales de WhatsApp permiten conversaciones con múltiples participantes. OpenClaw puede:

- Recibir mensajes de grupos de WhatsApp
- Enviar mensajes a grupos
- Responder a menciones y citas
- Gestionar notificaciones de grupo
- Acceder a metadatos del grupo

## Configuración

### Habilitar Soporte de Grupo

Por defecto, OpenClaw maneja mensajes grupales automáticamente cuando está conectado a WhatsApp. Puedes controlar el comportamiento:

```bash
# Responder solo a menciones en grupos
openclaw config set channels.whatsapp.groupBehavior "mention"

# Responder a todos los mensajes en grupos
openclaw config set channels.whatsapp.groupBehavior "all"

# Ignorar mensajes de grupo completamente
openclaw config set channels.whatsapp.groupBehavior "none"
```

### Lista Blanca de Grupos

Limita qué grupos puede gestionar el bot:

```bash
# Solo responder en grupos específicos
openclaw config set channels.whatsapp.allowedGroups '["grupo1@g.us", "grupo2@g.us"]'
```

## Recibir Mensajes de Grupo

### Formato del Mensaje

Los mensajes grupales incluyen metadatos adicionales:

```typescript
{
  id: "mensaje_id",
  from: "123456789@s.whatsapp.net",
  groupId: "grupo_id@g.us",
  body: "contenido del mensaje",
  timestamp: 1234567890,
  isGroup: true,
  participant: "participante@s.whatsapp.net",
  quoted: null // o mensaje citado
}
```

### Detectar Menciones

Detecta cuándo el bot es mencionado:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup && message.mentions?.includes(agent.phoneNumber)) {
    await message.reply('¿Me mencionaste?');
  }
});
```

## Enviar Mensajes de Grupo

### Mensaje Básico

Envía un mensaje a un grupo:

```bash
openclaw message send --channel whatsapp --recipient "grupo@g.us" "Hola grupo!"
```

En código:

```typescript
await agent.sendMessage({
  to: 'grupo@g.us',
  body: 'Hola grupo!'
});
```

### Mencionar Participantes

Menciona participantes específicos:

```typescript
await agent.sendMessage({
  to: 'grupo@g.us',
  body: '@1234567890 por favor revisa esto',
  mentions: ['1234567890@s.whatsapp.net']
});
```

### Citar Mensajes

Responde a un mensaje específico:

```typescript
await agent.sendMessage({
  to: 'grupo@g.us',
  body: 'Respondiendo a tu mensaje',
  quoted: messageId
});
```

## Información del Grupo

### Obtener Metadatos del Grupo

Recupera información del grupo:

```typescript
const groupInfo = await agent.getGroupMetadata('grupo@g.us');

console.log(groupInfo.subject); // Nombre del grupo
console.log(groupInfo.participants); // Lista de miembros
console.log(groupInfo.admins); // Lista de administradores
console.log(groupInfo.description); // Descripción del grupo
```

### Listar Todos los Grupos

Obtén todos los grupos a los que el bot pertenece:

```bash
openclaw channels status --deep
```

En código:

```typescript
const groups = await agent.getGroups();

for (const group of groups) {
  console.log(`${group.name} (${group.id})`);
}
```

## Mejores Prácticas

### 1. Usa Comportamiento de Solo Mención

Para grupos activos, responde solo cuando seas mencionado:

```bash
openclaw config set channels.whatsapp.groupBehavior "mention"
```

### 2. Implementa Límites de Tasa

Evita que el bot haga spam en el grupo:

```typescript
const rateLimiter = new Map();

agent.on('message', async (message) => {
  if (message.isGroup) {
    const lastReply = rateLimiter.get(message.groupId);
    
    if (lastReply && Date.now() - lastReply < 60000) {
      // Omitir - respondido hace menos de 1 minuto
      return;
    }
    
    // Procesar mensaje...
    rateLimiter.set(message.groupId, Date.now());
  }
});
```

### 3. Maneja Conversaciones Privadas

Redirige consultas sensibles a DMs:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup && isSensitive(message.body)) {
    await message.reply('Por favor envíame un DM para consultas sensibles.');
  }
});
```

## Solución de Problemas

### El Bot No Recibe Mensajes de Grupo

Si el bot no ve mensajes de grupo:

1. Verifica que el bot esté en el grupo:
   ```bash
   openclaw channels status --deep
   ```

2. Comprueba la configuración de comportamiento de grupo:
   ```bash
   openclaw config get channels.whatsapp.groupBehavior
   ```

3. Asegúrate de que los grupos estén en la lista permitida (si está configurada):
   ```bash
   openclaw config get channels.whatsapp.allowedGroups
   ```

### Las Menciones No Funcionan

Si las menciones no funcionan correctamente:

1. Verifica el formato de número de teléfono (debe incluir código de país)
2. Asegúrate de usar el array `mentions` correctamente
3. Prueba con una mención simple primero

### Los Mensajes No se Envían

Si los mensajes al grupo no se envían:

1. Verifica que el bot esté en el grupo
2. Comprueba que el bot no haya sido removido o restringido
3. Asegúrate de que el ID del grupo sea correcto (termina en `@g.us`)
4. Revisa los logs del gateway:
   ```bash
   openclaw gateway logs
   ```

## Ejemplos

### Bot de Grupo Básico

```typescript
import { OpenClawAgent } from 'openclaw';

const agent = new OpenClawAgent({
  name: 'whatsapp-group-bot'
});

agent.on('message', async (message) => {
  if (message.isGroup) {
    // Responde solo a menciones
    if (message.mentions?.includes(agent.phoneNumber)) {
      await message.reply('¿Cómo puedo ayudarte?');
    }
  }
});

await agent.start();
```

### Bot con Información del Grupo

```typescript
agent.on('message', async (message) => {
  if (message.isGroup && message.body === '!info') {
    const groupInfo = await agent.getGroupMetadata(message.groupId);
    
    await message.reply(`
**${groupInfo.subject}**
Miembros: ${groupInfo.participants.length}
Administradores: ${groupInfo.admins.length}
    `);
  }
});
```

## Recursos Adicionales

- [Chats Grupales](/es-ES/channels/groups)
- [Grupos de Difusión de WhatsApp](/es-ES/channels/broadcast-groups)
- [Canal de WhatsApp](/es-ES/channels/whatsapp)

## Soporte

Si encuentras problemas:

1. Revisa esta documentación
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
