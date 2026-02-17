---
summary: "Superficies web del Gateway: Interfaz de Control, modos de enlace y seguridad"
read_when:
  - Quieres acceder al Gateway a través de Tailscale
  - Quieres la Interfaz de Control del navegador y edición de configuración
title: "Web"
---

# Web (Gateway)

El Gateway sirve una pequeña **Interfaz de Control del navegador** (Vite + Lit) desde el mismo puerto que el WebSocket del Gateway:

- predeterminado: `http://<host>:18789/`
- prefijo opcional: establece `gateway.controlUi.basePath` (por ejemplo, `/openclaw`)

Las capacidades están en [Interfaz de Control](/es-ES/web/control-ui).
Esta página se centra en los modos de enlace, seguridad y superficies orientadas a la web.

## Webhooks

Cuando `hooks.enabled=true`, el Gateway también expone un pequeño endpoint de webhook en el mismo servidor HTTP.
Consulta [Configuración del Gateway](/es-ES/gateway/configuration) → `hooks` para auth + payloads.

## Config (activado por defecto)

La Interfaz de Control está **activada por defecto** cuando los recursos están presentes (`dist/control-ui`).
Puedes controlarla mediante la configuración:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath opcional
  },
}
```

## Acceso a Tailscale

### Serve integrado (recomendado)

Mantén el Gateway en bucle local y deja que Tailscale Serve lo proxifique:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Luego inicia el gateway:

```bash
openclaw gateway
```

Abre:

- `https://<magicdns>/` (o tu `gateway.controlUi.basePath` configurado)

### Bind de tailnet + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "tu-token" },
  },
}
```

Luego inicia el gateway (se requiere token para enlaces no loopback):

```bash
openclaw gateway
```

Abre:

- `http://<tailscale-ip>:18789/` (o tu `gateway.controlUi.basePath` configurado)

### Internet público (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // o OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Notas de seguridad

- Se requiere autenticación del Gateway por defecto (token/contraseña o encabezados de identidad de Tailscale).
- Los enlaces no loopback aún **requieren** un token/contraseña compartido (`gateway.auth` o env).
- El asistente genera un token del gateway por defecto (incluso en loopback).
- La interfaz envía `connect.params.auth.token` o `connect.params.auth.password`.
- La Interfaz de Control envía encabezados anti-clickjacking y solo acepta conexiones websocket
  del navegador del mismo origen a menos que se establezca `gateway.controlUi.allowedOrigins`.
- Con Serve, los encabezados de identidad de Tailscale pueden satisfacer la autenticación cuando
  `gateway.auth.allowTailscale` es `true` (no se requiere token/contraseña). Establece
  `gateway.auth.allowTailscale: false` para requerir credenciales explícitas. Consulta
  [Tailscale](/es-ES/gateway/tailscale) y [Seguridad](/es-ES/gateway/security).
- `gateway.tailscale.mode: "funnel"` requiere `gateway.auth.mode: "password"` (contraseña compartida).

## Construcción de la interfaz

El Gateway sirve archivos estáticos desde `dist/control-ui`. Constrúyelos con:

```bash
pnpm ui:build # instala automáticamente las dependencias de la interfaz en la primera ejecución
```
