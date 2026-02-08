---
summary: "Reglas de gestión de sesiones, claves y persistencia para chats"
read_when:
  - Modificar el manejo o almacenamiento de sesiones
title: "Gestión de sesiones"
x-i18n:
  source_path: concepts/session.md
  source_hash: e2040cea1e0738a8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:32Z
---

# Gestión de sesiones

OpenClaw trata **una sesión de chat directo por agente** como principal. Los chats directos se colapsan en `agent:<agentId>:<mainKey>` (predeterminado `main`), mientras que los chats de grupo/canal obtienen sus propias claves. Se respeta `session.mainKey`.

Use `session.dmScope` para controlar cómo se agrupan los **mensajes directos**:

- `main` (predeterminado): todos los MD comparten la sesión principal para continuidad.
- `per-peer`: aislar por id de remitente entre canales.
- `per-channel-peer`: aislar por canal + remitente (recomendado para bandejas de entrada multiusuario).
- `per-account-channel-peer`: aislar por cuenta + canal + remitente (recomendado para bandejas de entrada multicuentas).
  Use `session.identityLinks` para mapear ids de pares con prefijo de proveedor a una identidad canónica para que la misma persona comparta una sesión de MD entre canales al usar `per-peer`, `per-channel-peer` o `per-account-channel-peer`.

## Modo de MD seguro (recomendado para configuraciones multiusuario)

> **Advertencia de seguridad:** Si su agente puede recibir MD de **múltiples personas**, debería considerar seriamente habilitar el modo de MD seguro. Sin él, todos los usuarios comparten el mismo contexto de conversación, lo que puede filtrar información privada entre usuarios.

**Ejemplo del problema con la configuración predeterminada:**

- Alicia (`<SENDER_A>`) le envía un mensaje a su agente sobre un tema privado (por ejemplo, una cita médica)
- Bob (`<SENDER_B>`) le envía un mensaje a su agente preguntando "¿De qué estábamos hablando?"
- Como ambos MD comparten la misma sesión, el modelo puede responder a Bob usando el contexto previo de Alicia.

**La solución:** Configure `dmScope` para aislar sesiones por usuario:

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    // Secure DM mode: isolate DM context per channel + sender.
    dmScope: "per-channel-peer",
  },
}
```

**Cuándo habilitarlo:**

- Tiene aprobaciones de emparejamiento para más de un remitente
- Usa una lista de permitidos de MD con múltiples entradas
- Configura `dmPolicy: "open"`
- Múltiples números de teléfono o cuentas pueden enviar mensajes a su agente

Notas:

- El valor predeterminado es `dmScope: "main"` para continuidad (todos los MD comparten la sesión principal). Esto está bien para configuraciones de un solo usuario.
- Para bandejas de entrada multicuentas en el mismo canal, prefiera `per-account-channel-peer`.
- Si la misma persona lo contacta en múltiples canales, use `session.identityLinks` para colapsar sus sesiones de MD en una sola identidad canónica.
- Puede verificar la configuración de MD con `openclaw security audit` (ver [security](/cli/security)).

## El Gateway es la fuente de la verdad

Todo el estado de sesión es **propiedad del gateway** (el OpenClaw “maestro”). Los clientes de UI (app de macOS, WebChat, etc.) deben consultar al gateway para las listas de sesiones y los conteos de tokens en lugar de leer archivos locales.

- En **modo remoto**, el almacén de sesiones que importa vive en el host del Gateway remoto, no en su Mac.
- Los conteos de tokens mostrados en las UIs provienen de los campos del almacén del gateway (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Los clientes no analizan transcripciones JSONL para “arreglar” totales.

## Dónde vive el estado

- En el **host del Gateway**:
  - Archivo de almacén: `~/.openclaw/agents/<agentId>/sessions/sessions.json` (por agente).
- Transcripciones: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` (las sesiones de temas de Telegram usan `.../<SessionId>-topic-<threadId>.jsonl`).
- El almacén es un mapa `sessionKey -> { sessionId, updatedAt, ... }`. Eliminar entradas es seguro; se recrean bajo demanda.
- Las entradas de grupo pueden incluir `displayName`, `channel`, `subject`, `room` y `space` para etiquetar sesiones en las UIs.
- Las entradas de sesión incluyen metadatos `origin` (etiqueta + pistas de enrutamiento) para que las UIs puedan explicar de dónde provino una sesión.
- OpenClaw **no** lee carpetas de sesiones heredadas de Pi/Tau.

