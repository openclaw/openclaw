---
summary: "Superficie de herramientas de agente para OpenClaw (navegador, lienzo, nodos, mensajes, cron) reemplazando las antiguas habilidades `openclaw-*`"
read_when:
  - Agregar o modificar herramientas de agente
  - Retirar o cambiar habilidades `openclaw-*`
title: "Herramientas"
---

# Herramientas (OpenClaw)

OpenClaw expone **herramientas de agente de primera clase** para navegador, lienzo, nodos y cron.
Estas reemplazan las antiguas habilidades `openclaw-*`: las herramientas tienen tipos, no usan shell,
y el agente debe confiar en ellas directamente.

## Deshabilitar herramientas

Puedes permitir/denegar herramientas globalmente mediante `tools.allow` / `tools.deny` en `openclaw.json`
(deny tiene prioridad). Esto evita que las herramientas no permitidas se envíen a los proveedores de modelos.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notas:

- La coincidencia no distingue mayúsculas y minúsculas.
- Se admiten comodines `*` (`"*"` significa todas las herramientas).
- Si `tools.allow` solo hace referencia a nombres de herramientas de complementos desconocidos o no cargados, OpenClaw registra una advertencia e ignora la lista de permitidos para que las herramientas principales permanezcan disponibles.

## Perfiles de herramientas (lista de permitidos base)

`tools.profile` establece una **lista de permitidos de herramientas base** antes de `tools.allow`/`tools.deny`.
Anulación por agente: `agents.list[].tools.profile`.

Perfiles:

- `minimal`: solo `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: sin restricción (igual que no establecer)

Ejemplo (solo mensajería por defecto, permitir también herramientas de Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Ejemplo (perfil de codificación, pero denegar exec/process en todas partes):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Ejemplo (perfil de codificación global, agente de soporte solo mensajería):

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## Política de herramientas específica del proveedor

Usa `tools.byProvider` para **restringir aún más** las herramientas para proveedores específicos
(o un solo `provider/model`) sin cambiar tus valores predeterminados globales.
Anulación por agente: `agents.list[].tools.byProvider`.

Esto se aplica **después** del perfil de herramientas base y **antes** de las listas de permitir/denegar,
por lo que solo puede reducir el conjunto de herramientas.
Las claves de proveedor aceptan `provider` (por ejemplo, `google-antigravity`) o
`provider/model` (por ejemplo, `openai/gpt-5.2`).

Ejemplo (mantener perfil de codificación global, pero herramientas mínimas para Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Ejemplo (lista de permitidos específica de provider/model para un endpoint inestable):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

Ejemplo (anulación específica del agente para un solo proveedor):

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## Grupos de herramientas (abreviaturas)

Las políticas de herramientas (global, agente, sandbox) admiten entradas `group:*` que se expanden a múltiples herramientas.
Úsalas en `tools.allow` / `tools.deny`.

Grupos disponibles:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas las herramientas integradas de OpenClaw (excluye complementos de proveedor)

Ejemplo (permitir solo herramientas de archivo + navegador):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Complementos + herramientas

Los complementos pueden registrar **herramientas adicionales** (y comandos CLI) más allá del conjunto principal.
Consulta [Complementos](/es-ES/tools/plugin) para instalar + configurar, y [Habilidades](/es-ES/tools/skills) para ver cómo
se inyecta la orientación de uso de herramientas en los prompts. Algunos complementos incluyen sus propias habilidades
junto con las herramientas (por ejemplo, el complemento de llamada de voz).

Herramientas de complementos opcionales:

- [Lobster](/es-ES/tools/lobster): tiempo de ejecución de flujo de trabajo tipado con aprobaciones reanudables (requiere Lobster CLI en el host del gateway).
- [LLM Task](/es-ES/tools/llm-task): paso LLM solo JSON para salida de flujo de trabajo estructurada (validación de esquema opcional).

## Inventario de herramientas

### `apply_patch`

Aplica parches estructurados en uno o más archivos. Úsalo para ediciones de múltiples fragmentos.
Experimental: habilitar mediante `tools.exec.applyPatch.enabled` (solo modelos OpenAI).
`tools.exec.applyPatch.workspaceOnly` tiene como valor predeterminado `true` (contenido en el espacio de trabajo). Establécelo en `false` solo si intencionalmente deseas que `apply_patch` escriba/elimine fuera del directorio del espacio de trabajo.

### `exec`

Ejecuta comandos de shell en el espacio de trabajo.

Parámetros principales:

- `command` (requerido)
- `yieldMs` (segundo plano automático después del tiempo de espera, predeterminado 10000)
- `background` (segundo plano inmediato)
- `timeout` (segundos; mata el proceso si se excede, predeterminado 1800)
- `elevated` (bool; ejecutar en host si el modo elevado está habilitado/permitido; solo cambia el comportamiento cuando el agente está en sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/nombre de nodo para `host=node`)
- ¿Necesitas una TTY real? Establece `pty: true`.

Notas:

- Devuelve `status: "running"` con un `sessionId` cuando está en segundo plano.
- Usa `process` para sondear/registrar/escribir/matar/limpiar sesiones en segundo plano.
- Si `process` no está permitido, `exec` se ejecuta sincrónicamente e ignora `yieldMs`/`background`.
- `elevated` está restringido por `tools.elevated` más cualquier anulación de `agents.list[].tools.elevated` (ambos deben permitirlo) y es un alias para `host=gateway` + `security=full`.
- `elevated` solo cambia el comportamiento cuando el agente está en sandbox (de lo contrario, no hace nada).
- `host=node` puede apuntar a una aplicación complementaria de macOS o un host de nodo sin interfaz gráfica (`openclaw node run`).
- aprobaciones y listas de permitidos de gateway/nodo: [Aprobaciones de Exec](/es-ES/tools/exec-approvals).

### `process`

Administra sesiones de exec en segundo plano.

Acciones principales:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notas:

- `poll` devuelve nueva salida y estado de salida cuando se completa.
- `log` admite `offset`/`limit` basado en líneas (omite `offset` para tomar las últimas N líneas).
- `process` tiene alcance por agente; las sesiones de otros agentes no son visibles.

### `loop-detection` (protecciones de bucle de llamada de herramientas)

OpenClaw rastrea el historial reciente de llamadas de herramientas y bloquea o advierte cuando detecta bucles repetitivos sin progreso.
Habilita con `tools.loopDetection.enabled: true` (el valor predeterminado es `false`).

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      historySize: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `genericRepeat`: patrón de llamada repetida de la misma herramienta + mismos parámetros.
- `knownPollNoProgress`: repetición de herramientas tipo sondeo con salidas idénticas.
- `pingPong`: patrones alternos `A/B/A/B` sin progreso.
- Anulación por agente: `agents.list[].tools.loopDetection`.

### `web_search`

Busca en la web usando la API de Brave Search.

Parámetros principales:

- `query` (requerido)
- `count` (1–10; predeterminado de `tools.web.search.maxResults`)

Notas:

- Requiere una clave de API de Brave (recomendado: `openclaw configure --section web`, o establece `BRAVE_API_KEY`).
- Habilita mediante `tools.web.search.enabled`.
- Las respuestas se almacenan en caché (predeterminado 15 min).
- Consulta [Herramientas web](/es-ES/tools/web) para la configuración.

### `web_fetch`

Obtiene y extrae contenido legible de una URL (HTML → markdown/texto).

Parámetros principales:

- `url` (requerido)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncar páginas largas)

Notas:

- Habilita mediante `tools.web.fetch.enabled`.
- `maxChars` está limitado por `tools.web.fetch.maxCharsCap` (predeterminado 50000).
- Las respuestas se almacenan en caché (predeterminado 15 min).
- Para sitios con mucho JS, prefiere la herramienta browser.
- Consulta [Herramientas web](/es-ES/tools/web) para la configuración.
- Consulta [Firecrawl](/es-ES/tools/firecrawl) para la solución alternativa anti-bot opcional.

### `browser`

Controla el navegador dedicado administrado por OpenClaw.

Acciones principales:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (devuelve bloque de imagen + `MEDIA:<ruta>`)
- `act` (acciones de UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Gestión de perfiles:

- `profiles` — lista todos los perfiles del navegador con estado
- `create-profile` — crea un nuevo perfil con puerto auto-asignado (o `cdpUrl`)
- `delete-profile` — detiene el navegador, elimina datos de usuario, elimina de la configuración (solo local)
- `reset-profile` — mata el proceso huérfano en el puerto del perfil (solo local)

Parámetros comunes:

- `profile` (opcional; predeterminado a `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcional; selecciona un id/nombre de nodo específico)
  Notas:
