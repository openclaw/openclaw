---
summary: "Aprobaciones de Exec, listas de permitidos y prompts de escape de sandbox"
read_when:
  - Configurar aprobaciones de exec o listas de permitidos
  - Implementar UX de aprobación de exec en la aplicación de macOS
  - Revisar prompts de escape de sandbox e implicaciones
title: "Aprobaciones de Exec"
---

# Aprobaciones de exec

Las aprobaciones de exec son la **protección de aplicación complementaria / host de nodo** para permitir que un agente en sandbox ejecute
comandos en un host real (`gateway` o `node`). Piénsalo como un bloqueo de seguridad:
los comandos solo se permiten cuando la política + lista de permitidos + (opcional) aprobación del usuario están de acuerdo.
Las aprobaciones de exec son **además** de la política de herramientas y el control elevado (a menos que elevated esté establecido en `full`, lo que omite las aprobaciones).
La política efectiva es la **más estricta** de `tools.exec.*` y los valores predeterminados de aprobaciones; si se omite un campo de aprobaciones, se usa el valor de `tools.exec`.

Si la IU de la aplicación complementaria **no está disponible**, cualquier solicitud que requiera un prompt se
resuelve mediante el **fallback de ask** (predeterminado: deny).

## Dónde se aplica

Las aprobaciones de exec se aplican localmente en el host de ejecución:

- **gateway host** → proceso `openclaw` en la máquina del gateway
- **node host** → ejecutor de nodo (aplicación complementaria de macOS o host de nodo sin interfaz gráfica)

División de macOS:

- **servicio de node host** reenvía `system.run` a la **aplicación de macOS** sobre IPC local.
- **aplicación de macOS** aplica aprobaciones + ejecuta el comando en contexto de UI.

## Configuración y almacenamiento

Las aprobaciones viven en un archivo JSON local en el host de ejecución:

`~/.openclaw/exec-approvals.json`

Ejemplo de esquema:

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

### Security (`exec.security`)

- **deny**: bloquear todas las solicitudes de exec del host.
- **allowlist**: permitir solo comandos en lista de permitidos.
- **full**: permitir todo (equivalente a elevated).

### Ask (`exec.ask`)

- **off**: nunca preguntar.
- **on-miss**: preguntar solo cuando la lista de permitidos no coincida.
- **always**: preguntar en cada comando.

### Ask fallback (`askFallback`)

Si se requiere un prompt pero no se puede alcanzar ninguna UI, el fallback decide:

- **deny**: bloquear.
- **allowlist**: permitir solo si la lista de permitidos coincide.
- **full**: permitir.

## Lista de permitidos (por agente)

Las listas de permitidos son **por agente**. Si existen múltiples agentes, cambia qué agente estás
editando en la aplicación de macOS. Los patrones son **coincidencias glob insensibles a mayúsculas/minúsculas**.
Los patrones deben resolverse a **rutas de binario** (las entradas solo de nombre base se ignoran).
Las entradas heredadas de `agents.default` se migran a `agents.main` al cargar.

Ejemplos:

- `~/Projects/**/bin/peekaboo`
- `~/.local/bin/*`
- `/opt/homebrew/bin/rg`

Cada entrada de lista de permitidos rastrea:

- **id** UUID estable usado para identidad de UI (opcional)
- **last used** marca de tiempo
- **last used command**
- **last resolved path**

## Auto-permitir CLIs de habilidades

Cuando **Auto-permitir CLIs de habilidades** está habilitado, los ejecutables referenciados por habilidades conocidas
se tratan como permitidos en nodos (nodo macOS o host de nodo sin interfaz gráfica). Esto usa
`skills.bins` sobre el RPC del Gateway para obtener la lista de bins de habilidades. Deshabilita esto si quieres listas de permitidos manuales estrictas.

## Bins seguros (solo stdin)

`tools.exec.safeBins` define una pequeña lista de binarios **solo stdin** (por ejemplo `jq`)
que pueden ejecutarse en modo de lista de permitidos **sin** entradas explícitas de lista de permitidos. Los bins seguros rechazan
argumentos de archivo posicionales y tokens tipo ruta, por lo que solo pueden operar en el flujo entrante.
Los bins seguros también fuerzan que los tokens argv se traten como **texto literal** en tiempo de ejecución (sin globbing
y sin expansión de `$VARS`) para segmentos solo stdin, por lo que patrones como `*` o `$HOME/...` no pueden usarse
para contrabandear lecturas de archivos.
El encadenamiento de shell y las redirecciones no se permiten automáticamente en modo de lista de permitidos.

