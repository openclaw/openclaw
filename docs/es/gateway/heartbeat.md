---
summary: "Mensajes de sondeo de heartbeat y reglas de notificación"
read_when:
  - Ajustar la cadencia del heartbeat o la mensajería
  - Decidir entre heartbeat y cron para tareas programadas
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **¿Heartbeat vs Cron?** Consulte [Cron vs Heartbeat](/automation/cron-vs-heartbeat) para obtener orientación sobre cuándo usar cada uno.

Heartbeat ejecuta **turnos periódicos del agente** en la sesión principal para que el modelo pueda
mostrar cualquier cosa que requiera atención sin enviarle spam.

Solución de problemas: [/automation/troubleshooting](/automation/troubleshooting)

## Inicio rápido (principiante)

1. Deje los heartbeats habilitados (el valor predeterminado es `30m`, o `1h` para Anthropic OAuth/setup-token) o establezca su propia cadencia.
2. Cree una pequeña lista de verificación `HEARTBEAT.md` en el espacio de trabajo del agente (opcional pero recomendado).
3. Decida a dónde deben ir los mensajes de heartbeat (`target: "last"` es el valor predeterminado).
4. Opcional: habilite la entrega del razonamiento del heartbeat para mayor transparencia.
5. Opcional: restrinja los heartbeats a horas activas (hora local).

Ejemplo de configuración:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Valores predeterminados

