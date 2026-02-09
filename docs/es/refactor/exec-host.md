---
summary: "Plan de refactorización: enrutamiento del host de exec, aprobaciones de nodos y runner sin interfaz"
read_when:
  - Al diseñar el enrutamiento del host de exec o aprobaciones de exec
  - Al implementar el runner de nodos + IPC de la UI
  - Al agregar modos de seguridad del host de exec y comandos slash
title: "Refactorización del Host de Exec"
---

# Plan de refactorización del host de exec

## Objetivos

- Agregar `exec.host` + `exec.security` para enrutar la ejecución entre **sandbox**, **gateway** y **node**.
- Mantener valores predeterminados **seguros**: sin ejecución entre hosts a menos que se habilite explícitamente.
- Dividir la ejecución en un **servicio runner sin interfaz** con UI opcional (app de macOS) vía IPC local.
- Proporcionar políticas **por agente**, lista de permitidos, modo de confirmación y vinculación de nodo.
- Soportar **modos de confirmación** que funcionen _con_ o _sin_ listas de permitidos.
- Multiplataforma: socket Unix + autenticación por token (paridad macOS/Linux/Windows).

## No objetivos

- Sin migración de listas de permitidos heredadas ni soporte de esquemas heredados.
- Sin PTY/streaming para exec en nodos (solo salida agregada).
- Sin nueva capa de red más allá del Bridge + Gateway existentes.

## Decisiones (bloqueadas)

- **Claves de configuración:** `exec.host` + `exec.security` (se permite override por agente).
- **Elevación:** mantener `/elevated` como alias para acceso completo del gateway.
- **Confirmación predeterminada:** `on-miss`.
- **Almacén de aprobaciones:** `~/.openclaw/exec-approvals.json` (JSON, sin migración heredada).
- **Runner:** servicio del sistema sin interfaz; la app UI aloja un socket Unix para aprobaciones.
- **Identidad del nodo:** usar el `nodeId` existente.
- **Autenticación del socket:** socket Unix + token (multiplataforma); dividir más adelante si es necesario.
- **Estado del host del nodo:** `~/.openclaw/node.json` (id del nodo + token de emparejamiento).
- **Host de exec en macOS:** ejecutar `system.run` dentro de la app de macOS; el servicio host del nodo reenvía solicitudes vía IPC local.
- **Sin helper XPC:** usar socket Unix + token + verificaciones de par.

## Conceptos clave

### Host

- `sandbox`: exec en Docker (comportamiento actual).
- `gateway`: exec en el host del gateway.
- `node`: exec en el runner del nodo vía Bridge (`system.run`).

### Modo de seguridad

- `deny`: bloquear siempre.
- `allowlist`: permitir solo coincidencias.
- `full`: permitir todo (equivalente a elevado).

### Modo preguntar

- `off`: nunca preguntar.
- `on-miss`: preguntar solo cuando la lista de permitidos no coincide.
- `always`: preguntar siempre.

La confirmación es **independiente** de la lista de permitidos; la lista de permitidos puede usarse con `always` o `on-miss`.

### Resolución de políticas (por exec)

1. Resolver `exec.host` (parámetro de herramienta → override del agente → valor global).
2. Resolver `exec.security` y `exec.ask` (misma precedencia).
3. Si el host es `sandbox`, continuar con exec local en sandbox.
4. Si el host es `gateway` o `node`, aplicar seguridad + política de confirmación en ese host.

## Seguridad predeterminada

- Predeterminado `exec.host = sandbox`.
- Predeterminado `exec.security = deny` para `gateway` y `node`.
- Predeterminado `exec.ask = on-miss` (solo relevante si la seguridad lo permite).
- Si no se establece una vinculación de nodo, **el agente puede apuntar a cualquier nodo**, pero solo si la política lo permite.

## Superficie de configuración

### Parámetros de la herramienta

- `exec.host` (opcional): `sandbox | gateway | node`.
- `exec.security` (opcional): `deny | allowlist | full`.
- `exec.ask` (opcional): `off | on-miss | always`.
- `exec.node` (opcional): id/nombre del nodo a usar cuando `host=node`.

### Claves de configuración (globales)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (vinculación de nodo predeterminada)

### Claves de configuración (por agente)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = establecer `tools.exec.host=gateway`, `tools.exec.security=full` para la sesión del agente.
- `/elevated off` = restaurar configuraciones de exec previas para la sesión del agente.

## Almacén de aprobaciones (JSON)

Ruta: `~/.openclaw/exec-approvals.json`

Propósito:

- Política local + listas de permitidos para el **host de ejecución** (gateway o runner del nodo).
- Respaldo de confirmación cuando no hay UI disponible.
- Credenciales IPC para clientes de UI.

Esquema propuesto (v1):

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

Notas:

- Sin formatos de listas de permitidos heredados.
- `askFallback` aplica solo cuando se requiere `ask` y no hay UI accesible.
- Permisos de archivo: `0600`.

## Servicio runner (sin interfaz)

### Rol

- Hacer cumplir `exec.security` + `exec.ask` localmente.
- Ejecutar comandos del sistema y devolver la salida.
- Emitir eventos Bridge para el ciclo de vida de exec (opcional pero recomendado).

### Ciclo de vida del servicio

- Launchd/daemon en macOS; servicio del sistema en Linux/Windows.
- El JSON de aprobaciones es local al host de ejecución.
- La UI aloja un socket Unix; los runners se conectan bajo demanda.

