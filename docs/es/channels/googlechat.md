---
summary: "Estado de compatibilidad, capacidades y configuración de la app de Google Chat"
read_when:
  - Al trabajar en funciones del canal de Google Chat
title: "Google Chat"
---

# Google Chat (Chat API)

Estado: listo para mensajes directos (DMs) + espacios mediante webhooks de la API de Google Chat (solo HTTP).

## Configuración rápida (principiante)

1. Cree un proyecto de Google Cloud y habilite la **Google Chat API**.
   - Vaya a: [Credenciales de la API de Google Chat](https://console.cloud.google.com/apis/api/chat.googleapis.com/credentials)
   - Habilite la API si aún no está habilitada.
2. Cree una **Cuenta de servicio**:
   - Presione **Crear credenciales** > **Cuenta de servicio**.
   - Asigne el nombre que desee (p. ej., `openclaw-chat`).
   - Deje los permisos en blanco (presione **Continuar**).
   - Deje los principales con acceso en blanco (presione **Listo**).
3. Cree y descargue la **Clave JSON**:
   - En la lista de cuentas de servicio, haga clic en la que acaba de crear.
   - Vaya a la pestaña **Claves**.
   - Haga clic en **Agregar clave** > **Crear nueva clave**.
   - Seleccione **JSON** y presione **Crear**.
4. Guarde el archivo JSON descargado en su host del Gateway (p. ej., `~/.openclaw/googlechat-service-account.json`).
5. Cree una app de Google Chat en la [Configuración de Chat de la Consola de Google Cloud](https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat):
   - Complete la **Información de la aplicación**:
     - **Nombre de la app**: (p. ej., `OpenClaw`)
     - **URL del avatar**: (p. ej., `https://openclaw.ai/logo.png`)
     - **Descripción**: (p. ej., `Personal AI Assistant`)
   - Habilite **Funciones interactivas**.
   - En **Funcionalidad**, marque **Unirse a espacios y conversaciones de grupo**.
   - En **Configuración de conexión**, seleccione **URL de endpoint HTTP**.
   - En **Desencadenadores**, seleccione **Usar una URL de endpoint HTTP común para todos los desencadenadores** y configúrela con la URL pública de su Gateway seguida de `/googlechat`.
     - _Consejo: Ejecute `openclaw status` para encontrar la URL pública de su Gateway._
   - En **Visibilidad**, marque **Hacer que esta app de Chat esté disponible para personas y grupos específicos en &lt;Su Dominio&gt;**.
   - Ingrese su dirección de correo electrónico (p. ej., `user@example.com`) en el cuadro de texto.
   - Haga clic en **Guardar** al final.
6. **Habilite el estado de la app**:
   - Después de guardar, **actualice la página**.
   - Busque la sección **Estado de la app** (normalmente cerca de la parte superior o inferior después de guardar).
   - Cambie el estado a **Activo: disponible para usuarios**.
   - Haga clic en **Guardar** nuevamente.
7. Configure OpenClaw con la ruta de la cuenta de servicio + el audience del webhook:
   - Env: `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE=/path/to/service-account.json`
   - O config: `channels.googlechat.serviceAccountFile: "/path/to/service-account.json"`.
8. Configure el tipo y el valor del audience del webhook (coincide con la configuración de su app de Chat).
9. Inicie el Gateway. Google Chat enviará POST a la ruta de su webhook.

## Agregar a Google Chat

Una vez que el Gateway esté en ejecución y su correo electrónico esté agregado a la lista de visibilidad:

1. Vaya a [Google Chat](https://chat.google.com/).
2. Haga clic en el ícono **+** (más) junto a **Mensajes directos**.
3. En la barra de búsqueda (donde normalmente agrega personas), escriba el **Nombre de la app** que configuró en la Consola de Google Cloud.
   - **Nota**: El bot _no_ aparecerá en la lista de exploración del “Marketplace” porque es una app privada. Debe buscarla por nombre.
4. Seleccione su bot en los resultados.
5. Haga clic en **Agregar** o **Chatear** para iniciar una conversación 1:1.
6. Envíe “Hello” para activar el asistente.

## URL pública (solo webhook)

Los webhooks de Google Chat requieren un endpoint HTTPS público. Por seguridad, **exponga solo la ruta `/googlechat`** a internet. Mantenga el panel de OpenClaw y otros endpoints sensibles en su red privada.

### Opción A: Tailscale Funnel (Recomendado)

Use Tailscale Serve para el panel privado y Funnel para la ruta pública del webhook. Esto mantiene `/` privado mientras expone solo `/googlechat`.

1. **Verifique a qué dirección está vinculado su Gateway:**

   ```bash
   ss -tlnp | grep 18789
   ```

   Anote la dirección IP (p. ej., `127.0.0.1`, `0.0.0.0` o su IP de Tailscale como `100.x.x.x`).

2. **Exponga el panel solo al tailnet (puerto 8443):**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale serve --bg --https 8443 http://127.0.0.1:18789

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale serve --bg --https 8443 http://100.106.161.80:18789
   ```

3. **Exponga públicamente solo la ruta del webhook:**

   ```bash
   # If bound to localhost (127.0.0.1 or 0.0.0.0):
   tailscale funnel --bg --set-path /googlechat http://127.0.0.1:18789/googlechat

   # If bound to Tailscale IP only (e.g., 100.106.161.80):
   tailscale funnel --bg --set-path /googlechat http://100.106.161.80:18789/googlechat
   ```

4. **Autorice el nodo para acceso a Funnel:**
   Si se le solicita, visite la URL de autorización que aparece en la salida para habilitar Funnel para este nodo en la política de su tailnet.

5. **Verifique la configuración:**

   ```bash
   tailscale serve status
   tailscale funnel status
   ```

Su URL pública del webhook será:
`https://<node-name>.<tailnet>.ts.net/googlechat`

Su panel privado permanece solo en el tailnet:
`https://<node-name>.<tailnet>.ts.net:8443/`

Use la URL pública (sin `:8443`) en la configuración de la app de Google Chat.

> Nota: Esta configuración persiste tras los reinicios. Para eliminarla más adelante, ejecute `tailscale funnel reset` y `tailscale serve reset`.

### Opción B: Proxy inverso (Caddy)

Si usa un proxy inverso como Caddy, solo proxifique la ruta específica:

```caddy
your-domain.com {
    reverse_proxy /googlechat* localhost:18789
}
```

Con esta configuración, cualquier solicitud a `your-domain.com/` será ignorada o devolverá 404, mientras que `your-domain.com/googlechat` se enruta de forma segura a OpenClaw.

### Opción C: Túnel de Cloudflare

Configure las reglas de ingreso de su túnel para enrutar solo la ruta del webhook:

- **Ruta**: `/googlechat` -> `http://localhost:18789/googlechat`
- **Regla predeterminada**: HTTP 404 (No encontrado)

## Cómo funciona

1. Google Chat envía POSTs de webhook al Gateway. Cada solicitud incluye un encabezado `Authorization: Bearer <token>`.
2. OpenClaw verifica el token contra el `audienceType` + `audience` configurados:
   - `audienceType: "app-url"` → el audience es su URL HTTPS del webhook.
   - `audienceType: "project-number"` → el audience es el número del proyecto de Cloud.
3. Los mensajes se enrutan por espacio:
   - Los DMs usan la clave de sesión `agent:<agentId>:googlechat:dm:<spaceId>`.
   - Los espacios usan la clave de sesión `agent:<agentId>:googlechat:group:<spaceId>`.
4. El acceso a DMs es por emparejamiento de forma predeterminada. Los remitentes desconocidos reciben un código de emparejamiento; apruebe con:
   - `openclaw pairing approve googlechat <code>`
5. Los espacios de grupo requieren @mención de forma predeterminada. Use `botUser` si la detección de menciones necesita el nombre de usuario de la app.

## Destinos

Use estos identificadores para la entrega y las listas de permitidos:

- Mensajes directos: `users/<userId>` o `users/<email>` (se aceptan direcciones de correo electrónico).
- Espacios: `spaces/<spaceId>`.

## Aspectos destacados de configuración

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url",
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; helps mention detection
      dm: {
        policy: "pairing",
        allowFrom: ["users/1234567890", "name@example.com"],
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": {
          allow: true,
          requireMention: true,
          users: ["users/1234567890"],
          systemPrompt: "Short answers only.",
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

- Las credenciales de la cuenta de servicio también se pueden pasar en línea con `serviceAccount` (cadena JSON).
- La ruta predeterminada del webhook es `/googlechat` si `webhookPath` no está configurado.
- Las reacciones están disponibles mediante la herramienta `reactions` y `channels action` cuando `actions.reactions` está habilitado.
- `typingIndicator` admite `none`, `message` (predeterminado) y `reaction` (la reacción requiere OAuth de usuario).
- Los adjuntos se descargan a través de la API de Chat y se almacenan en el pipeline de medios (tamaño limitado por `mediaMaxMb`).

## Solución de problemas

### 405 Method Not Allowed

Si el Explorador de registros de Google Cloud muestra errores como:

```
status code: 405, reason phrase: HTTP error response: HTTP/1.1 405 Method Not Allowed
```

Esto significa que el manejador del webhook no está registrado. Causas comunes:

1. **Canal no configurado**: Falta la sección `channels.googlechat` en su configuración. Verifique con:

   ```bash
   openclaw config get channels.googlechat
   ```

   Si devuelve “Config path not found”, agregue la configuración (consulte [Aspectos destacados de configuración](#aspectos-destacados-de-configuración)).

2. **Plugin no habilitado**: Verifique el estado del plugin:

   ```bash
   openclaw plugins list | grep googlechat
   ```

   Si muestra “disabled”, agregue `plugins.entries.googlechat.enabled: true` a su configuración.

3. **Gateway no reiniciado**: Después de agregar la configuración, reinicie el Gateway:

   ```bash
   openclaw gateway restart
   ```

Verifique que el canal esté en ejecución:

```bash
openclaw channels status
# Should show: Google Chat default: enabled, configured, ...
```

### Otros problemas

- Revise `openclaw channels status --probe` para detectar errores de autenticación o configuración de audience faltante.
- Si no llegan mensajes, confirme la URL del webhook de la app de Chat + las suscripciones de eventos.
- Si el bloqueo por mención impide las respuestas, configure `botUser` con el nombre de recurso del usuario de la app y verifique `requireMention`.
- Use `openclaw logs --follow` mientras envía un mensaje de prueba para ver si las solicitudes llegan al Gateway.

Documentación relacionada:

- [Configuración del Gateway](/gateway/configuration)
- [Seguridad](/gateway/security)
- [Reacciones](/tools/reactions)