El encadenamiento de shell (`&&`, `||`, `;`) se permite cuando cada segmento de nivel superior satisface la lista de permitidos
(incluidos bins seguros o auto-permitir de habilidades). Las redirecciones permanecen no soportadas en modo de lista de permitidos.
La sustitución de comandos (`$()` / comillas invertidas) se rechaza durante el análisis de lista de permitidos, incluyendo dentro de
comillas dobles; usa comillas simples si necesitas texto literal `$()`.

Bins seguros por defecto: `jq`, `grep`, `cut`, `sort`, `uniq`, `head`, `tail`, `tr`, `wc`.

## Edición de UI de control

Usa la tarjeta **Control UI → Nodos → Aprobaciones de Exec** para editar valores predeterminados, anulaciones por agente
y listas de permitidos. Elige un alcance (Valores predeterminados o un agente), ajusta la política,
agrega/elimina patrones de lista de permitidos, luego **Guardar**. La UI muestra metadatos de **última vez usado**
por patrón para que puedas mantener la lista ordenada.

El selector de objetivo elige **Gateway** (aprobaciones locales) o un **Nodo**. Los nodos
deben anunciar `system.execApprovals.get/set` (aplicación de macOS o host de nodo sin interfaz gráfica).
Si un nodo aún no anuncia aprobaciones de exec, edita su
`~/.openclaw/exec-approvals.json` local directamente.

CLI: `openclaw approvals` admite edición de gateway o nodo (ver [CLI de Aprobaciones](/es-ES/cli/approvals)).

## Flujo de aprobación

Cuando se requiere un prompt, el gateway transmite `exec.approval.requested` a clientes operadores.
La UI de Control y la aplicación de macOS lo resuelven mediante `exec.approval.resolve`, luego el gateway reenvía la
solicitud aprobada al host del nodo.

Cuando se requieren aprobaciones, la herramienta exec devuelve inmediatamente con un id de aprobación. Usa ese id para
correlacionar eventos del sistema posteriores (`Exec finished` / `Exec denied`). Si no llega ninguna decisión antes del
tiempo de espera, la solicitud se trata como un tiempo de espera de aprobación y se presenta como una razón de denegación.

El diálogo de confirmación incluye:

- comando + argumentos
- cwd
- id de agente
- ruta de ejecutable resuelta
- host + metadatos de política

Acciones:

- **Allow once** → ejecutar ahora
- **Always allow** → agregar a lista de permitidos + ejecutar
- **Deny** → bloquear

## Reenvío de aprobación a canales de chat

Puedes reenviar prompts de aprobación de exec a cualquier canal de chat (incluidos canales de complementos) y aprobarlos
con `/approve`. Esto usa el pipeline de entrega saliente normal.

Config:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring o regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Responder en chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

### Flujo IPC de macOS

```
Gateway -> Servicio de Nodo (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Aplicación Mac (UI + aprobaciones + system.run)
```

Notas de seguridad:

- Modo de socket Unix `0600`, token almacenado en `exec-approvals.json`.
- Verificación de peer mismo-UID.
- Desafío/respuesta (nonce + token HMAC + hash de solicitud) + TTL corto.

## Eventos del sistema

El ciclo de vida de exec se presenta como mensajes del sistema:

- `Exec running` (solo si el comando excede el umbral de notificación de ejecución)
- `Exec finished`
- `Exec denied`

Estos se publican en la sesión del agente después de que el nodo informa el evento.
Las aprobaciones de exec del gateway-host emiten los mismos eventos de ciclo de vida cuando el comando termina (y opcionalmente cuando se ejecuta más tiempo que el umbral).
Los execs con aprobación reutilizan el id de aprobación como `runId` en estos mensajes para una correlación fácil.

## Implicaciones

- **full** es poderoso; prefiere listas de permitidos cuando sea posible.
- **ask** te mantiene informado mientras permite aprobaciones rápidas.
- Las listas de permitidos por agente evitan que las aprobaciones de un agente se filtren a otros.
- Las aprobaciones solo se aplican a solicitudes de exec del host de **remitentes autorizados**. Los remitentes no autorizados no pueden emitir `/exec`.
- `/exec security=full` es una conveniencia a nivel de sesión para operadores autorizados y omite aprobaciones por diseño.
  Para bloquear completamente el exec del host, establece la seguridad de aprobaciones en `deny` o niega la herramienta `exec` mediante política de herramientas.

Relacionado:

- [Herramienta Exec](/es-ES/tools/exec)
- [Modo elevado](/es-ES/tools/elevated)
- [Habilidades](/es-ES/tools/skills)
