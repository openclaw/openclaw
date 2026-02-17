---
summary: "Soporte de cuenta personal de Zalo mediante zca-cli (inicio de sesión QR), capacidades y configuración"
read_when:
  - Configurando Zalo Personal para OpenClaw
  - Depurando inicio de sesión o flujo de mensajes de Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (no oficial)

Estado: experimental. Esta integración automatiza una **cuenta personal de Zalo** mediante `zca-cli`.

> **Advertencia:** Esta es una integración no oficial y puede resultar en la suspensión/baneo de la cuenta. Úsala bajo tu propio riesgo.

## Plugin requerido

Zalo Personal se distribuye como plugin y no viene incluido con la instalación principal.

- Instalar mediante CLI: `openclaw plugins install @openclaw/zalouser`
- O desde un checkout de fuente: `openclaw plugins install ./extensions/zalouser`
- Detalles: [Plugins](/es-ES/tools/plugin)

## Prerequisito: zca-cli

La máquina del Gateway debe tener el binario `zca` disponible en `PATH`.

- Verificar: `zca --version`
- Si falta, instala zca-cli (consulta `extensions/zalouser/README.md` o la documentación de zca-cli upstream).

## Configuración rápida (principiante)

1. Instala el plugin (ver arriba).
2. Inicia sesión (QR, en la máquina del Gateway):
   - `openclaw channels login --channel zalouser`
   - Escanea el código QR en el terminal con la app móvil de Zalo.
3. Habilita el canal:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      dmPolicy: "pairing",
    },
  },
}
```

4. Reinicia el Gateway (o termina la incorporación).
5. El acceso a mensajes directos usa emparejamiento por defecto; aprueba el código de emparejamiento en el primer contacto.

## Qué es

- Usa `zca listen` para recibir mensajes entrantes.
- Usa `zca msg ...` para enviar respuestas (texto/medios/enlace).
- Diseñado para casos de uso de "cuenta personal" donde la API de Bot de Zalo no está disponible.

## Nomenclatura

El id del canal es `zalouser` para dejar explícito que esto automatiza una **cuenta de usuario personal de Zalo** (no oficial). Mantenemos `zalo` reservado para una posible futura integración oficial de la API de Zalo.

## Encontrar IDs (directorio)

Usa el CLI de directorio para descubrir pares/grupos y sus IDs:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "nombre"
openclaw directory groups list --channel zalouser --query "trabajo"
```

## Límites

- El texto de salida se fragmenta en ~2000 caracteres (límites del cliente de Zalo).
- El streaming está bloqueado por defecto.

## Control de acceso (mensajes directos)

`channels.zalouser.dmPolicy` admite: `pairing | allowlist | open | disabled` (predeterminado: `pairing`).
`channels.zalouser.allowFrom` acepta IDs de usuario o nombres. El asistente resuelve nombres a IDs mediante `zca friend find` cuando está disponible.

Aprobar mediante:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Acceso a grupos (opcional)

- Predeterminado: `channels.zalouser.groupPolicy = "open"` (grupos permitidos). Usa `channels.defaults.groupPolicy` para anular el predeterminado cuando no esté establecido.
- Restringir a una lista de permitidos con:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (las claves son IDs o nombres de grupo)
- Bloquear todos los grupos: `channels.zalouser.groupPolicy = "disabled"`.
- El asistente de configuración puede solicitar listas de permitidos de grupos.
- Al iniciar, OpenClaw resuelve nombres de grupo/usuario en listas de permitidos a IDs y registra el mapeo; las entradas no resueltas se mantienen como están escritas.

Ejemplo:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Chat de trabajo": { allow: true },
      },
    },
  },
}
```

## Multi-cuenta

Las cuentas se mapean a perfiles de zca. Ejemplo:

```json5
{
  channels: {
    zalouser: {
      enabled: true,
      defaultAccount: "default",
      accounts: {
        work: { enabled: true, profile: "work" },
      },
    },
  },
}
```

## Solución de problemas

**`zca` no encontrado:**

- Instala zca-cli y asegúrate de que esté en `PATH` para el proceso del Gateway.

**El inicio de sesión no persiste:**

- `openclaw channels status --probe`
- Re-iniciar sesión: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
