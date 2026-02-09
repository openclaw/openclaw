---
summary: "Comandos de barra: texto vs nativos, configuración y comandos compatibles"
read_when:
  - Uso o configuración de comandos de chat
  - Depuración del enrutamiento de comandos o permisos
title: "Comandos de barra"
---

# Comandos de barra

Los comandos son gestionados por el Gateway. La mayoría de los comandos deben enviarse como un mensaje **independiente** que comienza con `/`.
El comando de chat bash solo para el host usa `! <cmd>` (con `/bash <cmd>` como alias).

Hay dos sistemas relacionados:

- **Comandos**: mensajes `/...` independientes.
- **Directivas**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Las directivas se eliminan del mensaje antes de que el modelo lo vea.
  - En mensajes de chat normales (no solo directivas), se tratan como “pistas en línea” y **no** persisten la configuración de la sesión.
  - En mensajes solo de directivas (el mensaje contiene únicamente directivas), persisten en la sesión y responden con un acuse de recibo.
  - Las directivas solo se aplican a **remitentes autorizados** (listas de permitidos del canal/emparejamiento más `commands.useAccessGroups`).
    Los remitentes no autorizados ven las directivas tratadas como texto plano.

También hay algunos **atajos en línea** (solo remitentes permitidos/autorizados): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Se ejecutan de inmediato, se eliminan antes de que el modelo vea el mensaje, y el texto restante continúa por el flujo normal.

## Configuración

```json5
{
  commands: {
    native: "auto",
    nativeSkills: "auto",
    text: true,
    bash: false,
    bashForegroundMs: 2000,
    config: false,
    debug: false,
    restart: false,
    useAccessGroups: true,
  },
}
```

- `commands.text` (predeterminado `true`) habilita el análisis de `/...` en mensajes de chat.
  - En superficies sin comandos nativos (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), los comandos de texto siguen funcionando incluso si establece esto en `false`.
- `commands.native` (predeterminado `"auto"`) registra comandos nativos.
  - Auto: activado para Discord/Telegram; desactivado para Slack (hasta que agregue comandos de barra); ignorado para proveedores sin soporte nativo.
  - Establezca `channels.discord.commands.native`, `channels.telegram.commands.native` o `channels.slack.commands.native` para sobrescribir por proveedor (bool o `"auto"`).
  - `false` borra los comandos previamente registrados en Discord/Telegram al iniciar. Los comandos de Slack se gestionan en la app de Slack y no se eliminan automáticamente.
- `commands.nativeSkills` (predeterminado `"auto"`) registra comandos de **skills** de forma nativa cuando hay soporte.
  - Auto: activado para Discord/Telegram; desactivado para Slack (Slack requiere crear un comando de barra por skill).
  - Establezca `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills` o `channels.slack.commands.nativeSkills` para sobrescribir por proveedor (bool o `"auto"`).
- `commands.bash` (predeterminado `false`) habilita `! <cmd>` para ejecutar comandos de shell del host (`/bash <cmd>` es un alias; requiere listas de permitidos `tools.elevated`).
- `commands.bashForegroundMs` (predeterminado `2000`) controla cuánto tiempo espera bash antes de cambiar a modo en segundo plano (`0` pasa a segundo plano de inmediato).
- `commands.config` (predeterminado `false`) habilita `/config` (lee/escribe `openclaw.json`).
- `commands.debug` (predeterminado `false`) habilita `/debug` (sobrescrituras solo en tiempo de ejecución).
- `commands.useAccessGroups` (predeterminado `true`) hace cumplir listas de permitidos/políticas para comandos.

## Lista de comandos

Texto + nativos (cuando están habilitados):

