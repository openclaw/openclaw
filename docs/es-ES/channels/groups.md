---
title: Chats Grupales
description: Cómo funcionan los chats grupales en OpenClaw
icon: users
---

# Chats Grupales

OpenClaw soporta chats grupales en todos los canales que los permiten, incluyendo WhatsApp, Telegram, Discord, Slack, Signal, Matrix y más. Los chats grupales te permiten tener conversaciones con múltiples participantes, donde el agente puede interactuar con todos los miembros.

## Descripción General

Los chats grupales funcionan de manera diferente a los mensajes directos (DMs). En un chat grupal:

- Múltiples participantes pueden ver y enviar mensajes
- El agente puede mencionar a participantes específicos
- Los mensajes del agente son visibles para todos en el grupo
- Puedes controlar cuándo el agente responde (por ejemplo, solo cuando es mencionado)
- Los agentes pueden rastrear el contexto de conversación con múltiples personas

## Comportamiento del Grupo

### Respuesta Automática vs. Respuesta por Mención

Por defecto, los agentes pueden responder de dos maneras en grupos:

<CardGroup cols={2}>
  <Card title="Respuesta Automática" icon="bolt">
    El agente responde a cada mensaje en el grupo, similar a como respondería en un DM.
  </Card>
  <Card title="Respuesta por Mención" icon="at">
    El agente solo responde cuando es mencionado específicamente (por ejemplo, `@bot` o `/comando`).
  </Card>
</CardGroup>

Configura el comportamiento de respuesta:

```bash
# Responder solo cuando sea mencionado (recomendado)
openclaw config set channels.groupBehavior "mention"

# Responder a todos los mensajes
openclaw config set channels.groupBehavior "all"

# Nunca responder en grupos
openclaw config set channels.groupBehavior "none"
```

### Comportamiento Específico del Canal

Diferentes canales pueden tener comportamientos de grupo diferentes:

```bash
# WhatsApp: solo responder a menciones
openclaw config set channels.whatsapp.groupBehavior "mention"

# Telegram: responder a todos los mensajes
openclaw config set channels.telegram.groupBehavior "all"

# Discord: responder a menciones y comandos
openclaw config set channels.discord.groupBehavior "mention"
```

## Unirse a Grupos

### WhatsApp

En WhatsApp, puedes unirte a grupos de dos maneras:

1. **Ser añadido por un participante existente**
   ```bash
   # No se requiere configuración - solo haz que alguien te añada al grupo
   ```

2. **Escanear un código QR de invitación**
   ```bash
   # Usa la función de enlace de invitación de WhatsApp
   ```

Una vez en el grupo:

```bash
# Ver todos los grupos activos
openclaw channels status --deep

# Ver miembros de un grupo específico
openclaw group info <group_id>
```

### Telegram

Para grupos de Telegram:

1. **Ser añadido al grupo**
   ```bash
   # Haz que un administrador te añada al grupo
   ```

2. **Unirse vía enlace de invitación**
   ```bash
   # Haz clic en un enlace t.me/joinchat/...
   ```

3. **Hacer el bot administrador** (recomendado)
   ```bash
   # Esto permite funciones completas como borrar mensajes, patear usuarios, etc.
   ```

### Discord

Para servidores de Discord:

1. **Invitar el bot al servidor**
   ```bash
   openclaw channel discord invite
   ```
   
   Esto generará un enlace de invitación OAuth2.

2. **Seleccionar canales**
   
   Por defecto, el bot puede ver todos los canales. Restringe el acceso mediante permisos de Discord:
   
   - Ve a Configuración del Servidor → Roles
   - Edita el rol del bot
   - Deshabilita "Ver Canales" para canales específicos

### Slack

Para espacios de trabajo de Slack:

1. **Instalar la aplicación**
   ```bash
   openclaw channel slack install
   ```

2. **Invitar el bot a canales**
   ```bash
   # En Slack: /invite @openclaw
   ```

### Signal

Para grupos de Signal:

```bash
# El bot debe ser añadido por un administrador del grupo existente
# Signal no soporta enlaces de invitación para bots
```

### Matrix

Para salas de Matrix:

```bash
# Invitar el bot a la sala
# En Matrix: /invite @bot:matrix.org

# O habilitar auto-unión
openclaw config set channels.matrix.autoAcceptInvites true
```

## Comandos en Grupo

### Sintaxis de Comandos

Los agentes pueden responder a comandos en grupos:

```bash
# Establecer un prefijo de comando
openclaw config set agents.default.commandPrefix "!"

# Ahora los usuarios pueden usar:
# !help
# !status
# !ask <pregunta>
```

### Comandos Incorporados

OpenClaw proporciona comandos incorporados de grupo:

- `!help` - Listar comandos disponibles
- `!status` - Mostrar estado del agente
- `!version` - Mostrar versión de OpenClaw
- `!ping` - Verificar si el bot responde

### Comandos Personalizados

Define comandos personalizados para tu agente:

```typescript
import { OpenClawAgent } from 'openclaw';

const agent = new OpenClawAgent({
  name: 'mybot',
  commandPrefix: '!'
});

agent.command('hello', async (ctx) => {
  await ctx.reply('¡Hola! ¿Cómo puedo ayudarte?');
});

agent.command('echo', async (ctx, args) => {
  await ctx.reply(args.join(' '));
});
```

Ahora los usuarios pueden usar:

```
!hello
!echo Este es un mensaje de eco
```

## Gestión de Contexto

### Contexto de Conversación

En grupos, los agentes rastrean el contexto de conversación por:

- **Por mensaje**: Cada mensaje se trata independientemente
- **Por hilo**: Los mensajes en un hilo se agrupan juntos (si el canal lo soporta)
- **Por participante**: Conversaciones separadas con cada participante
- **Por grupo**: Una conversación compartida para todo el grupo

Configura la estrategia de contexto:

```bash
# Rastrear contexto por participante
openclaw config set agents.default.contextStrategy "per-user"

# Rastrear contexto por hilo (si está disponible)
openclaw config set agents.default.contextStrategy "per-thread"

# Contexto compartido del grupo
openclaw config set agents.default.contextStrategy "per-group"
```

### Límites del Historial

Controla cuánto historial conserva el agente:

```bash
# Máximo de mensajes a recordar por conversación
openclaw config set agents.default.maxHistory 50

# Límite de edad del historial (en horas)
openclaw config set agents.default.historyMaxAge 24
```

## Menciones y Referencias

### Mencionar Usuarios

