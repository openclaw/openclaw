---
summary: "Comandos slash: texto vs nativos, config, y comandos soportados"
read_when:
  - Usar o configurar comandos de chat
  - Depurar enrutamiento de comandos o permisos
title: "Comandos Slash"
---

# Comandos slash

Los comandos son manejados por el Gateway. La mayoría de los comandos deben enviarse como un mensaje **independiente** que comience con `/`.
El comando de chat bash exclusivo del host usa `! <cmd>` (con `/bash <cmd>` como alias).

Hay dos sistemas relacionados:

- **Comandos**: mensajes independientes `/...`.
- **Directivas**: `/think`, `/verbose`, `/reasoning`, `/elevated`, `/exec`, `/model`, `/queue`.
  - Las directivas se eliminan del mensaje antes de que el modelo lo vea.
  - En mensajes de chat normales (no solo directivas), se tratan como "pistas en línea" y **no** persisten la configuración de sesión.
  - En mensajes solo de directivas (el mensaje contiene solo directivas), persisten en la sesión y responden con una confirmación.
  - Las directivas solo se aplican para **remitentes autorizados**. Si `commands.allowFrom` está establecido, es la única
    lista de permitidos utilizada; de lo contrario, la autorización proviene de listas de permitidos/emparejamiento del canal más `commands.useAccessGroups`.
    Los remitentes no autorizados ven las directivas tratadas como texto plano.

También hay algunos **atajos en línea** (solo remitentes autorizados/en lista de permitidos): `/help`, `/commands`, `/status`, `/whoami` (`/id`).
Se ejecutan inmediatamente, se eliminan antes de que el modelo vea el mensaje, y el texto restante continúa a través del flujo normal.

## Config

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
    allowFrom: {
      "*": ["user1"],
      discord: ["user:123"],
    },
    useAccessGroups: true,
  },
}
```

- `commands.text` (predeterminado `true`) habilita el análisis de `/...` en mensajes de chat.
  - En superficies sin comandos nativos (WhatsApp/WebChat/Signal/iMessage/Google Chat/MS Teams), los comandos de texto siguen funcionando incluso si estableces esto en `false`.
- `commands.native` (predeterminado `"auto"`) registra comandos nativos.
  - Auto: activado para Discord/Telegram; desactivado para Slack (hasta que agregues comandos slash); ignorado para proveedores sin soporte nativo.
  - Establece `channels.discord.commands.native`, `channels.telegram.commands.native`, o `channels.slack.commands.native` para anular por proveedor (bool o `"auto"`).
  - `false` borra los comandos registrados previamente en Discord/Telegram al inicio. Los comandos de Slack se administran en la aplicación de Slack y no se eliminan automáticamente.
- `commands.nativeSkills` (predeterminado `"auto"`) registra comandos de **habilidades** de forma nativa cuando es compatible.
  - Auto: activado para Discord/Telegram; desactivado para Slack (Slack requiere crear un comando slash por habilidad).
  - Establece `channels.discord.commands.nativeSkills`, `channels.telegram.commands.nativeSkills`, o `channels.slack.commands.nativeSkills` para anular por proveedor (bool o `"auto"`).
- `commands.bash` (predeterminado `false`) habilita `! <cmd>` para ejecutar comandos de shell del host (`/bash <cmd>` es un alias; requiere listas de permitidos `tools.elevated`).
- `commands.bashForegroundMs` (predeterminado `2000`) controla cuánto tiempo espera bash antes de cambiar al modo segundo plano (`0` pasa a segundo plano inmediatamente).
- `commands.config` (predeterminado `false`) habilita `/config` (lee/escribe `openclaw.json`).
- `commands.debug` (predeterminado `false`) habilita `/debug` (anulaciones solo en tiempo de ejecución).
- `commands.allowFrom` (opcional) establece una lista de permitidos por proveedor para autorización de comandos. Cuando está configurado, es la
  única fuente de autorización para comandos y directivas (las listas de permitidos/emparejamiento del canal y `commands.useAccessGroups`
  se ignoran). Usa `"*"` para un predeterminado global; las claves específicas del proveedor lo anulan.
- `commands.useAccessGroups` (predeterminado `true`) aplica listas de permitidos/políticas para comandos cuando `commands.allowFrom` no está establecido.

## Lista de comandos

Texto + nativos (cuando están habilitados):

- `/help`
- `/commands`
- `/skill <nombre> [entrada]` (ejecutar una habilidad por nombre)
- `/status` (mostrar estado actual; incluye uso/cuota del proveedor para el proveedor de modelo actual cuando está disponible)
- `/mesh <objetivo>` (planificación automática + ejecución de flujo de trabajo; también `/mesh plan|run|status|retry`, con `/mesh run <mesh-plan-id>` para repetición exacta del plan en el mismo chat)
- `/allowlist` (listar/agregar/eliminar entradas de lista de permitidos)
- `/approve <id> allow-once|allow-always|deny` (resolver prompts de aprobación de exec)
- `/context [list|detail|json]` (explicar "contexto"; `detail` muestra por archivo + por herramienta + por habilidad + tamaño del prompt del sistema)
- `/export-session [ruta]` (alias: `/export`) (exportar sesión actual a HTML con prompt del sistema completo)
- `/whoami` (mostrar tu id de remitente; alias: `/id`)
- `/subagents list|kill|log|info|send|steer` (inspeccionar, matar, registrar o dirigir ejecuciones de subagentes para la sesión actual)
- `/kill <id|#|all>` (abortar inmediatamente uno o todos los subagentes en ejecución para esta sesión; sin mensaje de confirmación)
- `/steer <id|#> <mensaje>` (dirigir un subagente en ejecución inmediatamente: en ejecución cuando sea posible, de lo contrario abortar el trabajo actual y reiniciar en el mensaje de dirección)
- `/tell <id|#> <mensaje>` (alias para `/steer`)
- `/config show|get|set|unset` (persistir config en disco, solo propietario; requiere `commands.config: true`)
- `/debug show|set|unset|reset` (anulaciones en tiempo de ejecución, solo propietario; requiere `commands.debug: true`)
- `/usage off|tokens|full|cost` (pie de página de uso por respuesta o resumen de costo local)
- `/tts off|always|inbound|tagged|status|provider|limit|summary|audio` (controlar TTS; ver [/tts](/es-ES/tts))
  - Discord: el comando nativo es `/voice` (Discord reserva `/tts`); el texto `/tts` aún funciona.
