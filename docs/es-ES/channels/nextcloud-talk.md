---
title: Nextcloud Talk
description: Conecta OpenClaw a Nextcloud Talk
icon: cloud
---

# Canal de Nextcloud Talk

OpenClaw soporta Nextcloud Talk, un servicio de chat y videollamada auto-hospedado. Conéctate a tu instancia de Nextcloud Talk para recibir y responder mensajes.

<Note>
El soporte de Nextcloud Talk está disponible a través del plugin **@openclaw/nextcloud-talk**. Este plugin proporciona integración con Nextcloud Talk vía webhooks.
</Note>

## Características

- 💬 **Mensajería en Tiempo Real**: Recibe mensajes de conversaciones de Nextcloud Talk
- 🤖 **Bot Webhook**: Responde a comandos y menciones
- 🔒 **Auto-Hospedado**: Funciona con tu instancia privada de Nextcloud
- 👥 **Salas Grupales**: Soporta conversaciones de sala
- 🔔 **Basado en Eventos**: Responde a eventos de mensajes vía webhooks

## Instalación

Instala el plugin de Nextcloud Talk:

```bash
openclaw plugin install @openclaw/nextcloud-talk
```

## Configuración Rápida

### 1. Prerrequisitos

Necesitas:

- Una instancia de Nextcloud en ejecución con la aplicación Talk habilitada
- Credenciales de usuario (nombre de usuario + contraseña o token de aplicación)
- Acceso para crear webhooks en salas de Talk

### 2. Configurar Credenciales

Configura tu URL de Nextcloud y credenciales:

```bash
# Configura la URL de tu instancia de Nextcloud
openclaw config set channels.nextcloudTalk.serverUrl "https://cloud.example.com"

# Configura tu nombre de usuario
openclaw config set channels.nextcloudTalk.username "tu_usuario"

# Configura tu contraseña (o token de aplicación)
openclaw config set channels.nextcloudTalk.password "tu_contraseña"
```

<Accordion title="Usando Token de Aplicación en lugar de Contraseña">
  Para mayor seguridad, puedes usar un token de aplicación en lugar de tu contraseña:

1. Ve a Configuración de Nextcloud → Seguridad
2. Crea un nuevo token de aplicación
3. Usa el token como contraseña:

```bash
openclaw config set channels.nextcloudTalk.password "tu_token_de_aplicacion"
```

</Accordion>

### 3. Configurar Webhook

Nextcloud Talk usa webhooks para entregar mensajes. Configura el puerto del webhook:

```bash
# Configura el puerto del webhook (por defecto: 3979)
openclaw config set channels.nextcloudTalk.webhook.port 3979

# Opcional: configura la ruta (por defecto: /nextcloud-talk/webhook)
openclaw config set channels.nextcloudTalk.webhook.path "/nextcloud-talk/webhook"
```

### 4. Exponer el Webhook

El webhook debe ser accesible desde tu servidor de Nextcloud:

**Producción: Usar un proxy inverso**

```nginx
# Configuración Nginx de ejemplo
location /nextcloud-talk/webhook {
  proxy_pass http://localhost:3979/nextcloud-talk/webhook;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
}
```

**Desarrollo: Usar un túnel**

```bash
# Opción A: ngrok
ngrok http 3979

# Opción B: Tailscale Funnel
tailscale funnel 3979
```

### 5. Registrar el Webhook en Nextcloud

Para cada sala de Talk donde quieras que el bot esté activo:

1. Abre la sala en Nextcloud Talk
2. Ve a Configuración de sala → Webhooks
3. Añade un nuevo webhook entrante:
   - **URL del webhook**: Tu URL pública del webhook (ej., `https://tu-dominio.com/nextcloud-talk/webhook`)
   - **Nombre para mostrar**: OpenClaw
   - **Eventos**: Selecciona "Nuevo mensaje"

### 6. Habilitar el Canal

Habilita el canal de Nextcloud Talk:

```bash
openclaw config set channels.nextcloudTalk.enabled true
```

### 7. Iniciar el Gateway

Inicia o reinicia el gateway:

```bash
openclaw gateway restart
```

## Configuración

### Opciones de Configuración

```bash
# Requerido: URL del servidor de Nextcloud
openclaw config set channels.nextcloudTalk.serverUrl "https://cloud.example.com"

# Requerido: Nombre de usuario
openclaw config set channels.nextcloudTalk.username "tu_usuario"

# Requerido: Contraseña o token de aplicación
openclaw config set channels.nextcloudTalk.password "tu_contraseña"

# Opcional: Puerto del webhook (por defecto: 3979)
openclaw config set channels.nextcloudTalk.webhook.port 3979

# Opcional: Ruta del webhook (por defecto: /nextcloud-talk/webhook)
openclaw config set channels.nextcloudTalk.webhook.path "/nextcloud-talk/webhook"

# Opcional: Requiere mención en salas (por defecto: true)
openclaw config set channels.nextcloudTalk.requireMention true

# Opcional: Prefijo de comando (por defecto: "!")
openclaw config set channels.nextcloudTalk.commandPrefix "!"
```

