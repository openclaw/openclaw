---
title: IRC
description: Conecta OpenClaw a servidores IRC
icon: hashtag
---

# Canal IRC

OpenClaw soporta IRC (Internet Relay Chat), uno de los protocolos de chat más antiguos y ampliamente usados. Conéctate a servidores IRC para chatear con usuarios y participar en canales.

<Note>
El soporte de IRC está disponible a través del plugin **@openclaw/irc**. Este plugin proporciona integración completa con redes IRC.
</Note>

## Características

- 💬 **Canales y Mensajes Privados**: Soporta tanto canales (#channel) como mensajes privados
- 🔐 **Autenticación**: Soporta autenticación NickServ y SASL
- 🌐 **Multi-Servidor**: Conéctate a múltiples redes IRC simultáneamente
- 🔒 **SSL/TLS**: Conexiones seguras soportadas
- 👥 **Gestión de Canales**: Únete, sal y gestiona canales
- 🔔 **Notificaciones**: Recibe notificaciones para mensajes y menciones

## Instalación

Instala el plugin de IRC:

```bash
openclaw plugin install @openclaw/irc
```

## Configuración Rápida

### 1. Configuración Básica

Configura tu conexión IRC:

```bash
# Configura el servidor IRC
openclaw config set channels.irc.server "irc.libera.chat"

# Configura tu nick
openclaw config set channels.irc.nick "OpenClawBot"

# Opcional: Configura canales para auto-unirse
openclaw config set channels.irc.channels '["#openclaw", "#general"]'
```

### 2. Configuración SSL (Recomendado)

Habilita SSL para conexiones seguras:

```bash
# Habilita SSL
openclaw config set channels.irc.ssl true

# Configura el puerto SSL (por defecto: 6697)
openclaw config set channels.irc.port 6697
```

### 3. Autenticación (Opcional)

Si necesitas autenticarte con NickServ:

```bash
# Configura la contraseña de NickServ
openclaw config set channels.irc.password "tu_contraseña"

# O usa autenticación SASL
openclaw config set channels.irc.sasl true
openclaw config set channels.irc.saslUsername "tu_usuario"
openclaw config set channels.irc.saslPassword "tu_contraseña"
```

### 4. Habilitar el Canal

Habilita el canal IRC:

```bash
openclaw config set channels.irc.enabled true
```

### 5. Iniciar el Gateway

Inicia o reinicia el gateway:

```bash
openclaw gateway restart
```

## Configuración

### Opciones de Configuración

```bash
# Requerido: Servidor IRC
openclaw config set channels.irc.server "irc.libera.chat"

# Requerido: Nick
openclaw config set channels.irc.nick "OpenClawBot"

# Opcional: Puerto (por defecto: 6667 sin SSL, 6697 con SSL)
openclaw config set channels.irc.port 6697

# Opcional: SSL/TLS (por defecto: false)
openclaw config set channels.irc.ssl true

# Opcional: Canales para auto-unirse
openclaw config set channels.irc.channels '["#canal1", "#canal2"]'

# Opcional: Contraseña de servidor
openclaw config set channels.irc.serverPassword "contraseña"

# Opcional: Contraseña de NickServ
openclaw config set channels.irc.password "contraseña"

# Opcional: Autenticación SASL
openclaw config set channels.irc.sasl true
openclaw config set channels.irc.saslUsername "usuario"
openclaw config set channels.irc.saslPassword "contraseña"

# Opcional: Nombre real
openclaw config set channels.irc.realName "Bot OpenClaw"

# Opcional: Nombre de usuario (ident)
openclaw config set channels.irc.userName "openclaw"

# Opcional: Prefijo de comando (por defecto: "!")
openclaw config set channels.irc.commandPrefix "!"
```

### Servidores Populares de IRC

| Red           | Servidor             | Puerto SSL | Notas                    |
| ------------- | -------------------- | ---------- | ------------------------ |
| Libera.Chat   | irc.libera.chat      | 6697       | Ex-Freenode, FOSS        |
| OFTC          | irc.oftc.net         | 6697       | Comunidad de software libre |
| EFnet         | irc.efnet.org        | 6697       | Red original de IRC      |
| DALnet        | irc.dal.net          | 6697       | Red de chat general      |
| QuakeNet      | irc.quakenet.org     | 6697       | Comunidad de juegos      |

## Uso

### Unirse a Canales

El bot se une automáticamente a canales configurados. Para unirse a más canales:

```bash
# Añadir un canal a la lista de auto-unión
openclaw config set channels.irc.channels '["#openclaw", "#nuevo-canal"]'

# Reiniciar el gateway
openclaw gateway restart
```

### Enviar Mensajes

Envía mensajes a canales o usuarios:

```bash
# Enviar mensaje a un canal
openclaw message send --channel irc --recipient "#openclaw" "Hola canal!"

# Enviar mensaje privado a un usuario
openclaw message send --channel irc --recipient "usuario" "Hola!"
```

### Recibir Mensajes

El bot recibe automáticamente mensajes de:

- Canales a los que está unido
- Mensajes privados de usuarios

### Comandos en Canal

Por defecto, el bot responde a comandos con el prefijo `!`:

```
!help - Mostrar comandos disponibles
!ping - Verificar si el bot está activo
!status - Mostrar estado del bot
```

Personaliza el prefijo de comando:

```bash
openclaw config set channels.irc.commandPrefix "."
```

## Control de Acceso

### Requiere Mención en Canales

Por defecto, el bot puede requerir ser mencionado en canales:

```bash
# Responder solo a menciones
openclaw config set channels.irc.requireMention true

# Responder a todos los mensajes
openclaw config set channels.irc.requireMention false
```

### Lista Blanca de Usuarios

Limita quién puede usar el bot:

```bash
# Solo responder a usuarios específicos
openclaw config set channels.irc.allowedUsers '["usuario1", "usuario2"]'
```

### Lista Blanca de Canales

Limita en qué canales el bot responde:

```bash
# Solo responder en canales específicos
openclaw config set channels.irc.allowedChannels '["#openclaw", "#permitido"]'
```

## Características Avanzadas

### Múltiples Servidores

Conéctate a múltiples redes IRC:

```bash
# Configurar primera red
openclaw config set agents.bot1.channels.irc.server "irc.libera.chat"
openclaw config set agents.bot1.channels.irc.nick "Bot1"

# Configurar segunda red
openclaw config set agents.bot2.channels.irc.server "irc.oftc.net"
openclaw config set agents.bot2.channels.irc.nick "Bot2"
```

### Comandos de Canal

Gestiona canales mediante comandos:

```typescript
// Unirse a un canal
await ircBot.join('#nuevo-canal');

// Salir de un canal
await ircBot.part('#canal', 'Adiós!');

// Cambiar tópico
await ircBot.setTopic('#canal', 'Nuevo tópico');

// Patear usuario (requiere op)
await ircBot.kick('#canal', 'usuario', 'Razón');
```

### Modos de Usuario

El bot puede tener varios modos de usuario:

- `+o` - Operador de canal (op)
- `+v` - Voz (puede hablar en canales moderados)
- `+i` - Invisible (no aparece en /who global)

Solicita modos desde NickServ u operadores de canal.

## Solución de Problemas

### No se Puede Conectar

Si el bot no se conecta:

1. Verifica el servidor y puerto:
   ```bash
   openclaw config get channels.irc.server
   openclaw config get channels.irc.port
   ```

2. Prueba la conectividad:
   ```bash
   telnet irc.libera.chat 6667
   ```

3. Verifica configuración SSL:
   ```bash
   openclaw config get channels.irc.ssl
   ```

4. Revisa los logs del gateway:
   ```bash
   openclaw gateway logs
   ```

### Nick Ya en Uso

Si tu nick ya está en uso:

1. Configura un nick alternativo:
   ```bash
   openclaw config set channels.irc.nick "OpenClawBot2"
   ```

2. O identifícate con NickServ:
   ```bash
   openclaw config set channels.irc.password "tu_contraseña"
   ```

### No se Puede Unir a Canales

Si el bot no puede unirse a canales:

1. Verifica que el canal exista y sea público

2. Comprueba si necesitas estar registrado:
   ```bash
   openclaw config set channels.irc.password "tu_contraseña"
   ```

3. Verifica bans o prohibiciones de canal

4. Revisa los logs para errores:
   ```bash
   openclaw gateway logs --level debug
   ```

### Problemas de Autenticación

Si la autenticación falla:

1. Verifica credenciales SASL:
   ```bash
   openclaw config get channels.irc.saslUsername
   ```

2. Asegúrate de que el servidor soporte SASL

3. Intenta autenticación NickServ en su lugar:
   ```bash
   openclaw config set channels.irc.sasl false
   openclaw config set channels.irc.password "tu_contraseña"
   ```

## Ejemplos

### Bot Básico de IRC

```typescript
import { IRCChannel } from '@openclaw/irc';

const irc = new IRCChannel({
  server: 'irc.libera.chat',
  nick: 'OpenClawBot',
  channels: ['#openclaw'],
  ssl: true
});

await irc.connect();

irc.on('message', async (event) => {
  if (event.message.startsWith('!hello')) {
    await irc.say(event.target, `Hola ${event.nick}!`);
  }
});
```

### Bot con Autenticación

```typescript
import { IRCChannel } from '@openclaw/irc';

const irc = new IRCChannel({
  server: 'irc.libera.chat',
  nick: 'OpenClawBot',
  password: process.env.IRC_PASSWORD, // Contraseña NickServ
  channels: ['#openclaw'],
  ssl: true
});

await irc.connect();

irc.on('registered', () => {
  console.log('Conectado y autenticado!');
});
```

### Bot con Comandos

```typescript
import { IRCChannel } from '@openclaw/irc';

const irc = new IRCChannel({
  server: 'irc.libera.chat',
  nick: 'OpenClawBot',
  channels: ['#openclaw'],
  ssl: true,
  commandPrefix: '!'
});

await irc.connect();

irc.command('info', async (ctx) => {
  await ctx.reply(`
Canal: ${ctx.channel}
Nick: ${ctx.nick}
Servidor: ${irc.server}
  `);
});

irc.command('join', async (ctx, args) => {
  const channel = args[0];
  if (channel && channel.startsWith('#')) {
    await irc.join(channel);
    await ctx.reply(`Uniéndome a ${channel}...`);
  }
});
```

## Mejores Prácticas

### 1. Usa SSL/TLS

Siempre usa conexiones SSL cuando sea posible:

```bash
openclaw config set channels.irc.ssl true
openclaw config set channels.irc.port 6697
```

### 2. Autentica tu Nick

Registra y autentica tu nick para prevenir suplantación:

```bash
openclaw config set channels.irc.password "tu_contraseña"
```

### 3. Limita el Acceso

Usa listas blancas para controlar el acceso:

```bash
openclaw config set channels.irc.allowedChannels '["#openclaw"]'
openclaw config set channels.irc.allowedUsers '["admin", "moderador"]'
```

### 4. Maneja Límites de Tasa

IRC tiene límites de tasa. Evita que el bot envíe mensajes demasiado rápido.

### 5. Respeta las Reglas del Canal

Siempre sigue las reglas del canal y la política de la red.

## Recursos Adicionales

- [Libera.Chat](https://libera.chat/)
- [Especificación del Protocolo IRC](https://modern.ircdocs.horse/)
- [Documentación de Canales de OpenClaw](/es-ES/channels)
- [Repositorio del Plugin IRC](https://github.com/openclaw/openclaw/tree/main/extensions/irc)

## Soporte

Si encuentras problemas con IRC:

1. Revisa la [documentación de IRC](https://modern.ircdocs.horse/)
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
4. Reporta bugs del plugin en el [rastreador de problemas](https://github.com/openclaw/openclaw/issues)