- `/stop`
- `/restart`
- `/dock-telegram` (alias: `/dock_telegram`) (cambiar respuestas a Telegram)
- `/dock-discord` (alias: `/dock_discord`) (cambiar respuestas a Discord)
- `/dock-slack` (alias: `/dock_slack`) (cambiar respuestas a Slack)
- `/activation mention|always` (solo grupos)
- `/send on|off|inherit` (solo propietario)
- `/reset` o `/new [modelo]` (sugerencia de modelo opcional; el resto se pasa)
- `/think <off|minimal|low|medium|high|xhigh>` (opciones dinámicas por modelo/proveedor; aliases: `/thinking`, `/t`)
- `/verbose on|full|off` (alias: `/v`)
- `/reasoning on|off|stream` (alias: `/reason`; cuando está activado, envía un mensaje separado con prefijo `Reasoning:`; `stream` = solo borrador de Telegram)
- `/elevated on|off|ask|full` (alias: `/elev`; `full` omite aprobaciones de exec)
- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>` (enviar `/exec` para mostrar actual)
- `/model <nombre>` (alias: `/models`; o `/<alias>` de `agents.defaults.models.*.alias`)
- `/queue <modo>` (más opciones como `debounce:2s cap:25 drop:summarize`; enviar `/queue` para ver configuración actual)
- `/bash <comando>` (solo host; alias para `! <comando>`; requiere `commands.bash: true` + listas de permitidos `tools.elevated`)

Solo texto:

- `/compact [instrucciones]` (ver [/conceptos/compactación](/es-ES/concepts/compaction))
- `! <comando>` (solo host; uno a la vez; usar `!poll` + `!stop` para trabajos de larga duración)
- `!poll` (verificar salida / estado; acepta `sessionId` opcional; `/bash poll` también funciona)
- `!stop` (detener el trabajo bash en ejecución; acepta `sessionId` opcional; `/bash stop` también funciona)

Notas:

- Los comandos aceptan un `:` opcional entre el comando y los argumentos (por ejemplo, `/think: high`, `/send: on`, `/help:`).
- `/new <modelo>` acepta un alias de modelo, `proveedor/modelo`, o un nombre de proveedor (coincidencia difusa); si no hay coincidencia, el texto se trata como el cuerpo del mensaje.
- Para el desglose completo de uso del proveedor, usa `openclaw status --usage`.
- `/allowlist add|remove` requiere `commands.config=true` y respeta `configWrites` del canal.
- `/usage` controla el pie de página de uso por respuesta; `/usage cost` imprime un resumen de costos local desde los registros de sesión de OpenClaw.
- `/restart` está deshabilitado por defecto; establece `commands.restart: true` para habilitarlo.
- `/verbose` está destinado a depuración y visibilidad extra; mantenlo **desactivado** en uso normal.
- `/reasoning` (y `/verbose`) son riesgosos en entornos de grupo: pueden revelar razonamiento interno o salida de herramientas que no pretendías exponer. Prefiere dejarlos desactivados, especialmente en chats grupales.
- **Ruta rápida:** los mensajes solo de comandos de remitentes en lista de permitidos se manejan inmediatamente (omitir cola + modelo).
- **Control de mención de grupo:** los mensajes solo de comandos de remitentes en lista de permitidos omiten los requisitos de mención.
- **Atajos en línea (solo remitentes en lista de permitidos):** ciertos comandos también funcionan cuando se incrustan en un mensaje normal y se eliminan antes de que el modelo vea el texto restante.
  - Ejemplo: `hey /status` activa una respuesta de estado, y el texto restante continúa a través del flujo normal.
- Actualmente: `/help`, `/commands`, `/status`, `/whoami` (`/id`).
- Los mensajes solo de comandos no autorizados se ignoran silenciosamente, y los tokens en línea `/...` se tratan como texto plano.
- **Comandos de habilidades:** las habilidades `user-invocable` se exponen como comandos slash. Los nombres se sanean a `a-z0-9_` (máx. 32 caracteres); las colisiones obtienen sufijos numéricos (por ejemplo, `_2`).
  - `/skill <nombre> [entrada]` ejecuta una habilidad por nombre (útil cuando los límites de comandos nativos impiden comandos por habilidad).
  - Por defecto, los comandos de habilidades se reenvían al modelo como una solicitud normal.
  - Las habilidades pueden declarar opcionalmente `command-dispatch: tool` para enrutar el comando directamente a una herramienta (determinista, sin modelo).
  - Ejemplo: `/prose` (complemento OpenProse) — ver [OpenProse](/es-ES/prose).
- **Argumentos de comandos nativos:** Discord usa autocompletar para opciones dinámicas (y menús de botones cuando omites argumentos requeridos). Telegram y Slack muestran un menú de botones cuando un comando admite opciones y omites el argumento.

## Superficies de uso (qué se muestra dónde)

- **Uso/cuota del proveedor** (ejemplo: "Claude 80% restante") aparece en `/status` para el proveedor de modelo actual cuando el seguimiento de uso está habilitado.
- **Tokens/costo por respuesta** se controla mediante `/usage off|tokens|full` (agregado a respuestas normales).
- `/model status` es sobre **modelos/autenticación/endpoints**, no uso.

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

- `/model` y `/model list` muestran un selector compacto numerado (familia de modelos + proveedores disponibles).
- `/model <#>` selecciona de ese selector (y prefiere el proveedor actual cuando sea posible).
- `/model status` muestra la vista detallada, incluyendo el endpoint del proveedor configurado (`baseUrl`) y modo API (`api`) cuando está disponible.