## Integración de UI (app de macOS)

### IPC

- Socket Unix en `~/.openclaw/exec-approvals.sock` (0600).
- Token almacenado en `exec-approvals.json` (0600).
- Verificaciones de par: solo mismo UID.
- Desafío/respuesta: nonce + HMAC(token, request-hash) para prevenir replay.
- TTL corto (p. ej., 10s) + tamaño máximo de payload + límite de tasa.

### Flujo de confirmación (host de exec de la app de macOS)

1. El servicio del nodo recibe `system.run` del gateway.
2. El servicio del nodo se conecta al socket local y envía la solicitud de prompt/exec.
3. La app valida par + token + HMAC + TTL, luego muestra el diálogo si es necesario.
4. La app ejecuta el comando en el contexto de la UI y devuelve la salida.
5. El servicio del nodo devuelve la salida al gateway.

Si falta la UI:

- Aplicar `askFallback` (`deny|allowlist|full`).

### Diagrama (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Identidad y vinculación del nodo

- Usar el `nodeId` existente del emparejamiento del Bridge.
- Modelo de vinculación:
  - `tools.exec.node` restringe al agente a un nodo específico.
  - Si no está configurado, el agente puede elegir cualquier nodo (la política aún aplica los valores predeterminados).
- Resolución de selección de nodo:
  - `nodeId` coincidencia exacta
  - `displayName` (normalizado)
  - `remoteIp`
  - Prefijo `nodeId` (>= 6 caracteres)

## Eventos

### Quién ve los eventos

- Los eventos del sistema son **por sesión** y se muestran al agente en el siguiente prompt.
- Se almacenan en la cola en memoria del gateway (`enqueueSystemEvent`).

### Texto del evento

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + cola opcional de salida
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transporte

Opción A (recomendada):

- El runner envía frames Bridge `event` `exec.started` / `exec.finished`.
- El gateway `handleBridgeEvent` los mapea a `enqueueSystemEvent`.

Opción B:

- La herramienta `exec` del gateway maneja el ciclo de vida directamente (solo síncrono).

## Flujos Exec

### Host sandbox

- Comportamiento existente `exec` (Docker o host cuando no está en sandbox).
- PTY soportado solo en modo no sandbox.

### Host del Gateway

- El proceso del Gateway ejecuta en su propia máquina.
- Hace cumplir `exec-approvals.json` local (seguridad/confirmación/lista de permitidos).

### Host del nodo

- El Gateway llama a `node.invoke` con `system.run`.
- El runner hace cumplir las aprobaciones locales.
- El runner devuelve stdout/stderr agregados.
- Eventos Bridge opcionales para inicio/finalización/denegación.

## Límites de salida

- Limitar stdout+stderr combinados a **200k**; mantener **cola de 20k** para eventos.
- Truncar con un sufijo claro (p. ej., `"… (truncated)"`).

## Comandos slash

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Overrides por agente y por sesión; no persistentes a menos que se guarden vía configuración.
- `/elevated on|off|ask|full` permanece como atajo para `host=gateway security=full` (con `full` omitiendo aprobaciones).

## Historia multiplataforma

- El servicio runner es el objetivo de ejecución portable.
- La UI es opcional; si falta, aplica `askFallback`.
- Windows/Linux soportan el mismo JSON de aprobaciones + protocolo de socket.

## Fases de implementación

### Fase 1: configuración + enrutamiento de exec

- Agregar esquema de configuración para `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Actualizar el cableado de herramientas para respetar `exec.host`.
- Agregar el comando slash `/exec` y mantener el alias `/elevated`.

### Fase 2: almacén de aprobaciones + cumplimiento en el gateway

- Implementar lector/escritor de `exec-approvals.json`.
- Hacer cumplir lista de permitidos + modos de confirmación para el host `gateway`.
- Agregar límites de salida.

### Fase 3: cumplimiento del runner del nodo

- Actualizar el runner del nodo para hacer cumplir lista de permitidos + confirmación.
- Agregar puente de prompts por socket Unix a la UI de la app de macOS.
- Conectar `askFallback`.

### Fase 4: eventos

- Agregar eventos Bridge del nodo → gateway para el ciclo de vida de exec.
- Mapear a `enqueueSystemEvent` para los prompts del agente.

### Fase 5: pulido de UI

- App de Mac: editor de listas de permitidos, selector por agente, UI de políticas de confirmación.
- Controles de vinculación de nodo (opcional).

## Plan de pruebas

- Pruebas unitarias: coincidencia de listas de permitidos (glob + sin distinción de mayúsculas).
- Pruebas unitarias: precedencia de resolución de políticas (parámetro de herramienta → override del agente → global).
- Pruebas de integración: flujos de denegar/permitir/confirmar del runner del nodo.
- Pruebas de eventos Bridge: evento del nodo → enrutamiento de evento del sistema.

## Riesgos abiertos

- Indisponibilidad de la UI: asegurar que se respete `askFallback`.
- Comandos de larga duración: confiar en timeout + límites de salida.
- Ambigüedad multi-nodo: error a menos que haya vinculación de nodo o parámetro de nodo explícito.

## Documentos relacionados

- [Herramienta Exec](/tools/exec)
- [Aprobaciones de Exec](/tools/exec-approvals)
- [Nodos](/nodes)
- [Modo elevado](/tools/elevated)
