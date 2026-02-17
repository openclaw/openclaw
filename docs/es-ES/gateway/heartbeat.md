---
summary: "Mensajes de polling de heartbeat y reglas de notificación"
read_when:
  - Ajustando cadencia o mensajería de heartbeat
  - Decidiendo entre heartbeat y cron para tareas programadas
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **¿Heartbeat vs Cron?** Ver [Cron vs Heartbeat](/es-ES/automation/cron-vs-heartbeat) para orientación sobre cuándo usar cada uno.

Heartbeat ejecuta **turnos de agente periódicos** en la sesión principal para que el modelo pueda
mostrar cualquier cosa que necesite atención sin inundarte con spam.

Solución de problemas: [/automation/troubleshooting](/es-ES/automation/troubleshooting)

## Inicio rápido (principiante)

1. Deja los heartbeats habilitados (predeterminado es `30m`, o `1h` para OAuth/setup-token de Anthropic) o establece tu propia cadencia.
2. Crea una pequeña checklist `HEARTBEAT.md` en el workspace del agente (opcional pero recomendado).
3. Decide dónde deberían ir los mensajes de heartbeat (`target: "last"` es el predeterminado).
4. Opcional: habilita entrega de razonamiento de heartbeat para transparencia.
5. Opcional: restringe heartbeats a horas activas (hora local).

Ejemplo de configuración:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last",
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // opcional: enviar mensaje separado `Reasoning:` también
      },
    },
  },
}
```

## Valores predeterminados

- Intervalo: `30m` (o `1h` cuando OAuth/setup-token de Anthropic es el modo de auth detectado). Establece `agents.defaults.heartbeat.every` o por agente `agents.list[].heartbeat.every`; usa `0m` para deshabilitar.
- Cuerpo del prompt (configurable vía `agents.defaults.heartbeat.prompt`):
  `Lee HEARTBEAT.md si existe (contexto del workspace). Síguelo estrictamente. No infiera o repita tareas antiguas de chats previos. Si nada necesita atención, responde HEARTBEAT_OK.`
- El prompt de heartbeat se envía **textualmente** como el mensaje del usuario. El prompt
  del sistema incluye una sección "Heartbeat" y la ejecución se marca internamente.
- Las horas activas (`heartbeat.activeHours`) se verifican en la zona horaria configurada.
  Fuera de la ventana, los heartbeats se omiten hasta el siguiente tick dentro de la ventana.

## Para qué es el prompt de heartbeat

El prompt predeterminado es intencionalmente amplio:

- **Tareas de fondo**: "Considera tareas pendientes" empuja al agente a revisar
  seguimientos (bandeja de entrada, calendario, recordatorios, trabajo en cola) y mostrar cualquier cosa urgente.
- **Chequeo humano**: "Chequea a veces a tu humano durante el día" empuja un
  mensaje ocasional ligero de "¿necesitas algo?", pero evita spam nocturno
  usando tu zona horaria local configurada (ver [/concepts/timezone](/es-ES/concepts/timezone)).

Si quieres que un heartbeat haga algo muy específico (por ejemplo "verificar estadísticas de Gmail PubSub"
o "verificar salud del gateway"), establece `agents.defaults.heartbeat.prompt` (o
`agents.list[].heartbeat.prompt`) a un cuerpo personalizado (enviado textualmente).

## Contrato de respuesta

- Si nada necesita atención, responde con **`HEARTBEAT_OK`**.
- Durante ejecuciones de heartbeat, OpenClaw trata `HEARTBEAT_OK` como un ack cuando aparece
  al **inicio o final** de la respuesta. El token se elimina y la respuesta se
  descarta si el contenido restante es **≤ `ackMaxChars`** (predeterminado: 300).
- Si `HEARTBEAT_OK` aparece en el **medio** de una respuesta, no se trata
  especialmente.
- Para alertas, **no** incluyas `HEARTBEAT_OK`; devuelve solo el texto de alerta.

Fuera de heartbeats, `HEARTBEAT_OK` perdido al inicio/final de un mensaje se elimina
y se registra; un mensaje que es solo `HEARTBEAT_OK` se descarta.

## Configuración

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // predeterminado: 30m (0m deshabilita)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // predeterminado: false (entregar mensaje Reasoning: separado cuando esté disponible)
        target: "last", // last | none | <channel id> (core o plugin, ej. "bluebubbles")
        to: "+15551234567", // anulación opcional específica de canal
        accountId: "ops-bot", // id de canal multi-cuenta opcional
        prompt: "Lee HEARTBEAT.md si existe (contexto del workspace). Síguelo estrictamente. No infiera o repita tareas antiguas de chats previos. Si nada necesita atención, responde HEARTBEAT_OK.",
        ackMaxChars: 300, // caracteres máximos permitidos después de HEARTBEAT_OK
      },
    },
  },
}
```