## Uso

### Interactuar con el Bot

Una vez configurado, puedes interactuar con el bot en Nextcloud Talk:

**En salas (grupo):**

```
@OpenClaw hola
!help
!status
```

**En mensajes directos:**

```
hola
¿cómo estás?
```

### Enviar Mensajes

Envía mensajes a salas de Talk vía CLI:

```bash
# Enviar mensaje a una sala
openclaw message send --channel nextcloudTalk --recipient "<token_sala>" "Hola sala!"

# Enviar mensaje directo a un usuario
openclaw message send --channel nextcloudTalk --recipient "<nombre_usuario>" "Hola!"
```

## Comportamiento de Sala

Por defecto, el bot requiere ser mencionado en salas grupales:

```bash
# Responder solo a menciones (por defecto)
openclaw config set channels.nextcloudTalk.requireMention true

# Responder a todos los mensajes
openclaw config set channels.nextcloudTalk.requireMention false
```

## Comandos

El bot soporta comandos con un prefijo (por defecto `!`):

```
!help - Mostrar comandos disponibles
!ping - Verificar si el bot está activo
!status - Mostrar estado del bot
```

Personaliza el prefijo de comando:

```bash
openclaw config set channels.nextcloudTalk.commandPrefix "/"
```

## Solución de Problemas

### El Bot No Recibe Mensajes

Si el bot no recibe mensajes:

1. Verifica que el webhook esté correctamente registrado en Nextcloud Talk
2. Comprueba que la URL del webhook sea accesible desde tu servidor Nextcloud
3. Verifica los logs del gateway:
   ```bash
   openclaw gateway logs
   ```

### Problemas de Autenticación

Si ves errores de autenticación:

1. Verifica nombre de usuario y contraseña/token:

   ```bash
   openclaw config get channels.nextcloudTalk.username
   ```

2. Asegúrate de que la cuenta tenga acceso a las salas

3. Intenta generar un nuevo token de aplicación

### El Webhook No es Alcanzable

Si Nextcloud no puede alcanzar el webhook:

1. Verifica que el puerto esté abierto:

   ```bash
   netstat -an | grep 3979
   ```

2. Comprueba la configuración del firewall

3. Asegúrate de que la configuración de proxy inverso sea correcta

4. Prueba el endpoint del webhook directamente:
   ```bash
   curl -X POST https://tu-dominio.com/nextcloud-talk/webhook \
     -H "Content-Type: application/json" \
     -d '{"message":"test"}'
   ```

## Ejemplos

### Bot Básico de Nextcloud Talk

```typescript
import { NextcloudTalkChannel } from "@openclaw/nextcloud-talk";

const talk = new NextcloudTalkChannel({
  serverUrl: "https://cloud.example.com",
  username: "bot",
  password: process.env.NEXTCLOUD_PASSWORD,
});

await talk.connect();

talk.on("message", async (event) => {
  if (event.message.startsWith("!hello")) {
    await talk.sendMessage(event.roomToken, "Hola!");
  }
});
```

### Bot con Comandos

```typescript
import { NextcloudTalkChannel } from "@openclaw/nextcloud-talk";

const talk = new NextcloudTalkChannel({
  serverUrl: "https://cloud.example.com",
  username: "bot",
  password: process.env.NEXTCLOUD_PASSWORD,
  commandPrefix: "!",
});

await talk.connect();

talk.command("info", async (ctx) => {
  await ctx.reply(`
**Información de Sala**
Token de sala: ${ctx.roomToken}
Remitente: ${ctx.sender.name}
  `);
});
```

## Recursos Adicionales

- [Sitio Web de Nextcloud Talk](https://nextcloud.com/talk/)
- [Documentación de API de Nextcloud Talk](https://nextcloud-talk.readthedocs.io/)
- [Documentación de Canales de OpenClaw](/es-ES/channels)
- [Repositorio del Plugin](https://github.com/openclaw/openclaw/tree/main/extensions/nextcloud-talk)

## Soporte

Si encuentras problemas con Nextcloud Talk:

1. Revisa la [documentación de Nextcloud Talk](https://nextcloud-talk.readthedocs.io/)
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
4. Reporta bugs del plugin en el [rastreador de problemas](https://github.com/openclaw/openclaw/issues)