El agente puede mencionar a usuarios en sus respuestas:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup) {
    // Menciona al remitente
    await message.reply(`Hola @${message.sender.name}!`);
    
    // Menciona a múltiples usuarios
    await message.reply(`@${user1.name} y @${user2.name}, por favor revisen esto.`);
  }
});
```

La sintaxis de mención específica depende del canal:

- **WhatsApp**: `@nombre`
- **Telegram**: `@username` o `[nombre](tg://user?id=123456)`
- **Discord**: `<@user_id>`
- **Slack**: `<@user_id>`
- **Matrix**: `@usuario:servidor.org`

### Responder a Mensajes

Responde a mensajes específicos (si el canal lo soporta):

```typescript
agent.on('message', async (message) => {
  if (message.isGroup) {
    // Responde directamente al mensaje del usuario
    await message.reply('Respondiendo a tu pregunta...', {
      replyTo: message.id
    });
  }
});
```

## Moderación y Permisos

### Permisos de Administrador

Si el bot tiene permisos de administrador, puede:

- Borrar mensajes
- Patear/banear usuarios
- Cambiar configuraciones del grupo
- Silenciar/dessilenciar participantes

```typescript
// Borrar un mensaje (requiere permisos de admin)
await message.delete();

// Patear un usuario (requiere permisos de admin)
await group.kick(userId);

// Silenciar a un usuario (requiere permisos de admin)
await group.mute(userId, duration);
```

### Control de Acceso

Limita quién puede usar el bot en grupos:

```bash
# Lista de usuarios permitidos
openclaw config set channels.allowedUsers '["user1", "user2"]'

# Lista de grupos permitidos
openclaw config set channels.allowedGroups '["group1", "group2"]'

# Requerir roles específicos (específico de Discord)
openclaw config set channels.discord.requiredRoles '["Admin", "Moderador"]'
```

### Filtrado de Contenido

Implementa filtrado de contenido en grupos:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup) {
    // Filtra spam
    if (isSpam(message.content)) {
      await message.delete();
      await group.warn(message.sender, 'No se permite spam');
      return;
    }
    
    // Filtra contenido inapropiado
    if (hasInappropriateContent(message.content)) {
      await message.delete();
      await group.mute(message.sender, '1h');
      return;
    }
  }
});
```

## Características Avanzadas

### Manejo de Hilos

Algunos canales soportan hilos (Discord, Slack, Matrix):

```typescript
agent.on('message', async (message) => {
  if (message.isGroup && message.thread) {
    // Este mensaje es parte de un hilo
    console.log(`Hilo: ${message.thread.id}`);
    
    // Responde en el hilo
    await message.reply('Respondiendo en hilo', {
      threadId: message.thread.id
    });
  }
});
```

### Encuestas y Votaciones

Crea encuestas en grupos:

```typescript
agent.command('poll', async (ctx, args) => {
  const question = args[0];
  const options = args.slice(1);
  
  await ctx.createPoll({
    question,
    options,
    allowMultipleAnswers: false,
    isAnonymous: true
  });
});
```

Uso:

```
!poll "¿Cuál es tu color favorito?" "Rojo" "Azul" "Verde"
```

### Mensajes Anclados

Ancla mensajes importantes (requiere permisos de admin):

```typescript
agent.command('pin', async (ctx) => {
  if (ctx.message.replyTo) {
    await ctx.group.pinMessage(ctx.message.replyTo.id);
    await ctx.reply('Mensaje anclado!');
  }
});
```

### Información del Grupo

Obtén información sobre el grupo:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup) {
    const group = await message.getGroup();
    
    console.log(`Nombre del grupo: ${group.name}`);
    console.log(`Descripción: ${group.description}`);
    console.log(`Conteo de miembros: ${group.memberCount}`);
    console.log(`Administradores: ${group.admins.map(a => a.name).join(', ')}`);
  }
});
```

## Mejores Prácticas

### 1. Usa Respuesta por Mención en Grupos Grandes

En grupos con mucha actividad, evita responder a cada mensaje:

```bash
openclaw config set channels.groupBehavior "mention"
```

Esto reduce ruido y conserva recursos.

### 2. Implementa Límites de Tasa

Prevén que el bot haga spam en el grupo:

```typescript
const rateLimiter = new RateLimiter({
  maxMessages: 10,
  perMinutes: 1
});

agent.on('message', async (message) => {
  if (message.isGroup) {
    if (!rateLimiter.allow(message.group.id)) {
      // Omitir este mensaje - límite de tasa excedido
      return;
    }
    
    // Procesar mensaje...
  }
});
```

### 3. Proporciona Mensajes de Ayuda Claros

Haz que los usuarios sepan cómo interactuar con el bot:

```typescript
agent.command('help', async (ctx) => {
  await ctx.reply(`
**Comandos del Bot**
• !help - Mostrar esta ayuda
• !ask <pregunta> - Hacer una pregunta
• !status - Mostrar estado del bot

**Uso**
Mencióname (@bot) o usa un comando para interactuar conmigo.
  `);
});
```

### 4. Maneja Conversaciones Privadas