- Requiere `browser.enabled=true` (el predeterminado es `true`; establece `false` para deshabilitar).
- Todas las acciones aceptan el parámetro `profile` opcional para soporte de múltiples instancias.
- Cuando se omite `profile`, usa `browser.defaultProfile` (predeterminado a "chrome").
- Nombres de perfil: solo alfanuméricos en minúsculas + guiones (máximo 64 caracteres).
- Rango de puerto: 18800-18899 (~100 perfiles máx.).
- Los perfiles remotos son solo de adjuntar (sin iniciar/detener/reiniciar).
- Si un nodo con capacidad de navegador está conectado, la herramienta puede enrutar automáticamente hacia él (a menos que fijes `target`).
- `snapshot` tiene como predeterminado `ai` cuando Playwright está instalado; usa `aria` para el árbol de accesibilidad.
- `snapshot` también admite opciones de role-snapshot (`interactive`, `compact`, `depth`, `selector`) que devuelven refs como `e12`.
- `act` requiere `ref` de `snapshot` (numérico `12` de snapshots AI, o `e12` de role snapshots); usa `evaluate` para necesidades raras de selector CSS.
- Evita `act` → `wait` por defecto; úsalo solo en casos excepcionales (sin estado de UI confiable en el que esperar).
- `upload` puede pasar opcionalmente un `ref` para hacer clic automáticamente después de armar.
- `upload` también admite `inputRef` (ref aria) o `element` (selector CSS) para establecer `<input type="file">` directamente.

### `canvas`

Controla el Lienzo del nodo (present, eval, snapshot, A2UI).

Acciones principales:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (devuelve bloque de imagen + `MEDIA:<ruta>`)
- `a2ui_push`, `a2ui_reset`

Notas:

- Usa `node.invoke` del gateway internamente.
- Si no se proporciona `node`, la herramienta elige un predeterminado (nodo único conectado o nodo mac local).
- A2UI es solo v0.8 (sin `createSurface`); el CLI rechaza JSONL v0.9 con errores de línea.
- Prueba rápida: `openclaw nodes canvas a2ui push --node <id> --text "Hola desde A2UI"`.

### `nodes`

Descubre y apunta a nodos emparejados; envía notificaciones; captura cámara/pantalla.

Acciones principales:

- `status`, `describe`
- `pending`, `approve`, `reject` (emparejamiento)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notas:

- Los comandos de cámara/pantalla requieren que la aplicación del nodo esté en primer plano.
- Las imágenes devuelven bloques de imagen + `MEDIA:<ruta>`.
- Los videos devuelven `FILE:<ruta>` (mp4).
- Location devuelve una carga JSON (lat/lon/accuracy/timestamp).
- Parámetros de `run`: array argv de `command`; `cwd`, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording` opcionales.

Ejemplo (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hola"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analiza una imagen con el modelo de imagen configurado.

Parámetros principales:

- `image` (ruta o URL requerida)
- `prompt` (opcional; predeterminado a "Describe the image.")
- `model` (anulación opcional)
- `maxBytesMb` (límite de tamaño opcional)

Notas:

- Solo disponible cuando `agents.defaults.imageModel` está configurado (primario o alternativas), o cuando un modelo de imagen implícito puede inferirse de tu modelo predeterminado + autenticación configurada (emparejamiento de mejor esfuerzo).
- Usa el modelo de imagen directamente (independiente del modelo de chat principal).

### `message`

Envía mensajes y acciones de canal a través de Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Acciones principales:

- `send` (texto + medios opcionales; MS Teams también admite `card` para Adaptive Cards)
- `poll` (encuestas de WhatsApp/Discord/MS Teams)
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

Notas:

- `send` enruta WhatsApp a través del Gateway; otros canales van directos.
- `poll` usa el Gateway para WhatsApp y MS Teams; las encuestas de Discord van directas.
- Cuando una llamada de herramienta de mensaje está vinculada a una sesión de chat activa, los envíos se restringen al objetivo de esa sesión para evitar fugas de contexto cruzado.

### `cron`

Administra trabajos cron y despertares del Gateway.

Acciones principales:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (encolar evento del sistema + latido inmediato opcional)

Notas:

- `add` espera un objeto de trabajo cron completo (mismo esquema que RPC `cron.add`).
- `update` usa `{ jobId, patch }` (`id` aceptado por compatibilidad).

### `gateway`

Reinicia o aplica actualizaciones al proceso Gateway en ejecución (in situ).

Acciones principales:

- `restart` (autoriza + envía `SIGUSR1` para reinicio en proceso; reinicio `openclaw gateway` in situ)
- `config.get` / `config.schema`
- `config.apply` (validar + escribir config + reiniciar + despertar)
- `config.patch` (fusionar actualización parcial + reiniciar + despertar)
- `update.run` (ejecutar actualización + reiniciar + despertar)

Notas:

- Usa `delayMs` (predeterminado a 2000) para evitar interrumpir una respuesta en vuelo.
- `restart` está deshabilitado por defecto; habilita con `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Lista sesiones, inspecciona el historial de transcripción o envía a otra sesión.

