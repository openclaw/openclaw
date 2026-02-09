---
summary: "Estado de soporte del bot de Microsoft Teams, capacidades y configuración"
read_when:
  - Trabajando en funciones del canal de MS Teams
title: "Microsoft Teams"
---

# Microsoft Teams (plugin)

> "Abandonen toda esperanza quienes entren aquí."

Actualizado: 2026-01-21

Estado: se admiten texto + archivos adjuntos en mensajes directos; el envío de archivos en canales/grupos requiere `sharePointSiteId` + permisos de Graph (consulte [Envío de archivos en chats grupales](#sending-files-in-group-chats)). Las encuestas se envían mediante Adaptive Cards.

## Plugin requerido

Microsoft Teams se distribuye como un plugin y no viene incluido con la instalación principal.

**Cambio disruptivo (2026.1.15):** MS Teams salió del núcleo. Si lo usa, debe instalar el plugin.

Explicación: mantiene las instalaciones del núcleo más ligeras y permite que las dependencias de MS Teams se actualicen de forma independiente.

Instalar vía CLI (registro npm):

```bash
openclaw plugins install @openclaw/msteams
```

Instalación local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/msteams
```

Si elige Teams durante la configuración/onboarding y se detecta un checkout de git,
OpenClaw ofrecerá automáticamente la ruta de instalación local.

Detalles: [Plugins](/tools/plugin)

## Configuración rápida (principiante)

1. Instale el plugin de Microsoft Teams.
2. Cree un **Azure Bot** (App ID + secreto del cliente + ID de tenant).
3. Configure OpenClaw con esas credenciales.
4. Exponga `/api/messages` (puerto 3978 por defecto) mediante una URL pública o un túnel.
5. Instale el paquete de la app de Teams e inicie el gateway.

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

Nota: los chats grupales están bloqueados por defecto (`channels.msteams.groupPolicy: "allowlist"`). Para permitir respuestas en grupos, configure `channels.msteams.groupAllowFrom` (o use `groupPolicy: "open"` para permitir a cualquier miembro, con mención obligatoria).

## Objetivos

- Comunicarse con OpenClaw mediante mensajes directos de Teams, chats grupales o canales.
- Mantener un enrutamiento determinista: las respuestas siempre vuelven al canal por el que llegaron.
- Usar por defecto un comportamiento seguro del canal (menciones requeridas salvo que se configure lo contrario).

## Escrituras de configuración

De forma predeterminada, Microsoft Teams puede escribir actualizaciones de configuración activadas por `/config set|unset` (requiere `commands.config: true`).

Deshabilitar con:

```json5
{
  channels: { msteams: { configWrites: false } },
}
```

## Control de acceso (mensajes directos + grupos)

**Acceso a mensajes directos**

- Predeterminado: `channels.msteams.dmPolicy = "pairing"`. Los remitentes desconocidos se ignoran hasta ser aprobados.
- `channels.msteams.allowFrom` acepta IDs de objetos AAD, UPNs o nombres para mostrar. El asistente resuelve nombres a IDs mediante Microsoft Graph cuando las credenciales lo permiten.

**Acceso a grupos**

- Predeterminado: `channels.msteams.groupPolicy = "allowlist"` (bloqueado a menos que agregue `groupAllowFrom`). Use `channels.defaults.groupPolicy` para anular el valor predeterminado cuando no esté configurado.
- `channels.msteams.groupAllowFrom` controla qué remitentes pueden activar en chats/canales grupales (usa como respaldo `channels.msteams.allowFrom`).
- Configure `groupPolicy: "open"` para permitir a cualquier miembro (aún con mención obligatoria por defecto).
- Para permitir **ningún canal**, configure `channels.msteams.groupPolicy: "disabled"`.

Ejemplo:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
  },
}
```

**Teams + lista de permitidos de canales**

- Limite respuestas por grupo/canal listando equipos y canales bajo `channels.msteams.teams`.
- Las claves pueden ser IDs o nombres de equipos; las claves de canal pueden ser IDs de conversación o nombres.
- Cuando `groupPolicy="allowlist"` y existe una lista de permitidos de equipos, solo se aceptan los equipos/canales listados (con mención obligatoria).
- El asistente de configuración acepta entradas `Team/Channel` y las almacena por usted.
- Al iniciar, OpenClaw resuelve nombres de equipos/canales y listas de permitidos de usuarios a IDs (cuando los permisos de Graph lo permiten)
  y registra el mapeo; las entradas no resueltas se conservan tal como se escribieron.

Ejemplo:

```json5
{
  channels: {
    msteams: {
      groupPolicy: "allowlist",
      teams: {
        "My Team": {
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

1. Instale el plugin de Microsoft Teams.
2. Cree un **Azure Bot** (App ID + secreto + ID de tenant).
3. Cree un **paquete de app de Teams** que haga referencia al bot e incluya los permisos RSC a continuación.
4. Cargue/instale la app de Teams en un equipo (o en ámbito personal para mensajes directos).
5. Configure `msteams` en `~/.openclaw/openclaw.json` (o variables de entorno) e inicie el gateway.
6. El gateway escucha tráfico de webhook de Bot Framework en `/api/messages` por defecto.

## Configuración del Azure Bot (Requisitos previos)

Antes de configurar OpenClaw, debe crear un recurso de Azure Bot.

### Paso 1: Crear Azure Bot

1. Vaya a [Crear Azure Bot](https://portal.azure.com/#create/Microsoft.AzureBot)
2. Complete la pestaña **Basics**:

   | Campo              | Valor                                                                                                            |
   | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
   | **Bot handle**     | Nombre de su bot, p. ej., `openclaw-msteams` (debe ser único) |
   | **Subscription**   | Seleccione su suscripción de Azure                                                                               |
   | **Resource group** | Cree uno nuevo o use uno existente                                                                               |
   | **Pricing tier**   | **Free** para dev/pruebas                                                                                        |
   | **Type of App**    | **Single Tenant** (recomendado; ver nota abajo)                                               |
   | **Creation type**  | **Create new Microsoft App ID**                                                                                  |

> **Aviso de deprecación:** La creación de nuevos bots multi-tenant se deprecó después del 2025-07-31. Use **Single Tenant** para nuevos bots.

3. Haga clic en **Review + create** → **Create** (espere ~1-2 minutos)

### Paso 2: Obtener credenciales

1. Vaya a su recurso de Azure Bot → **Configuration**
2. Copie **Microsoft App ID** → este es su `appId`
3. Haga clic en **Manage Password** → vaya al App Registration
4. En **Certificates & secrets** → **New client secret** → copie el **Value** → este es su `appPassword`
5. Vaya a **Overview** → copie **Directory (tenant) ID** → este es su `tenantId`

### Paso 3: Configurar el endpoint de mensajería

1. En Azure Bot → **Configuration**
2. Establezca **Messaging endpoint** en la URL de su webhook:
   - Producción: `https://your-domain.com/api/messages`
   - Desarrollo local: use un túnel (consulte [Desarrollo local](#local-development-tunneling) abajo)

### Paso 4: Habilitar el canal de Teams

1. En Azure Bot → **Channels**
2. Haga clic en **Microsoft Teams** → Configure → Save
3. Acepte los Términos del servicio

## Desarrollo local (túneles)

Teams no puede alcanzar `localhost`. Use un túnel para desarrollo local:

**Opción A: ngrok**

```bash
ngrok http 3978
# Copy the https URL, e.g., https://abc123.ngrok.io
# Set messaging endpoint to: https://abc123.ngrok.io/api/messages
```

**Opción B: Tailscale Funnel**

```bash
tailscale funnel 3978
# Use your Tailscale funnel URL as the messaging endpoint
```

## Portal para desarrolladores de Teams (alternativa)

En lugar de crear manualmente un ZIP de manifiesto, puede usar el [Portal para desarrolladores de Teams](https://dev.teams.microsoft.com/apps):

1. Haga clic en **+ New app**
2. Complete la información básica (nombre, descripción, info del desarrollador)
3. Vaya a **App features** → **Bot**
4. Seleccione **Enter a bot ID manually** y pegue el App ID de su Azure Bot
5. Marque los ámbitos: **Personal**, **Team**, **Group Chat**
6. Haga clic en **Distribute** → **Download app package**
7. En Teams: **Apps** → **Manage your apps** → **Upload a custom app** → seleccione el ZIP

Suele ser más fácil que editar manifiestos JSON a mano.

## Prueba del bot

**Opción A: Azure Web Chat (verifique primero el webhook)**

1. En Azure Portal → su recurso de Azure Bot → **Test in Web Chat**
2. Envíe un mensaje: debería ver una respuesta
3. Esto confirma que su endpoint de webhook funciona antes de configurar Teams

**Opción B: Teams (después de instalar la app)**

1. Instale la app de Teams (sideload o catálogo de la organización)
2. Busque el bot en Teams y envíe un mensaje directo
3. Revise los logs del gateway para actividad entrante

## Configuración (mínima solo texto)

1. **Instale el plugin de Microsoft Teams**
   - Desde npm: `openclaw plugins install @openclaw/msteams`
   - Desde un checkout local: `openclaw plugins install ./extensions/msteams`

2. **Registro del bot**
   - Cree un Azure Bot (ver arriba) y anote:
     - App ID
     - Secreto del cliente (contraseña de la app)
     - Tenant ID (single-tenant)

3. **Manifiesto de la app de Teams**
   - Incluya una entrada `bot` con `botId = <App ID>`.
   - Ámbitos: `personal`, `team`, `groupChat`.
   - `supportsFiles: true` (requerido para manejo de archivos en ámbito personal).
   - Agregue permisos RSC (abajo).
   - Cree íconos: `outline.png` (32x32) y `color.png` (192x192).
   - Comprima los tres archivos juntos: `manifest.json`, `outline.png`, `color.png`.

4. **Configure OpenClaw**

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

   También puede usar variables de entorno en lugar de claves de configuración:

   - `MSTEAMS_APP_ID`
   - `MSTEAMS_APP_PASSWORD`
   - `MSTEAMS_TENANT_ID`

5. **Endpoint del bot**
   - Establezca el Messaging Endpoint del Azure Bot en:
     - `https://<host>:3978/api/messages` (o su ruta/puerto elegido).

6. **Ejecute el gateway**
   - El canal de Teams se inicia automáticamente cuando el plugin está instalado y existe la configuración `msteams` con credenciales.

## Contexto de historial

- `channels.msteams.historyLimit` controla cuántos mensajes recientes de canal/grupo se envuelven en el prompt.
- Usa como respaldo `messages.groupChat.historyLimit`. Configure `0` para deshabilitar (predeterminado 50).
- El historial de mensajes directos puede limitarse con `channels.msteams.dmHistoryLimit` (turnos por usuario). Anulaciones por usuario: `channels.msteams.dms["<user_id>"].historyLimit`.

## Permisos RSC actuales de Teams (manifiesto)

Estos son los **resourceSpecific permissions** existentes en nuestro manifiesto de la app de Teams. Solo aplican dentro del equipo/chat donde está instalada la app.

**Para canales (ámbito de equipo):**

- `ChannelMessage.Read.Group` (Application) - recibir todos los mensajes del canal sin @mention
- `ChannelMessage.Send.Group` (Application)
- `Member.Read.Group` (Application)
- `Owner.Read.Group` (Application)
- `ChannelSettings.Read.Group` (Application)
- `TeamMember.Read.Group` (Application)
- `TeamSettings.Read.Group` (Application)

**Para chats grupales:**

- `ChatMessage.Read.Chat` (Application) - recibir todos los mensajes del chat grupal sin @mention

## Ejemplo de manifiesto de Teams (redactado)

Ejemplo mínimo y válido con los campos requeridos. Reemplace IDs y URLs.

```json
{
  "$schema": "https://developer.microsoft.com/en-us/json-schemas/teams/v1.23/MicrosoftTeams.schema.json",
  "manifestVersion": "1.23",
  "version": "1.0.0",
  "id": "00000000-0000-0000-0000-000000000000",
  "name": { "short": "OpenClaw" },
  "developer": {
    "name": "Your Org",
    "websiteUrl": "https://example.com",
    "privacyUrl": "https://example.com/privacy",
    "termsOfUseUrl": "https://example.com/terms"
  },
  "description": { "short": "OpenClaw in Teams", "full": "OpenClaw in Teams" },
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

- `bots[].botId` **debe** coincidir con el App ID del Azure Bot.
- `webApplicationInfo.id` **debe** coincidir con el App ID del Azure Bot.
- `bots[].scopes` debe incluir las superficies que planea usar (`personal`, `team`, `groupChat`).
- `bots[].supportsFiles: true` es requerido para manejo de archivos en ámbito personal.
- `authorization.permissions.resourceSpecific` debe incluir lectura/envío de canales si desea tráfico de canales.

### Actualizar una app existente

Para actualizar una app de Teams ya instalada (p. ej., para agregar permisos RSC):

1. Actualice su `manifest.json` con la nueva configuración
2. **Incremente el campo `version`** (p. ej., `1.0.0` → `1.1.0`)
3. **Vuelva a comprimir** el manifiesto con los íconos (`manifest.json`, `outline.png`, `color.png`)
4. Cargue el nuevo zip:
   - **Opción A (Teams Admin Center):** Teams Admin Center → Teams apps → Manage apps → busque su app → Upload new version
   - **Opción B (Sideload):** En Teams → Apps → Manage your apps → Upload a custom app
5. **Para canales de equipo:** Reinstale la app en cada equipo para que los nuevos permisos surtan efecto
6. **Cierre completamente y vuelva a abrir Teams** (no solo cerrar la ventana) para limpiar la caché de metadatos de la app

## Capacidades: solo RSC vs Graph

### Con **solo Teams RSC** (app instalada, sin permisos de Graph API)

Funciona:

- Leer contenido **de texto** de mensajes de canal.
- Enviar contenido **de texto** de mensajes de canal.
- Recibir archivos adjuntos **personales (DM)**.

No funciona:

- Contenido de **imágenes o archivos** en canales/grupos (la carga solo incluye un stub HTML).
- Descargar adjuntos almacenados en SharePoint/OneDrive.
- Leer historial de mensajes (más allá del evento de webhook en vivo).

### Con **Teams RSC + permisos de aplicación de Microsoft Graph**

Agrega:

- Descarga de contenidos alojados (imágenes pegadas en mensajes).
- Descarga de archivos adjuntos almacenados en SharePoint/OneDrive.
- Lectura del historial de mensajes de canal/chat vía Graph.

### RSC vs Graph API

| Capacidad                        | Permisos RSC                                    | Graph API                                              |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| **Mensajes en tiempo real**      | Sí (vía webhook)             | No (solo sondeo)                    |
| **Mensajes históricos**          | No                                              | Sí (se puede consultar historial)   |
| **Complejidad de configuración** | Solo manifiesto de la app                       | Requiere consentimiento de admin + flujo de tokens     |
| **Funciona sin conexión**        | No (debe estar en ejecución) | Sí (consultar en cualquier momento) |

**Conclusión:** RSC es para escucha en tiempo real; Graph API es para acceso histórico. Para ponerse al día con mensajes perdidos mientras estaba offline, necesita Graph API con `ChannelMessage.Read.All` (requiere consentimiento de administrador).

## Medios + historial habilitados con Graph (requerido para canales)

Si necesita imágenes/archivos en **canales** o desea obtener **historial de mensajes**, debe habilitar permisos de Microsoft Graph y otorgar consentimiento de administrador.

1. En Entra ID (Azure AD) **App Registration**, agregue permisos de **Application** de Microsoft Graph:
   - `ChannelMessage.Read.All` (adjuntos de canal + historial)
   - `Chat.Read.All` o `ChatMessage.Read.All` (chats grupales)
2. **Otorgue consentimiento de administrador** para el tenant.
3. Aumente la **versión del manifiesto** de la app de Teams, vuelva a cargarla y **reinstale la app en Teams**.
4. **Cierre completamente y vuelva a abrir Teams** para limpiar la caché de metadatos de la app.

## Limitaciones conocidas

### Tiempos de espera del webhook

Teams entrega mensajes mediante webhook HTTP. Si el procesamiento tarda demasiado (p. ej., respuestas lentas del LLM), puede ver:

- Tiempos de espera del gateway
- Reintentos de Teams (causando duplicados)
- Respuestas perdidas

OpenClaw maneja esto devolviendo rápidamente y enviando respuestas de forma proactiva, pero respuestas muy lentas aún pueden causar problemas.

### Formato

El markdown de Teams es más limitado que Slack o Discord:

- El formato básico funciona: **negrita**, _cursiva_, `code`, enlaces
- El markdown complejo (tablas, listas anidadas) puede no renderizarse correctamente
- Adaptive Cards son compatibles para encuestas y envíos arbitrarios de tarjetas (ver abajo)

## Configuración

Ajustes clave (consulte `/gateway/configuration` para patrones de canales compartidos):

- `channels.msteams.enabled`: habilitar/deshabilitar el canal.
- `channels.msteams.appId`, `channels.msteams.appPassword`, `channels.msteams.tenantId`: credenciales del bot.
- `channels.msteams.webhook.port` (predeterminado `3978`)
- `channels.msteams.webhook.path` (predeterminado `/api/messages`)
- `channels.msteams.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: emparejamiento)
- `channels.msteams.allowFrom`: lista de permitidos para mensajes directos (IDs de objeto AAD, UPNs o nombres para mostrar). El asistente resuelve nombres a IDs durante la configuración cuando hay acceso a Graph.
- `channels.msteams.textChunkLimit`: tamaño de fragmento de texto saliente.
- `channels.msteams.chunkMode`: `length` (predeterminado) o `newline` para dividir en líneas en blanco (límites de párrafo) antes del troceado por longitud.
- `channels.msteams.mediaAllowHosts`: lista de permitidos de hosts de adjuntos entrantes (predeterminado: dominios de Microsoft/Teams).
- `channels.msteams.mediaAuthAllowHosts`: lista de permitidos para adjuntar encabezados Authorization en reintentos de medios (predeterminado: hosts de Graph + Bot Framework).
- `channels.msteams.requireMention`: requerir @mention en canales/grupos (predeterminado true).
- `channels.msteams.replyStyle`: `thread | top-level` (consulte [Estilo de respuesta](#reply-style-threads-vs-posts)).
- `channels.msteams.teams.<teamId>.replyStyle`: anulación por equipo.
- `channels.msteams.teams.<teamId>.requireMention`: anulación por equipo.
- `channels.msteams.teams.<teamId>.tools`: anulaciones predeterminadas de política de herramientas por equipo (`allow`/`deny`/`alsoAllow`) usadas cuando falta una anulación de canal.
- `channels.msteams.teams.<teamId>.toolsBySender`: anulaciones predeterminadas de política de herramientas por equipo y remitente (`"*"` comodín compatible).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.replyStyle`: anulación por canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.requireMention`: anulación por canal.
- `channels.msteams.teams.<teamId>.channels.<conversationId>.tools`: anulaciones de política de herramientas por canal (`allow`/`deny`/`alsoAllow`).
- `channels.msteams.teams.<teamId>.channels.<conversationId>.toolsBySender`: anulaciones de política de herramientas por canal y remitente (`"*"` comodín compatible).
- `channels.msteams.sharePointSiteId`: ID del sitio de SharePoint para cargas de archivos en chats/canales grupales (consulte [Envío de archivos en chats grupales](#sending-files-in-group-chats)).

## Enrutamiento y sesiones

- Las claves de sesión siguen el formato estándar del agente (consulte [/concepts/session](/concepts/session)):
  - Los mensajes directos comparten la sesión principal (`agent:<agentId>:<mainKey>`).
  - Los mensajes de canal/grupo usan el id de conversación:
    - `agent:<agentId>:msteams:channel:<conversationId>`
    - `agent:<agentId>:msteams:group:<conversationId>`

## Estilo de respuesta: Hilos vs Publicaciones

Teams introdujo recientemente dos estilos de UI de canal sobre el mismo modelo de datos subyacente:

| Estilo                                         | Descripción                                                       | `replyStyle` recomendado                     |
| ---------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| **Publicaciones** (clásico) | Los mensajes aparecen como tarjetas con respuestas en hilo debajo | `thread` (predeterminado) |
| **Hilos** (tipo Slack)      | Los mensajes fluyen linealmente, más como Slack                   | `top-level`                                  |

**El problema:** La API de Teams no expone qué estilo de UI usa un canal. Si usa el `replyStyle` incorrecto:

- `thread` en un canal con estilo Hilos → las respuestas aparecen anidadas de forma incómoda
- `top-level` en un canal con estilo Publicaciones → las respuestas aparecen como publicaciones de nivel superior separadas en lugar de en hilo

**Solución:** Configure `replyStyle` por canal según cómo esté configurado el canal:

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

## Adjuntos e imágenes

**Limitaciones actuales:**

- **Mensajes directos:** Imágenes y archivos adjuntos funcionan mediante las APIs de archivos del bot de Teams.
- **Canales/grupos:** Los adjuntos viven en el almacenamiento M365 (SharePoint/OneDrive). La carga del webhook solo incluye un stub HTML, no los bytes reales del archivo. **Se requieren permisos de Graph API** para descargar adjuntos de canales.

Sin permisos de Graph, los mensajes de canal con imágenes se recibirán solo como texto (el contenido de la imagen no es accesible para el bot).
Por defecto, OpenClaw solo descarga medios desde nombres de host de Microsoft/Teams. Anule con `channels.msteams.mediaAllowHosts` (use `["*"]` para permitir cualquier host).
Los encabezados Authorization solo se adjuntan para hosts en `channels.msteams.mediaAuthAllowHosts` (predeterminado: hosts de Graph + Bot Framework). Mantenga esta lista estricta (evite sufijos multi-tenant).

## Envío de archivos en chats grupales

Los bots pueden enviar archivos en mensajes directos usando el flujo FileConsentCard (integrado). Sin embargo, **enviar archivos en chats/canales grupales** requiere configuración adicional:

| Contexto                                             | Cómo se envían los archivos                        | Configuración necesaria                         |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| **Mensajes directos**                                | FileConsentCard → el usuario acepta → el bot carga | Funciona fuera de la caja                       |
| **Chats/canales grupales**                           | Carga a SharePoint → enlace compartido             | Requiere `sharePointSiteId` + permisos de Graph |
| **Imágenes (cualquier contexto)** | Inline codificado en Base64                        | Funciona fuera de la caja                       |

### Por qué los chats grupales necesitan SharePoint

Los bots no tienen una unidad personal de OneDrive (el endpoint de Graph `/me/drive` no funciona para identidades de aplicación). Para enviar archivos en chats/canales grupales, el bot carga a un **sitio de SharePoint** y crea un enlace de uso compartido.

### Configuración

1. **Agregue permisos de Graph API** en Entra ID (Azure AD) → App Registration:
   - `Sites.ReadWrite.All` (Application) - cargar archivos a SharePoint
   - `Chat.Read.All` (Application) - opcional, habilita enlaces de uso compartido por usuario

2. **Otorgue consentimiento de administrador** para el tenant.

3. **Obtenga el ID de su sitio de SharePoint:**

   ```bash
   # Via Graph Explorer or curl with a valid token:
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/{hostname}:/{site-path}"

   # Example: for a site at "contoso.sharepoint.com/sites/BotFiles"
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles"

   # Response includes: "id": "contoso.sharepoint.com,guid1,guid2"
   ```

4. **Configure OpenClaw:**

   ```json5
   {
     channels: {
       msteams: {
         // ... other config ...
         sharePointSiteId: "contoso.sharepoint.com,guid1,guid2",
       },
     },
   }
   ```

### Comportamiento de uso compartido

| Permiso                                 | Comportamiento de uso compartido                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `Sites.ReadWrite.All` solamente         | Enlace de uso compartido a nivel de organización (cualquiera en la org puede acceder) |
| `Sites.ReadWrite.All` + `Chat.Read.All` | Enlace de uso compartido por usuario (solo miembros del chat pueden acceder)          |

El uso compartido por usuario es más seguro, ya que solo los participantes del chat pueden acceder al archivo. Si falta el permiso `Chat.Read.All`, el bot recurre al uso compartido a nivel de organización.

### Comportamiento de respaldo

| Escenario                                              | Resultado                                                                    |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Chat grupal + archivo + `sharePointSiteId` configurado | Carga a SharePoint, envía enlace compartido                                  |
| Chat grupal + archivo + sin `sharePointSiteId`         | Intenta carga a OneDrive (puede fallar), envía solo texto |
| Chat personal + archivo                                | Flujo FileConsentCard (funciona sin SharePoint)           |
| Cualquier contexto + imagen                            | Inline codificado en Base64 (funciona sin SharePoint)     |

### Ubicación de almacenamiento de archivos

Los archivos cargados se almacenan en una carpeta `/OpenClawShared/` en la biblioteca de documentos predeterminada del sitio de SharePoint configurado.

## Encuestas (Adaptive Cards)

OpenClaw envía encuestas de Teams como Adaptive Cards (no existe una API nativa de encuestas de Teams).

- CLI: `openclaw message poll --channel msteams --target conversation:<id> ...`
- Los votos se registran por el gateway en `~/.openclaw/msteams-polls.json`.
- El gateway debe permanecer en línea para registrar votos.
- Las encuestas aún no publican automáticamente resúmenes de resultados (inspeccione el archivo de almacenamiento si es necesario).

## Adaptive Cards (arbitrarias)

Envíe cualquier JSON de Adaptive Card a usuarios o conversaciones de Teams usando la herramienta o CLI `message`.

El parámetro `card` acepta un objeto JSON de Adaptive Card. Cuando se proporciona `card`, el texto del mensaje es opcional.

**Herramienta del agente:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:<id>",
  "card": {
    "type": "AdaptiveCard",
    "version": "1.5",
    "body": [{ "type": "TextBlock", "text": "Hello!" }]
  }
}
```

**CLI:**

```bash
openclaw message send --channel msteams \
  --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello!"}]}'
```

Consulte la [documentación de Adaptive Cards](https://adaptivecards.io/) para el esquema y ejemplos. Para detalles del formato de destino, consulte [Formatos de destino](#target-formats) abajo.

## Formatos de destino

Los destinos de MSTeams usan prefijos para distinguir entre usuarios y conversaciones:

| Tipo de destino                         | Formato                          | Ejemplo                                                                |
| --------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Usuario (por ID)     | `user:<aad-object-id>`           | `user:40a1a0ed-4ff2-4164-a219-55518990c197`                            |
| Usuario (por nombre) | `user:<display-name>`            | `user:John Smith` (requiere Graph API)              |
| Grupo/canal                             | `conversation:<conversation-id>` | `conversation:19:abc123...@thread.tacv2`                               |
| Grupo/canal (raw)    | `<conversation-id>`              | `19:abc123...@thread.tacv2` (si contiene `@thread`) |

**Ejemplos de CLI:**

```bash
# Send to a user by ID
openclaw message send --channel msteams --target "user:40a1a0ed-..." --message "Hello"

# Send to a user by display name (triggers Graph API lookup)
openclaw message send --channel msteams --target "user:John Smith" --message "Hello"

# Send to a group chat or channel
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" --message "Hello"

# Send an Adaptive Card to a conversation
openclaw message send --channel msteams --target "conversation:19:abc...@thread.tacv2" \
  --card '{"type":"AdaptiveCard","version":"1.5","body":[{"type":"TextBlock","text":"Hello"}]}'
```

**Ejemplos de herramienta del agente:**

```json
{
  "action": "send",
  "channel": "msteams",
  "target": "user:John Smith",
  "message": "Hello!"
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
    "body": [{ "type": "TextBlock", "text": "Hello" }]
  }
}
```

Nota: Sin el prefijo `user:`, los nombres se resuelven por defecto a grupos/equipos. Use siempre `user:` cuando apunte a personas por nombre para mostrar.

## Mensajería proactiva

- Los mensajes proactivos solo son posibles **después** de que un usuario haya interactuado, porque almacenamos referencias de conversación en ese punto.
- Consulte `/gateway/configuration` para `dmPolicy` y el control por lista de permitidos.

## IDs de equipo y canal (error común)

El parámetro de consulta `groupId` en las URLs de Teams **NO** es el ID de equipo usado para la configuración. Extraiga los IDs desde la ruta de la URL:

**URL del equipo:**

```
https://teams.microsoft.com/l/team/19%3ABk4j...%40thread.tacv2/conversations?groupId=...
                                    └────────────────────────────┘
                                    Team ID (URL-decode this)
```

**URL del canal:**

```
https://teams.microsoft.com/l/channel/19%3A15bc...%40thread.tacv2/ChannelName?groupId=...
                                      └─────────────────────────┘
                                      Channel ID (URL-decode this)
```

**Para configuración:**

- ID de equipo = segmento de ruta después de `/team/` (decodificado de URL, p. ej., `19:Bk4j...@thread.tacv2`)
- ID de canal = segmento de ruta después de `/channel/` (decodificado de URL)
- **Ignore** el parámetro de consulta `groupId`

## Canales privados

Los bots tienen soporte limitado en canales privados:

| Función                                              | Canales estándar | Canales privados                     |
| ---------------------------------------------------- | ---------------- | ------------------------------------ |
| Instalación del bot                                  | Sí               | Limitado                             |
| Mensajes en tiempo real (webhook) | Sí               | Puede no funcionar                   |
| Permisos RSC                                         | Sí               | Pueden comportarse distinto          |
| @mentions                               | Sí               | Si el bot es accesible               |
| Historial por Graph API                              | Sí               | Sí (con permisos) |

**Alternativas si los canales privados no funcionan:**

1. Use canales estándar para interacciones con el bot
2. Use mensajes directos: los usuarios siempre pueden escribirle al bot directamente
3. Use Graph API para acceso histórico (requiere `ChannelMessage.Read.All`)

## Solución de problemas

### Problemas comunes

- **Las imágenes no se muestran en canales:** faltan permisos de Graph o consentimiento de administrador. Reinstale la app de Teams y cierre/abra completamente Teams.
- **Sin respuestas en canal:** las menciones son obligatorias por defecto; configure `channels.msteams.requireMention=false` o ajuste por equipo/canal.
- **Desajuste de versión (Teams aún muestra el manifiesto antiguo):** quite y vuelva a agregar la app y cierre completamente Teams para refrescar.
- **401 Unauthorized desde el webhook:** esperado al probar manualmente sin JWT de Azure; indica que el endpoint es alcanzable pero falló la autenticación. Use Azure Web Chat para probar correctamente.

### Errores al cargar el manifiesto

- **"Icon file cannot be empty":** El manifiesto referencia íconos de 0 bytes. Cree íconos PNG válidos (32x32 para `outline.png`, 192x192 para `color.png`).
- **"webApplicationInfo.Id already in use":** La app aún está instalada en otro equipo/chat. Encuéntrela y desinstálela primero, o espere 5-10 minutos para la propagación.
- **"Something went wrong" al cargar:** Cargue mediante [https://admin.teams.microsoft.com](https://admin.teams.microsoft.com) en su lugar, abra las DevTools del navegador (F12) → pestaña Network, y revise el cuerpo de la respuesta para el error real.
- **Fallo de sideload:** Intente "Upload an app to your org's app catalog" en lugar de "Upload a custom app"; a menudo evita restricciones de sideload.

### Permisos RSC no funcionan

1. Verifique que `webApplicationInfo.id` coincida exactamente con el App ID de su bot
2. Vuelva a cargar la app y reinstálela en el equipo/chat
3. Verifique si el admin de su organización bloqueó los permisos RSC
4. Confirme que usa el ámbito correcto: `ChannelMessage.Read.Group` para equipos, `ChatMessage.Read.Chat` para chats grupales

## Referencias

- [Crear Azure Bot](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-quickstart-registration) - Guía de configuración de Azure Bot
- [Portal para desarrolladores de Teams](https://dev.teams.microsoft.com/apps) - crear/administrar apps de Teams
- [Esquema del manifiesto de apps de Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/resources/schema/manifest-schema)
- [Recibir mensajes de canal con RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-messages-with-rsc)
- [Referencia de permisos RSC](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent)
- [Manejo de archivos del bot de Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4) (canal/grupo requiere Graph)
- [Mensajería proactiva](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages)
