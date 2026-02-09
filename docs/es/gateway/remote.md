---
summary: "Acceso remoto mediante túneles SSH (Gateway WS) y tailnets"
read_when:
  - Ejecución o solución de problemas de configuraciones de Gateway remotas
title: "Acceso remoto"
---

# Acceso remoto (SSH, túneles y tailnets)

Este repositorio admite “remoto por SSH” manteniendo un único Gateway (el maestro) ejecutándose en un host dedicado (escritorio/servidor) y conectando clientes a él.

- Para **operadores (usted / la app de macOS)**: el túnel SSH es el respaldo universal.
- Para **nodos (iOS/Android y dispositivos futuros)**: conéctese al **WebSocket** del Gateway (LAN/tailnet o túnel SSH según sea necesario).

## La idea central

- El WebSocket del Gateway se enlaza a **loopback** en el puerto configurado (predeterminado: 18789).
- Para uso remoto, reenvíe ese puerto de loopback mediante SSH (o use una tailnet/VPN y reduzca los túneles).

## Configuraciones comunes de VPN/tailnet (donde vive el agente)

Piense en el **host del Gateway** como “donde vive el agente”. Posee sesiones, perfiles de autenticación, canales y estado.
Su laptop/escritorio (y los nodos) se conectan a ese host.

### 1. Gateway siempre activo en su tailnet (VPS o servidor doméstico)

Ejecute el Gateway en un host persistente y acceda a él mediante **Tailscale** o SSH.

- **Mejor UX:** mantenga `gateway.bind: "loopback"` y use **Tailscale Serve** para la UI de Control.
- **Respaldo:** mantenga loopback + túnel SSH desde cualquier máquina que necesite acceso.
- **Ejemplos:** [exe.dev](/install/exe-dev) (VM sencilla) o [Hetzner](/install/hetzner) (VPS de producción).

Esto es ideal cuando su laptop duerme con frecuencia pero desea que el agente esté siempre activo.

### 2. El escritorio doméstico ejecuta el Gateway, la laptop es el control remoto

La laptop **no** ejecuta el agente. Se conecta de forma remota:

- Use el modo **Remote over SSH** de la app de macOS (Configuración → General → “OpenClaw runs”).
- La app abre y gestiona el túnel, por lo que WebChat + comprobaciones de estado “simplemente funcionan”.

Runbook: [acceso remoto en macOS](/platforms/mac/remote).

### 3. La laptop ejecuta el Gateway, acceso remoto desde otras máquinas

Mantenga el Gateway local pero expóngalo de forma segura:

- Túnel SSH hacia la laptop desde otras máquinas, o
- Use Tailscale Serve para la UI de Control y mantenga el Gateway solo en loopback.

Guía: [Tailscale](/gateway/tailscale) y [Descripción general de Web](/web).

## Flujo de comandos (qué se ejecuta dónde)

Un servicio de gateway posee el estado + los canales. Los nodos son periféricos.

Ejemplo de flujo (Telegram → nodo):

- Un mensaje de Telegram llega al **Gateway**.
- El Gateway ejecuta el **agente** y decide si llamar a una herramienta de nodo.
- El Gateway llama al **nodo** a través del WebSocket del Gateway (RPC `node.*`).
- El nodo devuelve el resultado; el Gateway responde de vuelta a Telegram.

Notas:

- **Los nodos no ejecutan el servicio de gateway.** Solo debe ejecutarse un gateway por host, a menos que ejecute perfiles aislados intencionalmente (ver [Múltiples gateways](/gateway/multiple-gateways)).
- El “modo nodo” de la app de macOS es solo un cliente de nodo sobre el WebSocket del Gateway.

## Túnel SSH (CLI + herramientas)

Cree un túnel local hacia el WS del Gateway remoto:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

Con el túnel activo:

- `openclaw health` y `openclaw status --deep` ahora alcanzan el gateway remoto vía `ws://127.0.0.1:18789`.
- `openclaw gateway {status,health,send,agent,call}` también puede apuntar a la URL reenviada mediante `--url` cuando sea necesario.

Nota: reemplace `18789` con su `gateway.port` configurado (o `--port`/`OPENCLAW_GATEWAY_PORT`).
Nota: cuando pase `--url`, la CLI no recurre a credenciales de configuración ni de variables de entorno.
Incluya `--token` o `--password` explícitamente. La falta de credenciales explícitas es un error.

## Valores predeterminados remotos de la CLI

Puede persistir un destino remoto para que los comandos de la CLI lo usen de forma predeterminada:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

Cuando el gateway es solo loopback, mantenga la URL en `ws://127.0.0.1:18789` y abra primero el túnel SSH.

## Chat UI sobre SSH

WebChat ya no usa un puerto HTTP separado. La UI de chat SwiftUI se conecta directamente al WebSocket del Gateway.

- Reenvíe `18789` por SSH (ver arriba) y luego conecte los clientes a `ws://127.0.0.1:18789`.
- En macOS, prefiera el modo “Remote over SSH” de la app, que gestiona el túnel automáticamente.

## App de macOS “Remote over SSH”

La app de la barra de menús de macOS puede controlar la misma configuración de extremo a extremo (comprobaciones de estado remotas, WebChat y reenvío de Voice Wake).

Runbook: [acceso remoto en macOS](/platforms/mac/remote).

## Reglas de seguridad (remoto/VPN)

Versión corta: **mantenga el Gateway solo en loopback** a menos que esté seguro de necesitar un bind.

- **Loopback + SSH/Tailscale Serve** es el valor predeterminado más seguro (sin exposición pública).
- **Binds no loopback** (`lan`/`tailnet`/`custom`, o `auto` cuando loopback no está disponible) deben usar tokens/contraseñas de autenticación.
- `gateway.remote.token` es **solo** para llamadas remotas de la CLI; **no** habilita autenticación local.
- `gateway.remote.tlsFingerprint` fija el certificado TLS remoto cuando se usa `wss://`.
- **Tailscale Serve** puede autenticarse mediante encabezados de identidad cuando `gateway.auth.allowTailscale: true`.
  Ajústelo a `false` si desea tokens/contraseñas en su lugar.
- Trate el control del navegador como acceso de operador: solo tailnet + emparejamiento deliberado de nodos.

Análisis en profundidad: [Seguridad](/gateway/security).
