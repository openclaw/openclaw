---
summary: "Estado, capacidades y configuración de soporte para la app de Google Chat"
read_when:
  - Trabajando en características del canal de Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Estado: listo para mensajes directos + espacios mediante webhooks de la API de Google Chat (solo HTTP).

## Configuración rápida (principiante)

1. Crear un proyecto de Google Cloud y habilitar la **API de Google Chat**.
   - Ir a: [Google Chat API Credentials](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Habilitar la API si aún no está habilitada.
2. Crear una **Cuenta de Servicio**:
   - Presionar **Create Credentials** > **Service Account**.
   - Nombrarla como quieras (ej., `openclaw-chat`).
   - Dejar permisos en blanco (presionar **Continue**).
   - Dejar principales con acceso en blanco (presionar **Done**).
3. Crear y descargar la **Clave JSON**:
   - En la lista de cuentas de servicio, hacer clic en la que acabas de crear.
   - Ir a la pestaña **Keys**.
   - Hacer clic en **Add Key** > **Create new key**.
   - Seleccionar **JSON** y presionar **Create**.
4. Almacenar el archivo JSON descargado en tu host del gateway (ej., `~/.openclaw/googlechat-service-account.json`).
5. Crear una app de Google Chat en la [Configuración de Chat de Google Cloud Console](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Completar la **Application info**:
     - **App name**: (ej. `OpenClaw`)
     - **Avatar URL**: (ej. `https://openclaw.ai/logo.png`)
     - **Description**: (ej. `Asistente de IA Personal`)
   - Habilitar **Interactive features**.
   - En **Functionality**, marcar **Join spaces and group conversations**.
   - En **Connection settings**, seleccionar **HTTP endpoint URL**.
   - En **Triggers**, seleccionar **Use a common HTTP endpoint URL for all triggers** y configurarlo con la URL pública de tu gateway seguida de `/googlechat`.
     - _Consejo: Ejecuta `openclaw status` para encontrar la URL pública de tu gateway._
   - En **Visibility**, marcar **Make this Chat app available to specific people and groups in &lt;Tu Dominio&gt;**.
   - Ingresar tu dirección de correo (ej. `user@example.com`) en el cuadro de texto.
   - Hacer clic en **Save** en la parte inferior.
6. **Habilitar el estado de la app**:
   - Después de guardar, **refrescar la página**.
   - Buscar la sección **App status** (usualmente cerca de la parte superior o inferior después de guardar).
   - Cambiar el estado a **Live - available to users**.
   - Hacer clic en **Save** nuevamente.
7. Configurar OpenClaw con la ruta de la cuenta de servicio + audiencia del webhook:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/ruta/a/service-account.json`
   - O config: `channels.googlechat.serviceAccountFile: "/ruta/a/service-account.json"`.
8. Configurar el tipo de audiencia del webhook + valor (coincide con tu config de app de Chat).
9. Iniciar el gateway. Google Chat hará POST a tu ruta de webhook.

## Agregar a Google Chat

Una vez que el gateway esté ejecutándose y tu correo esté agregado a la lista de visibilidad:

1. Ir a [Google Chat](https://chat.google.com/).
2. Hacer clic en el ícono **+** (más) junto a **Direct Messages**.
3. En la barra de búsqueda (donde usualmente agregas personas), escribir el **App name** que configuraste en Google Cloud Console.
   - **Nota**: El bot _no_ aparecerá en la lista de navegación del "Marketplace" porque es una app privada. Debes buscarlo por nombre.
4. Seleccionar tu bot de los resultados.
5. Hacer clic en **Add** o **Chat** para iniciar una conversación 1:1.
6. Enviar "Hola" para activar el asistente!

## URL pública (Solo webhook)

Los webhooks de Google Chat requieren un endpoint HTTPS público. Por seguridad, **solo exponer la ruta `/googlechat`** a internet. Mantén el panel de OpenClaw y otros endpoints sensibles en tu red privada.

### Opción A: Tailscale Funnel (Recomendado)

Usa Tailscale Serve para el panel privado y Funnel para la ruta de webhook pública. Esto mantiene `/` privado mientras expone solo `/googlechat`.

1. **Verificar a qué dirección está vinculado tu gateway:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Anotar la dirección IP (ej., `127.0.0.1`, `0.0.0.0`, o tu IP de Tailscale como `100.x.x.x`).

2. **Exponer el panel solo al tailnet (puerto 8443):**

   ```bash
   # Si está vinculado a localhost (127.0.0.1 o 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # Si está vinculado solo a IP de Tailscale (ej., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Exponer solo la ruta del webhook públicamente:**

   ```bash
   # Si está vinculado a localhost (127.0.0.1 o 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # Si está vinculado solo a IP de Tailscale (ej., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Autorizar el nodo para acceso a Funnel:**
   Si se solicita, visitar la URL de autorización mostrada en la salida para habilitar Funnel para este nodo en tu política de tailnet.

5. **Verificar la configuración:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Tu URL de webhook pública será:
`https://<nombre-nodo>.<tailnet>.ts.net/googlechat`

Tu panel privado permanece solo en tailnet:
`https://<nombre-nodo>.<tailnet>.ts.net:8443/`

Usar la URL pública (sin `:8443`) en la config de la app de Google Chat.

> Nota: Esta configuración persiste entre reinicios. Para eliminarla después, ejecuta `tailscale funnel reset` y `tailscale serve reset`.

### Opción B: Proxy Inverso (Caddy)

Si usas un proxy inverso como Caddy, solo hacer proxy de la ruta específica:

```caddy
tu-dominio.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Con esta config, cualquier solicitud a `tu-dominio.com/` será ignorada o retornada como 404, mientras que `tu-dominio.com/googlechat` es enrutada de forma segura a OpenClaw.

### Opción C: Cloudflare Tunnel

Configurar las reglas de ingress de tu túnel para enrutar solo la ruta del webhook:

- **Path**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Regla por defecto**: HTTP 404 (Not Found)

## Cómo funciona

1. Google Chat envía POSTs de webhook al gateway. Cada solicitud incluye un encabezado `Authorization: Bearer <token>`.
2. OpenClaw verifica el token contra el `audienceType` + `audience` configurados:
   - `audienceType: "app-url"` → audience es tu URL HTTPS del webhook.
   - `audienceType: "project-number"` → audience es el número del proyecto Cloud.
3. Los mensajes se enrutan por espacio:
   - Los mensajes directos usan clave de sesión `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Los espacios usan clave de sesión `agent:<agentId>:googlechat:group:<spaceId>`.
4. El acceso a mensajes directos es por emparejamiento por defecto. Los remitentes desconocidos reciben un código de emparejamiento; aprobar con:
   - `openclaw pairing approve googlechat <código>`
5. Los espacios de grupo requieren @-mención por defecto. Usa `botUser` si la detección de menciones necesita el nombre de usuario de la app.

## Destinos

Usa estos identificadores para entregas y listas de permitidos:

- Mensajes directos: `users/<userId>` (recomendado) o correo sin formato `nombre@example.com` (principal mutable).
- Obsoleto: `users/<email>` se trata como un id de usuario, no una lista de permitidos de correos.
- Espacios: `spaces/<spaceId>`.

## Aspectos destacados de config

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/ruta/a/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // opcional; ayuda con la detección de menciones
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "nombre@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Respuestas cortas solamente.",
        },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notas:

- Las credenciales de cuenta de servicio también pueden pasarse en línea con `serviceAccount` (cadena JSON).
- La ruta de webhook por defecto es `/googlechat` si `webhookPath` no está configurado.
- Las reacciones están disponibles mediante la herramienta `reactions` y `channels action` cuando `actions.reactions` está habilitado.
- `typingIndicator` soporta `none`, `message` (por defecto), y `reaction` (reaction requiere OAuth de usuario).
- Los adjuntos se descargan a través de la API de Chat y se almacenan en el pipeline de medios (tamaño limitado por `mediaMaxMb`).

## Solución de problemas

### 405 Method Not Allowed

Si Google Cloud Logs Explorer muestra errores como:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Esto significa que el manejador de webhook no está registrado. Causas comunes:

1. **Canal no configurado**: La sección `channels.googlechat` falta en tu config. Verificar con:

   ```bash
   openclaw config get channels.googlechat
   ```

   Si retorna "Config path not found", agregar la configuración (ver [Aspectos destacados de config](#aspectos-destacados-de-config)).

2. **Plugin no habilitado**: Verificar estado del plugin:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Si muestra "disabled", agregar `plugins.entries.googlechat.enabled: true` a tu config.

3. **Gateway no reiniciado**: Después de agregar config, reiniciar el gateway:

   ```bash
   openclaw gateway restart
   ```

Verificar que el canal esté ejecutándose:

```bash
openclaw channels status
# Debería mostrar: Google Chat default: enabled, configured, ...
```

### Otros problemas

- Verificar `openclaw channels status --probe` para errores de autenticación o config de audience faltante.
- Si no llegan mensajes, confirmar la URL del webhook de la app de Chat + suscripciones de eventos.
- Si el control de menciones bloquea respuestas, configurar `botUser` con el nombre de recurso de usuario de la app y verificar `requireMention`.
- Usar `openclaw logs --follow` mientras envías un mensaje de prueba para ver si las solicitudes llegan al gateway.

Documentos relacionados:

- [Configuración del Gateway](/es-ES/gateway/configuration)
- [Seguridad](/es-ES/gateway/security)
- [Reacciones](/es-ES/tools/reactions)