## Anulaciones de depuración

`/debug` te permite establecer anulaciones de configuración **solo en tiempo de ejecución** (memoria, no disco). Solo propietario. Deshabilitado por defecto; habilita con `commands.debug: true`.

Ejemplos:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug set channels.whatsapp.allowFrom=["+1555","+4477"]
/debug unset messages.responsePrefix
/debug reset
```

Notas:

- Las anulaciones se aplican inmediatamente a nuevas lecturas de config, pero **no** escriben en `openclaw.json`.
- Usa `/debug reset` para borrar todas las anulaciones y volver a la configuración en disco.

## Actualizaciones de configuración

`/config` escribe en tu configuración en disco (`openclaw.json`). Solo propietario. Deshabilitado por defecto; habilita con `commands.config: true`.

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
  - Telegram: `telegram:slash:<userId>` (apunta a la sesión de chat mediante `CommandTargetSessionKey`)
- **`/stop`** apunta a la sesión de chat activa para que pueda abortar la ejecución actual.
- **Slack:** `channels.slack.slashCommand` aún se admite para un solo comando estilo `/openclaw`. Si habilitas `commands.native`, debes crear un comando slash de Slack por comando integrado (mismos nombres que `/help`). Los menús de argumentos de comandos para Slack se entregan como botones efímeros de Block Kit.