## Poda de sesiones

OpenClaw recorta **resultados antiguos de herramientas** del contexto en memoria justo antes de las llamadas al LLM de forma predeterminada.
Esto **no** reescribe el historial JSONL. Consulte [/concepts/session-pruning](/concepts/session-pruning).

## Vaciado de memoria previo a la compactación

Cuando una sesión se acerca a la compactación automática, OpenClaw puede ejecutar un **vaciado de memoria silencioso**
que le recuerda al modelo escribir notas duraderas en disco. Esto solo se ejecuta cuando
el espacio de trabajo es escribible. Consulte [Memory](/concepts/memory) y
[Compaction](/concepts/compaction).

## Mapeo de transportes → claves de sesión

- Los chats directos siguen `session.dmScope` (predeterminado `main`).
  - `main`: `agent:<agentId>:<mainKey>` (continuidad entre dispositivos/canales).
    - Múltiples números de teléfono y canales pueden mapearse a la misma clave principal del agente; actúan como transportes hacia una sola conversación.
  - `per-peer`: `agent:<agentId>:dm:<peerId>`.
  - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`.
  - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>` (accountId predetermina a `default`).
  - Si `session.identityLinks` coincide con un id de par con prefijo de proveedor (por ejemplo `telegram:123`), la clave canónica reemplaza a `<peerId>` para que la misma persona comparta una sesión entre canales.
- Los chats de grupo aíslan el estado: `agent:<agentId>:<channel>:group:<id>` (las salas/canales usan `agent:<agentId>:<channel>:channel:<id>`).
  - Los temas de foros de Telegram agregan `:topic:<threadId>` al id del grupo para aislamiento.
  - Las claves heredadas `group:<id>` aún se reconocen para migración.
- Los contextos entrantes aún pueden usar `group:<id>`; el canal se infiere desde `Provider` y se normaliza a la forma canónica `agent:<agentId>:<channel>:group:<id>`.
- Otras fuentes:
  - Tareas cron: `cron:<job.id>`
  - Webhooks: `hook:<uuid>` (a menos que el hook lo establezca explícitamente)
  - Ejecuciones de nodos: `node-<nodeId>`

## Ciclo de vida

- Política de reinicio: las sesiones se reutilizan hasta que expiran, y la expiración se evalúa en el siguiente mensaje entrante.
- Reinicio diario: predetermina a **4:00 AM hora local en el host del Gateway**. Una sesión está obsoleta una vez que su última actualización es anterior al tiempo de reinicio diario más reciente.
- Reinicio por inactividad (opcional): `idleMinutes` agrega una ventana deslizante de inactividad. Cuando se configuran reinicios diarios e inactividad, **el que expire primero** fuerza una nueva sesión.
- Solo inactividad heredado: si configura `session.idleMinutes` sin ninguna configuración de `session.reset`/`resetByType`, OpenClaw permanece en modo solo inactividad por compatibilidad hacia atrás.
- Anulaciones por tipo (opcional): `resetByType` le permite anular la política para sesiones `dm`, `group` y `thread` (hilo = hilos de Slack/Discord, temas de Telegram, hilos de Matrix cuando el conector los proporciona).
- Anulaciones por canal (opcional): `resetByChannel` anula la política de reinicio para un canal (se aplica a todos los tipos de sesión para ese canal y tiene prioridad sobre `reset`/`resetByType`).
- Disparadores de reinicio: los `/new` o `/reset` exactos (más cualquier extra en `resetTriggers`) inician un id de sesión nuevo y pasan el resto del mensaje. `/new <model>` acepta un alias de modelo, `provider/model` o nombre de proveedor (coincidencia difusa) para establecer el modelo de la nueva sesión. Si `/new` o `/reset` se envía solo, OpenClaw ejecuta un breve turno de saludo “hola” para confirmar el reinicio.
- Reinicio manual: elimine claves específicas del almacén o quite la transcripción JSONL; el siguiente mensaje las recrea.
- Las tareas cron aisladas siempre acuñan un `sessionId` nuevo por ejecución (sin reutilización por inactividad).