- `/help`
- `/commands`
- `/skill <name> [input]` (ejecutar una skill por nombre)
- `/status` (mostrar estado actual; incluye uso/cuota del proveedor para el proveedor del modelo actual cuando está disponible)
- `/allowlist` (listar/agregar/eliminar entradas de la lista de permitidos)
- `/approve <id> allow-once|allow-always|deny` (resolver avisos de aprobación de exec)
- `/context [list|detail|json]` (explicar “contexto”; `detail` muestra tamaño por archivo + por herramienta + por skill + prompt del sistema)
- `/whoami` (mostrar su id de remitente; alias: `/id`)
- `/subagents list|stop|log|info|send` (inspeccionar, detener, registrar o enviar mensajes a ejecuciones de subagentes para la sesión actual)
- `/config show|get|set|unset` (persistir configuración en disco, solo propietario; requiere `commands.config: true`)
- `/debug show|set|unset|reset` (sobrescrituras en tiempo de ejecución, solo propietario; requiere `commands.debug: true`)
- `/usage off|tokens|full|cost` (pie de uso por respuesta o resumen de costos local)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (controlar TTS; vea [/tts](/tts))
  - Discord: el comando nativo es `/voice` (Discord reserva `/tts`); el texto `/tts` sigue funcionando.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (cambiar respuestas a Telegram)
- `/dock-discord` (alias: `/dock_discord`) (cambiar respuestas a Discord)
- `/dock-slack` (alias: `/dock_slack`) (cambiar respuestas a Slack)
- `/activation mention|always` (solo grupos)
- `/send on|off|inherit` (solo propietario)
- `/reset` o `/new [model]` (sugerencia opcional de modelo; el resto se pasa tal cual)
- `/think <off|minimal|low|medium|high|xhigh>` (opciones dinámicas por modelo/proveedor; alias: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; cuando está activado, envía un mensaje separado con el prefijo `Reasoning:`; `stream` = solo borrador de Telegram)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` omite aprobaciones de exec)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (enviar `/exec` para mostrar el actual)
- `/model <name>` (alias: `/models`; o `/<alias>` desde `agents.defaults.models.*.alias`)
- `/queue <mode>` (más opciones como `debounce:2s cap:25 drop:summarize`; envíe `/queue` para ver la configuración actual)
- `/bash <command>` (solo host; alias de `! <command>`; requiere listas de permitidos `commands.bash: true` + `tools.elevated`)

Solo texto:

- `/compact [instructions]` (vea [/concepts/compaction](/concepts/compaction))
- `! <command>` (solo host; uno a la vez; use `!poll` + `!stop` para trabajos de larga duración)
- `!poll` (comprobar salida/estado; acepta `sessionId` opcional; `/bash poll` también funciona)
- `!stop` (detener el trabajo bash en ejecución; acepta `sessionId` opcional; `/bash stop` también funciona)

Notas:

- Los comandos aceptan un `:` opcional entre el comando y los argumentos (p. ej., `/think: high`, `/send: on`, `/help:`).
- `/new <model>` acepta un alias de modelo, `provider/model` o un nombre de proveedor (coincidencia difusa); si no hay coincidencia, el texto se trata como el cuerpo del mensaje.
- Para un desglose completo de uso por proveedor, use `openclaw status --usage`.
- `/allowlist add|remove` requiere `commands.config=true` y respeta la `configWrites` del canal.
- `/usage` controla el pie de uso por respuesta; `/usage cost` imprime un resumen de costos local a partir de los registros de sesión de OpenClaw.
- `/restart` está deshabilitado por defecto; establezca `commands.restart: true` para habilitarlo.
- `/verbose` está pensado para depuración y visibilidad adicional; manténgalo **apagado** en uso normal.
- `/reasoning` (y `/verbose`) son riesgosos en entornos de grupo: pueden revelar razonamiento interno o salida de herramientas que no pretendía exponer. Prefiera dejarlos apagados, especialmente en chats de grupo.
- **Ruta rápida:** los mensajes solo de comandos de remitentes permitidos se gestionan de inmediato (omiten cola + modelo).
- **Puerta de mención de grupo:** los mensajes solo de comandos de remitentes permitidos omiten los requisitos de mención.
- **Atajos en línea (solo remitentes permitidos):** ciertos comandos también funcionan cuando se incrustan en un mensaje normal y se eliminan antes de que el modelo vea el texto restante.
  - Ejemplo: `hey /status` activa una respuesta de estado, y el texto restante continúa por el flujo normal.
- Actualmente: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Los mensajes solo de comandos no autorizados se ignoran silenciosamente, y los tokens `/...` en línea se tratan como texto plano.
- **Comandos de skills:** las skills `user-invocable` se exponen como comandos de barra. Los nombres se sanitizan a `a-z0-9_` (máx. 32 caracteres); las colisiones reciben sufijos numéricos (p. ej., `_2`).
  - `/skill <name> [input]` ejecuta una skill por nombre (útil cuando los límites de comandos nativos impiden comandos por skill).
  - De forma predeterminada, los comandos de skills se reenvían al modelo como una solicitud normal.
  - Las skills pueden declarar opcionalmente `command-dispatch: tool` para enrutar el comando directamente a una herramienta (determinista, sin modelo).
  - Ejemplo: `/prose` (plugin OpenProse) — vea [OpenProse](/prose).
- **Argumentos de comandos nativos:** Discord usa autocompletado para opciones dinámicas (y menús de botones cuando omite argumentos obligatorios). Telegram y Slack muestran un menú de botones cuando un comando admite opciones y omite el argumento.

## Superficies de uso (qué se muestra dónde)

- **Uso/cuota del proveedor** (ejemplo: “Claude 80% restante”) aparece en `/status` para el proveedor del modelo actual cuando el seguimiento de uso está habilitado.
- **Tokens/costo por respuesta** está controlado por `/usage off|tokens|full` (se añade a las respuestas normales).
- `/model status` trata sobre **modelos/autenticación/endpoints**, no sobre uso.

## Selección de modelo (`/model`)

`/model` se implementa como una directiva.

Ejemplos:

```
/model
/model list
/model 3
/model openai/gpt-5.2
/model opus@anthropic:default
/model status
```

Notas:

- `/model` y `/model list` muestran un selector compacto y numerado (familia de modelos + proveedores disponibles).
- `/model <#>` selecciona desde ese selector (y prefiere el proveedor actual cuando es posible).
- `/model status` muestra la vista detallada, incluido el endpoint del proveedor configurado (`baseUrl`) y el modo de API (`api`) cuando está disponible.

