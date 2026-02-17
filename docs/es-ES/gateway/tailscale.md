---
summary: "Integración de Tailscale Serve/Funnel para el panel de control del Gateway"
read_when:
  - Exponer la UI de control del Gateway fuera de localhost
  - Automatizar el acceso al panel de control en tailnet o público
title: "Tailscale"
---

# Tailscale (panel de control del Gateway)

OpenClaw puede configurar automáticamente Tailscale **Serve** (tailnet) o **Funnel** (público) para
el panel de control del Gateway y el puerto WebSocket. Esto mantiene el Gateway vinculado a loopback mientras
Tailscale proporciona HTTPS, enrutamiento y (para Serve) encabezados de identidad.

## Modos

- `serve`: Serve exclusivo de tailnet mediante `tailscale serve`. El gateway permanece en `127.0.0.1`.
- `funnel`: HTTPS público mediante `tailscale funnel`. OpenClaw requiere una contraseña compartida.
- `off`: Por defecto (sin automatización de Tailscale).

## Autenticación

Configura `gateway.auth.mode` para controlar el protocolo de autenticación:

- `token` (por defecto cuando `OPENCLAW_GATEWAY_TOKEN` está configurado)
- `password` (secreto compartido mediante `OPENCLAW_GATEWAY_PASSWORD` o config)

Cuando `tailscale.mode = "serve"` y `gateway.auth.allowTailscale` es `true`,
las solicitudes de proxy Serve válidas pueden autenticarse mediante encabezados de identidad de Tailscale
(`tailscale-user-login`) sin proporcionar un token/contraseña. OpenClaw verifica
la identidad resolviendo la dirección `x-forwarded-for` mediante el demonio local de Tailscale
(`tailscale whois`) y comparándola con el encabezado antes de aceptarla.
OpenClaw solo trata una solicitud como Serve cuando llega desde loopback con
los encabezados `x-forwarded-for`, `x-forwarded-proto` y `x-forwarded-host` de Tailscale.
Para requerir credenciales explícitas, configura `gateway.auth.allowTailscale: false` o
fuerza `gateway.auth.mode: "password"`.

## Ejemplos de configuración

### Solo tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Abre: `https://<magicdns>/` (o tu `gateway.controlUi.basePath` configurado)

### Solo tailnet (vincular a IP de tailnet)

Usa esto cuando quieras que el Gateway escuche directamente en la IP de tailnet (sin Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Conéctate desde otro dispositivo de tailnet:

- UI de control: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Nota: loopback (`http://127.0.0.1:18789`) **no funcionará** en este modo.

### Internet público (Funnel + contraseña compartida)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Prefiere `OPENCLAW_GATEWAY_PASSWORD` en lugar de confirmar una contraseña en disco.

## Ejemplos CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notas

- Tailscale Serve/Funnel requiere que el CLI `tailscale` esté instalado y con sesión iniciada.
- `tailscale.mode: "funnel"` se niega a iniciar a menos que el modo de autenticación sea `password` para evitar exposición pública.
- Configura `gateway.tailscale.resetOnExit` si quieres que OpenClaw deshaga la configuración de `tailscale serve`
  o `tailscale funnel` al apagarse.
- `gateway.bind: "tailnet"` es una vinculación directa a tailnet (sin HTTPS, sin Serve/Funnel).
- `gateway.bind: "auto"` prefiere loopback; usa `tailnet` si quieres solo tailnet.
- Serve/Funnel solo expone la **UI de control del Gateway + WS**. Los nodos se conectan sobre
  el mismo endpoint WS del Gateway, por lo que Serve puede funcionar para acceso de nodos.

## Control del navegador (Gateway remoto + navegador local)

Si ejecutas el Gateway en una máquina pero quieres controlar un navegador en otra máquina,
ejecuta un **node host** en la máquina del navegador y mantén ambos en el mismo tailnet.
El Gateway hará proxy de las acciones del navegador al nodo; no se necesita servidor de control o URL Serve separada.

Evita Funnel para control del navegador; trata el emparejamiento de nodos como acceso de operador.

## Prerrequisitos + límites de Tailscale

- Serve requiere HTTPS habilitado para tu tailnet; el CLI solicita si falta.
- Serve inyecta encabezados de identidad de Tailscale; Funnel no lo hace.
- Funnel requiere Tailscale v1.38.3+, MagicDNS, HTTPS habilitado y un atributo de nodo funnel.
- Funnel solo admite los puertos `443`, `8443` y `10000` sobre TLS.
- Funnel en macOS requiere la variante de aplicación Tailscale de código abierto.

## Aprende más

- Resumen de Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Comando `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Resumen de Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Comando `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
