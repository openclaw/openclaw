---
summary: "Referencia CLI de OpenClaw para comandos, subcomandos y opciones de `openclaw`"
read_when:
  - Añadir o modificar comandos CLI u opciones
  - Documentar nuevas superficies de comandos
title: "Referencia CLI"
---

# Referencia CLI

Esta página describe el comportamiento actual del CLI. Si los comandos cambian, actualiza este documento.

## Páginas de comandos

- [`setup`](/es-ES/cli/setup)
- [`onboard`](/es-ES/cli/onboard)
- [`configure`](/es-ES/cli/configure)
- [`config`](/es-ES/cli/config)
- [`doctor`](/es-ES/cli/doctor)
- [`dashboard`](/es-ES/cli/dashboard)
- [`reset`](/es-ES/cli/reset)
- [`uninstall`](/es-ES/cli/uninstall)
- [`update`](/es-ES/cli/update)
- [`message`](/es-ES/cli/message)
- [`agent`](/es-ES/cli/agent)
- [`agents`](/es-ES/cli/agents)
- [`acp`](/es-ES/cli/acp)
- [`status`](/es-ES/cli/status)
- [`health`](/es-ES/cli/health)
- [`sessions`](/es-ES/cli/sessions)
- [`gateway`](/es-ES/cli/gateway)
- [`logs`](/es-ES/cli/logs)
- [`system`](/es-ES/cli/system)
- [`models`](/es-ES/cli/models)
- [`memory`](/es-ES/cli/memory)
- [`nodes`](/es-ES/cli/nodes)
- [`devices`](/es-ES/cli/devices)
- [`node`](/es-ES/cli/node)
- [`approvals`](/es-ES/cli/approvals)
- [`sandbox`](/es-ES/cli/sandbox)
- [`tui`](/es-ES/cli/tui)
- [`browser`](/es-ES/cli/browser)
- [`cron`](/es-ES/cli/cron)
- [`dns`](/es-ES/cli/dns)
- [`docs`](/es-ES/cli/docs)
- [`hooks`](/es-ES/cli/hooks)
- [`webhooks`](/es-ES/cli/webhooks)
- [`pairing`](/es-ES/cli/pairing)
- [`plugins`](/es-ES/cli/plugins) (comandos de plugins)
- [`channels`](/es-ES/cli/channels)
- [`security`](/es-ES/cli/security)
- [`skills`](/es-ES/cli/skills)
- [`voicecall`](/es-ES/cli/voicecall) (plugin; si está instalado)

## Banderas globales

- `--dev`: aislar estado bajo `~/.openclaw-dev` y cambiar puertos predeterminados.
- `--profile <name>`: aislar estado bajo `~/.openclaw-<name>`.
- `--no-color`: desactivar colores ANSI.
- `--update`: atajo para `openclaw update` (solo instalaciones desde fuente).
- `-V`, `--version`, `-v`: imprimir versión y salir.

## Estilo de salida

- Los colores ANSI y los indicadores de progreso solo se renderizan en sesiones TTY.
- Los hiperenlaces OSC-8 se renderizan como enlaces clicables en terminales compatibles; de lo contrario, usamos URLs simples.
- `--json` (y `--plain` donde esté soportado) desactiva el estilo para una salida limpia.
- `--no-color` desactiva el estilo ANSI; `NO_COLOR=1` también es respetado.
- Los comandos de larga duración muestran un indicador de progreso (OSC 9;4 cuando esté soportado).

## Paleta de colores

OpenClaw usa una paleta lobster para la salida del CLI.

