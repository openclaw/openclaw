---
summary: "Protocolo Bridge (nodos legacy): TCP JSONL, pairing, RPC con alcance"
read_when:
  - Construcción o debugging de clientes de nodo (iOS/Android/modo nodo macOS)
  - Investigación de pairing o fallos de auth del bridge
  - Auditoría de la superficie del nodo expuesta por el gateway
title: "Protocolo Bridge"
---

# Protocolo Bridge (transporte de nodo legacy)

El protocolo Bridge es un transporte de nodo **legacy** (TCP JSONL). Los nuevos clientes de nodo
deben usar el protocolo WebSocket del Gateway unificado en su lugar.

Si estás construyendo un operador o cliente de nodo, usa el
[Protocolo Gateway](/es-ES/gateway/protocol).

**Nota:** Las compilaciones actuales de OpenClaw ya no incluyen el listener TCP bridge; este documento se mantiene para referencia histórica.
Las claves de configuración `bridge.*` legacy ya no son parte del esquema de config.

## Por qué tenemos ambos

- **Límite de seguridad**: el bridge expone una pequeña lista permitida en lugar de la
  superficie completa de API del gateway.
- **Pairing + identidad de nodo**: la admisión de nodos es propiedad del gateway y está vinculada
  a un token por nodo.
- **UX de descubrimiento**: los nodos pueden descubrir gateways vía Bonjour en LAN, o conectarse
  directamente sobre una tailnet.
- **WS loopback**: el plano de control WS completo permanece local a menos que se haga túnel vía SSH.

## Transporte

- TCP, un objeto JSON por línea (JSONL).
- TLS opcional (cuando `bridge.tls.enabled` es true).
- El puerto de listener predeterminado legacy era `18790` (las compilaciones actuales no inician un bridge TCP).

Cuando TLS está habilitado, los registros TXT de descubrimiento incluyen `bridgeTls=1` más
`bridgeTlsSha256` como una pista no secreta. Nota que los registros TXT Bonjour/mDNS no están
autenticados; los clientes no deben tratar la huella anunciada como un
pin autoritativo sin intención explícita del usuario u otra verificación fuera de banda.

## Handshake + pairing

1. El cliente envía `hello` con metadata del nodo + token (si ya está pareado).
2. Si no está pareado, el gateway responde `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. El cliente envía `pair-request`.
4. El gateway espera aprobación, luego envía `pair-ok` y `hello-ok`.

`hello-ok` devuelve `serverName` y puede incluir `canvasHostUrl`.

## Frames

Cliente → Gateway:

- `req` / `res`: RPC del gateway con alcance (chat, sessions, config, health, voicewake, skills.bins)
- `event`: señales del nodo (transcripción de voz, solicitud de agente, suscripción de chat, ciclo de vida exec)

Gateway → Cliente:

- `invoke` / `invoke-res`: comandos de nodo (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: actualizaciones de chat para sesiones suscritas
- `ping` / `pong`: keepalive

La aplicación de la lista permitida legacy vivía en `src/gateway/server-bridge.ts` (eliminado).

## Eventos de ciclo de vida exec

Los nodos pueden emitir eventos `exec.finished` o `exec.denied` para mostrar actividad system.run.
Estos se mapean a eventos del sistema en el gateway. (Los nodos legacy aún pueden emitir `exec.started`.)

Campos de payload (todos opcionales a menos que se indique):

- `sessionKey` (requerido): sesión de agente para recibir el evento del sistema.
- `runId`: ID de exec único para agrupación.
- `command`: cadena de comando cruda o formateada.
- `exitCode`, `timedOut`, `success`, `output`: detalles de completado (solo finished).
- `reason`: razón de denegación (solo denied).

## Uso de Tailnet

- Vincula el bridge a una IP tailnet: `bridge.bind: "tailnet"` en
  `~/.openclaw/openclaw.json`.
- Los clientes se conectan vía nombre MagicDNS o IP tailnet.
- Bonjour **no** cruza redes; usa host/puerto manual o DNS-SD de área amplia
  cuando sea necesario.

## Versionado

Bridge es actualmente **v1 implícito** (sin negociación min/max). Se espera compat hacia atrás;
agrega un campo de versión del protocolo bridge antes de cualquier cambio que rompa compatibilidad.
