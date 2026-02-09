---
summary: "Superficie de herramientas del agente para OpenClaw (browser, canvas, nodes, message, cron) que reemplaza las skills heredadas `openclaw-*`"
read_when:
  - Agregar o modificar herramientas del agente
  - Retirar o cambiar skills `openclaw-*`
title: "Herramientas"
---

# Herramientas (OpenClaw)

OpenClaw expone **herramientas de agente de primera clase** para browser, canvas, nodes y cron.
Estas reemplazan las skills antiguas `openclaw-*`: las herramientas son tipadas, sin ejecutar shell,
y el agente debe apoyarse directamente en ellas.

## Deshabilitar herramientas

Puede permitir/denegar herramientas globalmente mediante `tools.allow` / `tools.deny` en `openclaw.json`
(la denegación prevalece). Esto evita que herramientas no permitidas se envíen a los proveedores de modelos.

```json5
{
  tools: { deny: ["browser"] },
}
```

Notas:

- La coincidencia no distingue mayúsculas/minúsculas.
- Se admiten comodines `*` (`"*"` significa todas las herramientas).
- Si `tools.allow` solo hace referencia a nombres de herramientas de plugins desconocidos o no cargados, OpenClaw registra una advertencia e ignora la lista de permitidos para que las herramientas centrales sigan disponibles.

## Perfiles de herramientas (lista de permitidos base)

`tools.profile` establece una **lista de permitidos base de herramientas** antes de `tools.allow`/`tools.deny`.
Anulación por agente: `agents.list[].tools.profile`.

Perfiles:

- `minimal`: solo `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: sin restricción (igual que no configurado)

Ejemplo (solo mensajería por defecto, permitir también herramientas de Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Ejemplo (perfil de programación, pero denegar exec/process en todas partes):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

Ejemplo (perfil global de programación, agente de soporte solo mensajería):

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

Use `tools.byProvider` para **restringir aún más** las herramientas para proveedores específicos
(o un solo `provider/model`) sin cambiar sus valores globales.
Anulación por agente: `agents.list[].tools.byProvider`.

Esto se aplica **después** del perfil base de herramientas y **antes** de las listas de permitir/denegar,
por lo que solo puede reducir el conjunto de herramientas.
Las claves de proveedor aceptan `provider` (p. ej., `google-antigravity`) o
`provider/model` (p. ej., `openai/gpt-5.2`).

Ejemplo (mantener el perfil global de programación, pero herramientas mínimas para Google Antigravity):

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

Ejemplo (lista de permitidos específica de proveedor/modelo para un endpoint inestable):

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

## Grupos de herramientas (atajos)

Las políticas de herramientas (global, agente, sandbox) admiten entradas `group:*` que se expanden a múltiples herramientas.
Úselas en `tools.allow` / `tools.deny`.

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
- `group:openclaw`: todas las herramientas integradas de OpenClaw (excluye plugins de proveedores)

Ejemplo (permitir solo herramientas de archivos + browser):

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## Plugins + herramientas

Los plugins pueden registrar **herramientas adicionales** (y comandos de la CLI) más allá del conjunto central.
Vea [Plugins](/tools/plugin) para instalación + configuración, y [Skills](/tools/skills) para cómo
se inyecta la guía de uso de herramientas en los prompts. Algunos plugins incluyen sus propias skills
junto con herramientas (por ejemplo, el plugin de llamadas de voz).

Herramientas opcionales de plugins:

- [Lobster](/tools/lobster): runtime de flujos de trabajo tipados con aprobaciones reanudables (requiere la CLI de Lobster en el host del Gateway).
- [LLM Task](/tools/llm-task): paso LLM solo JSON para salida estructurada de flujos de trabajo (validación de esquema opcional).

## Inventario de herramientas

### `apply_patch`

Aplique parches estructurados en uno o más archivos. Úselo para ediciones con múltiples hunks.
Experimental: habilítelo mediante `tools.exec.applyPatch.enabled` (solo modelos de OpenAI).

### `exec`

Ejecute comandos de shell en el workspace.

Parámetros principales:

- `command` (requerido)
- `yieldMs` (auto a segundo plano tras el tiempo de espera, predeterminado 10000)
- `background` (segundo plano inmediato)
- `timeout` (segundos; finaliza el proceso si se excede, predeterminado 1800)
- `elevated` (bool; ejecutar en el host si el modo elevado está habilitado/permitido; solo cambia el comportamiento cuando el agente está en sandbox)
- `host` (`sandbox | gateway | node`)
- `security` (`deny | allowlist | full`)
- `ask` (`off | on-miss | always`)
- `node` (id/nombre del nodo para `host=node`)
- ¿Necesita un TTY real? Configure `pty: true`.

Notas:

- Devuelve `status: "running"` con un `sessionId` cuando se envía a segundo plano.
- Use `process` para sondear/registrar/escribir/finalizar/limpiar sesiones en segundo plano.
- Si `process` no está permitido, `exec` se ejecuta de forma sincrónica e ignora `yieldMs`/`background`.
- `elevated` está restringido por `tools.elevated` más cualquier anulación `agents.list[].tools.elevated` (ambos deben permitir) y es un alias de `host=gateway` + `security=full`.
- `elevated` solo cambia el comportamiento cuando el agente está en sandbox (de lo contrario no hace nada).
- `host=node` puede apuntar a una aplicación complementaria de macOS o a un host de nodo sin interfaz (`openclaw node run`).
- aprobaciones y listas de permitidos de gateway/nodo: [Aprobaciones de exec](/tools/exec-approvals).

### `process`

Gestione sesiones de exec en segundo plano.

Acciones principales:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

Notas:

- `poll` devuelve nueva salida y estado de salida cuando se completa.
- `log` admite `offset`/`limit` basados en líneas (omita `offset` para obtener las últimas N líneas).
- `process` tiene alcance por agente; las sesiones de otros agentes no son visibles.

### `web_search`

Busque en la web usando la API de Brave Search.

Parámetros principales:

- `query` (requerido)
- `count` (1–10; valor predeterminado desde `tools.web.search.maxResults`)

Notas:

- Requiere una clave de API de Brave (recomendado: `openclaw configure --section web`, o configurar `BRAVE_API_KEY`).
- Habilite mediante `tools.web.search.enabled`.
- Las respuestas se almacenan en caché (predeterminado 15 min).
- Consulte [Herramientas web](/tools/web) para la configuración.

### `web_fetch`

Obtenga y extraiga contenido legible de una URL (HTML → markdown/texto).

Parámetros principales:

- `url` (requerido)
- `extractMode` (`markdown` | `text`)
- `maxChars` (truncar páginas largas)

Notas:

- Habilite mediante `tools.web.fetch.enabled`.
- `maxChars` está limitado por `tools.web.fetch.maxCharsCap` (predeterminado 50000).
- Las respuestas se almacenan en caché (predeterminado 15 min).
- Para sitios con mucho JS, prefiera la herramienta de browser.
- Consulte [Herramientas web](/tools/web) para la configuración.
- Consulte [Firecrawl](/tools/firecrawl) para el respaldo anti-bot opcional.

### `browser`

Controle el browser dedicado administrado por OpenClaw.

Acciones principales:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot` (aria/ai)
- `screenshot` (devuelve bloque de imagen + `MEDIA:<path>`)
- `act` (acciones de UI: click/type/press/hover/drag/select/fill/resize/wait/evaluate)
- `navigate`, `console`, `pdf`, `upload`, `dialog`

Gestión de perfiles:

- `profiles` — listar todos los perfiles de browser con estado
- `create-profile` — crear un perfil nuevo con puerto autoasignado (o `cdpUrl`)
- `delete-profile` — detener browser, borrar datos de usuario, eliminar de la configuración (solo local)
- `reset-profile` — finalizar proceso huérfano en el puerto del perfil (solo local)

Parámetros comunes:

- `profile` (opcional; predeterminado `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcional; selecciona un id/nombre de nodo específico)
  Notas:
- Requiere `browser.enabled=true` (el valor predeterminado es `true`; configure `false` para deshabilitar).
- Todas las acciones aceptan el parámetro opcional `profile` para soporte de múltiples instancias.
- Cuando se omite `profile`, usa `browser.defaultProfile` (predeterminado "chrome").
- Nombres de perfil: solo alfanumérico en minúsculas + guiones (máx. 64 caracteres).
- Rango de puertos: 18800-18899 (~100 perfiles máx.).
- Los perfiles remotos son solo de adjunción (sin iniciar/detener/restablecer).
- Si hay un nodo con capacidad de browser conectado, la herramienta puede enrutar automáticamente hacia él (a menos que fije `target`).
- `snapshot` usa por defecto `ai` cuando Playwright está instalado; use `aria` para el árbol de accesibilidad.
- `snapshot` también admite opciones de instantánea por rol (`interactive`, `compact`, `depth`, `selector`) que devuelven referencias como `e12`.
- `act` requiere `ref` de `snapshot` (numérico `12` de instantáneas de IA, o `e12` de instantáneas por rol); use `evaluate` para casos raros de selectores CSS.
- Evite `act` → `wait` por defecto; úselo solo en casos excepcionales (sin un estado de UI confiable en el que esperar).
- `upload` puede pasar opcionalmente un `ref` para auto‑hacer clic tras armar.
- `upload` también admite `inputRef` (referencia aria) o `element` (selector CSS) para establecer `<input type="file">` directamente.

### `canvas`

Conduzca el Canvas del nodo (present, eval, snapshot, A2UI).

Acciones principales:

- `present`, `hide`, `navigate`, `eval`
- `snapshot` (devuelve bloque de imagen + `MEDIA:<path>`)
- `a2ui_push`, `a2ui_reset`

Notas:

- Usa `node.invoke` del Gateway internamente.
- Si no se proporciona `node`, la herramienta elige un valor predeterminado (un único nodo conectado o un nodo mac local).
- A2UI es solo v0.8 (sin `createSurface`); la CLI rechaza JSONL v0.9 con errores de línea.
- Prueba rápida: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`.

### `nodes`

Descubra y apunte a nodos emparejados; envíe notificaciones; capture cámara/pantalla.

Acciones principales:

- `status`, `describe`
- `pending`, `approve`, `reject` (emparejamiento)
- `notify` (macOS `system.notify`)
- `run` (macOS `system.run`)
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

Notas:

- Los comandos de cámara/pantalla requieren que la app del nodo esté en primer plano.
- Las imágenes devuelven bloques de imagen + `MEDIA:<path>`.
- Los videos devuelven `FILE:<path>` (mp4).
- La ubicación devuelve una carga JSON (lat/lon/accuracy/timestamp).
- Parámetros de `run`: `command` arreglo argv; `cwd` opcional, `env` (`KEY=VAL`), `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`.

Ejemplo (`run`):

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

Analice una imagen con el modelo de imágenes configurado.

Parámetros principales:

- `image` (ruta o URL requerida)
- `prompt` (opcional; predeterminado "Describe the image.")
- `model` (anulación opcional)
- `maxBytesMb` (límite de tamaño opcional)

Notas:

- Solo disponible cuando `agents.defaults.imageModel` está configurado (principal o de respaldo), o cuando se puede inferir implícitamente un modelo de imágenes a partir de su modelo predeterminado + autenticación configurada (emparejamiento de mejor esfuerzo).
- Usa el modelo de imágenes directamente (independiente del modelo principal de chat).

### `message`

Envíe mensajes y acciones de canal en Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams.

Acciones principales:

- `send` (texto + medios opcionales; MS Teams también admite `card` para tarjetas adaptativas)
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

- `send` enruta WhatsApp a través del Gateway; los demás canales van directos.
- `poll` usa el Gateway para WhatsApp y MS Teams; las encuestas de Discord van directas.
- Cuando una llamada de herramienta de mensajería está vinculada a una sesión de chat activa, los envíos se restringen al destino de esa sesión para evitar fugas entre contextos.

### `cron`

Gestione trabajos cron y activaciones del Gateway.

Acciones principales:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake` (encolar evento del sistema + latido inmediato opcional)

Notas:

- `add` espera un objeto completo de trabajo cron (el mismo esquema que el RPC `cron.add`).
- `update` usa `{ jobId, patch }` (se acepta `id` por compatibilidad).

### `gateway`

Reinicie o aplique actualizaciones al proceso del Gateway en ejecución (en sitio).

Acciones principales:

- `restart` (autoriza + envía `SIGUSR1` para reinicio en proceso; `openclaw gateway` reinicio en sitio)
- `config.get` / `config.schema`
- `config.apply` (validar + escribir configuración + reiniciar + activar)
- `config.patch` (fusionar actualización parcial + reiniciar + activar)
- `update.run` (ejecutar actualización + reiniciar + activar)

Notas:

- Use `delayMs` (predeterminado 2000) para evitar interrumpir una respuesta en curso.
- `restart` está deshabilitado por defecto; habilítelo con `commands.restart: true`.

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

Liste sesiones, inspeccione el historial de transcripciones o envíe a otra sesión.

Parámetros principales:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?` (0 = ninguno)
- `sessions_history`: `sessionKey` (o `sessionId`), `limit?`, `includeTools?`
- `sessions_send`: `sessionKey` (o `sessionId`), `message`, `timeoutSeconds?` (0 = fire-and-forget)
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?` (predeterminado actual; acepta `sessionId`), `model?` (`default` limpia la anulación)

Notas:

- `main` es la clave canónica de chat directo; global/desconocido están ocultos.
- `messageLimit > 0` obtiene las últimas N mensajes por sesión (mensajes de herramientas filtrados).
- `sessions_send` espera la finalización cuando `timeoutSeconds > 0`.
- La entrega/anuncio ocurre después de la finalización y es de mejor esfuerzo; `status: "ok"` confirma que la ejecución del agente terminó, no que el anuncio se haya entregado.
- `sessions_spawn` inicia una ejecución de sub‑agente y publica una respuesta de anuncio de vuelta al chat solicitante.
- `sessions_spawn` no bloquea y devuelve `status: "accepted"` de inmediato.
- `sessions_send` ejecuta un ping‑pong de respuesta (responda `REPLY_SKIP` para detener; máx. turnos vía `session.agentToAgent.maxPingPongTurns`, 0–5).
- Tras el ping‑pong, el agente destino ejecuta un **paso de anuncio**; responda `ANNOUNCE_SKIP` para suprimir el anuncio.

### `agents_list`

Liste los ids de agentes a los que la sesión actual puede apuntar con `sessions_spawn`.

Notas:

- El resultado se restringe a listas de permitidos por agente (`agents.list[].subagents.allowAgents`).
- Cuando `["*"]` está configurado, la herramienta incluye todos los agentes configurados y marca `allowAny: true`.

## Parámetros (comunes)

Herramientas respaldadas por el Gateway (`canvas`, `nodes`, `cron`):

- `gatewayUrl` (predeterminado `ws://127.0.0.1:18789`)
- `gatewayToken` (si la autenticación está habilitada)
- `timeoutMs`

Nota: cuando se establece `gatewayUrl`, incluya `gatewayToken` explícitamente. Las herramientas no heredan la configuración
ni las credenciales del entorno para las anulaciones, y la falta de credenciales explícitas es un error.

Herramienta de browser:

- `profile` (opcional; predeterminado `browser.defaultProfile`)
- `target` (`sandbox` | `host` | `node`)
- `node` (opcional; fijar un id/nombre de nodo específico)

## Flujos recomendados del agente

Automatización del browser:

1. `browser` → `status` / `start`
2. `snapshot` (ai o aria)
3. `act` (click/type/press)
4. `screenshot` si necesita confirmación visual

Renderizado de canvas:

1. `canvas` → `present`
2. `a2ui_push` (opcional)
3. `snapshot`

Orientación del nodo:

1. `nodes` → `status`
2. `describe` en el nodo elegido
3. `notify` / `run` / `camera_snap` / `screen_record`

## Seguridad

- Evite `system.run` directo; use `nodes` → `run` solo con consentimiento explícito del usuario.
- Respete el consentimiento del usuario para la captura de cámara/pantalla.
- Use `status/describe` para asegurar permisos antes de invocar comandos de medios.

## Cómo se presentan las herramientas al agente

Las herramientas se exponen en dos canales paralelos:

1. **Texto del prompt del sistema**: una lista legible por humanos + guía.
2. **Esquema de herramientas**: las definiciones de funciones estructuradas enviadas a la API del modelo.

Esto significa que el agente ve tanto “qué herramientas existen” como “cómo llamarlas”. Si una herramienta
no aparece en el prompt del sistema ni en el esquema, el modelo no puede llamarla.
