---
summary: "Acceso remoto usando túneles SSH (Gateway WS) y tailnets"
read_when:
  - Ejecutando o solucionando problemas de configuraciones de gateway remoto
title: "Acceso Remoto"
---

# Acceso remoto (SSH, túneles y tailnets)

Este repositorio soporta "remoto sobre SSH" manteniendo un único Gateway (el maestro) ejecutándose en un host dedicado (escritorio/servidor) y conectando clientes a él.

- Para **operadores (tú / la app de macOS)**: los túneles SSH son el respaldo universal.
- Para **nodos (iOS/Android y futuros dispositivos)**: conéctate al **WebSocket** del Gateway (LAN/tailnet o túnel SSH según sea necesario).

## La idea central

- El WebSocket del Gateway se enlaza a **bucle local** en tu puerto configurado (predeterminado 18789).
- Para uso remoto, reenvías ese puerto de bucle local sobre SSH (o usas un tailnet/VPN y túnel menos).

## Configuraciones comunes de VPN/tailnet (donde vive el agente)

Piensa en el **host del Gateway** como "donde vive el agente". Es propietario de sesiones, perfiles de autenticación, canales y estado.
Tu laptop/escritorio (y nodos) se conectan a ese host.

### 1) Gateway siempre activo en tu tailnet (VPS o servidor doméstico)

Ejecuta el Gateway en un host persistente y accede a él a través de **Tailscale** o SSH.

- **Mejor UX:** mantén `gateway.bind: "loopback"` y usa **Tailscale Serve** para la Interfaz de Control.
- **Respaldo:** mantén bucle local + túnel SSH desde cualquier máquina que necesite acceso.
- **Ejemplos:** [exe.dev](/es-ES/install/exe-dev) (VM fácil) o [Hetzner](/es-ES/install/hetzner) (VPS de producción).

Esto es ideal cuando tu laptop duerme a menudo pero quieres que el agente esté siempre activo.

### 2) El escritorio doméstico ejecuta el Gateway, la laptop es control remoto

La laptop **no** ejecuta el agente. Se conecta remotamente:

- Usa el modo **Remoto sobre SSH** de la app de macOS (Configuración → General → "OpenClaw se ejecuta").
- La app abre y gestiona el túnel, por lo que WebChat + verificaciones de salud "simplemente funcionan".

Runbook: [acceso remoto de macOS](/es-ES/platforms/mac/remote).

### 3) La laptop ejecuta el Gateway, acceso remoto desde otras máquinas

Mantén el Gateway local pero exponlo de forma segura:

- Túnel SSH a la laptop desde otras máquinas, o
- Tailscale Serve la Interfaz de Control y mantén el Gateway solo en bucle local.

Guía: [Tailscale](/es-ES/gateway/tailscale) y [descripción general de Web](/es-ES/web).

## Flujo de comandos (qué se ejecuta dónde)

Un servicio gateway posee estado + canales. Los nodos son periféricos.

Ejemplo de flujo (Telegram → nodo):

- El mensaje de Telegram llega al **Gateway**.
- El Gateway ejecuta el **agente** y decide si llamar a una herramienta de nodo.
- El Gateway llama al **nodo** sobre el WebSocket del Gateway (RPC `node.*`).
- El nodo devuelve el resultado; el Gateway responde de vuelta a Telegram.

Notas:

- **Los nodos no ejecutan el servicio gateway.** Solo un gateway debe ejecutarse por host a menos que ejecutes intencionalmente perfiles aislados (ver [Múltiples gateways](/es-ES/gateway/multiple-gateways)).
- El "modo nodo" de la app de macOS es solo un cliente de nodo sobre el WebSocket del Gateway.

## Túnel SSH (CLI + herramientas)

Crea un túnel local al WS del Gateway remoto:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Con el túnel activo:

- `openclaw health` y `openclaw status --deep` ahora alcanzan el gateway remoto a través de `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` también puede dirigirse a la URL reenviada a través de `--url` cuando sea necesario.

Nota: reemplaza `18789` con tu `gateway.port` configurado (o `--port`/`OPENCLAW_GATEWAY_PORT`).
Nota: cuando pasas `--url`, la CLI no recurre a las credenciales de config o entorno.
Incluye `--token` o `--password` explícitamente. Faltar credenciales explícitas es un error.

## Valores predeterminados remotos de CLI

Puedes persistir un objetivo remoto para que los comandos CLI lo usen por defecto:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "tu-token",
    },
  },
}
```

Cuando el gateway es solo de bucle local, mantén la URL en `ws://127.0.0.1:18789` y abre el túnel SSH primero.

## UI de Chat sobre SSH

WebChat ya no usa un puerto HTTP separado. La UI de chat SwiftUI se conecta directamente al WebSocket del Gateway.

- Reenvía `18789` sobre SSH (ver arriba), luego conecta clientes a `ws://127.0.0.1:18789`.
- En macOS, prefiere el modo "Remoto sobre SSH" de la app, que gestiona el túnel automáticamente.

## App de macOS "Remoto sobre SSH"

La app de barra de menú de macOS puede gestionar la misma configuración de extremo a extremo (verificaciones de estado remotas, WebChat y reenvío de Activación por Voz).

Runbook: [acceso remoto de macOS](/es-ES/platforms/mac/remote).

## Reglas de seguridad (remoto/VPN)

Versión corta: **mantén el Gateway solo en bucle local** a menos que estés seguro de que necesitas un enlace.

- **Bucle local + SSH/Tailscale Serve** es el predeterminado más seguro (sin exposición pública).
- **Enlaces no de bucle local** (`lan`/`tailnet`/`custom`, o `auto` cuando bucle local no está disponible) deben usar tokens/contraseñas de autenticación.
- `gateway.remote.token` es **solo** para llamadas CLI remotas — **no** habilita autenticación local.
- `gateway.remote.tlsFingerprint` fija el certificado TLS remoto cuando se usa `wss://`.
- **Tailscale Serve** puede autenticar a través de encabezados de identidad cuando `gateway.auth.allowTailscale: true`.
  Establécelo en `false` si quieres tokens/contraseñas en su lugar.
- Trata el control del navegador como acceso de operador: solo tailnet + emparejamiento de nodos deliberado.

Análisis profundo: [Seguridad](/es-ES/gateway/security).
