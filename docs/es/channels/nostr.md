---
summary: "Canal de mensajes directos de Nostr mediante mensajes cifrados NIP-04"
read_when:
  - Quiere que OpenClaw reciba mensajes directos mediante Nostr
  - Está configurando mensajería descentralizada
title: "Nostr"
---

# Nostr

**Estado:** Plugin opcional (deshabilitado de forma predeterminada).

Nostr es un protocolo descentralizado para redes sociales. Este canal permite que OpenClaw reciba y responda a mensajes directos (DMs) cifrados mediante NIP-04.

## Instalación (bajo demanda)

### Incorporación (recomendado)

- El asistente de incorporación (`openclaw onboard`) y `openclaw channels add` enumeran plugins de canal opcionales.
- Al seleccionar Nostr, se le pedirá instalar el plugin bajo demanda.

Valores predeterminados de instalación:

- **Canal Dev + checkout de git disponible:** usa la ruta local del plugin.
- **Stable/Beta:** descarga desde npm.

Siempre puede sobrescribir la elección en el aviso.

### Instalación manual

```bash
openclaw plugins install @openclaw/nostr
```

Usar un checkout local (flujos de trabajo de desarrollo):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Reinicie el Gateway después de instalar o habilitar plugins.

## Configuración rápida

1. Genere un par de claves de Nostr (si es necesario):

```bash
# Using nak
nak key generate
```

2. Agregue a la configuración:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Exporte la clave:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Reinicie el Gateway.

## Referencia de configuración

| Clave        | Tipo                                                         | Predeterminado                              | Descripción                                 |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------- |
| `privateKey` | string                                                       | required                                    | Clave privada en formato `nsec` o hex       |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URLs de relé (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Política de acceso a DMs                    |
| `allowFrom`  | string[] | `[]`                                        | Pubkeys de remitentes permitidos            |
| `enabled`    | boolean                                                      | `true`                                      | Habilitar/deshabilitar el canal             |
| `name`       | string                                                       | -                                           | Nombre para mostrar                         |
| `profile`    | object                                                       | -                                           | Metadatos de perfil NIP-01                  |

## Metadatos de perfil

Los datos del perfil se publican como un evento NIP-01 `kind:0`. Puede administrarlos desde la IU de Control (Canales -> Nostr -> Perfil) o configurarlos directamente en la configuración.

Ejemplo:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
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
- La importación desde relés fusiona campos y conserva las sobrescrituras locales.

## Control de acceso

### Políticas de DM

- **pairing** (predeterminado): los remitentes desconocidos reciben un código de emparejamiento.
- **allowlist**: solo los pubkeys en `allowFrom` pueden enviar DM.
- **open**: DMs entrantes públicos (requiere `allowFrom: ["*"]`).
- **disabled**: ignorar DMs entrantes.

### Ejemplo de allowlist

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

## Relés

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

- Use 2–3 relés para redundancia.
- Evite demasiados relés (latencia, duplicación).
- Los relés de pago pueden mejorar la confiabilidad.
- Los relés locales son adecuados para pruebas (`ws://localhost:7777`).

## Compatibilidad de protocolo

| NIP    | Estado      | Descripción                                     |
| ------ | ----------- | ----------------------------------------------- |
| NIP-01 | Compatible  | Formato básico de eventos + metadatos de perfil |
| NIP-04 | Compatible  | DMs cifrados (`kind:4`)      |
| NIP-17 | Planificado | DMs con envoltura de regalo                     |
| NIP-44 | Planificado | Cifrado Versionado                              |

## Pruebas

### Relé local

```bash
# Start strfry
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

1. Anote el pubkey del bot (npub) desde los logs.
2. Abra un cliente de Nostr (Damus, Amethyst, etc.).
3. Envíe un DM al pubkey del bot.
4. Verifique la respuesta.

## Solución de problemas

### No se reciben mensajes

- Verifique que la clave privada sea válida.
- Asegúrese de que las URLs de los relés sean accesibles y usen `wss://` (o `ws://` para local).
- Confirme que `enabled` no sea `false`.
- Revise los logs del Gateway para detectar errores de conexión con relés.

### No se envían respuestas

- Verifique que el relé acepte escrituras.
- Verifique la conectividad de salida.
- Esté atento a los límites de tasa del relé.

### Respuestas duplicadas

- Es esperable al usar múltiples relés.
- Los mensajes se desduplican por ID de evento; solo la primera entrega activa una respuesta.

## Seguridad

- Nunca confirme claves privadas en repositorios.
- Use variables de entorno para las claves.
- Considere `allowlist` para bots en producción.

## Limitaciones (MVP)

- Solo mensajes directos (sin chats grupales).
- Sin adjuntos multimedia.
- Solo NIP-04 (NIP-17 con envoltura de regalo planificado).