- `accent` (#FF5A2D): encabezados, etiquetas, resaltados principales.
- `accentBright` (#FF7A3D): nombres de comandos, énfasis.
- `accentDim` (#D14A22): texto de resaltado secundario.
- `info` (#FF8A5B): valores informativos.
- `success` (#2FBF71): estados de éxito.
- `warn` (#FFB020): advertencias, respaldos, atención.
- `error` (#E23D2D): errores, fallos.
- `muted` (#8B7F77): desenfatizado, metadatos.

Fuente de verdad de la paleta: `src/terminal/palette.ts` (aka "lobster seam").

## Árbol de comandos

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

Nota: los plugins pueden añadir comandos adicionales de nivel superior (por ejemplo `openclaw voicecall`).

## Seguridad

- `openclaw security audit` — auditar configuración + estado local para problemas comunes de seguridad.
- `openclaw security audit --deep` — sonda mejor esfuerzo del Gateway en vivo.
- `openclaw security audit --fix` — ajustar valores predeterminados seguros y chmod estado/configuración.

## Plugins

Gestionar extensiones y su configuración:

- `openclaw plugins list` — descubrir plugins (usa `--json` para salida de máquina).
- `openclaw plugins info <id>` — mostrar detalles de un plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — instalar un plugin (o añadir una ruta de plugin a `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — alternar `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — reportar errores de carga de plugins.

La mayoría de los cambios de plugins requieren un reinicio del gateway. Ver [/tools/plugin](/es-ES/tools/plugin).

## Memoria

Búsqueda vectorial sobre `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — mostrar estadísticas del índice.
- `openclaw memory index` — reindexar archivos de memoria.
- `openclaw memory search "<query>"` — búsqueda semántica sobre memoria.

## Comandos slash de chat

Los mensajes de chat soportan comandos `/...` (texto y nativos). Ver [/tools/slash-commands](/es-ES/tools/slash-commands).

Destacados:

- `/status` para diagnósticos rápidos.
- `/config` para cambios de configuración persistentes.
- `/debug` para sobrescrituras de configuración solo en tiempo de ejecución (memoria, no disco; requiere `commands.debug: true`).

## Configuración inicial + incorporación

### `setup`

Inicializar configuración + espacio de trabajo.

Opciones:

- `--workspace <dir>`: ruta del espacio de trabajo del agente (por defecto `~/.openclaw/workspace`).
- `--wizard`: ejecutar el asistente de incorporación.
- `--non-interactive`: ejecutar asistente sin prompts.
- `--mode <local|remote>`: modo del asistente.
- `--remote-url <url>`: URL del Gateway remoto.
- `--remote-token <token>`: token del Gateway remoto.

El asistente se ejecuta automáticamente cuando cualquier bandera del asistente está presente (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Asistente interactivo para configurar gateway, espacio de trabajo y habilidades.

Opciones:

- `--workspace <dir>`
- `--reset` (restablecer configuración + credenciales + sesiones + espacio de trabajo antes del asistente)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual es un alias para advanced)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|custom-api-key|skip>`
- `--token-provider <id>` (no interactivo; usado con `--auth-choice token`)
- `--token <token>` (no interactivo; usado con `--auth-choice token`)
- `--token-profile-id <id>` (no interactivo; predeterminado: `<provider>:manual`)
- `--token-expires-in <duration>` (no interactivo; ej. `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--custom-base-url <url>` (no interactivo; usado con `--auth-choice custom-api-key`)
- `--custom-model-id <id>` (no interactivo; usado con `--auth-choice custom-api-key`)
- `--custom-api-key <key>` (no interactivo; opcional; usado con `--auth-choice custom-api-key`; vuelve a `CUSTOM_API_KEY` cuando se omite)
- `--custom-provider-id <id>` (no interactivo; id de proveedor personalizado opcional)
- `--custom-compatibility <openai|anthropic>` (no interactivo; opcional; predeterminado `openai`)
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (alias: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm recomendado; bun no recomendado para el runtime del Gateway)
- `--json`

### `configure`

Asistente de configuración interactivo (modelos, canales, habilidades, gateway).

### `config`

Ayudantes de configuración no interactivos (get/set/unset). Ejecutar `openclaw config` sin
subcomando lanza el asistente.

Subcomandos:

- `config get <path>`: imprimir un valor de configuración (ruta de punto/corchete).
- `config set <path> <value>`: establecer un valor (JSON5 o cadena sin formato).
- `config unset <path>`: eliminar un valor.

### `doctor`

Comprobaciones de salud + correcciones rápidas (configuración + gateway + servicios heredados).

Opciones:

- `--no-workspace-suggestions`: desactivar sugerencias de memoria del espacio de trabajo.
- `--yes`: aceptar valores predeterminados sin preguntar (sin interfaz).
- `--non-interactive`: omitir prompts; aplicar solo migraciones seguras.
- `--deep`: escanear servicios del sistema para instalaciones extra de gateway.

## Ayudantes de canales

### `channels`

Gestionar cuentas de canales de chat (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Subcomandos:

- `channels list`: mostrar canales configurados y perfiles de autenticación.
- `channels status`: verificar alcanzabilidad del gateway y salud del canal (`--probe` ejecuta comprobaciones extra; usa `openclaw health` o `openclaw status --deep` para sondas de salud del gateway).
- Consejo: `channels status` imprime advertencias con correcciones sugeridas cuando puede detectar errores de configuración comunes (luego te señala a `openclaw doctor`).
- `channels logs`: mostrar registros recientes del canal del archivo de registro del gateway.
- `channels add`: configuración estilo asistente cuando no se pasan banderas; las banderas cambian a modo no interactivo.
- `channels remove`: desactivar por defecto; pasa `--delete` para eliminar entradas de configuración sin prompts.
- `channels login`: inicio de sesión interactivo del canal (solo WhatsApp Web).
- `channels logout`: cerrar sesión de una sesión de canal (si es compatible).

Opciones comunes:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: id de cuenta del canal (predeterminado `default`)
- `--name <label>`: nombre para mostrar de la cuenta

Opciones de `channels login`:

- `--channel <channel>` (predeterminado `whatsapp`; soporta `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Opciones de `channels logout`:

- `--channel <channel>` (predeterminado `whatsapp`)
- `--account <id>`

Opciones de `channels list`:

- `--no-usage`: omitir instantáneas de uso/cuota del proveedor de modelo (solo respaldado por OAuth/API).
- `--json`: salida JSON (incluye uso a menos que se establezca `--no-usage`).

Opciones de `channels logs`:

- `--channel <name|all>` (predeterminado `all`)
- `--lines <n>` (predeterminado `200`)
- `--json`

Más detalle: [/concepts/oauth](/es-ES/concepts/oauth)

Ejemplos:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Listar e inspeccionar habilidades disponibles más información de preparación.

Subcomandos:

- `skills list`: listar habilidades (predeterminado cuando no hay subcomando).
- `skills info <name>`: mostrar detalles de una habilidad.
- `skills check`: resumen de habilidades listas vs requisitos faltantes.

Opciones:

- `--eligible`: mostrar solo habilidades listas.
- `--json`: salida JSON (sin estilo).
- `-v`, `--verbose`: incluir detalle de requisitos faltantes.

Consejo: usa `npx clawhub` para buscar, instalar y sincronizar habilidades.

### `pairing`

Aprobar solicitudes de emparejamiento de mensajes directos a través de canales.

Subcomandos:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Configuración de hook de Gmail Pub/Sub + ejecutor. Ver [/automation/gmail-pubsub](/es-ES/automation/gmail-pubsub).

Subcomandos:

- `webhooks gmail setup` (requiere `--account <email>`; soporta `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (sobrescrituras de tiempo de ejecución para las mismas banderas)

### `dns setup`

Ayudante DNS de descubrimiento de área amplia (CoreDNS + Tailscale). Ver [/gateway/discovery](/es-ES/gateway/discovery).

Opciones:

- `--apply`: instalar/actualizar configuración de CoreDNS (requiere sudo; solo macOS).

## Mensajería + agente

### `message`

Mensajería saliente unificada + acciones de canal.

Ver: [/cli/message](/es-ES/cli/message)

Subcomandos:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

Ejemplos:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Ejecutar un turno de agente a través del Gateway (o `--local` embebido).

Requerido:

- `--message <text>`

Opciones:

- `--to <dest>` (para clave de sesión y entrega opcional)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (solo modelos GPT-5.2 + Codex)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

Gestionar agentes aislados (espacios de trabajo + autenticación + enrutamiento).

#### `agents list`

Listar agentes configurados.

Opciones:

- `--json`
- `--bindings`

#### `agents add [name]`

Añadir un nuevo agente aislado. Ejecuta el asistente guiado a menos que se pasen banderas (o `--non-interactive`); `--workspace` es requerido en modo no interactivo.

Opciones:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repetible)
- `--non-interactive`
- `--json`

Las especificaciones de binding usan `channel[:accountId]`. Cuando se omite `accountId` para WhatsApp, se usa el id de cuenta predeterminado.

#### `agents delete <id>`

Eliminar un agente y limpiar su espacio de trabajo + estado.

Opciones:

- `--force`
- `--json`

### `acp`

Ejecutar el puente ACP que conecta IDEs al Gateway.

Ver [`acp`](/es-ES/cli/acp) para opciones completas y ejemplos.

### `status`

Mostrar salud de sesión vinculada y destinatarios recientes.

Opciones:

- `--json`
- `--all` (diagnóstico completo; solo lectura, pegable)
- `--deep` (sondear canales)
- `--usage` (mostrar uso/cuota del proveedor de modelo)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias para `--verbose`)

Notas:

- La descripción general incluye el estado del servicio de host del Gateway + nodo cuando está disponible.

### Seguimiento de uso

OpenClaw puede mostrar uso/cuota del proveedor cuando las credenciales OAuth/API están disponibles.

Superficies:

- `/status` (añade una línea corta de uso del proveedor cuando está disponible)
- `openclaw status --usage` (imprime desglose completo del proveedor)
- Barra de menú de macOS (sección de Uso bajo Contexto)

Notas:

- Los datos provienen directamente de los endpoints de uso del proveedor (sin estimaciones).
- Proveedores: Anthropic, GitHub Copilot, OpenAI Codex OAuth, más Gemini CLI/Antigravity cuando esos plugins de proveedor están habilitados.
- Si no existen credenciales coincidentes, el uso está oculto.
- Detalles: ver [Seguimiento de uso](/es-ES/concepts/usage-tracking).

### `health`

Obtener salud del Gateway en ejecución.

Opciones:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

Listar sesiones de conversación almacenadas.

Opciones:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## Restablecer / Desinstalar

### `reset`

Restablecer configuración/estado local (mantiene el CLI instalado).

Opciones:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notas:

- `--non-interactive` requiere `--scope` y `--yes`.

### `uninstall`

Desinstalar el servicio de gateway + datos locales (el CLI permanece).

Opciones:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notas:

- `--non-interactive` requiere `--yes` y ámbitos explícitos (o `--all`).

## Gateway

### `gateway`

Ejecutar el WebSocket Gateway.

Opciones:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (restablecer configuración dev + credenciales + sesiones + espacio de trabajo)
- `--force` (matar oyente existente en el puerto)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias para `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gestionar el servicio Gateway (launchd/systemd/schtasks).

Subcomandos:

- `gateway status` (sondea el RPC del Gateway por defecto)
- `gateway install` (instalación de servicio)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notas:

- `gateway status` sondea el RPC del Gateway por defecto usando el puerto/configuración resuelto del servicio (sobrescribir con `--url/--token/--password`).
- `gateway status` soporta `--no-probe`, `--deep`, y `--json` para scripting.
- `gateway status` también muestra servicios de gateway heredados o extra cuando puede detectarlos (`--deep` añade escaneos a nivel de sistema). Los servicios OpenClaw nombrados por perfil se tratan como de primera clase y no se marcan como "extra".
- `gateway status` imprime qué ruta de configuración usa el CLI vs qué configuración probablemente usa el servicio (env del servicio), más la URL objetivo de sonda resuelta.
- `gateway install|uninstall|start|stop|restart` soportan `--json` para scripting (la salida predeterminada permanece amigable para humanos).
- `gateway install` por defecto usa el runtime de Node; bun **no es recomendado** (bugs de WhatsApp/Telegram).
- Opciones de `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Rastrear registros de archivos del Gateway a través de RPC.

Notas:

- Las sesiones TTY renderizan una vista estructurada y coloreada; los no-TTY vuelven a texto plano.
- `--json` emite JSON delimitado por línea (un evento de registro por línea).

Ejemplos:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Ayudantes CLI del Gateway (usa `--url`, `--token`, `--password`, `--timeout`, `--expect-final` para subcomandos RPC).
Cuando pasas `--url`, el CLI no aplica automáticamente credenciales de configuración o entorno.
Incluye `--token` o `--password` explícitamente. Faltar credenciales explícitas es un error.

Subcomandos:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

RPCs comunes:

- `config.apply` (validar + escribir configuración + reiniciar + despertar)
- `config.patch` (fusionar una actualización parcial + reiniciar + despertar)
- `update.run` (ejecutar actualización + reiniciar + despertar)

Consejo: al llamar directamente `config.set`/`config.apply`/`config.patch`, pasa `baseHash` de
`config.get` si ya existe una configuración.

## Modelos

Ver [/concepts/models](/es-ES/concepts/models) para comportamiento de respaldo y estrategia de escaneo.

Autenticación Anthropic preferida (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (raíz)

`openclaw models` es un alias para `models status`.

Opciones de raíz:

- `--status-json` (alias para `models status --json`)
- `--status-plain` (alias para `models status --plain`)

### `models list`

Opciones:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

Opciones:

- `--json`
- `--plain`
- `--check` (salir 1=expirado/faltante, 2=expirando)
- `--probe` (sonda en vivo de perfiles de autenticación configurados)
- `--probe-provider <name>`
- `--probe-profile <id>` (repetir o separado por comas)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Siempre incluye la descripción general de autenticación y el estado de expiración OAuth para perfiles en el almacén de autenticación.
`--probe` ejecuta solicitudes en vivo (puede consumir tokens y activar límites de tasa).

### `models set <model>`

Establecer `agents.defaults.model.primary`.

### `models set-image <model>`

Establecer `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

Opciones:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

Opciones:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

Opciones:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

Opciones:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

Opciones:

- `add`: ayudante de autenticación interactivo
- `setup-token`: `--provider <name>` (predeterminado `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Opciones:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## Sistema

### `system event`

Encolar un evento del sistema y opcionalmente activar un latido (Gateway RPC).

Requerido:

- `--text <text>`

Opciones:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Controles de latido (Gateway RPC).

Opciones:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Listar entradas de presencia del sistema (Gateway RPC).

Opciones:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Gestionar trabajos programados (Gateway RPC). Ver [/automation/cron-jobs](/es-ES/automation/cron-jobs).

Subcomandos:

- `cron status [--json]`
- `cron list [--all] [--json]` (salida de tabla por defecto; usa `--json` para sin formato)
- `cron add` (alias: `create`; requiere `--name` y exactamente uno de `--at` | `--every` | `--cron`, y exactamente una carga útil de `--system-event` | `--message`)
- `cron edit <id>` (parchear campos)
- `cron rm <id>` (alias: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Todos los comandos `cron` aceptan `--url`, `--token`, `--timeout`, `--expect-final`.

## Host de nodo

`node` ejecuta un **host de nodo sin interfaz** o lo gestiona como un servicio en segundo plano. Ver
[`openclaw node`](/es-ES/cli/node).

Subcomandos:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodos

`nodes` habla al Gateway y apunta a nodos emparejados. Ver [/nodes](/es-ES/nodes).

Opciones comunes:

- `--url`, `--token`, `--timeout`, `--json`

Subcomandos:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (nodo mac o host de nodo sin interfaz)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (solo mac)

Cámara:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

Lienzo + pantalla:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

Ubicación:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## Navegador

CLI de control del navegador (Chrome/Brave/Edge/Chromium dedicado). Ver [`openclaw browser`](/es-ES/cli/browser) y la [Herramienta de navegador](/es-ES/tools/browser).

Opciones comunes:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Gestionar:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

Inspeccionar:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

Acciones:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## Búsqueda de documentación

### `docs [query...]`

Buscar en el índice de documentación en vivo.

## TUI

### `tui`

Abrir la interfaz de usuario del terminal conectada al Gateway.

Opciones:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (por defecto a `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
