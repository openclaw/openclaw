---
summary: "Cómo se producen, combinan y muestran las entradas de presencia de OpenClaw"
read_when:
  - Depuración de la pestaña Instances
  - Investigación de filas de instancias duplicadas u obsoletas
  - Cambio de la conexión WS del Gateway o de los beacons de eventos del sistema
title: "Presencia"
---

# Presencia

La “presencia” de OpenClaw es una vista ligera y de mejor esfuerzo de:

- el **Gateway** en sí, y
- **los clientes conectados al Gateway** (app de macOS, WebChat, CLI, etc.)

La presencia se utiliza principalmente para renderizar la pestaña **Instances** de la app de macOS y para
proporcionar visibilidad rápida al operador.

## Campos de presencia (lo que se muestra)

Las entradas de presencia son objetos estructurados con campos como:

- `instanceId` (opcional pero muy recomendado): identidad estable del cliente (normalmente `connect.client.instanceId`)
- `host`: nombre de host legible para humanos
- `ip`: dirección IP de mejor esfuerzo
- `version`: cadena de versión del cliente
- `deviceFamily` / `modelIdentifier`: indicios de hardware
- `mode`: `ui`, `webchat`, `cli`, `backend`, `probe`, `test`, `node`, ...
- `lastInputSeconds`: “segundos desde la última entrada del usuario” (si se conoce)
- `reason`: `self`, `connect`, `node-connected`, `periodic`, ...
- `ts`: marca de tiempo de la última actualización (ms desde epoch)

## Productores (de dónde proviene la presencia)

Las entradas de presencia son producidas por múltiples fuentes y se **combinan**.

### 1. Entrada propia del Gateway

El Gateway siempre inicializa una entrada “self” al arrancar para que las IU muestren el host del gateway
incluso antes de que se conecten clientes.

### 2. Conexión WebSocket

Cada cliente WS comienza con una solicitud `connect`. Tras un handshake exitoso, el
Gateway hace un upsert de una entrada de presencia para esa conexión.

#### Por qué los comandos puntuales de la CLI no aparecen

La CLI suele conectarse para comandos cortos y puntuales. Para evitar saturar la
lista de Instances, `client.mode === "cli"` **no** se convierte en una entrada de presencia.

### 3. Beacons `system-event`

Los clientes pueden enviar beacons periódicos más completos mediante el método `system-event`. La app de macOS
usa esto para informar el nombre de host, la IP y `lastInputSeconds`.

### 4. Conexiones de nodos (rol: node)

Cuando un nodo se conecta por el WebSocket del Gateway con `role: node`, el Gateway
hace un upsert de una entrada de presencia para ese nodo (el mismo flujo que otros clientes WS).

## Reglas de combinación y deduplicación (por qué `instanceId` importa)

Las entradas de presencia se almacenan en un único mapa en memoria:

- Las entradas se indexan por una **clave de presencia**.
- La mejor clave es un `instanceId` estable (de `connect.client.instanceId`) que sobrevive a reinicios.
- Las claves no distinguen mayúsculas de minúsculas.

Si un cliente se reconecta sin un `instanceId` estable, puede aparecer como una
fila **duplicada**.

## TTL y tamaño acotado

La presencia es intencionalmente efímera:

- **TTL:** las entradas con más de 5 minutos se depuran
- **Entradas máximas:** 200 (las más antiguas se descartan primero)

Esto mantiene la lista actualizada y evita un crecimiento de memoria sin límites.

## Advertencia de remoto/túnel (IP de loopback)

Cuando un cliente se conecta a través de un túnel SSH / reenvío de puertos local, el Gateway puede
ver la dirección remota como `127.0.0.1`. Para evitar sobrescribir una IP informada por el cliente que sea válida,
se ignoran las direcciones remotas de loopback.

## Consumidores

### Pestaña Instances de macOS

La app de macOS renderiza la salida de `system-presence` y aplica un pequeño indicador de estado
(Active/Idle/Stale) según la antigüedad de la última actualización.

## Consejos de depuración

- Para ver la lista sin procesar, llame a `system-presence` contra el Gateway.
- Si ve duplicados:
  - confirme que los clientes envían un `client.instanceId` estable en el handshake
  - confirme que los beacons periódicos usan el mismo `instanceId`
  - verifique si a la entrada derivada de la conexión le falta `instanceId` (los duplicados son esperables)
