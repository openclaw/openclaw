---
summary: "Plan de refactorización: enrutamiento de host exec, aprobaciones de nodos, y ejecutor sin interfaz"
read_when:
  - Diseñando enrutamiento de host exec o aprobaciones exec
  - Implementando ejecutor de nodos + IPC de UI
  - Agregando modos de seguridad de host exec y comandos slash
title: "Refactorización de Exec Host"
---

# Plan de refactorización de exec host

## Objetivos

- Agregar `exec.host` + `exec.security` para enrutar ejecución entre **sandbox**, **gateway**, y **node**.
- Mantener predeterminados **seguros**: sin ejecución entre hosts a menos que se habilite explícitamente.
- Dividir ejecución en un **servicio ejecutor sin interfaz** con UI opcional (app macOS) vía IPC local.
- Proporcionar política **por agente**, lista permitida, modo de pregunta, y vinculación de nodos.
- Soportar **modos de pregunta** que funcionen _con_ o _sin_ listas permitidas.
- Multiplataforma: socket Unix + autenticación por token (paridad macOS/Linux/Windows).

## No-objetivos

- Sin migración de lista permitida heredada o soporte de esquema heredado.
- Sin PTY/streaming para exec de nodo (solo salida agregada).
- Sin nueva capa de red más allá del Bridge + Gateway existente.

## Decisiones (bloqueadas)

- **Claves de config:** `exec.host` + `exec.security` (anulación por agente permitida).
- **Elevación:** mantener `/elevated` como alias para acceso completo del gateway.
- **Pregunta predeterminada:** `on-miss`.
- **Almacén de aprobaciones:** `~/.openclaw/exec-approvals.json` (JSON, sin migración heredada).
- **Ejecutor:** servicio del sistema sin interfaz; app UI hospeda un socket Unix para aprobaciones.
- **Identidad de nodo:** usar `nodeId` existente.
- **Autenticación de socket:** socket Unix + token (multiplataforma); dividir más tarde si es necesario.
- **Estado de host de nodo:** `~/.openclaw/node.json` (id de nodo + token de emparejamiento).
- **Host exec de macOS:** ejecutar `system.run` dentro de la app macOS; servicio de host de nodo reenvía solicitudes sobre IPC local.
- **Sin helper XPC:** apegarse a socket Unix + token + verificaciones de pares.

## Conceptos clave

### Host

- `sandbox`: exec de Docker (comportamiento actual).
- `gateway`: exec en host del gateway.
- `node`: exec en ejecutor de nodo vía Bridge (`system.run`).

### Modo de seguridad

- `deny`: bloquear siempre.
- `allowlist`: permitir solo coincidencias.
- `full`: permitir todo (equivalente a elevated).

### Modo de pregunta

- `off`: nunca preguntar.
- `on-miss`: preguntar solo cuando la lista permitida no coincida.
- `always`: preguntar cada vez.

Pregunta es **independiente** de lista permitida; lista permitida puede usarse con `always` o `on-miss`.

### Resolución de política (por exec)

1. Resolver `exec.host` (parámetro de herramienta → anulación de agente → predeterminado global).
2. Resolver `exec.security` y `exec.ask` (misma precedencia).
3. Si host es `sandbox`, proceder con exec de sandbox local.
4. Si host es `gateway` o `node`, aplicar política de seguridad + pregunta en ese host.

## Seguridad predeterminada

- `exec.host = sandbox` predeterminado.
- `exec.security = deny` predeterminado para `gateway` y `node`.
- `exec.ask = on-miss` predeterminado (solo relevante si la seguridad lo permite).
- Si no se establece vinculación de nodo, **el agente puede apuntar a cualquier nodo**, pero solo si la política lo permite.

## Superficie de configuración

### Parámetros de herramienta

- `exec.host` (opcional): `sandbox | gateway | node`.
- `exec.security` (opcional): `deny | allowlist | full`.
- `exec.ask` (opcional): `off | on-miss | always`.
- `exec.node` (opcional): id/nombre de nodo a usar cuando `host=node`.

### Claves de config (global)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (vinculación de nodo predeterminada)

### Claves de config (por agente)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### Alias

- `/elevated on` = establecer `tools.exec.host=gateway`, `tools.exec.security=full` para la sesión del agente.
- `/elevated off` = restaurar configuraciones exec anteriores para la sesión del agente.

## Almacén de aprobaciones (JSON)

Ruta: `~/.openclaw/exec-approvals.json`

Propósito:

- Política local + listas permitidas para el **host de ejecución** (gateway o ejecutor de nodo).
- Respaldo de pregunta cuando no hay UI disponible.
- Credenciales IPC para clientes UI.

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

- Sin formatos de lista permitida heredados.
- `askFallback` se aplica solo cuando se requiere `ask` y no se puede alcanzar ninguna UI.
- Permisos del archivo: `0600`.

## Servicio ejecutor (sin interfaz)

### Rol

- Aplicar `exec.security` + `exec.ask` localmente.
- Ejecutar comandos del sistema y retornar salida.
- Emitir eventos Bridge para ciclo de vida exec (opcional pero recomendado).

### Ciclo de vida del servicio

- Launchd/daemon en macOS; servicio del sistema en Linux/Windows.
- JSON de aprobaciones es local al host de ejecución.
- UI hospeda un socket Unix local; ejecutores se conectan bajo demanda.

## Integración de UI (app macOS)

### IPC

