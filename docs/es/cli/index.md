---
summary: "Referencia de la CLI de OpenClaw para los comandos, subcomandos y opciones de `openclaw`"
read_when:
  - Al agregar o modificar comandos u opciones de la CLI
  - Al documentar nuevas superficies de comandos
title: "Referencia de la CLI"
---

# Referencia de la CLI

Esta página describe el comportamiento actual de la CLI. Si los comandos cambian, actualice este documento.

## Páginas de comandos

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins) (comandos de plugins)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (plugin; si está instalado)

## Flags globales

- `--dev`: aislar el estado bajo `~/.openclaw-dev` y cambiar los puertos predeterminados.
- `--profile <name>`: aislar el estado bajo `~/.openclaw-<name>`.
- `--no-color`: deshabilitar colores ANSI.
- `--update`: abreviatura de `openclaw update` (solo instalaciones desde el código fuente).
- `-V`, `--version`, `-v`: imprimir la versión y salir.

## Estilo de salida

- Los colores ANSI y los indicadores de progreso solo se renderizan en sesiones TTY.
- Los hipervínculos OSC-8 se renderizan como enlaces clicables en terminales compatibles; de lo contrario, se usa texto con URLs simples.
- `--json` (y `--plain` donde sea compatible) deshabilita el estilo para una salida limpia.
- `--no-color` deshabilita el estilo ANSI; `NO_COLOR=1` también se respeta.
- Los comandos de larga duración muestran un indicador de progreso (OSC 9;4 cuando es compatible).

## Paleta de colores

OpenClaw utiliza una paleta “lobster” para la salida de la CLI.

