---
summary: "Protocolo Bridge (nodos heredados): TCP JSONL, emparejamiento, RPC con alcance"
read_when:
  - Creación o depuración de clientes de nodo (modo nodo iOS/Android/macOS)
  - Investigación de fallos de emparejamiento o autenticación del bridge
  - Auditoría de la superficie de nodo expuesta por el Gateway
title: "Protocolo Bridge"
---

# Protocolo Bridge (transporte de nodo heredado)

El protocolo Bridge es un transporte de nodo **heredado** (TCP JSONL). Los nuevos clientes de nodo
deben usar el protocolo WebSocket unificado del Gateway en su lugar.

Si está creando un operador o un cliente de nodo, use el
[protocolo del Gateway](/gateway/protocol).

**Nota:** Las compilaciones actuales de OpenClaw ya no incluyen el listener TCP del bridge; este documento se conserva como referencia histórica.
Las claves de configuración heredadas `bridge.*` ya no forman parte del esquema de configuración.

## Por qué tenemos ambos

- **Límite de seguridad**: el bridge expone una pequeña lista de permitidos en lugar de la
  superficie completa de la API del gateway.
- **Emparejamiento + identidad del nodo**: la admisión de nodos es responsabilidad del gateway y está vinculada
  a un token por nodo.
- **UX de descubrimiento**: los nodos pueden descubrir gateways vía Bonjour en la LAN, o conectarse
  directamente a través de un tailnet.
- **WS de loopback**: el plano de control WS completo permanece local a menos que se tunelice vía SSH.

## Transporte

- TCP, un objeto JSON por línea (JSONL).
- TLS opcional (cuando `bridge.tls.enabled` es true).
- El puerto de escucha predeterminado heredado era `18790` (las compilaciones actuales no inician un bridge TCP).

Cuando TLS está habilitado, los registros TXT de descubrimiento incluyen `bridgeTls=1` más
`bridgeTlsSha256` para que los nodos puedan fijar el certificado.

## Handshake + emparejamiento

1. El cliente envía `hello` con metadatos del nodo + token (si ya está emparejado).
2. Si no está emparejado, el gateway responde `error` (`NOT_PAIRED`/`UNAUTHORIZED`).
3. El cliente envía `pair-request`.
4. El gateway espera la aprobación y luego envía `pair-ok` y `hello-ok`.

`hello-ok` devuelve `serverName` y puede incluir `canvasHostUrl`.

## Frames

Cliente → Gateway:

- `req` / `res`: RPC del gateway con alcance (chat, sesiones, configuración, salud, voicewake, skills.bins)
- `event`: señales del nodo (transcripción de voz, solicitud de agente, suscripción a chat, ciclo de vida de exec)

Gateway → Cliente:

- `invoke` / `invoke-res`: comandos del nodo (`canvas.*`, `camera.*`, `screen.record`,
  `location.get`, `sms.send`)
- `event`: actualizaciones de chat para sesiones suscritas
- `ping` / `pong`: keepalive

La aplicación heredada de la lista de permitidos residía en `src/gateway/server-bridge.ts` (eliminado).

## Eventos del ciclo de vida de exec

Los nodos pueden emitir eventos `exec.finished` o `exec.denied` para exponer la actividad de system.run.
Estos se mapean a eventos del sistema en el gateway. (Los nodos heredados aún pueden emitir `exec.started`.)

Campos del payload (todos opcionales salvo que se indique lo contrario):

- `sessionKey` (obligatorio): sesión del agente que recibirá el evento del sistema.
- `runId`: id de exec único para agrupar.
- `command`: cadena de comando en bruto o formateada.
- `exitCode`, `timedOut`, `success`, `output`: detalles de finalización (solo cuando finaliza).
- `reason`: motivo de denegación (solo cuando se deniega).

## Uso de tailnet

- Vincule el bridge a una IP de tailnet: `bridge.bind: "tailnet"` en
  `~/.openclaw/openclaw.json`.
- Los clientes se conectan mediante el nombre MagicDNS o la IP del tailnet.
- Bonjour **no** cruza redes; use host/puerto manual o DNS‑SD de área amplia
  cuando sea necesario.

## Versionado

El Bridge es actualmente **v1 implícita** (sin negociación de mínimo/máximo). Se espera compatibilidad hacia atrás; agregue un campo de versión del protocolo Bridge antes de cualquier cambio incompatible.