- Socket Unix en `~/.openclaw/exec-approvals.sock` (0600).
- Token almacenado en `exec-approvals.json` (0600).
- Verificaciones de pares: solo mismo UID.
- Desafío/respuesta: nonce + HMAC(token, request-hash) para prevenir repetición.
- TTL corto (ej., 10s) + carga máxima + límite de tasa.

### Flujo de pregunta (host exec de app macOS)

1. Servicio de nodo recibe `system.run` del gateway.
2. Servicio de nodo se conecta al socket local y envía el prompt/solicitud exec.
3. App valida par + token + HMAC + TTL, luego muestra diálogo si es necesario.
4. App ejecuta el comando en contexto UI y retorna salida.
5. Servicio de nodo retorna salida al gateway.

Si UI falta:

- Aplicar `askFallback` (`deny|allowlist|full`).

### Diagrama (SCI)

```
Agente -> Gateway -> Bridge -> Servicio de Nodo (TS)
                          |  IPC (UDS + token + HMAC + TTL)
                          v
                      App Mac (UI + TCC + system.run)
```

## Identidad de nodo + vinculación

- Usar `nodeId` existente del emparejamiento Bridge.
- Modelo de vinculación:
  - `tools.exec.node` restringe el agente a un nodo específico.
  - Si no está establecido, el agente puede elegir cualquier nodo (la política aún aplica predeterminados).
- Resolución de selección de nodo:
  - Coincidencia exacta de `nodeId`
  - `displayName` (normalizado)
  - `remoteIp`
  - Prefijo de `nodeId` (>= 6 chars)

## Eventos

### Quién ve eventos

- Los eventos del sistema son **por sesión** y se muestran al agente en el siguiente prompt.
- Almacenados en la cola en memoria del gateway (`enqueueSystemEvent`).

### Texto del evento

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + cola de salida opcional
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transporte

Opción A (recomendada):

- Ejecutor envía frames `event` de Bridge `exec.started` / `exec.finished`.
- `handleBridgeEvent` del Gateway mapea estos a `enqueueSystemEvent`.

Opción B:

- Herramienta `exec` del Gateway maneja el ciclo de vida directamente (solo síncrono).

## Flujos exec

### Host sandbox

- Comportamiento `exec` existente (Docker o host cuando no está en sandbox).
- PTY soportado solo en modo no-sandbox.

### Host gateway

- Proceso del Gateway ejecuta en su propia máquina.
- Aplica `exec-approvals.json` local (security/ask/allowlist).

### Host node

- Gateway llama `node.invoke` con `system.run`.
- Ejecutor aplica aprobaciones locales.
- Ejecutor retorna stdout/stderr agregado.
- Eventos Bridge opcionales para start/finish/deny.

## Límites de salida

- Limitar stdout+stderr combinado a **200k**; mantener **cola de 20k** para eventos.
- Truncar con sufijo claro (ej., `"… (truncated)"`).

## Comandos slash

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Anulaciones por agente, por sesión; no persistentes a menos que se guarden vía config.
- `/elevated on|off|ask|full` sigue siendo un atajo para `host=gateway security=full` (con `full` omitiendo aprobaciones).

## Historia multiplataforma

- El servicio ejecutor es el objetivo de ejecución portable.
- UI es opcional; si falta, se aplica `askFallback`.
- Windows/Linux soportan el mismo JSON de aprobaciones + protocolo de socket.

## Fases de implementación

### Fase 1: config + enrutamiento exec

- Agregar esquema de config para `exec.host`, `exec.security`, `exec.ask`, `exec.node`.
- Actualizar plomería de herramienta para respetar `exec.host`.
- Agregar comando slash `/exec` y mantener alias `/elevated`.

### Fase 2: almacén de aprobaciones + aplicación de gateway

- Implementar lector/escritor de `exec-approvals.json`.
- Aplicar lista permitida + modos de pregunta para host `gateway`.
- Agregar límites de salida.

### Fase 3: aplicación de ejecutor de nodo

- Actualizar ejecutor de nodo para aplicar lista permitida + pregunta.
- Agregar puente de prompt de socket Unix a UI de app macOS.
- Cablear `askFallback`.

### Fase 4: eventos

- Agregar eventos Bridge nodo → gateway para ciclo de vida exec.
- Mapear a `enqueueSystemEvent` para prompts de agente.

### Fase 5: pulido de UI

- App Mac: editor de lista permitida, conmutador por agente, UI de política de pregunta.
- Controles de vinculación de nodos (opcional).

## Plan de pruebas

- Pruebas unitarias: coincidencia de lista permitida (glob + insensible a mayúsculas).
- Pruebas unitarias: precedencia de resolución de política (parámetro de herramienta → anulación de agente → global).
- Pruebas de integración: flujos deny/allow/ask del ejecutor de nodo.
- Pruebas de eventos Bridge: enrutamiento de evento de nodo → evento del sistema.

## Riesgos abiertos

- Indisponibilidad de UI: asegurar que se respeta `askFallback`.
- Comandos de larga ejecución: confiar en timeout + límites de salida.
- Ambigüedad multi-nodo: error a menos que haya vinculación de nodo o parámetro de nodo explícito.

## Documentos relacionados

- [Herramienta Exec](/es-ES/tools/exec)
- [Aprobaciones Exec](/es-ES/tools/exec-approvals)
- [Nodos](/es-ES/nodes)
- [Modo Elevado](/es-ES/tools/elevated)