### Alcance y precedencia

- `agents.defaults.heartbeat` establece comportamiento global de heartbeat.
- `agents.list[].heartbeat` se fusiona encima; si algún agente tiene un bloque `heartbeat`, **solo esos agentes** ejecutan heartbeats.
- `channels.defaults.heartbeat` establece valores predeterminados de visibilidad para todos los canales.
- `channels.<channel>.heartbeat` anula valores predeterminados de canal.
- `channels.<channel>.accounts.<id>.heartbeat` (canales multi-cuenta) anula configuraciones por canal.

### Heartbeats por agente

Si alguna entrada `agents.list[]` incluye un bloque `heartbeat`, **solo esos agentes**
ejecutan heartbeats. El bloque por agente se fusiona encima de `agents.defaults.heartbeat`
(para que puedas establecer valores predeterminados compartidos una vez y anular por agente).

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
          prompt: "Lee HEARTBEAT.md si existe (contexto del workspace). Síguelo estrictamente. No infiera o repita tareas antiguas de chats previos. Si nada necesita atención, responde HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Ejemplo de horas activas

Restringe heartbeats a horas de negocio en una zona horaria específica:

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
          timezone: "America/New_York", // opcional; usa tu userTimezone si está establecido, de lo contrario zona horaria del host
        },
      },
    },
  },
}
```

Fuera de esta ventana (antes de las 9am o después de las 10pm Eastern), los heartbeats se omiten. El siguiente tick programado dentro de la ventana se ejecutará normalmente.

### Ejemplo multi cuenta

Usa `accountId` para apuntar a una cuenta específica en canales multi-cuenta como Telegram:

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

- `every`: intervalo de heartbeat (string de duración; unidad predeterminada = minutos).
- `model`: anulación de modelo opcional para ejecuciones de heartbeat (`proveedor/modelo`).
- `includeReasoning`: cuando está habilitado, también entrega el mensaje separado `Reasoning:` cuando esté disponible (misma forma que `/reasoning on`).
- `session`: clave de sesión opcional para ejecuciones de heartbeat.
  - `main` (predeterminado): sesión principal del agente.
  - Clave de sesión explícita (copia de `openclaw sessions --json` o el [CLI de sesiones](/es-ES/cli/sessions)).
  - Formatos de clave de sesión: ver [Sesiones](/es-ES/concepts/session) y [Grupos](/es-ES/channels/groups).
- `target`:
  - `last` (predeterminado): entregar al último canal externo usado.
  - canal explícito: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none`: ejecutar el heartbeat pero **no entregar** externamente.
- `to`: anulación de destinatario opcional (id específico de canal, ej. E.164 para WhatsApp o un id de chat de Telegram).
- `accountId`: id de cuenta opcional para canales multi-cuenta. Cuando `target: "last"`, el id de cuenta se aplica al último canal resuelto si admite cuentas; de lo contrario se ignora. Si el id de cuenta no coincide con una cuenta configurada para el canal resuelto, la entrega se omite.
- `prompt`: anula el cuerpo del prompt predeterminado (no fusionado).
- `ackMaxChars`: caracteres máximos permitidos después de `HEARTBEAT_OK` antes de la entrega.
- `suppressToolErrorWarnings`: cuando es true, suprime payloads de advertencia de error de herramienta durante ejecuciones de heartbeat.
- `activeHours`: restringe ejecuciones de heartbeat a una ventana de tiempo. Objeto con `start` (HH:MM, inclusivo), `end` (HH:MM exclusivo; `24:00` permitido para fin de día), y `timezone` opcional.
  - Omitido o `"user"`: usa tu `agents.defaults.userTimezone` si está establecido, de lo contrario recurre a la zona horaria del sistema host.
  - `"local"`: siempre usa la zona horaria del sistema host.
  - Cualquier identificador IANA (ej. `America/New_York`): usado directamente; si es inválido, recurre al comportamiento `"user"` anterior.
  - Fuera de la ventana activa, los heartbeats se omiten hasta el siguiente tick dentro de la ventana.

## Comportamiento de entrega

- Los heartbeats se ejecutan en la sesión principal del agente por defecto (`agent:<id>:<mainKey>`),
  o `global` cuando `session.scope = "global"`. Establece `session` para anular a una
  sesión de canal específica (Discord/WhatsApp/etc.).
- `session` solo afecta el contexto de ejecución; la entrega se controla por `target` y `to`.
- Para entregar a un canal/destinatario específico, establece `target` + `to`. Con
  `target: "last"`, la entrega usa el último canal externo para esa sesión.
- Si la cola principal está ocupada, el heartbeat se omite y se reintenta más tarde.
- Si `target` resuelve a ningún destino externo, la ejecución aún sucede pero no se
  envía mensaje saliente.
