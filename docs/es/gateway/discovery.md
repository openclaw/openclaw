---
summary: "Descubrimiento de nodos y transportes (Bonjour, Tailscale, SSH) para encontrar el Gateway"
read_when:
  - Implementar o cambiar el descubrimiento/anuncio por Bonjour
  - Ajustar los modos de conexión remota (directo vs SSH)
  - Diseñar el descubrimiento de nodos y el emparejamiento para nodos remotos
title: "Descubrimiento y transportes"
---

# Descubrimiento y transportes

OpenClaw tiene dos problemas distintos que parecen similares en la superficie:

1. **Control remoto del operador**: la app de la barra de menú de macOS que controla un Gateway que se ejecuta en otro lugar.
2. **Emparejamiento de nodos**: iOS/Android (y nodos futuros) que encuentran un Gateway y se emparejan de forma segura.

El objetivo de diseño es mantener todo el descubrimiento/anuncio de red en el **Node Gateway** (`openclaw gateway`) y mantener a los clientes (app de mac, iOS) como consumidores.

## Términos

- **Gateway**: un único proceso de Gateway de larga duración que posee el estado (sesiones, emparejamiento, registro de nodos) y ejecuta canales. La mayoría de las configuraciones usan uno por host; son posibles configuraciones aisladas con múltiples Gateways.
- **Gateway WS (plano de control)**: el endpoint WebSocket en `127.0.0.1:18789` de forma predeterminada; puede enlazarse a LAN/tailnet mediante `gateway.bind`.
- **Transporte WS directo**: un endpoint Gateway WS orientado a LAN/tailnet (sin SSH).
- **Transporte SSH (alternativa)**: control remoto reenviando `127.0.0.1:18789` sobre SSH.
- **Puente TCP heredado (en desuso/eliminado)**: transporte de nodos antiguo (ver [Bridge protocol](/gateway/bridge-protocol)); ya no se anuncia para descubrimiento.

Detalles del protocolo:

- [Gateway protocol](/gateway/protocol)
- [Bridge protocol (heredado)](/gateway/bridge-protocol)

## Por qué mantenemos tanto “directo” como SSH

- **WS directo** ofrece la mejor experiencia de usuario en la misma red y dentro de una tailnet:
  - autodetección en LAN mediante Bonjour
  - tokens de emparejamiento + ACLs gestionados por el Gateway
  - no requiere acceso de shell; la superficie del protocolo puede mantenerse acotada y auditable
- **SSH** sigue siendo la alternativa universal:
  - funciona en cualquier lugar donde tenga acceso SSH (incluso a través de redes no relacionadas)
  - resiste problemas de multicast/mDNS
  - no requiere nuevos puertos entrantes además de SSH

## Entradas de descubrimiento (cómo los clientes aprenden dónde está el Gateway)

### 1. Bonjour / mDNS (solo LAN)

Bonjour es de mejor esfuerzo y no cruza redes. Se usa únicamente para la conveniencia de “misma LAN”.

Dirección objetivo:

- El **Gateway** anuncia su endpoint WS mediante Bonjour.
- Los clientes exploran y muestran una lista de “elegir un Gateway”, luego almacenan el endpoint elegido.

Solución de problemas y detalles de beacons: [Bonjour](/gateway/bonjour).

#### Detalles del beacon de servicio

- Tipos de servicio:
  - `_openclaw-gw._tcp` (beacon de transporte del Gateway)
- Claves TXT (no secretas):
  - `role=gateway`
  - `lanHost=<hostname>.local`
  - `sshPort=22` (o lo que se anuncie)
  - `gatewayPort=18789` (Gateway WS + HTTP)
  - `gatewayTls=1` (solo cuando TLS está habilitado)
  - `gatewayTlsSha256=<sha256>` (solo cuando TLS está habilitado y el fingerprint está disponible)
  - `canvasPort=18793` (puerto predeterminado del host del canvas; sirve `/__openclaw__/canvas/`)
  - `cliPath=<path>` (opcional; ruta absoluta a un entrypoint o binario ejecutable `openclaw`)
  - `tailnetDns=<magicdns>` (sugerencia opcional; se detecta automáticamente cuando Tailscale está disponible)

Deshabilitar/sobrescribir:

- `OPENCLAW_DISABLE_BONJOUR=1` deshabilita el anuncio.
- `gateway.bind` en `~/.openclaw/openclaw.json` controla el modo de enlace del Gateway.
- `OPENCLAW_SSH_PORT` sobrescribe el puerto SSH anunciado en TXT (el valor predeterminado es 22).
- `OPENCLAW_TAILNET_DNS` publica una sugerencia `tailnetDns` (MagicDNS).
- `OPENCLAW_CLI_PATH` sobrescribe la ruta de la CLI anunciada.

### 2. Tailnet (entre redes)

Para configuraciones estilo Londres/Viena, Bonjour no ayudará. El destino “directo” recomendado es:

- Nombre MagicDNS de Tailscale (preferido) o una IP de tailnet estable.

Si el Gateway puede detectar que se está ejecutando bajo Tailscale, publica `tailnetDns` como una sugerencia opcional para los clientes (incluidos los beacons de área amplia).

### 3. Objetivo manual / SSH

Cuando no hay una ruta directa (o el modo directo está deshabilitado), los clientes siempre pueden conectarse mediante SSH reenviando el puerto de gateway de loopback.

Vea [Remote access](/gateway/remote).

## Selección de transporte (política del cliente)

Comportamiento recomendado del cliente:

1. Si un endpoint directo emparejado está configurado y es alcanzable, úselo.
2. De lo contrario, si Bonjour encuentra un Gateway en la LAN, ofrezca una opción de “Usar este Gateway” con un toque y guárdela como el endpoint directo.
3. De lo contrario, si hay un DNS/IP de tailnet configurado, intente directo.
4. De lo contrario, recurra a SSH.

## Emparejamiento + autenticación (transporte directo)

El Gateway es la fuente de la verdad para la admisión de nodos/clientes.

- Las solicitudes de emparejamiento se crean/aprueban/rechazan en el Gateway (ver [Gateway pairing](/gateway/pairing)).
- El Gateway aplica:
  - autenticación (token / par de claves)
  - ámbitos/ACLs (el Gateway no es un proxy sin procesar para cada método)
  - límites de tasa

## Responsabilidades por componente

- **Gateway**: anuncia beacons de descubrimiento, toma decisiones de emparejamiento y aloja el endpoint WS.
- **app de macOS**: le ayuda a elegir un Gateway, muestra solicitudes de emparejamiento y usa SSH solo como alternativa.
- **nodos iOS/Android**: exploran Bonjour como conveniencia y se conectan al Gateway WS emparejado.
