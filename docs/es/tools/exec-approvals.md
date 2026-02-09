---
summary: "Aprobaciones de exec, listas de permitidos y avisos de escape del sandbox"
read_when:
  - Configurar aprobaciones de exec o listas de permitidos
  - Implementar UX de aprobación de exec en la app de macOS
  - Revisar avisos de escape del sandbox y sus implicaciones
title: "Aprobaciones de Exec"
---

# Aprobaciones de exec

Las aprobaciones de exec son el **guardarraíl de la aplicación complementaria / host de nodo** para permitir que un agente en sandbox ejecute
comandos en un host real (`gateway` o `node`). Piénselo como un interbloqueo de seguridad:
los comandos solo se permiten cuando la política + la lista de permitidos + (opcionalmente) la aprobación del usuario están de acuerdo.
Las aprobaciones de exec son **adicionales** a la política de herramientas y al gating elevado (a menos que elevado esté configurado en `full`, lo que omite las aprobaciones).
La política efectiva es la **más estricta** entre `tools.exec.*` y los valores predeterminados de aprobaciones; si se omite un campo de aprobaciones, se usa el valor `tools.exec`.

Si la UI de la aplicación complementaria **no está disponible**, cualquier solicitud que requiera un aviso se
resuelve mediante el **ask fallback** (predeterminado: denegar).

## Dónde aplica

Las aprobaciones de exec se aplican localmente en el host de ejecución:

- **host del Gateway** → proceso `openclaw` en la máquina del gateway
- **host de nodo** → ejecutor de nodo (aplicación complementaria de macOS o host de nodo sin interfaz)

División en macOS:

- **servicio del host de nodo** reenvía `system.run` a la **app de macOS** mediante IPC local.
- **app de macOS** aplica las aprobaciones + ejecuta el comando en el contexto de la UI.

## Configuración y almacenamiento

Las aprobaciones viven en un archivo JSON local en el host de ejecución:

`~/.openclaw/exec-approvals.json`

