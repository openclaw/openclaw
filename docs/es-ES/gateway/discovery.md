---
summary: "Descubrimiento de nodos y transportes (Bonjour, Tailscale, SSH) para encontrar el gateway"
read_when:
  - Implementando o cambiando descubrimiento/anuncio de Bonjour
  - Ajustando modos de conexión remota (directo vs SSH)
  - Diseñando descubrimiento de nodos + emparejamiento para nodos remotos
title: "Descubrimiento y Transportes"
---

# Descubrimiento y transportes

OpenClaw tiene dos problemas distintos que parecen similares en la superficie:

1. **Control remoto del operador**: la app de barra de menú de macOS controlando un gateway ejecutándose en otro lugar.
2. **Emparejamiento de nodos**: iOS/Android (y futuros nodos) encontrando un gateway y emparejándose de forma segura.

El objetivo de diseño es mantener todo el descubrimiento/anuncio de red en el **Gateway de Nodo** (`openclaw gateway`) y mantener los clientes (app de mac, iOS) como consumidores.

## Términos

- **Gateway**: un único proceso de gateway de larga duración que posee el estado (sesiones, emparejamiento, registro de nodos) y ejecuta canales. La mayoría de configuraciones usan uno por host; configuraciones multi-gateway aisladas son posibles.
- **Gateway WS (plano de control)**: el endpoint WebSocket en `127.0.0.1:18789` por defecto; puede vincularse a LAN/tailnet vía `gateway.bind`.
- **Transporte WS directo**: un endpoint Gateway WS orientado a LAN/tailnet (sin SSH).
- **Transporte SSH (fallback)**: control remoto reenviando `127.0.0.1:18789` sobre SSH.
- **Puente TCP heredado (obsoleto/eliminado)**: transporte de nodo antiguo (ver [Protocolo de puente](/es-ES/gateway/bridge-protocol)); ya no se anuncia para descubrimiento.

Detalles del protocolo:

- [Protocolo del Gateway](/es-ES/gateway/protocol)
- [Protocolo de puente (heredado)](/es-ES/gateway/bridge-protocol)

## Por qué mantenemos tanto "directo" como SSH

- **WS directo** es la mejor UX en la misma red y dentro de un tailnet:
  - auto-descubrimiento en LAN vía Bonjour
  - tokens de emparejamiento + ACLs propiedad del gateway
  - no se requiere acceso shell; la superficie del protocolo puede mantenerse ajustada y auditable
- **SSH** permanece como el fallback universal:
  - funciona en cualquier lugar donde tengas acceso SSH (incluso a través de redes no relacionadas)
  - sobrevive problemas de multicast/mDNS
  - no requiere nuevos puertos entrantes además de SSH

## Entradas de descubrimiento (cómo los clientes aprenden dónde está el gateway)

### 1) Bonjour / mDNS (solo LAN)

Bonjour es de mejor esfuerzo y no cruza redes. Solo se usa para conveniencia de "misma LAN".

Dirección objetivo:

- El **gateway** anuncia su endpoint WS vía Bonjour.
- Los clientes navegan y muestran una lista "elegir un gateway", luego almacenan el endpoint elegido.

Solución de problemas y detalles de beacon: [Bonjour](/es-ES/gateway/bonjour).

#### Detalles de beacon de servicio

- Tipos de servicio:
  - `_openclaw-gw._tcp` (beacon de transporte del gateway)
- Claves TXT (no secretas):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (o lo que se anuncie)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (solo cuando TLS está habilitado)
  - `gatewayTlsSha256=<sha256>` (solo cuando TLS está habilitado y la huella digital está disponible)
  - `canvasPort=<port>` (puerto del host canvas; actualmente el mismo que `gatewayPort` cuando el host canvas está habilitado)
  - `cliPath=<path>` (opcional; ruta absoluta a un punto de entrada o binario `openclaw` ejecutable)
  - `tailnetDns=<magicdns>` (pista opcional; auto-detectado cuando Tailscale está disponible)

Notas de seguridad:

- Los registros TXT de Bonjour/mDNS **no están autenticados**. Los clientes deben tratar los valores TXT solo como pistas de UX.
- El enrutamiento (host/puerto) debería preferir el **endpoint de servicio resuelto** (SRV + A/AAAA) sobre `lanHost`, `tailnetDns`, o `gatewayPort` proporcionados por TXT.
- El pinning de TLS nunca debe permitir que un `gatewayTlsSha256` anunciado anule un pin previamente almacenado.
- Los nodos iOS/Android deben tratar las conexiones directas basadas en descubrimiento como **solo TLS** y requerir una confirmación explícita de "confiar en esta huella digital" antes de almacenar un pin por primera vez (verificación fuera de banda).

Deshabilitar/anular:

- `OPENCLAW_DISABLE_BONJOUR=1` deshabilita el anuncio.
- `gateway.bind` en `~/.openclaw/openclaw.json` controla el modo de vinculación del Gateway.
- `OPENCLAW_SSH_PORT` anula el puerto SSH anunciado en TXT (por defecto 22).
- `OPENCLAW_TAILNET_DNS` publica una pista `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` anula la ruta CLI anunciada.

### 2) Tailnet (cross-network)

Para configuraciones estilo Londres/Viena, Bonjour no ayudará. El objetivo "directo" recomendado es:

- Nombre MagicDNS de Tailscale (preferido) o una IP tailnet estable.

Si el gateway puede detectar que se está ejecutando bajo Tailscale, publica `tailnetDns` como una pista opcional para clientes (incluyendo beacons de área amplia).

### 3) Manual / objetivo SSH

Cuando no hay ruta directa (o directo está deshabilitado), los clientes siempre pueden conectarse vía SSH reenviando el puerto de gateway loopback.

Ver [Acceso remoto](/es-ES/gateway/remote).

## Selección de transporte (política del cliente)

Comportamiento recomendado del cliente:

1. Si un endpoint directo emparejado está configurado y accesible, úsalo.
2. Si no, si Bonjour encuentra un gateway en LAN, ofrece una opción de "Usar este gateway" con un toque y guárdalo como el endpoint directo.
3. Si no, si un DNS/IP tailnet está configurado, intenta directo.
4. Si no, recurre a SSH.

## Emparejamiento + auth (transporte directo)

El gateway es la fuente de verdad para la admisión de nodos/clientes.

- Las solicitudes de emparejamiento son creadas/aprobadas/rechazadas en el gateway (ver [Emparejamiento del Gateway](/es-ES/gateway/pairing)).
- El gateway hace cumplir:
  - auth (token / par de claves)
  - scopes/ACLs (el gateway no es un proxy crudo a cada método)
  - límites de tasa

## Responsabilidades por componente

- **Gateway**: anuncia beacons de descubrimiento, posee decisiones de emparejamiento, y aloja el endpoint WS.
- **App macOS**: te ayuda a elegir un gateway, muestra prompts de emparejamiento, y usa SSH solo como fallback.
- **Nodos iOS/Android**: navegan Bonjour como conveniencia y se conectan al Gateway WS emparejado.
