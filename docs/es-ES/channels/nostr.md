---
summary: "Canal de mensajes directos de Nostr mediante mensajes cifrados NIP-04"
read_when:
  - Quieres que OpenClaw reciba mensajes directos mediante Nostr
  - Estás configurando mensajería descentralizada
title: "Nostr"
---

# Nostr

**Estado:** Plugin opcional (deshabilitado por defecto).

Nostr es un protocolo descentralizado para redes sociales. Este canal permite que OpenClaw reciba y responda a mensajes directos (DMs) cifrados mediante NIP-04.

## Instalar (bajo demanda)

### Incorporación (recomendado)

- El asistente de incorporación (`openclaw onboard`) y `openclaw channels add` listan plugins de canal opcionales.
- Seleccionar Nostr te solicita instalar el plugin bajo demanda.

Valores predeterminados de instalación:

- **Canal dev + checkout de git disponible:** usa la ruta del plugin local.
- **Estable/Beta:** descarga desde npm.

Siempre puedes anular la elección en la solicitud.

### Instalación manual

```bash
openclaw plugins install @openclaw/nostr
```

Usar un checkout local (flujos de trabajo dev):

```bash
openclaw plugins install --link <ruta-a-openclaw>/extensions/nostr
```

Reinicia el Gateway después de instalar o habilitar plugins.

## Configuración rápida

1. Genera un par de claves de Nostr (si es necesario):

```bash
# Usando nak
nak key generate
```

2. Añade a la configuración:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Exporta la clave:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Reinicia el Gateway.

## Referencia de configuración

| Clave        | Tipo     | Predeterminado                              | Descripción                           |
| ------------ | -------- | ------------------------------------------- | ------------------------------------- |
| `privateKey` | string   | requerido                                   | Clave privada en formato `nsec` o hex|
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URLs de Relay (WebSocket)             |
| `dmPolicy`   | string   | `pairing`                                   | Política de acceso a mensajes directos|
| `allowFrom`  | string[] | `[]`                                        | Pubkeys de remitentes permitidos      |
| `enabled`    | boolean  | `true`                                      | Habilitar/deshabilitar canal          |
| `name`       | string   | -                                           | Nombre para mostrar                   |
| `profile`    | object   | -                                           | Metadatos de perfil NIP-01            |

## Metadatos de perfil

Los datos de perfil se publican como un evento NIP-01 `kind:0`. Puedes gestionarlos desde la UI de Control (Canales -> Nostr -> Perfil) o establecerlos directamente en la configuración.

Ejemplo:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Bot DM de asistente personal",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Notas:

- Las URLs de perfil deben usar `https://`.
- La importación desde relays fusiona campos y preserva anulaciones locales.

## Control de acceso

### Políticas de mensajes directos

- **pairing** (predeterminado): los remitentes desconocidos obtienen un código de emparejamiento.
- **allowlist**: solo los pubkeys en `allowFrom` pueden enviar mensajes directos.
- **open**: mensajes directos entrantes públicos (requiere `allowFrom: ["*"]`).
- **disabled**: ignorar mensajes directos entrantes.

### Ejemplo de lista de permitidos

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Formatos de clave

Formatos aceptados:

- **Clave privada:** `nsec...` o hex de 64 caracteres
- **Pubkeys (`allowFrom`):** `npub...` o hex

## Relays

Predeterminados: `relay.damus.io` y `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Consejos:

- Usa 2-3 relays para redundancia.
- Evita demasiados relays (latencia, duplicación).
- Los relays de pago pueden mejorar la fiabilidad.
- Los relays locales son adecuados para pruebas (`ws://localhost:7777`).

## Soporte de protocolo

| NIP    | Estado      | Descripción                              |
| ------ | ----------- | ---------------------------------------- |
| NIP-01 | Compatible  | Formato de evento básico + metadatos de perfil |
| NIP-04 | Compatible  | DMs cifrados (`kind:4`)                  |
| NIP-17 | Planificado | DMs envueltos como regalo                |
| NIP-44 | Planificado | Cifrado versionado                       |

## Pruebas

### Relay local

```bash
# Iniciar strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Prueba manual

1. Anota el pubkey del bot (npub) desde los logs.
2. Abre un cliente de Nostr (Damus, Amethyst, etc.).
3. Envía un mensaje directo al pubkey del bot.
4. Verifica la respuesta.

## Solución de problemas

### No recibe mensajes

- Verifica que la clave privada sea válida.
- Asegúrate de que las URLs de relay sean accesibles y usen `wss://` (o `ws://` para local).
- Confirma que `enabled` no esté en `false`.
- Verifica los logs del Gateway para errores de conexión de relay.

### No envía respuestas

- Verifica que el relay acepte escrituras.
- Verifica la conectividad de salida.
- Vigila los límites de tasa del relay.

### Respuestas duplicadas

- Esperado al usar múltiples relays.
- Los mensajes se dedupen por ID de evento; solo la primera entrega activa una respuesta.

## Seguridad

- Nunca confirmes claves privadas en git.
- Usa variables de entorno para claves.
- Considera `allowlist` para bots de producción.

## Limitaciones (MVP)

- Solo mensajes directos (sin chats grupales).
- Sin adjuntos multimedia.
- Solo NIP-04 (gift-wrap NIP-17 planificado).
