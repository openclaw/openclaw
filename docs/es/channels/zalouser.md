---
summary: "Compatibilidad con cuentas personales de Zalo mediante zca-cli (inicio de sesión por QR), capacidades y configuración"
read_when:
  - Configuración de Zalo Personal para OpenClaw
  - Depuración del inicio de sesión o del flujo de mensajes de Zalo Personal
title: "Zalo Personal"
---

# Zalo Personal (no oficial)

Estado: experimental. Esta integración automatiza una **cuenta personal de Zalo** mediante `zca-cli`.

> **Advertencia:** Esta es una integración no oficial y puede resultar en la suspensión o el bloqueo de la cuenta. Úsela bajo su propio riesgo.

## Plugin requerido

Zalo Personal se distribuye como un plugin y no está incluido en la instalación principal.

- Instalar vía CLI: `openclaw plugins install @openclaw/zalouser`
- O desde un checkout del código fuente: `openclaw plugins install ./extensions/zalouser`
- Detalles: [Plugins](/tools/plugin)

## Prerrequisito: zca-cli

La máquina del Gateway debe tener el binario `zca` disponible en `PATH`.

- Verificar: `zca --version`
- Si falta, instale zca-cli (consulte `extensions/zalouser/README.md` o la documentación upstream de zca-cli).

## Configuración rápida (principiante)

1. Instale el plugin (ver arriba).
2. Inicie sesión (QR, en la máquina del Gateway):
   - `openclaw channels login --channel zalouser`
   - Escanee el código QR en la terminal con la app móvil de Zalo.
3. Habilite el canal:

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

4. Reinicie el Gateway (o finalice el onboarding).
5. El acceso a mensajes directos se establece por defecto mediante emparejamiento; apruebe el código de emparejamiento en el primer contacto.

## Qué es

- Usa `zca listen` para recibir mensajes entrantes.
- Usa `zca msg ...` para enviar respuestas (texto/medios/enlaces).
- Diseñado para casos de uso de “cuenta personal” donde la API de Zalo Bot no está disponible.

## Nomenclatura

El id del canal es `zalouser` para dejar explícito que esto automatiza una **cuenta de usuario personal de Zalo** (no oficial). Mantenemos `zalo` reservado para una posible integración oficial futura con la API de Zalo.

## Búsqueda de IDs (directorio)

Use la CLI del directorio para descubrir pares/grupos y sus IDs:

```bash
openclaw directory self --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory groups list --channel zalouser --query "work"
```

## Límites

- El texto saliente se fragmenta en bloques de ~2000 caracteres (límites del cliente de Zalo).
- El streaming está bloqueado por defecto.

## Control de acceso (mensajes directos)

`channels.zalouser.dmPolicy` admite: `pairing | allowlist | open | disabled` (predeterminado: `pairing`).
`channels.zalouser.allowFrom` acepta IDs de usuario o nombres. El asistente resuelve nombres a IDs mediante `zca friend find` cuando está disponible.

Aprobación mediante:

- `openclaw pairing list zalouser`
- `openclaw pairing approve zalouser <code>`

## Acceso a grupos (opcional)

- Predeterminado: `channels.zalouser.groupPolicy = "open"` (grupos permitidos). Use `channels.defaults.groupPolicy` para sobrescribir el valor predeterminado cuando no esté configurado.
- Restrinja a una lista de permitidos con:
  - `channels.zalouser.groupPolicy = "allowlist"`
  - `channels.zalouser.groups` (las claves son IDs o nombres de grupo)
- Bloquear todos los grupos: `channels.zalouser.groupPolicy = "disabled"`.
- El asistente de configuración puede solicitar listas de permitidos de grupos.
- Al iniciar, OpenClaw resuelve los nombres de grupos/usuarios en las listas de permitidos a IDs y registra el mapeo; las entradas no resueltas se mantienen tal como se escribieron.

Ejemplo:

```json5
{
  channels: {
    zalouser: {
      groupPolicy: "allowlist",
      groups: {
        "123456789": { allow: true },
        "Work Chat": { allow: true },
      },
    },
  },
}
```

## Multicuenta

Las cuentas se asignan a perfiles de zca. Ejemplo:

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

**No se encuentra `zca`:**

- Instale zca-cli y asegúrese de que esté en `PATH` para el proceso del Gateway.

**El inicio de sesión no se mantiene:**

- `openclaw channels status --probe`
- Vuelva a iniciar sesión: `openclaw channels logout --channel zalouser && openclaw channels login --channel zalouser`