- `accent` (#FF5A2D): encabezados, etiquetas, resaltados primarios.
- `accentBright` (#FF7A3D): nombres de comandos, énfasis.
- `accentDim` (#D14A22): texto de resaltado secundario.
- `info` (#FF8A5B): valores informativos.
- `success` (#2FBF71): estados de éxito.
- `warn` (#FFB020): advertencias, alternativas, atención.
- `error` (#E23D2D): errores, fallos.
- `muted` (#8B7F77): desénfasis, metadatos.

Fuente de verdad de la paleta: `src/terminal/palette.ts` (también conocida como “lobster seam”).

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

Nota: los plugins pueden agregar comandos adicionales de nivel superior (por ejemplo, `openclaw voicecall`).

## Seguridad

- `openclaw security audit` — auditar la configuración + el estado local para detectar errores de seguridad comunes.
- `openclaw security audit --deep` — sondeo en vivo del Gateway con el mejor esfuerzo.
- `openclaw security audit --fix` — ajustar valores predeterminados seguros y aplicar chmod al estado/configuración.

## Plugins

Administrar extensiones y su configuración:

- `openclaw plugins list` — descubrir plugins (use `--json` para salida de máquina).
- `openclaw plugins info <id>` — mostrar detalles de un plugin.
- `openclaw plugins install <path|.tgz|npm-spec>` — instalar un plugin (o agregar una ruta de plugin a `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — alternar `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — reportar errores de carga de plugins.

La mayoría de los cambios en plugins requieren reiniciar el gateway. Consulte [/plugin](/tools/plugin).

## Memoria

Búsqueda vectorial sobre `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — mostrar estadísticas del índice.
- `openclaw memory index` — reindexar archivos de memoria.
- `openclaw memory search "<query>"` — búsqueda semántica sobre la memoria.

## Comandos con barra del chat

Los mensajes de chat admiten comandos `/...` (texto y nativos). Consulte [/tools/slash-commands](/tools/slash-commands).

Destacados:

- `/status` para diagnósticos rápidos.
- `/config` para cambios de configuración persistidos.
- `/debug` para anulaciones de configuración solo en tiempo de ejecución (memoria, no disco; requiere `commands.debug: true`).

## Configuración + onboarding

### `setup`

Inicializar la configuración + el espacio de trabajo.

Opciones:

- `--workspace <dir>`: ruta del espacio de trabajo del agente (predeterminado `~/.openclaw/workspace`).
- `--wizard`: ejecutar el asistente de onboarding.
- `--non-interactive`: ejecutar el asistente sin indicaciones.
- `--mode <local|remote>`: modo del asistente.
- `--remote-url <url>`: URL del Gateway remoto.
- `--remote-token <token>`: token del Gateway remoto.

El asistente se ejecuta automáticamente cuando hay cualquier flag del asistente presente (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Asistente interactivo para configurar gateway, espacio de trabajo y skills.

Opciones:

- `--workspace <dir>`
- `--reset` (restablecer configuración + credenciales + sesiones + espacio de trabajo antes del asistente)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (manual es un alias de avanzado)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (no interactivo; se usa con `--auth-choice token`)
- `--token <token>` (no interactivo; se usa con `--auth-choice token`)
- `--token-profile-id <id>` (no interactivo; predeterminado: `<provider>:manual`)
- `--token-expires-in <duration>` (no interactivo; p. ej., `365d`, `12h`)
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
- `--node-manager <npm|pnpm|bun>` (se recomienda pnpm; bun no se recomienda para el runtime del Gateway)
- `--json`

### `configure`

Asistente interactivo de configuración (modelos, canales, skills, gateway).

### `config`

Ayudantes de configuración no interactivos (get/set/unset). Ejecutar `openclaw config` sin
subcomando inicia el asistente.

Subcomandos:

- `config get <path>`: imprimir un valor de configuración (ruta con puntos/corchetes).
- `config set <path> <value>`: establecer un valor (JSON5 o cadena sin procesar).
- `config unset <path>`: eliminar un valor.

### `doctor`

Comprobaciones de salud + correcciones rápidas (configuración + gateway + servicios heredados).

Opciones:

- `--no-workspace-suggestions`: deshabilitar sugerencias de memoria del espacio de trabajo.
- `--yes`: aceptar valores predeterminados sin solicitar confirmación (headless).
- `--non-interactive`: omitir indicaciones; aplicar solo migraciones seguras.
- `--deep`: escanear servicios del sistema en busca de instalaciones adicionales del gateway.

## Ayudantes de canales

### `channels`

Administrar cuentas de canales de chat (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).

Subcomandos:

- `channels list`: mostrar canales configurados y perfiles de autenticación.
- `channels status`: comprobar la accesibilidad del gateway y la salud del canal (`--probe` ejecuta comprobaciones adicionales; use `openclaw health` o `openclaw status --deep` para sondeos de salud del gateway).
- Consejo: `channels status` imprime advertencias con correcciones sugeridas cuando puede detectar configuraciones incorrectas comunes (luego le dirige a `openclaw doctor`).
- `channels logs`: mostrar registros recientes del canal desde el archivo de registro del gateway.
- `channels add`: configuración tipo asistente cuando no se pasan flags; los flags cambian a modo no interactivo.
- `channels remove`: deshabilitar por defecto; pase `--delete` para eliminar entradas de configuración sin solicitar confirmación.
- `channels login`: inicio de sesión interactivo del canal (solo WhatsApp Web).
- `channels logout`: cerrar sesión de una sesión de canal (si es compatible).

Opciones comunes:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: id de cuenta del canal (predeterminado `default`)
- `--name <label>`: nombre visible de la cuenta

Opciones de `channels login`:

- `--channel <channel>` (predeterminado `whatsapp`; admite `whatsapp`/`web`)
- `--account <id>`
- `--verbose`

Opciones de `channels logout`:

- `--channel <channel>` (predeterminado `whatsapp`)
- `--account <id>`

Opciones de `channels list`:

- `--no-usage`: omitir instantáneas de uso/cuota del proveedor de modelos (solo con OAuth/API).
- `--json`: salida JSON (incluye uso a menos que se establezca `--no-usage`).

Opciones de `channels logs`:

- `--channel <name|all>` (predeterminado `all`)
- `--lines <n>` (predeterminado `200`)
- `--json`

Más detalles: [/concepts/oauth](/concepts/oauth)

Ejemplos:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

Listar e inspeccionar skills disponibles más información de preparación.

Subcomandos:

- `skills list`: listar skills (predeterminado cuando no hay subcomando).
- `skills info <name>`: mostrar detalles de una skill.
- `skills check`: resumen de requisitos listos vs faltantes.

Opciones:

- `--eligible`: mostrar solo skills listas.
- `--json`: salida JSON (sin estilo).
- `-v`, `--verbose`: incluir detalle de requisitos faltantes.

Consejo: use `npx clawhub` para buscar, instalar y sincronizar skills.

### `pairing`

Aprobar solicitudes de emparejamiento por mensaje directo (DM) entre canales.

Subcomandos:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Configuración + ejecutor del hook de Gmail Pub/Sub. Consulte [/automation/gmail-pubsub](/automation/gmail-pubsub).

Subcomandos:

- `webhooks gmail setup` (requiere `--account <email>`; admite `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (anulaciones en tiempo de ejecución para los mismos flags)

### `dns setup`

Ayudante DNS de descubrimiento de área amplia (CoreDNS + Tailscale). Consulte [/gateway/discovery](/gateway/discovery).

Opciones:

- `--apply`: instalar/actualizar la configuración de CoreDNS (requiere sudo; solo macOS).

## Mensajería + agente

### `message`

Mensajería saliente unificada + acciones de canal.

Ver: [/cli/message](/cli/message)

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

Ejecutar un turno de agente a través del Gateway (o `--local` integrado).

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

Administrar agentes aislados (espacios de trabajo + autenticación + enrutamiento).

#### `agents list`

Listar agentes configurados.

Opciones:

- `--json`
- `--bindings`

#### `agents add [name]`

Agregar un nuevo agente aislado. Ejecuta el asistente guiado a menos que se pasen flags (o `--non-interactive`); `--workspace` es obligatorio en modo no interactivo.

Opciones:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (repetible)
- `--non-interactive`
- `--json`

Las especificaciones de enlace usan `channel[:accountId]`. Cuando se omite `accountId` para WhatsApp, se usa el id de cuenta predeterminado.

#### `agents delete <id>`

Eliminar un agente y depurar su espacio de trabajo + estado.

Opciones:

- `--force`
- `--json`

### `acp`

Ejecutar el puente ACP que conecta IDEs con el Gateway.

Consulte [`acp`](/cli/acp) para opciones completas y ejemplos.

### `status`

Mostrar la salud de sesiones vinculadas y destinatarios recientes.

Opciones:

- `--json`
- `--all` (diagnóstico completo; solo lectura, fácil de pegar)
- `--deep` (sondear canales)
- `--usage` (mostrar uso/cuota del proveedor de modelos)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias de `--verbose`)

Notas:

- El resumen incluye el estado del Gateway + el servicio del host del nodo cuando está disponible.

### Seguimiento de uso

OpenClaw puede mostrar el uso/cuota del proveedor cuando hay credenciales OAuth/API disponibles.

Superficies:

- `/status` (agrega una línea corta de uso del proveedor cuando está disponible)
- `openclaw status --usage` (imprime el desglose completo por proveedor)
- Barra de menú de macOS (sección Uso bajo Context)

Notas:

- Los datos provienen directamente de los endpoints de uso del proveedor (sin estimaciones).
- Proveedores: Anthropic, GitHub Copilot, OpenAI Codex OAuth, además de Gemini CLI/Antigravity cuando esos plugins de proveedor están habilitados.
- Si no existen credenciales coincidentes, el uso se oculta.
- Detalles: consulte [Seguimiento de uso](/concepts/usage-tracking).

### `health`

Obtener la salud del Gateway en ejecución.

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

Restablecer configuración/estado local (mantiene la CLI instalada).

Opciones:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

Notas:

- `--non-interactive` requiere `--scope` y `--yes`.

### `uninstall`

Desinstalar el servicio del gateway + datos locales (la CLI permanece).

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

- `--non-interactive` requiere `--yes` y alcances explícitos (o `--all`).

## Gateway

### `gateway`

Ejecutar el Gateway WebSocket.

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
- `--reset` (restablecer configuración de desarrollo + credenciales + sesiones + espacio de trabajo)
- `--force` (finalizar el listener existente en el puerto)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (alias de `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Administrar el servicio del Gateway (launchd/systemd/schtasks).

Subcomandos:

- `gateway status` (sondea el RPC del Gateway por defecto)
- `gateway install` (instalación del servicio)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

Notas:

- `gateway status` sondea el RPC del Gateway por defecto usando el puerto/configuración resueltos del servicio (anule con `--url/--token/--password`).
- `gateway status` admite `--no-probe`, `--deep` y `--json` para scripting.
- `gateway status` también muestra servicios de gateway heredados o adicionales cuando puede detectarlos (`--deep` agrega escaneos a nivel de sistema). Los servicios de OpenClaw con nombre de perfil se tratan como de primera clase y no se marcan como “extra”.
- `gateway status` imprime qué ruta de configuración usa la CLI frente a cuál probablemente usa el servicio (entorno del servicio), además de la URL objetivo del sondeo resuelta.
- `gateway install|uninstall|start|stop|restart` admite `--json` para scripting (la salida predeterminada sigue siendo amigable para humanos).
- `gateway install` usa Node runtime por defecto; bun **no se recomienda** (errores de WhatsApp/Telegram).
- Opciones de `gateway install`: `--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

Seguir los registros de archivos del Gateway vía RPC.

Notas:

- Las sesiones TTY renderizan una vista estructurada y con color; las no TTY vuelven a texto plano.
- `--json` emite JSON delimitado por líneas (un evento de registro por línea).

Ejemplos:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Ayudantes de la CLI del Gateway (use `--url`, `--token`, `--password`, `--timeout`, `--expect-final` para subcomandos RPC).
Cuando pasa `--url`, la CLI no aplica automáticamente credenciales de configuración o de entorno.
Incluya `--token` o `--password` explícitamente. La falta de credenciales explícitas es un error.

Subcomandos:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

RPC comunes:

- `config.apply` (validar + escribir configuración + reiniciar + despertar)
- `config.patch` (fusionar una actualización parcial + reiniciar + despertar)
- `update.run` (ejecutar actualización + reiniciar + despertar)

Consejo: al llamar `config.set`/`config.apply`/`config.patch` directamente, pase `baseHash` desde
`config.get` si ya existe una configuración.

## Modelos

Consulte [/concepts/models](/concepts/models) para el comportamiento de fallback y la estrategia de escaneo.

Autenticación Anthropic preferida (setup-token):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (raíz)

`openclaw models` es un alias de `models status`.

Opciones raíz:

- `--status-json` (alias de `models status --json`)
- `--status-plain` (alias de `models status --plain`)

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
- `--check` (salir 1=expirado/faltante, 2=por expirar)
- `--probe` (sondeo en vivo de perfiles de autenticación configurados)
- `--probe-provider <name>`
- `--probe-profile <id>` (repetir o separado por comas)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

Siempre incluye el resumen de autenticación y el estado de expiración OAuth para los perfiles en el almacén de autenticación.
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

- `add`: ayudante interactivo de autenticación
- `setup-token`: `--provider <name>` (predeterminado `anthropic`), `--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

Opciones:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## Sistema

### `system event`

Encolar un evento del sistema y, opcionalmente, activar un latido (RPC del Gateway).

Requerido:

- `--text <text>`

Opciones:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

Controles de latido (RPC del Gateway).

Opciones:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

Listar entradas de presencia del sistema (RPC del Gateway).

Opciones:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

Administrar trabajos programados (RPC del Gateway). Consulte [/automation/cron-jobs](/automation/cron-jobs).

Subcomandos:

- `cron status [--json]`
- `cron list [--all] [--json]` (salida en tabla por defecto; use `--json` para salida sin procesar)
- `cron add` (alias: `create`; requiere `--name` y exactamente uno de `--at` | `--every` | `--cron`, y exactamente una carga útil de `--system-event` | `--message`)
- `cron edit <id>` (parchear campos)
- `cron rm <id>` (alias: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

Todos los comandos `cron` aceptan `--url`, `--token`, `--timeout`, `--expect-final`.

## Host de nodo

`node` ejecuta un **host de nodo sin interfaz** o lo administra como un servicio en segundo plano. Consulte
[`openclaw node`](/cli/node).

Subcomandos:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## Nodos

`nodes` se comunica con el Gateway y apunta a nodos emparejados. Consulte [/nodes](/nodes).

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

CLI de control del navegador (Chrome/Brave/Edge/Chromium dedicados). Consulte [`openclaw browser`](/cli/browser) y la [herramienta Browser](/tools/browser).

Opciones comunes:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

Administrar:

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

## Búsqueda de documentos

### `docs [query...]`

Buscar en el índice de documentación en vivo.

## TUI

### `tui`

Abrir la interfaz de usuario de terminal conectada al Gateway.

Opciones:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (predeterminado `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
