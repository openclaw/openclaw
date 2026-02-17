---
summary: "Emparejamiento de nodos propiedad del Gateway (Opción B) para iOS y otros nodos remotos"
read_when:
  - Implementando aprobaciones de emparejamiento de nodos sin UI de macOS
  - Agregando flujos CLI para aprobar nodos remotos
  - Extendiendo el protocolo del gateway con gestión de nodos
title: "Emparejamiento Propiedad del Gateway"
---

# Emparejamiento propiedad del gateway (Opción B)

En el emparejamiento propiedad del Gateway, el **Gateway** es la fuente de verdad sobre qué nodos
tienen permitido unirse. Las UIs (app de macOS, futuros clientes) son solo frontends que
aprueban o rechazan solicitudes pendientes.

**Importante:** Los nodos WS usan **emparejamiento de dispositivos** (rol `node`) durante `connect`.
`node.pair.*` es un almacén de emparejamiento separado y **no** controla el handshake WS.
Solo los clientes que explícitamente llaman a `node.pair.*` usan este flujo.

## Conceptos

- **Solicitud pendiente**: un nodo pidió unirse; requiere aprobación.
- **Nodo emparejado**: nodo aprobado con un token de autenticación emitido.
- **Transporte**: el endpoint WS del Gateway reenvía solicitudes pero no decide
  la membresía. (El soporte de puente TCP heredado está obsoleto/eliminado.)

## Cómo funciona el emparejamiento

1. Un nodo se conecta al WS del Gateway y solicita emparejamiento.
2. El Gateway almacena una **solicitud pendiente** y emite `node.pair.requested`.
3. Apruebas o rechazas la solicitud (CLI o UI).
4. Al aprobarse, el Gateway emite un **nuevo token** (los tokens se rotan al re-emparejar).
5. El nodo se reconecta usando el token y ahora está "emparejado".

Las solicitudes pendientes expiran automáticamente después de **5 minutos**.

## Flujo de trabajo CLI (amigable sin cabeza)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` muestra nodos emparejados/conectados y sus capacidades.

## Superficie de API (protocolo del gateway)

Eventos:

- `node.pair.requested` — emitido cuando se crea una nueva solicitud pendiente.
- `node.pair.resolved` — emitido cuando una solicitud es aprobada/rechazada/expirada.

Métodos:

- `node.pair.request` — crea o reutiliza una solicitud pendiente.
- `node.pair.list` — lista nodos pendientes + emparejados.
- `node.pair.approve` — aprueba una solicitud pendiente (emite token).
- `node.pair.reject` — rechaza una solicitud pendiente.
- `node.pair.verify` — verifica `{ nodeId, token }`.

Notas:

- `node.pair.request` es idempotente por nodo: las llamadas repetidas devuelven la misma
  solicitud pendiente.
- La aprobación **siempre** genera un token nuevo; nunca se devuelve ningún token desde
  `node.pair.request`.
- Las solicitudes pueden incluir `silent: true` como sugerencia para flujos de auto-aprobación.

## Auto-aprobación (app de macOS)

La app de macOS puede intentar opcionalmente una **aprobación silenciosa** cuando:

- la solicitud está marcada como `silent`, y
- la app puede verificar una conexión SSH al host del gateway usando el mismo usuario.

Si la aprobación silenciosa falla, recurre al prompt normal "Aprobar/Rechazar".

## Almacenamiento (local, privado)

El estado de emparejamiento se almacena bajo el directorio de estado del Gateway (predeterminado `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Si anulas `OPENCLAW_STATE_DIR`, la carpeta `nodes/` se mueve con él.

Notas de seguridad:

- Los tokens son secretos; trata `paired.json` como sensible.
- Rotar un token requiere re-aprobación (o eliminar la entrada del nodo).

## Comportamiento del transporte

- El transporte es **sin estado**; no almacena la membresía.
- Si el Gateway está fuera de línea o el emparejamiento está deshabilitado, los nodos no pueden emparejarse.
- Si el Gateway está en modo remoto, el emparejamiento aún ocurre contra el almacén del Gateway remoto.
