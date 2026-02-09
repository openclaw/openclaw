---
summary: "Serve/Funnel de Tailscale integrados para el panel del Gateway"
read_when:
  - Exponer la IU de control del Gateway fuera de localhost
  - Automatizar el acceso al panel del tailnet o público
title: "Tailscale"
---

# Tailscale (panel del Gateway)

OpenClaw puede auto-configurar Tailscale **Serve** (tailnet) o **Funnel** (público) para el
panel del Gateway y el puerto WebSocket. Esto mantiene el Gateway vinculado a loopback mientras
Tailscale proporciona HTTPS, enrutamiento y (para Serve) encabezados de identidad.

## Modos

- `serve`: Serve solo para tailnet vía `tailscale serve`. El gateway permanece en `127.0.0.1`.
- `funnel`: HTTPS público vía `tailscale funnel`. OpenClaw requiere una contraseña compartida.
- `off`: Predeterminado (sin automatización de Tailscale).

## Autenticación

Configure `gateway.auth.mode` para controlar el handshake:

- `token` (predeterminado cuando `OPENCLAW_GATEWAY_TOKEN` está configurado)
- `password` (secreto compartido vía `OPENCLAW_GATEWAY_PASSWORD` o configuración)

Cuando `tailscale.mode = "serve"` y `gateway.auth.allowTailscale` es `true`,
las solicitudes válidas del proxy Serve pueden autenticarse mediante encabezados de identidad de Tailscale
(`tailscale-user-login`) sin proporcionar un token/contraseña. OpenClaw verifica
la identidad resolviendo la dirección `x-forwarded-for` a través del daemon local de Tailscale
(`tailscale whois`) y comparándola con el encabezado antes de aceptarla.
OpenClaw solo trata una solicitud como Serve cuando llega desde loopback con los encabezados
`x-forwarded-for`, `x-forwarded-proto` y `x-forwarded-host` de Tailscale.
Para exigir credenciales explícitas, configure `gateway.auth.allowTailscale: false` o
fuerce `gateway.auth.mode: "password"`.

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

Abrir: `https://<magicdns>/` (o su `gateway.controlUi.basePath` configurado)

### Solo tailnet (vincular a IP del Tailnet)

Use esto cuando quiera que el Gateway escuche directamente en la IP del Tailnet (sin Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Conéctese desde otro dispositivo del Tailnet:

- IU de control: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Nota: loopback (`http://127.0.0.1:18789`) **no** funcionará en este modo.

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

Prefiera `OPENCLAW_GATEWAY_PASSWORD` en lugar de confirmar una contraseña en disco.

## Ejemplos de CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Notas

- Tailscale Serve/Funnel requiere que la CLI `tailscale` esté instalada e iniciada sesión.
- `tailscale.mode: "funnel"` se niega a iniciar a menos que el modo de autenticación sea `password` para evitar exposición pública.
- Configure `gateway.tailscale.resetOnExit` si desea que OpenClaw deshaga la configuración de `tailscale serve`
  o `tailscale funnel` al apagarse.
- `gateway.bind: "tailnet"` es un enlace directo al Tailnet (sin HTTPS, sin Serve/Funnel).
- `gateway.bind: "auto"` prefiere loopback; use `tailnet` si desea solo Tailnet.
- Serve/Funnel solo exponen la **IU de control del Gateway + WS**. Los nodos se conectan a través
  del mismo endpoint WS del Gateway, por lo que Serve puede funcionar para el acceso de nodos.

## Control del navegador (Gateway remoto + navegador local)

Si ejecuta el Gateway en una máquina pero desea manejar un navegador en otra,
ejecute un **host de nodo** en la máquina del navegador y mantenga ambos en el mismo tailnet.
El Gateway hará de proxy de las acciones del navegador hacia el nodo; no se necesita un servidor
de control separado ni una URL de Serve.

Evite Funnel para el control del navegador; trate el emparejamiento de nodos como acceso de operador.

## Requisitos previos y límites de Tailscale

- Serve requiere HTTPS habilitado para su tailnet; la CLI le avisará si falta.
- Serve inyecta encabezados de identidad de Tailscale; Funnel no.
- Funnel requiere Tailscale v1.38.3+, MagicDNS, HTTPS habilitado y un atributo de nodo funnel.
- Funnel solo admite los puertos `443`, `8443` y `10000` sobre TLS.
- Funnel en macOS requiere la variante de la app Tailscale de código abierto.

## Más información

- Descripción general de Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Comando `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Descripción general de Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Comando `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
