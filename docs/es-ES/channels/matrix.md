---
title: Matrix
description: Conecta OpenClaw a la red Matrix
icon: matrix-org
---

# Canal Matrix

OpenClaw soporta Matrix, un protocolo de comunicación abierto y descentralizado para mensajería en tiempo real. Conéctate a servidores Matrix para chatear con usuarios Matrix y gestionar salas.

<Note>
El soporte de Matrix está disponible a través del plugin **@openclaw/matrix**. Este plugin proporciona integración completa con el protocolo Matrix, incluyendo mensajería cifrada de extremo a extremo (E2EE).
</Note>

## Características

- 📱 **Mensajería en Tiempo Real**: Envía y recibe mensajes instantáneamente
- 🔐 **Cifrado E2EE**: Soporte completo para salas cifradas usando Olm/Megolm
- 🏠 **Gestión de Salas**: Únete, crea y gestiona salas de Matrix
- 👥 **Mensajes Directos y Grupales**: Soporta tanto DMs como chats grupales
- 🔔 **Notificaciones**: Recibe notificaciones para mensajes y eventos de sala
- 📎 **Archivos Multimedia**: Envía y recibe imágenes, archivos y otro contenido multimedia
- ⚡ **Federado**: Conéctate a cualquier servidor Matrix en la red federada

## Instalación

Instala el plugin de Matrix:

```bash
openclaw plugin install @openclaw/matrix
```

## Configuración Rápida

### 1. Crear una Cuenta Matrix

Primero necesitas una cuenta Matrix. Puedes:

- Registrarte en [matrix.org](https://app.element.io/#/register)
- Usar cualquier otro servidor Matrix de tu elección
- Auto-hospedar tu propio servidor Synapse o Dendrite

### 2. Configurar las Credenciales

Configura tu servidor Matrix y credenciales:

```bash
# Configura el servidor homeserver
openclaw config set channels.matrix.homeserverUrl "https://matrix.org"

# Configura tu ID de usuario completo
openclaw config set channels.matrix.userId "@tuusuario:matrix.org"

# Configura tu contraseña (o usa token de acceso)
openclaw config set channels.matrix.password "tu_contraseña"
```

<Accordion title="Usando un Token de Acceso en lugar de Contraseña">
  Para mayor seguridad, puedes usar un token de acceso en lugar de tu contraseña:

```bash
openclaw config set channels.matrix.accessToken "tu_token_de_acceso"
```

Obtén un token de acceso desde la configuración de tu cliente Matrix o directamente desde la API.
</Accordion>

### 3. Habilitar el Canal

Habilita el canal Matrix:

```bash
openclaw config set channels.matrix.enabled true
```

### 4. Iniciar el Gateway

Inicia o reinicia el gateway para conectarte:

```bash
openclaw gateway restart
```

## Configuración

### Opciones de Configuración

El plugin de Matrix soporta las siguientes opciones de configuración:

```bash
# Requerido: URL del servidor homeserver
openclaw config set channels.matrix.homeserverUrl "https://matrix.org"

# Requerido: Tu ID de usuario Matrix (MXID)
openclaw config set channels.matrix.userId "@tuusuario:matrix.org"

# Autenticación: Contraseña o token de acceso
openclaw config set channels.matrix.password "tu_contraseña"
# O
openclaw config set channels.matrix.accessToken "tu_token"

# Opcional: Nombre para mostrar
openclaw config set channels.matrix.displayName "Mi Bot OpenClaw"

# Opcional: Habilitar/deshabilitar E2EE (por defecto: true)
openclaw config set channels.matrix.encryption.enabled true

# Opcional: Ruta del almacenamiento de cifrado (por defecto: ~/.openclaw/matrix/crypto)
openclaw config set channels.matrix.encryption.storePath "~/.openclaw/matrix/crypto"

# Opcional: Auto-unirse a invitaciones de sala (por defecto: false)
openclaw config set channels.matrix.autoAcceptInvites true

# Opcional: Prefijo de comando (por defecto: "!")
openclaw config set channels.matrix.commandPrefix "!"
```

### Configuración de Cifrado

El plugin de Matrix soporta cifrado de extremo a extremo (E2EE) usando el protocolo Olm/Megolm:

```bash
# Habilitar E2EE (habilitado por defecto)
openclaw config set channels.matrix.encryption.enabled true

# Configura la ubicación de almacenamiento de claves de cifrado
openclaw config set channels.matrix.encryption.storePath "~/.openclaw/matrix/crypto"

# Verificación de dispositivos (por defecto: false)
openclaw config set channels.matrix.encryption.verifyDevices false
```

<Warning>
**Importante**: El almacenamiento de cifrado contiene tus claves privadas. Realiza copias de seguridad de este directorio regularmente y mantenlo seguro. Perder estas claves significa perder acceso a mensajes cifrados históricos.
</Warning>

### Gestión de Salas

Configura cómo el bot maneja salas e invitaciones:

```bash
# Auto-aceptar invitaciones de sala
openclaw config set channels.matrix.autoAcceptInvites true

# Lista de salas permitidas (lista blanca)
openclaw config set channels.matrix.allowedRooms '["!roomId1:matrix.org", "!roomId2:matrix.org"]'

# Lista de usuarios permitidos (lista blanca)
openclaw config set channels.matrix.allowedUsers '["@usuario1:matrix.org", "@usuario2:matrix.org"]'
```

## Uso

### Enviar Mensajes

Una vez conectado, puedes enviar mensajes a salas Matrix:

```bash
# Enviar mensaje a una sala específica
openclaw message send --channel matrix --recipient "!roomId:matrix.org" "Hola Matrix!"

# Enviar mensaje directo a un usuario
openclaw message send --channel matrix --recipient "@usuario:matrix.org" "Hola!"
```

### Recibir Mensajes

El bot recibirá automáticamente mensajes de:

- Salas a las que se ha unido
- Mensajes directos de usuarios
- Invitaciones a salas (si autoAcceptInvites está habilitado)

### Comandos en Sala

Por defecto, el bot responde a comandos con el prefijo `!`:

```
!help - Mostrar comandos disponibles
!ping - Verificar si el bot está activo
!status - Mostrar estado del bot
```

Personaliza el prefijo de comando:

```bash
openclaw config set channels.matrix.commandPrefix "/"
```

## Salas Cifradas

### Unirse a una Sala Cifrada

Para unirse a una sala cifrada:

1. Asegúrate de que E2EE esté habilitado:

   ```bash
   openclaw config get channels.matrix.encryption.enabled
   ```

2. Acepta la invitación a la sala (o habilita auto-aceptar):

   ```bash
   openclaw config set channels.matrix.autoAcceptInvites true
   ```

3. El bot se unirá automáticamente y comenzará a descifrar mensajes

### Verificación de Dispositivos

Para salas con alta seguridad que requieren verificación de dispositivos:

```bash
# Habilitar verificación de dispositivos
openclaw config set channels.matrix.encryption.verifyDevices true
```

Luego verifica el dispositivo del bot manualmente desde tu cliente Matrix:

1. Abre tu cliente Matrix (Element, etc.)
2. Ve a la configuración de la sala → Seguridad
3. Encuentra el dispositivo del bot y márcalo como verificado

### Respaldar Claves de Cifrado

Respalda regularmente tus claves de cifrado:

```bash
# Ubicación por defecto
cp -r ~/.openclaw/matrix/crypto ~/backup/matrix-crypto-$(date +%Y%m%d)
```

<Tip>
Configura respaldos automáticos de tu directorio de claves de cifrado para prevenir pérdida de datos.
</Tip>

## Características Avanzadas

### Múltiples Cuentas

Puedes ejecutar múltiples bots Matrix con diferentes cuentas:

```bash
# Bot 1
openclaw config set agents.bot1.channels.matrix.userId "@bot1:matrix.org"
openclaw config set agents.bot1.channels.matrix.password "contraseña1"

# Bot 2
openclaw config set agents.bot2.channels.matrix.userId "@bot2:matrix.org"
openclaw config set agents.bot2.channels.matrix.password "contraseña2"
```

### Filtrado y Enrutamiento de Salas

Enruta mensajes según la sala:

```typescript
import { MatrixChannel } from "@openclaw/matrix";

const matrix = new MatrixChannel({
  homeserverUrl: "https://matrix.org",
  userId: "@bot:matrix.org",
  accessToken: "tu_token",
});

matrix.on("message", async (event) => {
  const roomId = event.roomId;

  // Enruta según la sala
  if (roomId === "!soporte:matrix.org") {
    // Maneja mensajes de soporte
    await handleSupportMessage(event);
  } else if (roomId === "!general:matrix.org") {
    // Maneja chat general
    await handleGeneralMessage(event);
  }
});
```

### Tipos de Mensajes Personalizados

Envía tipos de mensajes personalizados:

```typescript
// Enviar un mensaje de aviso
await matrix.sendMessage(roomId, {
  msgtype: "m.notice",
  body: "Este es un aviso del sistema",
});

// Enviar mensaje con formato HTML
await matrix.sendMessage(roomId, {
  msgtype: "m.text",
  body: "Texto plano alternativo",
  format: "org.matrix.custom.html",
  formatted_body: "<strong>Texto en negrita</strong> y <em>cursiva</em>",
});

// Enviar un archivo
await matrix.sendFile(roomId, {
  file: "/ruta/a/archivo.pdf",
  msgtype: "m.file",
});
```

### Manejo de Eventos de Sala

Escucha y responde a eventos de sala:

```typescript
// Evento de miembro (alguien se une/sale)
matrix.on("room.member", async (event) => {
  if (event.membership === "join") {
    console.log(`${event.sender} se unió a ${event.roomId}`);
  } else if (event.membership === "leave") {
    console.log(`${event.sender} salió de ${event.roomId}`);
  }
});

// Evento de nombre de sala
matrix.on("room.name", async (event) => {
  console.log(`Sala ${event.roomId} renombrada a ${event.name}`);
});

// Cambio de nivel de poder
matrix.on("room.power_levels", async (event) => {
  console.log(`Niveles de poder actualizados en ${event.roomId}`);
});
```

## Solución de Problemas

### Problemas de Conexión

Si el bot no se conecta:

1. Verifica la URL del homeserver:

   ```bash
   openclaw config get channels.matrix.homeserverUrl
   ```

2. Prueba la conectividad:

   ```bash
   curl -I https://matrix.org
   ```

3. Verifica las credenciales:

   ```bash
   openclaw config get channels.matrix.userId
   ```

4. Revisa los logs del gateway:
   ```bash
   openclaw gateway logs
   ```

### Problemas de Cifrado

Si tienes problemas con salas cifradas:

1. Verifica que E2EE esté habilitado:

   ```bash
   openclaw config get channels.matrix.encryption.enabled
   ```

2. Comprueba que el almacenamiento de cifrado es accesible:

   ```bash
   ls -la ~/.openclaw/matrix/crypto
   ```

3. Reinicia el bot para reinicializar el cifrado:

   ```bash
   openclaw gateway restart
   ```

4. Si los mensajes no se descifran, puede que necesites:
   - Verificar el dispositivo del bot
   - Solicitar claves de sala desde otro dispositivo
   - Reunirte a la sala

### No se Reciben Mensajes

Si no recibes mensajes:

1. Verifica que el bot esté en la sala:

   ```bash
   openclaw channels status matrix
   ```

2. Comprueba las listas permitidas:

   ```bash
   openclaw config get channels.matrix.allowedRooms
   openclaw config get channels.matrix.allowedUsers
   ```

3. Asegúrate de que el bot tenga poder suficiente en la sala

4. Revisa los logs para errores:
   ```bash
   openclaw gateway logs --level debug
   ```

### Problemas de Rendimiento

Para servidores Matrix grandes o congestionados:

```bash
# Reduce el límite de sincronización
openclaw config set channels.matrix.syncLimit 10

# Aumenta el tiempo de espera de sincronización
openclaw config set channels.matrix.syncTimeout 30000

# Deshabilita presencia para reducir carga
openclaw config set channels.matrix.presence false
```

## Ejemplos

### Bot Básico de Matrix

```typescript
import { MatrixChannel } from "@openclaw/matrix";

const matrix = new MatrixChannel({
  homeserverUrl: "https://matrix.org",
  userId: "@bot:matrix.org",
  accessToken: process.env.MATRIX_ACCESS_TOKEN,
});

await matrix.connect();

matrix.on("message", async (event) => {
  const { roomId, sender, body } = event;

  if (body.startsWith("!hello")) {
    await matrix.sendMessage(roomId, {
      msgtype: "m.text",
      body: `Hola ${sender}!`,
    });
  }
});
```

### Bot con E2EE

```typescript
import { MatrixChannel } from "@openclaw/matrix";

const matrix = new MatrixChannel({
  homeserverUrl: "https://matrix.org",
  userId: "@bot:matrix.org",
  accessToken: process.env.MATRIX_ACCESS_TOKEN,
  encryption: {
    enabled: true,
    storePath: "~/.openclaw/matrix/crypto",
  },
});

await matrix.connect();

matrix.on("message", async (event) => {
  // Maneja mensajes cifrados automáticamente
  console.log(`Mensaje de ${event.sender}: ${event.body}`);
});
```

### Bot con Auto-Unión a Salas

```typescript
import { MatrixChannel } from "@openclaw/matrix";

const matrix = new MatrixChannel({
  homeserverUrl: "https://matrix.org",
  userId: "@bot:matrix.org",
  accessToken: process.env.MATRIX_ACCESS_TOKEN,
  autoAcceptInvites: true,
});

await matrix.connect();

matrix.on("room.invite", async (invite) => {
  console.log(`Invitado a sala: ${invite.roomId}`);
  // Automáticamente acepta todas las invitaciones
});

matrix.on("room.join", async (event) => {
  const { roomId } = event;
  await matrix.sendMessage(roomId, {
    msgtype: "m.text",
    body: "¡Hola! Gracias por invitarme.",
  });
});
```

## Recursos Adicionales

- [Sitio Web de Matrix](https://matrix.org)
- [Especificación del Protocolo Matrix](https://spec.matrix.org)
- [Cliente Element](https://element.io)
- [Documentación de Canales de OpenClaw](/es-ES/channels)
- [Repositorio del Plugin Matrix](https://github.com/openclaw/openclaw/tree/main/extensions/matrix)

## Soporte

Si encuentras problemas con Matrix:

1. Revisa la [documentación de Matrix](https://matrix.org/docs)
2. Consulta los [problemas de GitHub](https://github.com/openclaw/openclaw/issues)
3. Pregunta en el [servidor de Discord](https://discord.gg/openclaw)
4. Reporta bugs del plugin en el [rastreador de problemas](https://github.com/openclaw/openclaw/issues)
