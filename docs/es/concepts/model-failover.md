---
summary: "Cómo OpenClaw rota perfiles de autenticación y realiza fallback entre modelos"
read_when:
  - Diagnosticar la rotación de perfiles de autenticación, los cooldowns o el comportamiento de fallback de modelos
  - Actualizar reglas de failover para perfiles de autenticación o modelos
title: "Failover de modelos"
---

# Failover de modelos

OpenClaw maneja los fallos en dos etapas:

1. **Rotación de perfiles de autenticación** dentro del proveedor actual.
2. **Fallback de modelos** al siguiente modelo en `agents.defaults.model.fallbacks`.

Este documento explica las reglas en tiempo de ejecución y los datos que las respaldan.

## Almacenamiento de autenticación (claves + OAuth)

OpenClaw usa **perfiles de autenticación** tanto para claves de API como para tokens OAuth.

- Los secretos viven en `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (legado: `~/.openclaw/agent/auth-profiles.json`).
- La configuración `auth.profiles` / `auth.order` es **solo metadatos + enrutamiento** (sin secretos).
- Archivo OAuth legado solo para importación: `~/.openclaw/credentials/oauth.json` (importado en `auth-profiles.json` en el primer uso).

Más detalles: [/concepts/oauth](/concepts/oauth)

Tipos de credenciales:

- `type: "api_key"` → `{ provider, key }`
- `type: "oauth"` → `{ provider, access, refresh, expires, email? }` (+ `projectId`/`enterpriseUrl` para algunos proveedores)

## IDs de perfil

Los inicios de sesión OAuth crean perfiles distintos para que puedan coexistir varias cuentas.

- Predeterminado: `provider:default` cuando no hay un correo disponible.
- OAuth con correo: `provider:<email>` (por ejemplo `google-antigravity:user@gmail.com`).

Los perfiles viven en `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` bajo `profiles`.

## Orden de rotación

Cuando un proveedor tiene varios perfiles, OpenClaw elige un orden como este:

1. **Configuración explícita**: `auth.order[provider]` (si está configurada).
2. **Perfiles configurados**: `auth.profiles` filtrados por proveedor.
3. **Perfiles almacenados**: entradas en `auth-profiles.json` para el proveedor.

Si no se configura un orden explícito, OpenClaw usa un orden round‑robin:

- **Clave primaria:** tipo de perfil (**OAuth antes que claves de API**).
- **Clave secundaria:** `usageStats.lastUsed` (el más antiguo primero, dentro de cada tipo).
- Los **perfiles en cooldown/deshabilitados** se mueven al final, ordenados por la expiración más próxima.

### Afinidad de sesión (amigable con caché)

OpenClaw **fija el perfil de autenticación elegido por sesión** para mantener calientes las cachés del proveedor.
**No** rota en cada solicitud. El perfil fijado se reutiliza hasta que:

- la sesión se restablece (`/new` / `/reset`)
- se completa una compactación (se incrementa el conteo de compactación)
- el perfil entra en cooldown o queda deshabilitado

La selección manual mediante `/model …@<profileId>` establece una **anulación del usuario** para esa sesión
y no se rota automáticamente hasta que comienza una nueva sesión.

Los perfiles fijados automáticamente (seleccionados por el enrutador de sesión) se tratan como una **preferencia**:
se intentan primero, pero OpenClaw puede rotar a otro perfil ante límites de tasa/tiempos de espera.
Los perfiles fijados por el usuario permanecen bloqueados a ese perfil; si falla y hay fallbacks de modelo
configurados, OpenClaw pasa al siguiente modelo en lugar de cambiar de perfil.

### Por qué OAuth puede “parecer perdido”

Si tiene tanto un perfil OAuth como un perfil de clave de API para el mismo proveedor, el round‑robin puede alternar entre ellos a lo largo de los mensajes si no están fijados. Para forzar un único perfil:

- Fíjelo con `auth.order[provider] = ["provider:profileId"]`, o
- Use una anulación por sesión mediante `/model …` con una anulación de perfil (cuando su UI/superficie de chat lo admita).

## Cooldowns

Cuando un perfil falla por errores de autenticación/límite de tasa (o por un tiempo de espera que parece
limitación de tasa), OpenClaw lo marca en cooldown y pasa al siguiente perfil.
Los errores de formato/solicitud inválida (por ejemplo, fallos de validación del ID de llamada de herramienta de Cloud Code Assist) se tratan como susceptibles de failover y usan los mismos cooldowns.

Los cooldowns usan backoff exponencial:

- 1 minuto
- 5 minutos
- 25 minutos
- 1 hora (límite)

El estado se almacena en `auth-profiles.json` bajo `usageStats`:

```json
{
  "usageStats": {
    "provider:profile": {
      "lastUsed": 1736160000000,
      "cooldownUntil": 1736160600000,
      "errorCount": 2
    }
  }
}
```

## Deshabilitaciones por facturación

Los fallos de facturación/crédito (por ejemplo, “créditos insuficientes” / “saldo de crédito demasiado bajo”) se tratan como susceptibles de failover, pero normalmente no son transitorios. En lugar de un cooldown corto, OpenClaw marca el perfil como **deshabilitado** (con un backoff más largo) y rota al siguiente perfil/proveedor.

El estado se almacena en `auth-profiles.json`:

```json
{
  "usageStats": {
    "provider:profile": {
      "disabledUntil": 1736178000000,
      "disabledReason": "billing"
    }
  }
}
```

Valores predeterminados:

- El backoff de facturación comienza en **5 horas**, se duplica por cada fallo de facturación y tiene un tope de **24 horas**.
- Los contadores de backoff se restablecen si el perfil no ha fallado durante **24 horas** (configurable).

## Fallback de modelos

Si fallan todos los perfiles de un proveedor, OpenClaw pasa al siguiente modelo en
`agents.defaults.model.fallbacks`. Esto aplica a fallos de autenticación, límites de tasa y
tiempos de espera que agotaron la rotación de perfiles (otros errores no avanzan el fallback).

Cuando una ejecución comienza con una anulación de modelo (hooks o CLI), los fallbacks aún terminan en
`agents.defaults.model.primary` después de intentar cualquier fallback configurado.

## Configuración relacionada

Consulte [Configuración del Gateway](/gateway/configuration) para:

- `auth.profiles` / `auth.order`
- `auth.cooldowns.billingBackoffHours` / `auth.cooldowns.billingBackoffHoursByProvider`
- `auth.cooldowns.billingMaxHours` / `auth.cooldowns.failureWindowHours`
- `agents.defaults.model.primary` / `agents.defaults.model.fallbacks`
- enrutamiento `agents.defaults.imageModel`

Consulte [Modelos](/concepts/models) para una visión general más amplia de la selección de modelos y el fallback.
