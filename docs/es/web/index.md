---
summary: "Superficies web del Gateway: IU de control, modos de enlace y seguridad"
read_when:
  - Quiere acceder al Gateway a través de Tailscale
  - Quiere la IU de Control en el navegador y la edición de configuración
title: "Web"
---

# Web (Gateway)

El Gateway ofrece una pequeña **IU de Control en el navegador** (Vite + Lit) desde el mismo puerto que el WebSocket del Gateway:

- predeterminado: `http://<host>:18789/`
- prefijo opcional: configure `gateway.controlUi.basePath` (p. ej., `/openclaw`)

Las capacidades se describen en [Control UI](/web/control-ui).
Esta página se centra en los modos de enlace, la seguridad y las superficies expuestas en la web.

## Webhooks

Cuando `hooks.enabled=true`, el Gateway también expone un pequeño endpoint de webhook en el mismo servidor HTTP.
Consulte [Configuración del Gateway](/gateway/configuration) → `hooks` para autenticación y cargas útiles.

## Configuración (activada por defecto)

La IU de Control está **habilitada de forma predeterminada** cuando los recursos están presentes (`dist/control-ui`).
Puede controlarla mediante la configuración:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Acceso con Tailscale

### Serve integrado (recomendado)

Mantenga el Gateway en loopback y deje que Tailscale Serve lo proxifique:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Luego inicie el gateway:

```bash
openclaw gateway
```

Abra:

- `https://<magicdns>/` (o su `gateway.controlUi.basePath` configurado)

### Enlace al tailnet + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Luego inicie el gateway (se requiere token para enlaces que no sean loopback):

```bash
openclaw gateway
```

Abra:

- `http://<tailscale-ip>:18789/` (o su `gateway.controlUi.basePath` configurado)

### Internet público (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Notas de seguridad

- La autenticación del Gateway es obligatoria de forma predeterminada (token/contraseña o encabezados de identidad de Tailscale).
- Los enlaces que no sean loopback **siguen requiriendo** un token/contraseña compartido (`gateway.auth` o variable de entorno).
- El asistente genera un token del gateway de forma predeterminada (incluso en loopback).
- La IU envía `connect.params.auth.token` o `connect.params.auth.password`.
- La IU de Control envía encabezados anti–clickjacking y solo acepta conexiones WebSocket del navegador del mismo origen, a menos que se configure `gateway.controlUi.allowedOrigins`.
- Con Serve, los encabezados de identidad de Tailscale pueden satisfacer la autenticación cuando
  `gateway.auth.allowTailscale` es `true` (no se requiere token/contraseña). Configure
  `gateway.auth.allowTailscale: false` para exigir credenciales explícitas. Consulte
  [Tailscale](/gateway/tailscale) y [Seguridad](/gateway/security).
- `gateway.tailscale.mode: "funnel"` requiere `gateway.auth.mode: "password"` (contraseña compartida).

## Construcción de la UI

El Gateway sirve archivos estáticos desde `dist/control-ui`. Compílelos con:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