## Debug overrides

`/debug` le permite establecer sobrescrituras de configuración **solo en tiempo de ejecución** (memoria, no disco). Solo propietario. Deshabilitado por defecto; habilítelo con `commands.debug: true`.

Ejemplos:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notas:

- Las sobrescrituras se aplican de inmediato a nuevas lecturas de configuración, pero **no** escriben en `openclaw.json`.
- Use `/debug reset` para borrar todas las sobrescrituras y volver a la configuración en disco.

## Actualizaciones de configuración

`/config` escribe en su configuración en disco (`openclaw.json`). Solo propietario. Deshabilitado por defecto; habilítelo con `commands.config: true`.

Ejemplos:

```
/config show
/config show messages.responsePrefix
/config get messages.responsePrefix
/config set messages.responsePrefix="[openclaw]"
/config unset messages.responsePrefix
```

Notas:

- La configuración se valida antes de escribir; los cambios inválidos se rechazan.
- Las actualizaciones de `/config` persisten entre reinicios.

## Notas de superficie

- **Comandos de texto** se ejecutan en la sesión de chat normal (los mensajes directos comparten `main`, los grupos tienen su propia sesión).
- **Comandos nativos** usan sesiones aisladas:
  - Discord: `agent:<agentId>:discord:slash:<userId>`
  - Slack: `agent:<agentId>:slack:slash:<userId>` (prefijo configurable mediante `channels.slack.slashCommand.sessionPrefix`)
  - Telegram: `telegram:slash:<userId>` (apunta a la sesión del chat mediante `CommandTargetSessionKey`)
- **`/stop`** apunta a la sesión de chat activa para poder abortar la ejecución actual.
- **Slack:** `channels.slack.slashCommand` aún es compatible para un solo comando de estilo `/openclaw`. Si habilita `commands.native`, debe crear un comando de barra de Slack por cada comando integrado (los mismos nombres que `/help`). Los menús de argumentos de comandos para Slack se entregan como botones efímeros de Block Kit.
