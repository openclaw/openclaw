---
summary: "Estado, capacidades y configuración del soporte de bots de Microsoft Teams"
read_when:
  - Trabajando en características del canal de MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Abandonad toda esperanza los que entráis aquí."

Actualizado: 2026-01-21

Estado: texto + adjuntos DM soportados; envío de archivos en canal/grupo requiere `sharePointSiteId` + permisos de Graph (ver [Envío de archivos en chats grupales](#envío-de-archivos-en-chats-grupales)). Las encuestas se envían vía Adaptive Cards.

## Plugin requerido

Microsoft Teams se distribuye como un plugin y no viene incluido con la instalación principal.

**Cambio disruptivo (2026.1.15):** MS Teams salió del núcleo. Si lo usas, debes instalar el plugin.

Explicación: mantiene instalaciones principales más ligeras y permite que las dependencias de MS Teams se actualicen independientemente.

Instalar vía CLI (registro npm):

```bash
openclaw plugins install @openclaw/msteams
```

Checkout local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/msteams
```

Si eliges Teams durante configure/onboarding y se detecta un checkout de git,
OpenClaw ofrecerá la ruta de instalación local automáticamente.

Detalles: [Plugins](/es-ES/tools/plugin)

## Configuración rápida (principiante)

1. Instala el plugin de Microsoft Teams.
2. Crea un **Bot de Azure** (App ID + secreto del cliente + ID del tenant).
3. Configura OpenClaw con esas credenciales.
4. Expón `/api/messages` (puerto 3978 por defecto) vía una URL pública o túnel.
5. Instala el paquete de la aplicación Teams e inicia el gateway.

Configuración mínima:

```json5
{
  channels: {
    msteams: {
      enabled: true,
      appId: "<APP_ID>",
      appPassword: "<APP_PASSWORD>",
      tenantId: "<TENANT_ID>",
      webhook: { port: 3978, path: "/api/messages" },
    },
  },
}
```

Nota: los chats grupales están bloqueados por defecto (`channels.msteams.groupPolicy: "allowlist"`). Para permitir respuestas en grupo, configura `channels.msteams.groupAllowFrom` (o usa `groupPolicy: "open"` para permitir cualquier miembro, con requisito de mención).

## Objetivos

- Hablar con OpenClaw vía DMs de Teams, chats grupales o canales.
- Mantener el enrutamiento determinista: las respuestas siempre vuelven al canal donde llegaron.
- Por defecto, comportamiento de canal seguro (menciones requeridas a menos que se configure de otro modo).

## Escritura de configuración

Por defecto, Microsoft Teams tiene permitido escribir actualizaciones de configuración activadas por `/config set|unset` (requiere `commands.config: true`).

Deshabilitar con:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Control de acceso (DMs + grupos)

**Acceso DM**

- Por defecto: `channels.msteams.dmPolicy = "pairing"`. Los remitentes desconocidos se ignoran hasta ser aprobados.
- `channels.msteams.allowFrom` acepta IDs de objetos AAD, UPNs o nombres para mostrar. El asistente resuelve nombres a IDs vía Microsoft Graph cuando las credenciales lo permiten.

**Acceso a grupos**

- Por defecto: `channels.msteams.groupPolicy = "allowlist"` (bloqueado a menos que añadas `groupAllowFrom`). Usa `channels.defaults.groupPolicy` para sobrescribir el valor por defecto cuando no esté configurado.
- `channels.msteams.groupAllowFrom` controla qué remitentes pueden activar en chats grupales/canales (recurre a `channels.msteams.allowFrom`).
- Configura `groupPolicy: "open"` para permitir cualquier miembro (aún con requisito de mención por defecto).
- Para no permitir **ningún canal**, configura `channels.msteams.groupPolicy: "disabled"`.

Ejemplo:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["usuario@org.com"],
    },
  },
}
```

**Lista blanca de equipos + canales**

- Delimita respuestas de grupo/canal listando equipos y canales bajo `channels.msteams.teams`.
- Las claves pueden ser IDs o nombres de equipo; las claves de canal pueden ser IDs de conversación o nombres.
- Cuando `groupPolicy="allowlist"` y hay una lista blanca de equipos presente, solo se aceptan equipos/canales listados (con requisito de mención).
- El asistente de configuración acepta entradas `Equipo/Canal` y las almacena por ti.
- Al inicio, OpenClaw resuelve nombres de equipos/canales y usuarios de listas blancas a IDs (cuando los permisos de Graph lo permiten)
  y registra el mapeo; las entradas no resueltas se mantienen como fueron escritas.

Ejemplo:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "Mi Equipo": {
          channels: {
            General: { requireMention: true },
          },
        },
      },
    },
  },
}
```

## Cómo funciona

1. Instala el plugin de Microsoft Teams.
2. Crea un **Bot de Azure** (App ID + secreto + ID de tenant).
3. Construye un **paquete de aplicación de Teams** que referencie el bot e incluya los permisos RSC abajo.
4. Sube/instala la aplicación de Teams en un equipo (o ámbito personal para DMs).
5. Configura `msteams` en `~/.openclaw/openclaw.json` (o variables de entorno) e inicia el gateway.
6. El gateway escucha tráfico webhook de Bot Framework en `/api/messages` por defecto.

## Configuración del Bot de Azure (Prerrequisitos)

Antes de configurar OpenClaw, necesitas crear un recurso de Bot de Azure.

### Paso 1: Crear Bot de Azure

1. Ve a [Crear Bot de Azure](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Completa la pestaña **Básico**:

   | Campo                | Valor                                                               |
   | -------------------- | ------------------------------------------------------------------- |
   | **Identificador**    | Nombre de tu bot, ej., `openclaw-msteams` (debe ser único)          |
   | **Suscripción**      | Selecciona tu suscripción de Azure                                  |
   | **Grupo de recursos**| Crear nuevo o usar existente                                        |
   | **Nivel de precios** | **Gratis** para desarrollo/pruebas                                  |
   | **Tipo de App**      | **Inquilino único** (recomendado - ver nota abajo)                  |
   | **Tipo de creación** | **Crear nuevo ID de aplicación de Microsoft**                       |

> **Aviso de desaprobación:** La creación de nuevos bots multi-inquilino fue desaprobada después del 2025-07-31. Usa **Inquilino único** para nuevos bots.

3. Haz clic en **Revisar + crear** → **Crear** (espera ~1-2 minutos)

### Paso 2: Obtener Credenciales

1. Ve a tu recurso de Bot de Azure → **Configuración**
2. Copia **ID de aplicación de Microsoft** → este es tu `appId`
3. Haz clic en **Administrar contraseña** → ve al Registro de aplicación
4. Bajo **Certificados y secretos** → **Nuevo secreto de cliente** → copia el **Valor** → este es tu `appPassword`
5. Ve a **Resumen** → copia **ID de directorio (tenant)** → este es tu `tenantId`

### Paso 3: Configurar Punto de Conexión de Mensajería

1. En Bot de Azure → **Configuración**
2. Configura **Punto de conexión de mensajería** a tu URL del webhook:
   - Producción: `https://tu-dominio.com/api/messages`
   - Desarrollo local: Usa un túnel (ver [Desarrollo Local](#desarrollo-local-túnel) abajo)

### Paso 4: Habilitar Canal de Teams

1. En Bot de Azure → **Canales**
2. Haz clic en **Microsoft Teams** → Configurar → Guardar
3. Acepta los Términos de Servicio

## Desarrollo Local (Túnel)

Teams no puede alcanzar `localhost`. Usa un túnel para desarrollo local:

**Opción A: ngrok**

```bash
ngrok http 3978
# Copia la URL https, ej., https://abc123.ngrok.io
# Configura el punto de conexión de mensajería a: https://abc123.ngrok.io/api/messages
```

**Opción B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Usa tu URL de funnel de Tailscale como punto de conexión de mensajería
```

## Portal de Desarrolladores de Teams (Alternativa)

En lugar de crear manualmente un ZIP de manifiesto, puedes usar el [Portal de Desarrolladores de Teams](https://dev.teams.microsoft.com/apps):

1. Haz clic en **+ Nueva aplicación**
2. Completa información básica (nombre, descripción, información del desarrollador)
3. Ve a **Características de aplicación** → **Bot**
4. Selecciona **Introducir un ID de bot manualmente** y pega tu ID de App del Bot de Azure
5. Marca ámbitos: **Personal**, **Equipo**, **Chat grupal**
6. Haz clic en **Distribuir** → **Descargar paquete de aplicación**
7. En Teams: **Aplicaciones** → **Administrar tus aplicaciones** → **Subir una aplicación personalizada** → selecciona el ZIP

Esto suele ser más fácil que editar manifiestos JSON a mano.

## Probar el Bot

**Opción A: Chat Web de Azure (verificar webhook primero)**

1. En Portal de Azure → tu recurso de Bot de Azure → **Probar en Chat Web**
2. Envía un mensaje - deberías ver una respuesta
3. Esto confirma que tu punto de conexión webhook funciona antes de configurar Teams

**Opción B: Teams (después de instalar la aplicación)**

1. Instala la aplicación de Teams (sideload o catálogo de org)
2. Encuentra el bot en Teams y envía un DM
3. Revisa los logs del gateway para actividad entrante

## Configuración (solo texto mínimo)

1. **Instalar el plugin de Microsoft Teams**
   - Desde npm: `openclaw plugins install @openclaw/msteams`
   - Desde un checkout local: `openclaw plugins install ./extensions/msteams`

2. **Registro del bot**
   - Crea un Bot de Azure (ver arriba) y anota:
     - App ID
     - Secreto del cliente (contraseña de la aplicación)
     - ID de Tenant (inquilino único)

3. **Manifiesto de aplicación de Teams**
   - Incluye una entrada `bot` con `botId = <App ID>`.
   - Ámbitos: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (requerido para manejo de archivos en ámbito personal).
   - Añade permisos RSC (abajo).
   - Crea iconos: `outline.png` (32x32) y `color.png` (192x192).
   - Comprime los tres archivos juntos: `manifest.json`, `outline.png`, `color.png`.

4. **Configurar OpenClaw**

   ```json
   {
     "msteams": {
       "enabled": true,
       "appId": "<APP_ID>",
       "appPassword": "<APP_PASSWORD>",
       "tenantId": "<TENANT_ID>",
       "webhook": { "port": 3978, "path": "/api/messages" }
     }
   }
   ```

   También puedes usar variables de entorno en lugar de claves de configuración:
   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Punto de conexión del bot**
   - Configura el Punto de conexión de mensajería del Bot de Azure a:
     - `https://<host>:3978/api/messages` (o tu ruta/puerto elegido).

6. **Ejecutar el gateway**
   - El canal de Teams se inicia automáticamente cuando el plugin está instalado y existe configuración `msteams` con credenciales.

## Contexto del historial

- `channels.msteams.historyLimit` controla cuántos mensajes recientes de canal/grupo se envuelven en el prompt.
- Recurre a `messages.groupChat.historyLimit`. Configura `0` para deshabilitar (por defecto 50).
- El historial de DM puede limitarse con `channels.msteams.dmHistoryLimit` (turnos de usuario). Sobrescrituras por usuario: `channels.msteams.dms["<user_id>"].historyLimit`.

## Permisos RSC Actuales de Teams (Manifiesto)

Estos son los **permisos resourceSpecific existentes** en nuestro manifiesto de aplicación de Teams. Solo aplican dentro del equipo/chat donde la aplicación está instalada.

**Para canales (ámbito de equipo):**

- `ChannelMessage.Read.Group` (Application) - recibir todos los mensajes de canal sin @mención
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Para chats grupales:**

- `ChatMessage.Read.Chat` (Application) - recibir todos los mensajes de chat grupal sin @mención

## Ejemplo de Manifiesto de Teams (redactado)

Ejemplo mínimo y válido con los campos requeridos. Reemplaza IDs y URLs.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Tu Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw en Teams", "full": "OpenClaw en Teams" },
  "icons": { "outline": "outline.png", "color": "color.png" },
  "accentColor": "#5B6DEF",
  "bots": [
    {
      "botId": "11111111-1111-1111-1111-111111111111",
      "scopes": ["personal", "team", "groupChat"],
      "isNotificationOnly": false,
      "supportsCalling": false,
      "supportsVideo": false,
      "supportsFiles": true
    }
  ],
  "webApplicationInfo": {
    "id": "11111111-1111-1111-1111-111111111111"
  },
  "authorization": {
    "permissions": {
      "resourceSpecific": [
        { "name": "ChannelMessage.Read.Group", "type": "Application" },
        { "name": "ChannelMessage.Send.Group", "type": "Application" },
        { "name": "Member.Read.Group", "type": "Application" },
        { "name": "Owner.Read.Group", "type": "Application" },
        { "name": "ChannelSettings.Read.Group", "type": "Application" },
        { "name": "TeamMember.Read.Group", "type": "Application" },
        { "name": "TeamSettings.Read.Group", "type": "Application" },
        { "name": "ChatMessage.Read.Chat", "type": "Application" }
      ]
    }
  }
}
```

### Advertencias del manifiesto (campos imprescindibles)

- `bots[].botId` **debe** coincidir con el ID de App del Bot de Azure.
- `webApplicationInfo.id` **debe** coincidir con el ID de App del Bot de Azure.
- `bots[].scopes` debe incluir las superficies que planeas usar (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` es requerido para manejo de archivos en ámbito personal.
- `authorization.permissions.resourceSpecific` debe incluir lectura/envío de canal si quieres tráfico de canal.

### Actualizar una aplicación existente

Para actualizar una aplicación de Teams ya instalada (ej., para añadir permisos RSC):

1. Actualiza tu `manifest.json` con las nuevas configuraciones
2. **Incrementa el campo `version`** (ej., `1.0.0` → `1.1.0`)
3. **Vuelve a comprimir** el manifiesto con iconos (`manifest.json`, `outline.png`, `color.png`)
4. Sube el nuevo zip:
   - **Opción A (Centro de Admin de Teams):** Centro de Admin de Teams → Aplicaciones de Teams → Administrar aplicaciones → encuentra tu aplicación → Subir nueva versión
   - **Opción B (Sideload):** En Teams → Aplicaciones → Administrar tus aplicaciones → Subir una aplicación personalizada
5. **Para canales de equipo:** Reinstala la aplicación en cada equipo para que los nuevos permisos tengan efecto
6. **Cierra completamente y reinicia Teams** (no solo cerrar la ventana) para limpiar metadatos de aplicación en caché

## Capacidades: Solo RSC vs Graph

### Con **solo Teams RSC** (aplicación instalada, sin permisos de API de Graph)

Funciona:

- Leer contenido de **texto** de mensajes de canal.
- Enviar contenido de **texto** de mensajes de canal.
- Recibir adjuntos de archivos **personales (DM)**.

NO funciona:

- **Contenidos de imágenes o archivos** de canal/grupo (payload solo incluye stub HTML).
- Descargar adjuntos almacenados en SharePoint/OneDrive.
- Leer historial de mensajes (más allá del evento webhook en vivo).

### Con **Teams RSC + permisos de Aplicación de Microsoft Graph**

Añade:

- Descargar contenidos hospedados (imágenes pegadas en mensajes).
- Descargar adjuntos de archivos almacenados en SharePoint/OneDrive.
- Leer historial de mensajes de canal/chat vía Graph.

### RSC vs API de Graph

| Capacidad                | Permisos RSC         | API de Graph                           |
| ------------------------ | -------------------- | -------------------------------------- |
| **Mensajes en tiempo real** | Sí (vía webhook)     | No (solo sondeo)                       |
| **Mensajes históricos** | No                   | Sí (puede consultar historial)         |
| **Complejidad de configuración** | Solo manifiesto de app | Requiere consentimiento admin + flujo token |
| **Funciona offline**     | No (debe estar ejecutándose) | Sí (consulta en cualquier momento)     |

**Conclusión:** RSC es para escucha en tiempo real; la API de Graph es para acceso histórico. Para ponerse al día con mensajes perdidos mientras estaba offline, necesitas API de Graph con `ChannelMessage.Read.All` (requiere consentimiento admin).

## Medios + historial habilitados con Graph (requerido para canales)

Si necesitas imágenes/archivos en **canales** o quieres obtener **historial de mensajes**, debes habilitar permisos de Microsoft Graph y otorgar consentimiento admin.

1. En Entra ID (Azure AD) **Registro de Aplicación**, añade permisos de **Aplicación** de Microsoft Graph:
   - `ChannelMessage.Read.All` (adjuntos de canal + historial)
   - `Chat.Read.All` o `ChatMessage.Read.All` (chats grupales)
2. **Otorga consentimiento admin** para el tenant.
3. Incrementa la **versión del manifiesto** de la aplicación de Teams, vuelve a subir y **reinstala la aplicación en Teams**.
4. **Cierra completamente y reinicia Teams** para limpiar metadatos de aplicación en caché.

**Permiso adicional para menciones de usuario:** Las @menciones de usuario funcionan inmediatamente para usuarios en la conversación. Sin embargo, si quieres buscar y mencionar dinámicamente usuarios que **no están en la conversación actual**, añade permiso `User.Read.All` (Application) y otorga consentimiento admin.

## Limitaciones Conocidas

### Tiempos de espera del webhook

Teams entrega mensajes vía webhook HTTP. Si el procesamiento tarda demasiado (ej., respuestas lentas de LLM), podrías ver:

- Tiempos de espera del gateway
- Teams reintentando el mensaje (causando duplicados)
- Respuestas perdidas

OpenClaw maneja esto devolviendo rápidamente y enviando respuestas proactivamente, pero respuestas muy lentas aún pueden causar problemas.

### Formato

El markdown de Teams es más limitado que Slack o Discord:

- El formato básico funciona: **negrita**, _cursiva_, `código`, enlaces
- Markdown complejo (tablas, listas anidadas) puede no renderizarse correctamente
- Las Adaptive Cards son soportadas para encuestas y envíos de tarjetas arbitrarias (ver abajo)

## Configuración

Configuraciones clave (ver `/gateway/configuration` para patrones de canal compartidos):

- `channels.msteams.enabled`: habilitar/deshabilitar el canal.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: credenciales del bot.
- `channels.msteams.webhook.port` (por defecto `3978`)
- `channels.msteams.webhook.path` (por defecto `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (por defecto: pairing)
- `channels.msteams.allowFrom`: lista blanca para DMs (IDs de objetos AAD, UPNs o nombres para mostrar). El asistente resuelve nombres a IDs durante la configuración cuando el acceso a Graph está disponible.
- `channels.msteams.textChunkLimit`: tamaño de fragmento de texto saliente.
- `channels.msteams.chunkMode`: `length` (por defecto) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de fragmentación por longitud.
- `channels.msteams.mediaAllowHosts`: lista blanca para hosts de adjuntos entrantes (por defecto dominios de Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: lista blanca para adjuntar encabezados de Authorization en reintentos de medios (por defecto hosts de Graph + Bot Framework).
- `channels.msteams.requireMention`: requiere @mención en canales/grupos (por defecto true).
- `channels.msteams.replyStyle`: `thread | top-level` (ver [Estilo de Respuesta](#estilo-de-respuesta-hilos-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: sobrescritura por equipo.
- `channels.msteams.teams.<teamId>.requireMention`: sobrescritura por equipo.
- `channels.msteams.teams.<teamId>.tools`: sobrescrituras de política de herramientas por equipo por defecto (`allow`/`deny`/`alsoAllow`) usadas cuando falta sobrescritura de canal.
- `channels.msteams.teams.<teamId>.toolsBySender`: sobrescrituras de política de herramientas por equipo por remitente por defecto (comodín `"*"` soportado).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: sobrescritura por canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: sobrescritura por canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: sobrescrituras de política de herramientas por canal (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: sobrescrituras de política de herramientas por canal por remitente (comodín `"*"` soportado).
- `channels.msteams.sharePointSiteId`: ID de sitio de SharePoint para subidas de archivos en chats grupales/canales (ver [Envío de archivos en chats grupales](#envío-de-archivos-en-chats-grupales)).

## Enrutamiento y Sesiones

- Las claves de sesión siguen el formato estándar de agente (ver [/concepts/session](/es-ES/concepts/session)):
  - Los mensajes directos comparten la sesión principal (`agent:<agentId>:<mainKey>`).
  - Los mensajes de canal/grupo usan el id de conversación:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Estilo de Respuesta: Hilos vs Posts

Teams introdujo recientemente dos estilos de UI de canal sobre el mismo modelo de datos subyacente:

| Estilo                   | Descripción                                                    | `replyStyle` recomendado |
| ------------------------ | -------------------------------------------------------------- | ------------------------ |
| **Posts** (clásico)      | Los mensajes aparecen como tarjetas con respuestas en hilo debajo | `thread` (por defecto)   |
| **Threads** (tipo Slack) | Los mensajes fluyen linealmente, más como Slack                | `top-level`              |

**El problema:** La API de Teams no expone qué estilo de UI usa un canal. Si usas el `replyStyle` incorrecto:

- `thread` en un canal estilo Threads → las respuestas aparecen anidadas de forma incómoda
- `top-level` en un canal estilo Posts → las respuestas aparecen como posts de nivel superior separados en lugar de en hilo

**Solución:** Configura `replyStyle` por canal según cómo esté configurado el canal:

```json
{
  "msteams": {
    "replyStyle": "thread",
    "teams": {
      "19:abc...@thread.tacv2": {
        "channels": {
          "19:xyz...@thread.tacv2": {
            "replyStyle": "top-level"
          }
        }
      }
    }
  }
}
```

## Adjuntos e Imágenes

**Limitaciones actuales:**

- **DMs:** Imágenes y adjuntos de archivos funcionan vía APIs de archivos de bot de Teams.
- **Canales/grupos:** Los adjuntos viven en almacenamiento M365 (SharePoint/OneDrive). El payload del webhook solo incluye un stub HTML, no los bytes reales del archivo. **Se requieren permisos de API de Graph** para descargar adjuntos de canal.

Sin permisos de Graph, los mensajes de canal con imágenes se recibirán como solo texto (el contenido de imagen no es accesible para el bot).
Por defecto, OpenClaw solo descarga medios de hostnames de Microsoft/Teams. Sobrescribe con `channels.msteams.mediaAllowHosts` (usa `["*"]` para permitir cualquier host).
Los encabezados de autorización solo se adjuntan para hosts en `channels.msteams.mediaAuthAllowHosts` (por defecto hosts de Graph + Bot Framework). Mantén esta lista estricta (evita sufijos multi-inquilino).

## Envío de archivos en chats grupales

Los bots pueden enviar archivos en DMs usando el flujo FileConsentCard (incorporado). Sin embargo, **enviar archivos en chats grupales/canales** requiere configuración adicional:

| Contexto                 | Cómo se envían archivos                       | Configuración necesaria                           |
| ------------------------ | --------------------------------------------- | ------------------------------------------------- |
| **DMs**                  | FileConsentCard → usuario acepta → bot sube   | Funciona inmediatamente                           |
| **Chats grupales/canales** | Subir a SharePoint → compartir enlace       | Requiere `sharePointSiteId` + permisos de Graph   |
| **Imágenes (cualquier contexto)** | Codificadas en base64 inline           | Funciona inmediatamente                           |

### Por qué los chats grupales necesitan SharePoint

Los bots no tienen una unidad personal de OneDrive (el endpoint `/me/drive` de API de Graph no funciona para identidades de aplicación). Para enviar archivos en chats grupales/canales, el bot sube a un **sitio de SharePoint** y crea un enlace para compartir.

### Configuración

1. **Añadir permisos de API de Graph** en Entra ID (Azure AD) → Registro de Aplicación:
   - `Sites.ReadWrite.All` (Application) - subir archivos a SharePoint
   - `Chat.Read.All` (Application) - opcional, habilita enlaces para compartir por usuario

2. **Otorgar consentimiento admin** para el tenant.

3. **Obtener tu ID de sitio de SharePoint:**

   ```bash
   # Vía Graph Explorer o curl con un token válido:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Ejemplo: para un sitio en "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # La respuesta incluye: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configurar OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... otra configuración ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Comportamiento de compartir

| Permiso                              | Comportamiento de compartir                                    |
| ------------------------------------ | -------------------------------------------------------------- |
| Solo `Sites.ReadWrite.All`           | Enlace para compartir a nivel de organización (cualquiera en la org puede acceder) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Enlace para compartir por usuario (solo miembros del chat pueden acceder) |

Compartir por usuario es más seguro ya que solo los participantes del chat pueden acceder al archivo. Si falta el permiso `Chat.Read.All`, el bot recurre a compartir a nivel de organización.

### Comportamiento de respaldo

| Escenario                                          | Resultado                                                |
| -------------------------------------------------- | -------------------------------------------------------- |
| Chat grupal + archivo + `sharePointSiteId` configurado | Subir a SharePoint, enviar enlace para compartir         |
| Chat grupal + archivo + sin `sharePointSiteId`     | Intentar subida a OneDrive (puede fallar), enviar solo texto |
| Chat personal + archivo                            | Flujo FileConsentCard (funciona sin SharePoint)          |
| Cualquier contexto + imagen                        | Codificada en base64 inline (funciona sin SharePoint)    |

### Ubicación de archivos almacenados

Los archivos subidos se almacenan en una carpeta `/OpenClawShared/` en la biblioteca de documentos por defecto del sitio de SharePoint configurado.

## Encuestas (Adaptive Cards)

OpenClaw envía encuestas de Teams como Adaptive Cards (no hay API nativa de encuestas de Teams).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Los votos son registrados por el gateway en `~/.openclaw/msteams-polls.json`.
- El gateway debe permanecer en línea para registrar votos.
- Las encuestas aún no publican resúmenes de resultados automáticamente (inspecciona el archivo de almacenamiento si es necesario).

## Adaptive Cards (arbitrarias)

Envía cualquier JSON de Adaptive Card a usuarios o conversaciones de Teams usando la herramienta `message` o CLI.

El parámetro `card` acepta un objeto JSON de Adaptive Card. Cuando se proporciona `card`, el texto del mensaje es opcional.

**Herramienta de agente:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "¡Hola!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"¡Hola!"}]}'
```

Ver [documentación de Adaptive Cards](https://adaptivecards.io/) para esquema de tarjeta y ejemplos. Para detalles de formato de destino, ver [Formatos de destino](#formatos-de-destino) abajo.

## Formatos de destino

Los destinos de MSTeams usan prefijos para distinguir entre usuarios y conversaciones:

| Tipo de destino         | Formato                          | Ejemplo                                             |
| ----------------------- | -------------------------------- | --------------------------------------------------- |
| Usuario (por ID)        | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`         |
| Usuario (por nombre)    | `user:<display-name>`            | `user:John Smith` (requiere API de Graph)           |
| Grupo/canal             | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`            |
| Grupo/canal (raw)       | `<conversation-id>`              | `19:abc123...@thread.tacv2` (si contiene `@thread`) |

**Ejemplos de CLI:**

```bash
# Enviar a un usuario por ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hola"

# Enviar a un usuario por nombre para mostrar (activa búsqueda de API de Graph)
openclaw message send --channel msteams --target "user:John Smith" --message "Hola"

# Enviar a un chat grupal o canal
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hola"

# Enviar una Adaptive Card a una conversación
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hola"}]}'
```

**Ejemplos de herramienta de agente:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "¡Hola!"
}
```

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "conversation:19:abc...@thread.tacv2",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hola" }]
  }
}
```

Nota: Sin el prefijo `user:`, los nombres por defecto resuelven a grupo/equipo. Siempre usa `user:` cuando apuntes a personas por nombre para mostrar.

## Mensajería proactiva

- Los mensajes proactivos solo son posibles **después** de que un usuario haya interactuado, porque almacenamos referencias de conversación en ese punto.
- Ver `/gateway/configuration` para gating de `dmPolicy` y lista blanca.

## IDs de Equipo y Canal (Trampa Común)

El parámetro de consulta `groupId` en las URLs de Teams **NO** es el ID de equipo usado para configuración. Extrae IDs de la ruta de URL en su lugar:

**URL de Equipo:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    ID de Equipo (decodifica esta URL)
```