## Política de envío (opcional)

Bloquee la entrega para tipos de sesión específicos sin listar ids individuales.

```json5
{
  session: {
    sendPolicy: {
      rules: [
        { action: "deny", match: { channel: "discord", chatType: "group" } },
        { action: "deny", match: { keyPrefix: "cron:" } },
      ],
      default: "allow",
    },
  },
}
```

Anulación en tiempo de ejecución (solo propietario):

- `/send on` → permitir para esta sesión
- `/send off` → denegar para esta sesión
- `/send inherit` → limpiar la anulación y usar reglas de configuración
  Envíelos como mensajes independientes para que se registren.

## Configuración (ejemplo opcional de cambio de nombre)

```json5
// ~/.openclaw/openclaw.json
{
  session: {
    scope: "per-sender", // keep group keys separate
    dmScope: "main", // DM continuity (set per-channel-peer/per-account-channel-peer for shared inboxes)
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      // Defaults: mode=daily, atHour=4 (gateway host local time).
      // If you also set idleMinutes, whichever expires first wins.
      mode: "daily",
      atHour: 4,
      idleMinutes: 120,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetByChannel: {
      discord: { mode: "idle", idleMinutes: 10080 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    mainKey: "main",
  },
}
```

## Inspección

- `openclaw status` — muestra la ruta del almacén y sesiones recientes.
- `openclaw sessions --json` — vuelca cada entrada (filtre con `--active <minutes>`).
- `openclaw gateway call sessions.list --params '{}'` — obtiene sesiones del gateway en ejecución (use `--url`/`--token` para acceso a Gateway remoto).
- Envíe `/status` como mensaje independiente en el chat para ver si el agente es alcanzable, cuánto del contexto de la sesión se usa, los alternadores actuales de pensamiento/verbosidad y cuándo se actualizaron por última vez sus credenciales web de WhatsApp (ayuda a detectar necesidades de reconexión).
- Envíe `/context list` o `/context detail` para ver qué hay en el prompt del sistema y los archivos del espacio de trabajo inyectados (y los mayores contribuyentes al contexto).
- Envíe `/stop` como mensaje independiente para abortar la ejecución actual, limpiar seguimientos en cola para esa sesión y detener cualquier ejecución de subagentes generada desde ella (la respuesta incluye el conteo detenido).
- Envíe `/compact` (instrucciones opcionales) como mensaje independiente para resumir contexto antiguo y liberar espacio de ventana. Consulte [/concepts/compaction](/concepts/compaction).
- Las transcripciones JSONL pueden abrirse directamente para revisar turnos completos.

## Consejos

- Mantenga la clave principal dedicada al tráfico 1:1; deje que los grupos mantengan sus propias claves.
- Al automatizar la limpieza, elimine claves individuales en lugar de todo el almacén para preservar contexto en otros lugares.

## Metadatos de origen de sesión

Cada entrada de sesión registra de dónde provino (mejor esfuerzo) en `origin`:

- `label`: etiqueta humana (resuelta desde la etiqueta de conversación + asunto del grupo/canal)
- `provider`: id de canal normalizado (incluidas extensiones)
- `from`/`to`: ids de enrutamiento sin procesar del sobre entrante
- `accountId`: id de cuenta del proveedor (cuando es multicuenta)
- `threadId`: id de hilo/tema cuando el canal lo admite
  Los campos de origen se rellenan para mensajes directos, canales y grupos. Si un
  conector solo actualiza el enrutamiento de entrega (por ejemplo, para mantener fresca una sesión principal de MD),
  aún debería proporcionar contexto entrante para que la sesión conserve sus
  metadatos explicativos. Las extensiones pueden hacerlo enviando `ConversationLabel`,
  `GroupSubject`, `GroupChannel`, `GroupSpace` y `SenderName` en el contexto
  entrante y llamando a `recordSessionMetaFromInbound` (o pasando el mismo contexto
  a `updateLastRoute`).