Esquema de ejemplo:

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64url-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny",
    "autoAllowSkills": false
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "askFallback": "deny",
      "autoAllowSkills": true,
      "allowlist": [
        {
          "id": "B0C8C0B3-2C2D-4F8A-9A3C-5A4B3C2D1E0F",
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 1737150000000,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

## Controles de política

### Seguridad (`exec.security`)

- **deny**: bloquea todas las solicitudes de exec en el host.
- **allowlist**: permite solo comandos en la lista de permitidos.
- **full**: permite todo (equivalente a elevado).

### Ask (`exec.ask`)

- **off**: nunca avisar.
- **on-miss**: avisar solo cuando la lista de permitidos no coincide.
- **always**: avisar en cada comando.

### Ask fallback (`askFallback`)

Si se requiere un aviso pero no hay UI accesible, el fallback decide:

- **deny**: bloquear.
- **allowlist**: permitir solo si coincide la lista de permitidos.
- **full**: permitir.

## Lista de permitidos (por agente)

Las listas de permitidos son **por agente**. Si existen múltiples agentes, cambie el agente que está
editando en la app de macOS. Los patrones son **coincidencias glob sin distinción de mayúsculas**.
Los patrones deben resolverse a **rutas de binarios** (las entradas solo con basename se ignoran).
Las entradas heredadas `agents.default` se migran a `agents.main` al cargar.

Ejemplos:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Cada entrada de la lista de permitidos registra:

- **id** UUID estable usado para identidad de UI (opcional)
- **último uso** marca de tiempo
- **último comando usado**
- **última ruta resuelta**

## Auto-allow de CLIs de Skills

Cuando **Auto-allow skill CLIs** está habilitado, los ejecutables referenciados por Skills conocidas
se tratan como permitidos en nodos (nodo de macOS o host de nodo sin interfaz). Esto usa
`skills.bins` sobre el RPC del Gateway para obtener la lista de binarios de Skills. Desactívelo si desea listas de permitidos manuales estrictas.

## Bins seguros (solo stdin)

`tools.exec.safeBins` define una pequeña lista de binarios **solo stdin** (por ejemplo `jq`)
que pueden ejecutarse en modo de lista de permitidos **sin** entradas explícitas en la lista. Los bins seguros rechazan
argumentos posicionales de archivo y tokens con apariencia de ruta, por lo que solo pueden operar sobre el flujo entrante.
El encadenamiento de shell y las redirecciones no se permiten automáticamente en el modo de lista de permitidos.

El encadenamiento de shell (`&&`, `||`, `;`) se permite cuando cada segmento de nivel superior satisface la lista de permitidos
(incluidos bins seguros o auto-allow de Skills). Las redirecciones siguen sin estar soportadas en el modo de lista de permitidos.
La sustitución de comandos (`$()` / comillas invertidas) se rechaza durante el análisis de la lista de permitidos, incluso dentro de
comillas dobles; use comillas simples si necesita texto literal `$()`.

Bins seguros predeterminados: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Edición en la UI de Control

Use la tarjeta **Control UI → Nodes → Exec approvals** para editar los valores predeterminados, las
sobrescrituras por agente y las listas de permitidos. Elija un alcance (Valores predeterminados o un agente), ajuste la política,
agregue o quite patrones de la lista de permitidos y luego **Guarde**. La UI muestra metadatos de **último uso**
por patrón para que pueda mantener la lista ordenada.

El selector de destino elige **Gateway** (aprobaciones locales) o un **Nodo**. Los nodos
deben anunciar `system.execApprovals.get/set` (app de macOS o host de nodo sin interfaz).
Si un nodo aún no anuncia aprobaciones de exec, edite su
`~/.openclaw/exec-approvals.json` local directamente.

CLI: `openclaw approvals` admite edición del gateway o del nodo (consulte [Approvals CLI](/cli/approvals)).

## Flujo de aprobación

Cuando se requiere un aviso, el gateway difunde `exec.approval.requested` a los clientes operadores.
La UI de Control y la app de macOS lo resuelven mediante `exec.approval.resolve`, y luego el gateway reenvía la
solicitud aprobada al host de nodo.

Cuando se requieren aprobaciones, la herramienta exec devuelve inmediatamente un id de aprobación. Use ese id para
correlacionar eventos del sistema posteriores (`Exec finished` / `Exec denied`). Si no llega ninguna decisión antes del
timeout, la solicitud se trata como un tiempo de espera de aprobación y se muestra como un motivo de denegación.

El cuadro de diálogo de confirmación incluye:

- comando + args
- cwd
- id del agente
- ruta del ejecutable resuelta
- metadatos de host + política

Acciones:

- **Allow once** → ejecutar ahora
- **Always allow** → agregar a la lista de permitidos + ejecutar
- **Deny** → bloquear

## Reenvío de aprobaciones a canales de chat

Puede reenviar avisos de aprobación de exec a cualquier canal de chat (incluidos canales de plugins) y aprobarlos
con `/approve`. Esto utiliza el flujo normal de entrega saliente.

Configuración:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Responder en el chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### Flujo de IPC en macOS

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Notas de seguridad:

- Modo de socket Unix `0600`, token almacenado en `exec-approvals.json`.
- Verificación de par con el mismo UID.
- Desafío/respuesta (nonce + token HMAC + hash de solicitud) + TTL corto.

## Eventos del sistema

El ciclo de vida de exec se expone como mensajes del sistema:

- `Exec running` (solo si el comando excede el umbral de aviso de ejecución)
- `Exec finished`
- `Exec denied`

Estos se publican en la sesión del agente después de que el nodo informa el evento.
Las aprobaciones de exec en el host del Gateway emiten los mismos eventos del ciclo de vida cuando el comando finaliza (y opcionalmente cuando se ejecuta por más tiempo que el umbral).
Los execs con aprobación reutilizan el id de aprobación como el `runId` en estos mensajes para una correlación sencilla.

## Implicaciones

- **full** es potente; prefiera listas de permitidos cuando sea posible.
- **ask** lo mantiene informado y aun así permite aprobaciones rápidas.
- Las listas de permitidos por agente evitan que las aprobaciones de un agente se filtren a otros.
- Las aprobaciones solo se aplican a solicitudes de exec en el host de **remitentes autorizados**. Los remitentes no autorizados no pueden emitir `/exec`.
- `/exec security=full` es una comodidad a nivel de sesión para operadores autorizados y salta las aprobaciones por diseño.
  `/exec security=full` es una conveniencia a nivel de sesión para operadores autorizados y omite las aprobaciones por diseño.
  Para bloquear de forma estricta el exec en el host, configure la seguridad de aprobaciones en `deny` o deniegue la herramienta `exec` mediante la política de herramientas.

Relacionado:

- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills)
