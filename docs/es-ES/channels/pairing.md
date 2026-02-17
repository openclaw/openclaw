---
summary: "Resumen de emparejamiento: aprobar quién puede enviarte mensajes directos + qué nodos pueden unirse"
read_when:
  - Configurando control de acceso de mensajes directos
  - Emparejando un nuevo nodo iOS/Android
  - Revisando la postura de seguridad de OpenClaw
title: "Emparejamiento"
---

# Emparejamiento

"Emparejamiento" es el paso explícito de **aprobación del propietario** de OpenClaw.
Se usa en dos lugares:

1. **Emparejamiento de mensajes directos** (quién tiene permitido hablar con el bot)
2. **Emparejamiento de nodos** (qué dispositivos/nodos tienen permitido unirse a la red del gateway)

Contexto de seguridad: [Seguridad](/gateway/security)

## 1) Emparejamiento de mensajes directos (acceso de chat entrante)

Cuando un canal está configurado con política de mensajes directos `pairing`, los remitentes desconocidos reciben un código corto y su mensaje **no se procesa** hasta que apruebes.

Las políticas predeterminadas de mensajes directos están documentadas en: [Seguridad](/gateway/security)

Códigos de emparejamiento:

- 8 caracteres, mayúsculas, sin caracteres ambiguos (`0O1I`).
- **Expiran después de 1 hora**. El bot solo envía el mensaje de emparejamiento cuando se crea una nueva solicitud (aproximadamente una vez por hora por remitente).
- Las solicitudes pendientes de emparejamiento de mensajes directos están limitadas a **3 por canal** por defecto; solicitudes adicionales se ignoran hasta que una expire o sea aprobada.

### Aprobar un remitente

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Canales soportados: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### Dónde vive el estado

Almacenado bajo `~/.openclaw/credentials/`:

- Solicitudes pendientes: `<channel>-pairing.json`
- Almacén de lista de permitidos aprobados: `<channel>-allowFrom.json`

Trata estos como sensibles (controlan el acceso a tu asistente).

## 2) Emparejamiento de dispositivo nodo (nodos iOS/Android/macOS/sin interfaz)

Los nodos se conectan al Gateway como **dispositivos** con `role: node`. El Gateway
crea una solicitud de emparejamiento de dispositivo que debe ser aprobada.

### Emparejar vía Telegram (recomendado para iOS)

Si usas el plugin `device-pair`, puedes hacer el emparejamiento de dispositivo por primera vez completamente desde Telegram:

1. En Telegram, envía un mensaje a tu bot: `/pair`
2. El bot responde con dos mensajes: un mensaje de instrucción y un mensaje de **código de configuración** separado (fácil de copiar/pegar en Telegram).
3. En tu teléfono, abre la app OpenClaw iOS → Configuración → Gateway.
4. Pega el código de configuración y conéctate.
5. De vuelta en Telegram: `/pair approve`

El código de configuración es un payload JSON codificado en base64 que contiene:

- `url`: la URL WebSocket del Gateway (`ws://...` o `wss://...`)
- `token`: un token de emparejamiento de corta duración

Trata el código de configuración como una contraseña mientras sea válido.

### Aprobar un dispositivo nodo

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Almacenamiento del estado de emparejamiento de nodos

Almacenado bajo `~/.openclaw/devices/`:

- `pending.json` (corta duración; las solicitudes pendientes expiran)
- `paired.json` (dispositivos emparejados + tokens)

### Notas

- La API heredada `node.pair.*` (CLI: `openclaw nodes pending/approve`) es un
  almacén de emparejamiento propiedad del gateway separado. Los nodos WS aún requieren emparejamiento de dispositivo.

## Documentación relacionada

- Modelo de seguridad + inyección de prompts: [Seguridad](/gateway/security)
- Actualizar de forma segura (ejecutar doctor): [Actualizar](/install/updating)
- Configuraciones de canales:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (heredado): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