- Intervalo: `30m` (o `1h` cuando Anthropic OAuth/setup-token es el modo de autenticación detectado). Establezca `agents.defaults.heartbeat.every` o por agente `agents.list[].heartbeat.every`; use `0m` para deshabilitar.
- Cuerpo del prompt (configurable mediante `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- El prompt de heartbeat se envía **literalmente** como el mensaje del usuario. El
  prompt del sistema incluye una sección “Heartbeat” y la ejecución se marca internamente.
- Las horas activas (`heartbeat.activeHours`) se verifican en la zona horaria configurada.
  Fuera de la ventana, los heartbeats se omiten hasta el siguiente tick dentro de la ventana.

## Para qué sirve el prompt de heartbeat

El prompt predeterminado es intencionalmente amplio:

- **Tareas en segundo plano**: “Consider outstanding tasks” incentiva al agente a revisar
  seguimientos (bandeja de entrada, calendario, recordatorios, trabajo en cola) y mostrar cualquier cosa urgente.
- **Chequeo humano**: “Checkup sometimes on your human during day time” incentiva un
  mensaje ocasional y ligero de “¿necesita algo?”, pero evita el spam nocturno
  usando su zona horaria local configurada (ver [/concepts/timezone](/concepts/timezone)).

Si quiere que un heartbeat haga algo muy específico (p. ej., “check Gmail PubSub
stats” o “verify gateway health”), establezca `agents.defaults.heartbeat.prompt` (o
`agents.list[].heartbeat.prompt`) con un cuerpo personalizado (enviado literalmente).

## Contrato de respuesta

- Si no hay nada que requiera atención, responda con **`HEARTBEAT_OK`**.
- Durante las ejecuciones de heartbeat, OpenClaw trata `HEARTBEAT_OK` como un acuse cuando aparece
  al **inicio o al final** de la respuesta. El token se elimina y la respuesta se
  descarta si el contenido restante es **≤ `ackMaxChars`** (predeterminado: 300).
- Si `HEARTBEAT_OK` aparece en la **mitad** de una respuesta, no se trata
  de forma especial.
- Para alertas, **no** incluya `HEARTBEAT_OK`; devuelva solo el texto de la alerta.

Fuera de los heartbeats, `HEARTBEAT_OK` aislado al inicio/final de un mensaje se elimina
y se registra; un mensaje que sea solo `HEARTBEAT_OK` se descarta.

## Configuración

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Alcance y precedencia

- `agents.defaults.heartbeat` establece el comportamiento global del heartbeat.
- `agents.list[].heartbeat` se fusiona encima; si algún agente tiene un bloque `heartbeat`, **solo esos agentes** ejecutan heartbeats.
- `channels.defaults.heartbeat` establece valores predeterminados de visibilidad para todos los canales.
- `channels.<channel>.heartbeat` sobrescribe los valores predeterminados del canal.
- `channels.<channel>.accounts.<id>.heartbeat` (canales de múltiples cuentas) sobrescribe la configuración por canal.

### Heartbeats por agente

Si alguna entrada `agents.list[]` incluye un bloque `heartbeat`, **solo esos agentes**
ejecutan heartbeats. El bloque por agente se fusiona encima de `agents.defaults.heartbeat`
(para que pueda establecer valores compartidos una vez y sobrescribir por agente).

Ejemplo: dos agentes, solo el segundo agente ejecuta heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Ejemplo de horas activas

Restrinja los heartbeats al horario laboral en una zona horaria específica:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Fuera de esta ventana (antes de las 9 a. m. o después de las 10 p. m. hora del Este), los heartbeats se omiten. El siguiente tick programado dentro de la ventana se ejecutará con normalidad.

### Ejemplo de múltiples cuentas

Use `accountId` para apuntar a una cuenta específica en canales de múltiples cuentas como Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678",
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Notas de campos

- `every`: intervalo de heartbeat (cadena de duración; unidad predeterminada = minutos).
- `model`: sobrescritura opcional del modelo para ejecuciones de heartbeat (`provider/model`).
- `includeReasoning`: cuando está habilitado, también entrega el mensaje separado `Reasoning:` cuando está disponible (misma forma que `/reasoning on`).
- `session`: clave de sesión opcional para ejecuciones de heartbeat.
  - `main` (predeterminado): sesión principal del agente.
  - Clave de sesión explícita (copiar desde `openclaw sessions --json` o la [CLI de sesiones](/cli/sessions)).
  - Formatos de clave de sesión: ver [Sesiones](/concepts/session) y [Grupos](/channels/groups).
- `target`:
  - `last` (predeterminado): entrega al último canal externo utilizado.
  - canal explícito: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: ejecuta el heartbeat pero **no entrega** externamente.
- `to`: sobrescritura opcional del destinatario (id específico del canal, p. ej., E.164 para WhatsApp o un id de chat de Telegram).
- `accountId`: id de cuenta opcional para canales de múltiples cuentas. Cuando `target: "last"`, el id de cuenta se aplica al último canal resuelto si admite cuentas; de lo contrario, se ignora. Si el id de cuenta no coincide con una cuenta configurada para el canal resuelto, la entrega se omite.
- `prompt`: sobrescribe el cuerpo del prompt predeterminado (no se fusiona).
- `ackMaxChars`: máximo de caracteres permitidos después de `HEARTBEAT_OK` antes de la entrega.
- `activeHours`: restringe las ejecuciones de heartbeat a una ventana de tiempo. Objeto con `start` (HH:MM, inclusivo), `end` (HH:MM exclusivo; se permite `24:00` para fin de día) y `timezone` opcional.
  - Omitido o `"user"`: usa su `agents.defaults.userTimezone` si está configurado; de lo contrario, vuelve a la zona horaria del sistema del host.
  - `"local"`: siempre usa la zona horaria del sistema del host.
  - Cualquier identificador IANA (p. ej., `America/New_York`): se usa directamente; si no es válido, vuelve al comportamiento `"user"` anterior.
  - Fuera de la ventana activa, los heartbeats se omiten hasta el siguiente tick dentro de la ventana.

## Comportamiento de entrega

- Los heartbeats se ejecutan en la sesión principal del agente de forma predeterminada (`agent:<id>:<mainKey>`),
  o `global` cuando `session.scope = "global"`. Establezca `session` para sobrescribir a una
  sesión de canal específica (Discord/WhatsApp/etc.).
- `session` solo afecta el contexto de la ejecución; la entrega está controlada por `target` y `to`.
- Para entregar a un canal/destinatario específico, establezca `target` + `to`. Con
  `target: "last"`, la entrega usa el último canal externo para esa sesión.
- Si la cola principal está ocupada, el heartbeat se omite y se reintenta más tarde.
- Si `target` se resuelve sin destino externo, la ejecución aún ocurre pero no
  se envía ningún mensaje saliente.
- Las respuestas solo de heartbeat **no** mantienen viva la sesión; se restaura el último `updatedAt`
  para que la expiración por inactividad se comporte con normalidad.

## Controles de visibilidad

De forma predeterminada, los acuses `HEARTBEAT_OK` se suprimen mientras que el contenido de alerta se
entrega. Puede ajustar esto por canal o por cuenta:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedencia: por cuenta → por canal → valores predeterminados del canal → valores predeterminados integrados.

### Qué hace cada indicador

- `showOk`: envía un acuse `HEARTBEAT_OK` cuando el modelo devuelve una respuesta solo OK.
- `showAlerts`: envía el contenido de la alerta cuando el modelo devuelve una respuesta que no es OK.
- `useIndicator`: emite eventos indicadores para superficies de estado de la UI.

Si **los tres** son false, OpenClaw omite la ejecución del heartbeat por completo (sin llamada al modelo).

### Ejemplos por canal vs por cuenta

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Patrones comunes

| Objetivo                                                                              | Configuración                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Comportamiento predeterminado (OKs silenciosos, alertas activadas) | _(no se necesita configuración)_                                      |
| Totalmente silencioso (sin mensajes, sin indicador)                | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Solo indicador (sin mensajes)                                      | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs solo en un canal                                                                  | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (opcional)

Si existe un archivo `HEARTBEAT.md` en el espacio de trabajo, el prompt predeterminado le indica al
agente que lo lea. Piénselo como su “lista de verificación de heartbeat”: pequeña, estable y
segura para incluir cada 30 minutos.

Si `HEARTBEAT.md` existe pero está efectivamente vacío (solo líneas en blanco y encabezados markdown como `# Heading`), OpenClaw omite la ejecución del heartbeat para ahorrar llamadas a la API.
Si el archivo falta, el heartbeat aún se ejecuta y el modelo decide qué hacer.

Manténgalo pequeño (lista corta o recordatorios) para evitar inflar el prompt.

Ejemplo de `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### ¿Puede el agente actualizar HEARTBEAT.md?

Sí — si usted se lo pide.

`HEARTBEAT.md` es solo un archivo normal en el espacio de trabajo del agente, por lo que puede decirle al
agente (en un chat normal) algo como:

- “Actualiza `HEARTBEAT.md` para agregar una revisión diaria del calendario.”
- “Reescribe `HEARTBEAT.md` para que sea más corto y se enfoque en seguimientos de la bandeja de entrada.”

Si quiere que esto ocurra de forma proactiva, también puede incluir una línea explícita en
su prompt de heartbeat como: “Si la lista de verificación se vuelve obsoleta, actualiza HEARTBEAT.md
con una mejor”.

Nota de seguridad: no ponga secretos (claves de API, números de teléfono, tokens privados) en
`HEARTBEAT.md` — pasa a formar parte del contexto del prompt.

## Activación manual (bajo demanda)

Puede poner en cola un evento del sistema y activar un heartbeat inmediato con:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

Si varios agentes tienen `heartbeat` configurado, una activación manual ejecuta inmediatamente
los heartbeats de cada uno de esos agentes.

Use `--mode next-heartbeat` para esperar al siguiente tick programado.

## Entrega de razonamiento (opcional)

De forma predeterminada, los heartbeats entregan solo la carga “respuesta” final.

Si quiere transparencia, habilite:

- `agents.defaults.heartbeat.includeReasoning: true`

Cuando está habilitado, los heartbeats también entregarán un mensaje separado con el prefijo
`Reasoning:` (misma forma que `/reasoning on`). Esto puede ser útil cuando el agente
administra múltiples sesiones/códices y quiere ver por qué decidió hacerle ping
— pero también puede filtrar más detalles internos de los que desea. Prefiera mantenerlo
desactivado en chats grupales.

## Conciencia de costos

Los heartbeats ejecutan turnos completos del agente. Intervalos más cortos consumen más tokens. Mantenga
`HEARTBEAT.md` pequeño y considere un `model` o `target: "none"` más económico si
solo quiere actualizaciones de estado internas.
