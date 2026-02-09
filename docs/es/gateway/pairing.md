---
summary: "Emparejamiento de nodos propiedad del Gateway (Opción B) para iOS y otros nodos remotos"
read_when:
  - Implementación de aprobaciones de emparejamiento de nodos sin UI de macOS
  - Adición de flujos de CLI para aprobar nodos remotos
  - Extensión del protocolo del Gateway con gestión de nodos
title: "Emparejamiento propiedad del Gateway"
---

# Emparejamiento propiedad del Gateway (Opción B)

En el emparejamiento propiedad del Gateway, el **Gateway** es la fuente de verdad sobre qué nodos
están permitidos para unirse. Las UIs (app de macOS, clientes futuros) son solo frontends que
aprueban o rechazan solicitudes pendientes.

**Importante:** Los nodos WS usan **emparejamiento de dispositivos** (rol `node`) durante `connect`.
`node.pair.*` es un almacén de emparejamiento separado y **no** controla el handshake de WS.
Solo los clientes que llaman explícitamente a `node.pair.*` usan este flujo.

## Conceptos

- **Solicitud pendiente**: un nodo solicitó unirse; requiere aprobación.
- **Nodo emparejado**: nodo aprobado con un token de autenticación emitido.
- **Transporte**: el endpoint WS del Gateway reenvía solicitudes pero no decide
  la membresía. (El soporte heredado del puente TCP está obsoleto/eliminado).

## Cómo funciona el emparejamiento

1. Un nodo se conecta al WS del Gateway y solicita emparejamiento.
2. El Gateway almacena una **solicitud pendiente** y emite `node.pair.requested`.
3. Usted aprueba o rechaza la solicitud (CLI o UI).
4. Tras la aprobación, el Gateway emite un **nuevo token** (los tokens se rotan al re‑emparejar).
5. El nodo se reconecta usando el token y ahora está “emparejado”.

Las solicitudes pendientes expiran automáticamente después de **5 minutos**.

## Flujo de trabajo con CLI (amigable para entornos sin UI)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` muestra los nodos emparejados/conectados y sus capacidades.

## Superficie de API (protocolo del Gateway)

Eventos:

- `node.pair.requested` — emitido cuando se crea una nueva solicitud pendiente.
- `node.pair.resolved` — emitido cuando una solicitud es aprobada/rechazada/expirada.

Métodos:

- `node.pair.request` — crear o reutilizar una solicitud pendiente.
- `node.pair.list` — listar nodos pendientes + emparejados.
- `node.pair.approve` — aprobar una solicitud pendiente (emite token).
- `node.pair.reject` — rechazar una solicitud pendiente.
- `node.pair.verify` — verificar `{ nodeId, token }`.

Notas:

- `node.pair.request` es idempotente por nodo: las llamadas repetidas devuelven la misma
  solicitud pendiente.
- La aprobación **siempre** genera un token nuevo; nunca se devuelve ningún token desde
  `node.pair.request`.
- Las solicitudes pueden incluir `silent: true` como una pista para flujos de autoaprobación.

## Autoaprobación (app de macOS)

La app de macOS puede intentar opcionalmente una **aprobación silenciosa** cuando:

- la solicitud está marcada como `silent`, y
- la app puede verificar una conexión SSH al host del Gateway usando el mismo usuario.

Si la aprobación silenciosa falla, se vuelve al aviso normal de “Aprobar/Rechazar”.

## Almacenamiento (local, privado)

El estado de emparejamiento se almacena bajo el directorio de estado del Gateway (predeterminado `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Si usted sobrescribe `OPENCLAW_STATE_DIR`, la carpeta `nodes/` se mueve junto con él.

Notas de seguridad:

- Los tokens son secretos; trate `paired.json` como sensible.
- Rotar un token requiere re‑aprobación (o eliminar la entrada del nodo).

## Comportamiento del transporte

- El transporte es **sin estado**; no almacena la membresía.
- Si el Gateway está fuera de línea o el emparejamiento está deshabilitado, los nodos no pueden emparejarse.
- Si el Gateway está en modo remoto, el emparejamiento sigue ocurriendo contra el almacén del Gateway remoto.