Parámetros principales:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = ninguno)
- `sessions_history`: `sessionKey` (o `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (o `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (predeterminado actual; acepta `sessionId`), `model?` (`default` borra la anulación)

Notas:

- `main` es la clave canónica de chat directo; global/desconocido están ocultos.
- `messageLimit > 0` obtiene los últimos N mensajes por sesión (mensajes de herramientas filtrados).
- La orientación de sesión está controlada por `tools.sessions.visibility` (predeterminado `tree`: sesión actual + sesiones de subagentes generadas). Si ejecutas un agente compartido para múltiples usuarios, considera establecer `tools.sessions.visibility: "self"` para evitar la navegación entre sesiones.
- `sessions_send` espera la finalización final cuando `timeoutSeconds > 0`.
- La entrega/anuncio ocurre después de la finalización y es de mejor esfuerzo; `status: "ok"` confirma que la ejecución del agente finalizó, no que se entregó el anuncio.
- `sessions_spawn` inicia una ejecución de subagente y publica una respuesta de anuncio al chat solicitante.
- `sessions_spawn` no es bloqueante y devuelve `status: "accepted"` inmediatamente.
- `sessions_send` ejecuta un ping-pong de respuesta (responde `REPLY_SKIP` para detener; máx. turnos mediante `session.agentToAgent.maxPingPongTurns`, 0–5).
- Después del ping-pong, el agente objetivo ejecuta un **paso de anuncio**; responde `ANNOUNCE_SKIP` para suprimir el anuncio.
- Restricción de Sandbox: cuando la sesión actual está en sandbox y `agents.defaults.sandbox.sessionToolsVisibility: "spawned"`, OpenClaw restringe `tools.sessions.visibility` a `tree`.

### `agents_list`

Lista ids de agentes a los que la sesión actual puede dirigirse con `sessions_spawn`.

Notas:

- El resultado está restringido a listas de permitidos por agente (`agents.list[].subagents.allowAgents`).
- Cuando se configura `["*"]`, la herramienta incluye todos los agentes configurados y marca `allowAny: true`.

## Parámetros (comunes)

Herramientas respaldadas por Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (predeterminado `ws://127.0.0.1:18789`)
- `gatewayToken` (si la autenticación está habilitada)
- `timeoutMs`

Nota: cuando se establece `gatewayUrl`, incluye `gatewayToken` explícitamente. Las herramientas no heredan config
o credenciales de entorno para anulaciones, y las credenciales explícitas faltantes son un error.

Herramienta Browser:

- `profile` (opcional; predeterminado a `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcional; fija un id/nombre de nodo específico)

## Flujos de agente recomendados

Automatización de navegador:

1. `browser` → `status` / `start`
2. `snapshot` (ai o aria)
3. `act` (click/type/press)
4. `screenshot` si necesitas confirmación visual

Renderizado de lienzo:

1. `canvas` → `present`
2. `a2ui_push` (opcional)
3. `snapshot`

Orientación de nodo:

1. `nodes` → `status`
2. `describe` en el nodo elegido
3. `notify` / `run` / `camera_snap` / `screen_record`

## Seguridad

- Evita `system.run` directo; usa `nodes` → `run` solo con consentimiento explícito del usuario.
- Respeta el consentimiento del usuario para captura de cámara/pantalla.
- Usa `status/describe` para asegurar permisos antes de invocar comandos de medios.

## Cómo se presentan las herramientas al agente

Las herramientas se exponen en dos canales paralelos:

1. **Texto del prompt del sistema**: una lista legible por humanos + orientación.
2. **Esquema de herramientas**: las definiciones de función estructuradas enviadas a la API del modelo.

Eso significa que el agente ve tanto "qué herramientas existen" como "cómo llamarlas". Si una herramienta
no aparece en el prompt del sistema o en el esquema, el modelo no puede llamarla.