**URL de Canal:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                       └─────────────────────────┘
                                       ID de Canal (decodifica esta URL)
```

**Para configuración:**

- ID de Equipo = segmento de ruta después de `/team/` (decodificado de URL, ej., `19:Bk4j...@thread.tacv2`)
- ID de Canal = segmento de ruta después de `/channel/` (decodificado de URL)
- **Ignora** el parámetro de consulta `groupId`

## Canales Privados

Los bots tienen soporte limitado en canales privados:

| Característica                | Canales Estándar | Canales Privados       |
| ----------------------------- | ---------------- | ---------------------- |
| Instalación de bot            | Sí               | Limitado               |
| Mensajes en tiempo real (webhook) | Sí           | Puede no funcionar     |
| Permisos RSC                  | Sí               | Puede comportarse diferente |
| @menciones                    | Sí               | Si el bot es accesible |
| Historial de API de Graph     | Sí               | Sí (con permisos)      |

**Soluciones alternativas si los canales privados no funcionan:**

1. Usa canales estándar para interacciones con bot
2. Usa DMs - los usuarios siempre pueden enviar mensajes al bot directamente
3. Usa API de Graph para acceso histórico (requiere `ChannelMessage.Read.All`)

## Solución de Problemas

### Problemas comunes

- **Las imágenes no se muestran en canales:** Permisos de Graph o consentimiento admin faltante. Reinstala la aplicación de Teams y cierra/reabre Teams completamente.
- **Sin respuestas en canal:** las menciones son requeridas por defecto; configura `channels.msteams.requireMention=false` o configura por equipo/canal.
- **Desajuste de versión (Teams aún muestra manifiesto antiguo):** remueve + vuelve a añadir la aplicación y cierra Teams completamente para refrescar.
- **401 Unauthorized del webhook:** Esperado cuando se prueba manualmente sin JWT de Azure - significa que el endpoint es alcanzable pero falló la autenticación. Usa Chat Web de Azure para probar apropiadamente.

### Errores de subida de manifiesto

- **"El archivo de icono no puede estar vacío":** El manifiesto referencia archivos de icono que son de 0 bytes. Crea iconos PNG válidos (32x32 para `outline.png`, 192x192 para `color.png`).
- **"webApplicationInfo.Id ya en uso":** La aplicación aún está instalada en otro equipo/chat. Encuentra y desinstálala primero, o espera 5-10 minutos para propagación.
- **"Algo salió mal" en subida:** Sube vía [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) en su lugar, abre DevTools del navegador (F12) → pestaña Red, y verifica el cuerpo de respuesta para el error real.
- **Sideload fallando:** Intenta "Subir una aplicación al catálogo de aplicaciones de tu org" en lugar de "Subir una aplicación personalizada" - esto suele eludir restricciones de sideload.

### Permisos RSC no funcionando

1. Verifica que `webApplicationInfo.id` coincida exactamente con tu ID de App del bot
2. Vuelve a subir la aplicación y reinstala en el equipo/chat
3. Verifica si tu administrador de org ha bloqueado permisos RSC
4. Confirma que estás usando el ámbito correcto: `ChannelMessage.Read.Group` para equipos, `ChatMessage.Read.Chat` para chats grupales

## Referencias

- [Crear Bot de Azure](https://learn.microsoft.com/es-es/azure/bot-service/bot-service-quickstart-registration) - guía de configuración de Bot de Azure
- [Portal de Desarrolladores de Teams](https://dev.teams.microsoft.com/apps) - crear/administrar aplicaciones de Teams
- [Esquema de manifiesto de aplicación de Teams](https://learn.microsoft.com/es-es/microsoftteams/platform/resources/schema/manifest-schema)
- [Recibir mensajes de canal con RSC](https://learn.microsoft.com/es-es/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [Referencia de permisos RSC](https://learn.microsoft.com/es-es/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Manejo de archivos de bot de Teams](https://learn.microsoft.com/es-es/microsoftteams/platform/bots/how-to/bots-filesv4) (canal/grupo requiere Graph)
- [Mensajería proactiva](https://learn.microsoft.com/es-es/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
