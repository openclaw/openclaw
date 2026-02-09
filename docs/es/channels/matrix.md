---
summary: "Estado de soporte de Matrix, capacidades y configuración"
read_when:
  - Al trabajar en funciones del canal Matrix
title: "Matrix"
---

# Matrix (plugin)

Matrix es un protocolo de mensajería abierto y descentralizado. OpenClaw se conecta como un **usuario**
de Matrix en cualquier homeserver, por lo que necesita una cuenta de Matrix para el bot. Una vez que inicia sesión, puede enviar mensajes directos al bot
o invitarlo a salas (los “grupos” de Matrix). Beeper también es una opción válida como cliente,
pero requiere que E2EE esté habilitado.

Estado: compatible mediante plugin (@vector-im/matrix-bot-sdk). Mensajes directos, salas, hilos, medios, reacciones,
encuestas (envío + inicio de encuesta como texto), ubicación y E2EE (con soporte criptográfico).

## Plugin requerido

Matrix se distribuye como plugin y no viene incluido con la instalación principal.

Instale vía CLI (registro npm):

```bash
openclaw plugins install @openclaw/matrix
```

Checkout local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/matrix
```

Si elige Matrix durante la configuración/onboarding y se detecta un checkout de git,
OpenClaw ofrecerá automáticamente la ruta de instalación local.

Detalles: [Plugins](/tools/plugin)

## Configuración

1. Instale el plugin de Matrix:
   - Desde npm: `openclaw plugins install @openclaw/matrix`
   - Desde un checkout local: `openclaw plugins install ./extensions/matrix`

2. Cree una cuenta de Matrix en un homeserver:
   - Explore opciones de alojamiento en [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - O alójelo usted mismo.

3. Obtenga un token de acceso para la cuenta del bot:

   - Use la API de inicio de sesión de Matrix con `curl` en su homeserver:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Reemplace `matrix.example.org` con la URL de su homeserver.
   - O configure `channels.matrix.userId` + `channels.matrix.password`: OpenClaw llama al mismo
     endpoint de inicio de sesión, almacena el token de acceso en `~/.openclaw/credentials/matrix/credentials.json`,
     y lo reutiliza en el siguiente inicio.

4. Configure las credenciales:
   - Variables de entorno: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (o `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - O configuración: `channels.matrix.*`
   - Si ambos están definidos, la configuración tiene prioridad.
   - Con token de acceso: el ID de usuario se obtiene automáticamente vía `/whoami`.
   - Cuando se establece, `channels.matrix.userId` debe ser el ID completo de Matrix (ejemplo: `@bot:example.org`).

5. Reinicie el Gateway (o finalice el onboarding).