Redirige consultas sensibles a DMs:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup && containsSensitiveInfo(message.content)) {
    await message.reply('Por favor envíame un DM para consultas sensibles.');
    return;
  }
});
```

### 5. Registra la Actividad del Grupo

Mantén registros de interacciones grupales para depuración:

```typescript
agent.on('message', async (message) => {
  if (message.isGroup) {
    logger.info('Mensaje de grupo', {
      group: message.group.name,
      sender: message.sender.name,
      content: message.content.substring(0, 100)
    });
  }
});
```

## Solución de Problemas

### El Bot No Responde en Grupos

Si el bot no responde en grupos:

1. Verifica el comportamiento de grupo:
   ```bash
   openclaw config get channels.groupBehavior
   ```

2. Asegúrate de que el bot esté en el grupo:
   ```bash
   openclaw channels status --deep
   ```

3. Verifica que el bot tenga permisos necesarios:
   - WhatsApp: Sin requisitos especiales
   - Telegram: Haz al bot administrador para funciones completas
   - Discord: Verifica permisos del rol del bot
   - Slack: Verifica ámbitos de la aplicación

4. Revisa los logs:
   ```bash
   openclaw gateway logs
   ```

### El Bot Responde Demasiado Frecuentemente

Si el bot hace spam en el grupo:

1. Cambia a comportamiento de solo-mención:
   ```bash
   openclaw config set channels.groupBehavior "mention"
   ```

2. Implementa límites de tasa en tu código

3. Ajusta los disparadores del agente para ser más específicos

### Los Mensajes No Llegan al Bot

Si el bot no ve mensajes:

1. En **Telegram**: Asegúrate de que el modo de privacidad esté **deshabilitado**:
   - Habla con @BotFather
   - Selecciona tu bot
   - Ve a Bot Settings → Group Privacy
   - Deshabilita Group Privacy

2. En **Discord**: Verifica que el bot pueda leer mensajes:
   - Ve a permisos del canal
   - Asegura "Leer Mensajes" e "Historia de Mensajes" habilitados

3. En **Slack**: Verifica eventos y ámbitos:
   - Ve a configuración de la aplicación
   - Verifica suscripciones de eventos
   - Asegura ámbitos necesarios habilitados

### El Bot No Puede Mencionar Usuarios

Si las menciones no funcionan:

1. Verifica el formato de mención específico del canal
2. Asegúrate de tener IDs de usuario correctos
3. Comprueba que el bot tenga permisos para mencionar (@everyone, etc.)

## Ejemplos

### Bot Básico de Grupo

```typescript
import { OpenClawAgent } from 'openclaw';

const agent = new OpenClawAgent({
  name: 'groupbot',
  commandPrefix: '!'
});

agent.on('message', async (message) => {
  if (message.isGroup) {
    // Responde solo a menciones
    if (message.mentions?.includes(agent.id)) {
      await message.reply('¿Cómo puedo ayudarte?');
    }
  }
});

await agent.start();
```

### Bot con Comandos

```typescript
import { OpenClawAgent } from 'openclaw';

const agent = new OpenClawAgent({
  name: 'commandbot',
  commandPrefix: '!'
});

agent.command('hello', async (ctx) => {
  await ctx.reply(`¡Hola @${ctx.sender.name}!`);
});

agent.command('info', async (ctx) => {
  const group = await ctx.getGroup();
  await ctx.reply(`
**Información del Grupo**
Nombre: ${group.name}
Miembros: ${group.memberCount}
  `);
});

await agent.start();
```

### Bot Moderador

```typescript
import { OpenClawAgent } from 'openclaw';

const agent = new OpenClawAgent({
  name: 'modbot',
  commandPrefix: '!'
});

// Auto-moderar spam
agent.on('message', async (message) => {
  if (message.isGroup && isSpam(message.content)) {
    await message.delete();
    await message.reply(`@${message.sender.name}, por favor no hagas spam.`);
  }
});

// Comando de patear (solo admin)
agent.command('kick', async (ctx, args) => {
  if (!ctx.sender.isAdmin) {
    await ctx.reply('Solo administradores pueden patear usuarios.');
    return;
  }
  
  const userId = args[0];
  await ctx.group.kick(userId);
  await ctx.reply(`Usuario pateado.`);
});

await agent.start();
```

## Recursos Adicionales

- [Mensajes Grupales de WhatsApp](/es-ES/channels/group-messages)
- [Grupos de Difusión de WhatsApp](/es-ES/channels/broadcast-groups)
- [Documentación de Canales](/es-ES/channels)
- [Configuración de Agentes](/es-ES/configuration/agents)

## Soporte

Si encuentras problemas con chats grupales:

1. Revisa esta documentación y las guías de solución de problemas
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
4. Contacta al soporte en [support@openclaw.ai](mailto:support@openclaw.ai)