- Las respuestas solo de heartbeat **no** mantienen la sesión viva; el último `updatedAt`
  se restaura para que la expiración inactiva se comporte normalmente.

## Controles de visibilidad

Por defecto, los reconocimientos `HEARTBEAT_OK` se suprimen mientras el contenido de alerta se
entrega. Puedes ajustar esto por canal o por cuenta:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Ocultar HEARTBEAT_OK (predeterminado)
      showAlerts: true # Mostrar mensajes de alerta (predeterminado)
      useIndicator: true # Emitir eventos de indicador (predeterminado)
  telegram:
    heartbeat:
      showOk: true # Mostrar reconocimientos OK en Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suprimir entrega de alerta para esta cuenta
```

Precedencia: por cuenta → por canal → valores predeterminados de canal → valores predeterminados integrados.

### Qué hace cada bandera

- `showOk`: envía un reconocimiento `HEARTBEAT_OK` cuando el modelo devuelve una respuesta solo OK.
- `showAlerts`: envía el contenido de alerta cuando el modelo devuelve una respuesta no-OK.
- `useIndicator`: emite eventos de indicador para superficies de estado de UI.

Si **las tres** son false, OpenClaw omite la ejecución de heartbeat por completo (sin llamada al modelo).

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
      showOk: true # todas las cuentas de Slack
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suprimir alertas solo para la cuenta ops
  telegram:
    heartbeat:
      showOk: true
```

### Patrones comunes

| Objetivo                                                           | Configuración                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Comportamiento predeterminado (OKs silenciosos, alertas activadas) | _(no se necesita configuración)_                                                         |
| Completamente silencioso (sin mensajes, sin indicador)             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Solo indicador (sin mensajes)                                      | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs solo en un canal                                               | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (opcional)

Si un archivo `HEARTBEAT.md` existe en el workspace, el prompt predeterminado le dice al
agente que lo lea. Piensa en él como tu "checklist de heartbeat": pequeño, estable, y
seguro para incluir cada 30 minutos.

Si `HEARTBEAT.md` existe pero está efectivamente vacío (solo líneas en blanco y
encabezados markdown como `# Heading`), OpenClaw omite la ejecución de heartbeat para ahorrar llamadas a API.
Si el archivo falta, el heartbeat aún se ejecuta y el modelo decide qué hacer.

Mantenlo pequeño (checklist corto o recordatorios) para evitar inflación del prompt.

Ejemplo `HEARTBEAT.md`:

```md
# Checklist de heartbeat

- Escaneo rápido: ¿algo urgente en bandejas de entrada?
- Si es de día, haz un chequeo ligero si nada más está pendiente.
- Si una tarea está bloqueada, anota _qué falta_ y pregunta a Peter la próxima vez.
```

### ¿Puede el agente actualizar HEARTBEAT.md?

Sí — si se lo pides.

`HEARTBEAT.md` es solo un archivo normal en el workspace del agente, así que puedes decirle al
agente (en un chat normal) algo como:

- "Actualiza `HEARTBEAT.md` para agregar una verificación diaria del calendario."
- "Reescribe `HEARTBEAT.md` para que sea más corto y enfocado en seguimientos de bandeja de entrada."

Si quieres que esto suceda proactivamente, también puedes incluir una línea explícita en
tu prompt de heartbeat como: "Si la checklist se vuelve obsoleta, actualiza HEARTBEAT.md
con una mejor."

Nota de seguridad: no pongas secretos (claves API, números de teléfono, tokens privados) en
`HEARTBEAT.md` — se convierte en parte del contexto del prompt.

## Despertar manual (bajo demanda)

Puedes encolar un evento del sistema y activar un heartbeat inmediato con:

```bash
openclaw system event --text "Verifica seguimientos urgentes" --mode now
```

Si múltiples agentes tienen `heartbeat` configurado, un despertar manual ejecuta cada uno de esos
heartbeats de agente inmediatamente.

Usa `--mode next-heartbeat` para esperar al siguiente tick programado.

## Entrega de razonamiento (opcional)

Por defecto, los heartbeats entregan solo el payload final de "respuesta".

Si quieres transparencia, habilita:

- `agents.defaults.heartbeat.includeReasoning: true`

Cuando está habilitado, los heartbeats también entregarán un mensaje separado con prefijo
`Reasoning:` (misma forma que `/reasoning on`). Esto puede ser útil cuando el agente
está gestionando múltiples sesiones/códices y quieres ver por qué decidió hacerte ping
— pero también puede filtrar más detalle interno del que quieres. Prefiere mantenerlo
desactivado en chats grupales.

## Conciencia de costos

Los heartbeats ejecutan turnos completos de agente. Intervalos más cortos queman más tokens. Mantén
`HEARTBEAT.md` pequeño y considera un `model` más barato o `target: "none"` si solo
quieres actualizaciones de estado interno.