6. Inicie un mensaje directo con el bot o invítelo a una sala desde cualquier cliente de Matrix
   (Element, Beeper, etc.; consulte [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper requiere E2EE,
   así que configure `channels.matrix.encryption: true` y verifique el dispositivo.

Configuración mínima (token de acceso, ID de usuario obtenido automáticamente):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Configuración E2EE (cifrado de extremo a extremo habilitado):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Cifrado (E2EE)

El cifrado de extremo a extremo está **soportado** mediante el SDK criptográfico en Rust.

Habilítelo con `channels.matrix.encryption: true`:

- Si el módulo criptográfico se carga, las salas cifradas se descifran automáticamente.
- Los medios salientes se cifran cuando se envían a salas cifradas.
- En la primera conexión, OpenClaw solicita verificación del dispositivo desde sus otras sesiones.
- Verifique el dispositivo en otro cliente de Matrix (Element, etc.) para habilitar el intercambio de claves.
- Si el módulo criptográfico no puede cargarse, E2EE se deshabilita y las salas cifradas no se descifrarán;
  OpenClaw registra una advertencia.
- Si ve errores de módulo criptográfico faltante (por ejemplo, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  permita los scripts de compilación para `@matrix-org/matrix-sdk-crypto-nodejs` y ejecute
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` o obtenga el binario con
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

El estado criptográfico se almacena por cuenta + token de acceso en
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(base de datos SQLite). El estado de sincronización vive junto a él en `bot-storage.json`.
Si el token de acceso (dispositivo) cambia, se crea un nuevo almacén y el bot debe
volver a verificarse para salas cifradas.

**Verificación de dispositivo:**
Cuando E2EE está habilitado, el bot solicitará verificación desde sus otras sesiones al iniciar.
Abra Element (u otro cliente) y apruebe la solicitud de verificación para establecer confianza.
Una vez verificado, el bot puede descifrar mensajes en salas cifradas.

## Modelo de enrutamiento

- Las respuestas siempre regresan a Matrix.
- Los mensajes directos comparten la sesión principal del agente; las salas se asignan a sesiones de grupo.

## Control de acceso (DMs)

- Predeterminado: `channels.matrix.dm.policy = "pairing"`. Los remitentes desconocidos reciben un código de emparejamiento.
- Aprobar mediante:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- DMs públicos: `channels.matrix.dm.policy="open"` más `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` acepta IDs completos de usuario de Matrix (ejemplo: `@user:server`). El asistente resuelve nombres visibles a IDs cuando la búsqueda en el directorio encuentra una coincidencia exacta única.

## Salas (grupos)

- Predeterminado: `channels.matrix.groupPolicy = "allowlist"` (restringido por mención). Use `channels.defaults.groupPolicy` para anular el valor predeterminado cuando no esté definido.
- Permita salas con `channels.matrix.groups` (IDs o alias de sala; los nombres se resuelven a IDs cuando la búsqueda en el directorio encuentra una coincidencia exacta única):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` habilita la respuesta automática en esa sala.
- `groups."*"` puede establecer valores predeterminados para la restricción por mención entre salas.
- `groupAllowFrom` restringe qué remitentes pueden activar el bot en salas (IDs completos de usuario de Matrix).
- Las listas de permitidos por sala `users` pueden restringir aún más los remitentes dentro de una sala específica (use IDs completos de usuario de Matrix).
- El asistente de configuración solicita listas de permitidos de salas (IDs, alias o nombres) y resuelve nombres solo con una coincidencia exacta y única.
- Al iniciar, OpenClaw resuelve nombres de salas/usuarios en listas de permitidos a IDs y registra el mapeo; las entradas no resueltas se ignoran para la coincidencia de listas de permitidos.
- Las invitaciones se aceptan automáticamente de forma predeterminada; contrólelo con `channels.matrix.autoJoin` y `channels.matrix.autoJoinAllowlist`.
- Para permitir **ninguna sala**, configure `channels.matrix.groupPolicy: "disabled"` (o mantenga una lista de permitidos vacía).
- Clave heredada: `channels.matrix.rooms` (misma estructura que `groups`).

## Hilos

- Se admite la respuesta en hilos.
- `channels.matrix.threadReplies` controla si las respuestas permanecen en hilos:
  - `off`, `inbound` (predeterminado), `always`
- `channels.matrix.replyToMode` controla los metadatos de respuesta cuando no se responde en un hilo:
  - `off` (predeterminado), `first`, `all`

## Capacidades

| Función           | Estado                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mensajes directos | ✅ Compatible                                                                                                      |
| Salas             | ✅ Compatible                                                                                                      |
| Hilos             | ✅ Compatible                                                                                                      |
| Medios            | ✅ Compatible                                                                                                      |
| E2EE              | ✅ Compatible (se requiere módulo criptográfico)                                                |
| Reacciones        | ✅ Compatible (enviar/leer mediante herramientas)                                               |
| Encuestas         | ✅ Envío compatible; los inicios entrantes se convierten a texto (respuestas/finales ignorados) |
| Ubicación         | ✅ Compatible (URI geo; altitud ignorada)                                                       |
| Comandos nativos  | ✅ Compatible                                                                                                      |

## Solución de problemas

Ejecute primero esta escalera:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego confirme el estado de emparejamiento de DMs si es necesario:

```bash
openclaw pairing list matrix
```

Fallos comunes:

- Con sesión iniciada pero mensajes de sala ignorados: sala bloqueada por `groupPolicy` o por la lista de permitidos de salas.
- DMs ignorados: remitente pendiente de aprobación cuando `channels.matrix.dm.policy="pairing"`.
- Fallos en salas cifradas: soporte criptográfico o desajuste en la configuración de cifrado.

Para el flujo de triaje: [/channels/troubleshooting](/channels/troubleshooting).

## Referencia de configuración (Matrix)

Configuración completa: [Configuration](/gateway/configuration)

Opciones del proveedor:

- `channels.matrix.enabled`: habilitar/deshabilitar el inicio del canal.
- `channels.matrix.homeserver`: URL del homeserver.
- `channels.matrix.userId`: ID de usuario de Matrix (opcional con token de acceso).
- `channels.matrix.accessToken`: token de acceso.
- `channels.matrix.password`: contraseña para inicio de sesión (se almacena el token).
- `channels.matrix.deviceName`: nombre visible del dispositivo.
- `channels.matrix.encryption`: habilitar E2EE (predeterminado: false).
- `channels.matrix.initialSyncLimit`: límite de sincronización inicial.
- `channels.matrix.threadReplies`: `off | inbound | always` (predeterminado: entrante).
- `channels.matrix.textChunkLimit`: tamaño de fragmento de texto saliente (caracteres).
- `channels.matrix.chunkMode`: `length` (predeterminado) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de fragmentar por longitud.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (predeterminado: emparejamiento).
- `channels.matrix.dm.allowFrom`: lista de permitidos de DMs (IDs completos de usuario de Matrix). `open` requiere `"*"`. El asistente resuelve nombres a IDs cuando es posible.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (predeterminado: lista de permitidos).
- `channels.matrix.groupAllowFrom`: remitentes permitidos para mensajes de grupo (IDs completos de usuario de Matrix).
- `channels.matrix.allowlistOnly`: forzar reglas de lista de permitidos para DMs + salas.
- `channels.matrix.groups`: lista de permitidos de grupos + mapa de configuraciones por sala.
- `channels.matrix.rooms`: lista/configuración heredada de grupos.
- `channels.matrix.replyToMode`: modo de respuesta para hilos/etiquetas.
- `channels.matrix.mediaMaxMb`: límite de medios entrantes/salientes (MB).
- `channels.matrix.autoJoin`: manejo de invitaciones (`always | allowlist | off`, predeterminado: siempre).
- `channels.matrix.autoJoinAllowlist`: IDs/alias de salas permitidas para unión automática.
- `channels.matrix.actions`: control de herramientas por acción (reacciones/mensajes/pines/memberInfo/channelInfo).
