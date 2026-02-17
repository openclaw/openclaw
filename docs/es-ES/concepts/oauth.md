---
title: OAuth
description: Cómo funciona la autenticación OAuth en OpenClaw
---

**OAuth** es el mecanismo de autenticación utilizado por OpenClaw para conectarse de forma segura a servicios externos como Slack, Discord, Google y otros. Permite a los usuarios autorizar a OpenClaw sin compartir sus contraseñas.

## Cómo Funciona OAuth

1. **Usuario inicia autorización** (`openclaw login slack`)
2. **OpenClaw abre navegador** a la página de autorización del servicio
3. **Usuario otorga permisos** en la página del servicio
4. **Servicio redirige** de vuelta a OpenClaw con un código de autorización
5. **OpenClaw intercambia código** por un token de acceso
6. **OpenClaw guarda token** en el keychain del sistema

Una vez autorizado, OpenClaw usa el token de acceso para hacer llamadas API en nombre del usuario.

## Proveedores OAuth Soportados

OpenClaw soporta OAuth para:

- **Slack** - Integración de workspace
- **Discord** - Integración de bot
- **Google** - Gmail, Calendar, Drive
- **Microsoft** - Teams, Outlook, OneDrive
- **GitHub** - Repositorios, Issues, PRs
- **Linear** - Integración de gestión de proyectos
- **Notion** - Integración de workspace

Más proveedores se añaden regularmente.

## Flujo de Autorización

### Login Inicial

Para conectar un servicio:

```bash
openclaw login slack
```

Esto:

1. Inicia un servidor local temporal en `http://localhost:8789`
2. Abre tu navegador a la URL de autorización del servicio
3. Espera a que completes la autorización
4. Recibe la respuesta de callback
5. Guarda el token de acceso
6. Cierra el servidor local

### Estado de Autorización

Verifica qué servicios están autorizados:

```bash
openclaw auth status
```

Esto muestra:

- Qué servicios están conectados
- Cuándo se autorizaron
- Qué alcances (permisos) están otorgados
- Si los tokens han expirado

### Renovación de Tokens

Algunos servicios proporcionan **tokens de actualización** que permiten a OpenClaw obtener nuevos tokens de acceso cuando expiran. OpenClaw maneja esto automáticamente:

1. Detecta que el token de acceso ha expirado
2. Usa el token de actualización para obtener uno nuevo
3. Guarda el nuevo token de acceso
4. Reintenta la solicitud original

Si el token de actualización también ha expirado, debes volver a autorizar:

```bash
openclaw login slack
```

### Revocación

Para revocar acceso a un servicio:

```bash
openclaw logout slack
```

Esto:

1. Elimina el token de acceso del keychain
2. Opcionalmente revoca el token en el servicio (si es soportado)
3. Previene futuras llamadas API a ese servicio

## Almacenamiento de Tokens

Los tokens de acceso se almacenan de forma segura en:

- **macOS**: Keychain
- **Windows**: Credential Manager
- **Linux**: Secret Service API (gnome-keyring, kwallet)

OpenClaw nunca almacena tokens en texto plano en disco.

## Alcances OAuth

Los **alcances** definen qué permisos OpenClaw solicita. Cada servicio tiene diferentes alcances:

### Alcances de Slack

```
chat:write        - Enviar mensajes
channels:read     - Listar canales
users:read        - Listar usuarios
files:write       - Subir archivos
```

### Alcances de Discord

```
bot               - Actuar como bot
guilds.members.read - Leer lista de miembros
messages.read     - Leer historial de mensajes
```

### Alcances de Google

```
gmail.send        - Enviar emails
calendar.readonly - Leer eventos de calendario
drive.readonly    - Leer archivos de Drive
```

OpenClaw solo solicita los alcances mínimos necesarios para cada integración.

## Tokens Personalizados

Para uso avanzado, puedes proporcionar tus propios tokens:

```bash
# Establecer token de Slack personalizado
openclaw config set slack.token "xoxb-..."

# Establecer token de Discord personalizado
openclaw config set discord.token "..."
```

Esto salta el flujo OAuth y usa el token proporcionado directamente.

## Aplicaciones OAuth

OpenClaw usa sus propias aplicaciones OAuth para cada servicio. Esto significa:

- **No necesitas** crear tu propia aplicación
- **No necesitas** registrarte para claves API
- **Solo autentica** usando tu cuenta del servicio

Para uso empresarial, puedes usar tus propias aplicaciones OAuth:

```bash
# Usar aplicación Slack personalizada
openclaw config set slack.clientId "..."
openclaw config set slack.clientSecret "..."
openclaw config set slack.redirectUri "http://localhost:8789/oauth/callback"
```

## Seguridad

OpenClaw sigue mejores prácticas de seguridad de OAuth:

- **Usa PKCE** (Proof Key for Code Exchange) cuando es soportado
- **Valida parámetros state** para prevenir ataques CSRF
- **Usa HTTPS** para todos los endpoints de API
- **Almacena tokens de forma segura** en el keychain del sistema
- **Nunca registra** tokens o información sensible
- **Revoca tokens** al hacer logout

## Solución de Problemas

### El navegador no se abre

Si el navegador no se abre automáticamente:

1. Copia la URL que se muestra en la terminal
2. Pega en tu navegador manualmente
3. Completa la autorización
4. Deberías ver "Authorization successful"

### Errores de Redirección

Si ves "Redirect URI mismatch" u errores similares:

1. Asegúrate de que estás usando la última versión de OpenClaw
2. Verifica que ningún firewall esté bloqueando `localhost:8789`
3. Intenta con un navegador diferente
4. Verifica los logs de OpenClaw para más detalles

### Tokens Expirados

Si ves errores "Unauthorized" o "Token expired":

1. Intenta reautorizar: `openclaw login <service>`
2. Verifica que el servicio aún esté activo
3. Verifica que tus permisos de cuenta no hayan cambiado
4. Contacta soporte si el problema persiste

### Errores de Alcance

Si ves "Insufficient permissions" u errores de alcance:

1. Reautoriza para otorgar permisos adicionales
2. Verifica que tu cuenta tenga los permisos necesarios
3. Contacta a tu administrador de workspace si los permisos son restringidos

## Soporte Empresarial

Para despliegues empresariales, OpenClaw soporta:

- **Aplicaciones OAuth personalizadas** con tus propias credenciales
- **SSO** (Single Sign-On) a través de proveedores OAuth
- **Configuración centralizada** para usuarios de equipo
- **Auditoría** de autorizaciones OAuth

Contacta a OpenClaw para más detalles sobre características empresariales.

## Desarrollo Local

Al desarrollar con OAuth:

1. **Usa el flujo OAuth predeterminado** cuando sea posible
2. **Configura tokens de desarrollo** si necesitas comportamiento personalizado
3. **Prueba con múltiples usuarios** para verificar alcances
4. **Documenta alcances requeridos** para cada característica

Consulta la [Guía del Desarrollador](/es-ES/development/oauth) para más detalles.

## Referencias API

OpenClaw proporciona APIs programáticas para OAuth:

```typescript
import { OAuthClient } from 'openclaw'

// Iniciar flujo OAuth
const client = new OAuthClient('slack')
const authUrl = await client.getAuthorizationUrl()

// Manejar callback
await client.handleCallback(code)

// Obtener token de acceso
const token = await client.getAccessToken()

// Actualizar token
const newToken = await client.refreshToken()
```

Consulta la [Referencia API](/es-ES/api/oauth) para documentación completa.
